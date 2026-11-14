# 项目目录与配置管理

日期：2026-11-14。状态：目录、工具链和可运行工程骨架已搭建；未实现的业务模块以 README 标明职责。基础设施沿用已确认的 PostgreSQL、Redis + BullMQ、Redis Streams；Pi 和默认云端沙箱仍待验证。

本文细化 [架构总览](architecture.md) 的工程组织。选型沿用 React + Vite 控制台、Hono 后端和 Zod 契约的提案。“干净”的判断标准是：修改一个行为时容易找到它；配置有明确来源；执行与资源生命周期有明确所有者。目录数量与抽象层数不是验收标准。

## 目录

```text
always-on/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   │   ├── app/                     # 路由、启动、顶层 providers
│   │   │   ├── features/
│   │   │   │   ├── agents/
│   │   │   │   ├── sessions/
│   │   │   │   ├── tasks/
│   │   │   │   └── settings/
│   │   │   └── shared/                  # 已实际共用的 UI、API 客户端
│   │   ├── vite.config.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── server/
│   │   ├── src/
│   │   │   ├── bootstrap/
│   │   │   │   ├── api.ts               # HTTP 入口与进程生命周期
│   │   │   │   ├── worker.ts            # 队列、扫描、投递入口
│   │   │   │   └── env.ts               # 按入口解析部署环境变量
│   │   │   ├── agents/                 # 配置、记忆、工具授权
│   │   │   ├── sessions/               # 会话、消息、Inbox
│   │   │   ├── tasks/                  # Router、任务、Run、Timers、审批
│   │   │   ├── devices/                # CLI 设备身份、连接与派发
│   │   │   ├── channels/               # 外部来源、Outbox、送达
│   │   │   ├── sandbox/                # 环境绑定、生命周期、provider
│   │   │   └── infrastructure/
│   │   │       ├── database/           # 连接与按功能分文件的表定义
│   │   │       ├── redis/              # Redis 客户端创建与释放
│   │   │       ├── object-storage/     # 附件与产物的对象存储
│   │   │       ├── authentication/     # 登录 SDK、会话认证与限流
│   │   │       ├── email/              # Resend 事务邮件传输
│   │   │       └── credentials/        # 凭据加解密与密钥版本
│   │   ├── migrations/                 # 单一数据库的 SQL 迁移历史
│   │   ├── drizzle.config.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   └── cli/
│       ├── src/
│       │   ├── bootstrap.ts            # 参数解析、组装、进程收尾
│       │   ├── config.ts               # 本机偏好与平台连接配置
│       │   ├── connect/                # 设备连接与任务接收
│       │   └── run/                    # 本地/云端共用执行、回传、关停
│       ├── tsconfig.json
│       └── package.json
├── packages/
│   ├── contracts/                      # 按功能导出的 Zod 协议契约
│   └── agent-runtime/                  # Pi / Codex 等执行适配与资源管理
├── tests/
│   ├── integration/                    # 跨功能与真实基础设施链路
│   └── sdk/                            # 第三方 SDK 行为研究
├── deploy/                             # 镜像、沙箱镜像、入口代理配置
├── docs/
├── .github/workflows/
├── .env.example                        # 本地后端/Compose 的变量说明和占位值
├── .env.local                          # 本地实际值，不提交
├── compose.yaml                        # 本地依赖与自托管启动组合
├── biome.json
├── tsconfig.base.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── package.json
└── AGENTS.md
```

这是职责图。按用户要求，server 功能目录已创建，暂未实现的模块放置职责说明；不预制空壳业务 API。`tests` 子目录、provider 和适配器只在有实际实现或研究用例时创建。`AGENTS.md` 继续只保留现有的简短约定与完整 TypeScript 指南链接。

### 功能放在一起，进程在入口组装

例如 `tasks/` 初期可以包含 `index.ts`、`routes.ts`、`task.ts`、`task-store.ts`、`routing.ts`、`timers.ts` 和相邻行为测试。它们分别集中公开入口、HTTP 解析、任务规则与编排、事务、路由判断和到期规则。文件按实际职责增长，不强制每个功能都有相同文件集合。

HTTP handler 与队列 handler 都调用所属功能的入口。事务、锁、条件提交与执行所有权集中在该功能的存储操作中；路由层不拼装数据库操作来完成原子命令。`task-store.ts` 是具体实现，不再套一层只有一个实现的通用 Repository。

数据库表按功能分文件，统一收在 `infrastructure/database` 的 schema 中；这样跨表关系不要求各功能相互深入导入内部表定义。业务查询和事务留在所属功能。数据库模块只拥有存储结构和连接，不逐渐吸收任务规则。Drizzle 支持多文件 schema；这是本项目的组织选择。[Drizzle schema](https://orm.drizzle.team/docs/sql-schema-declaration)

`infrastructure` 只放实际共享的底层能力，不再镜像一份 `agents/tasks/sessions`。登录认证与 Agent 操作授权分别归认证实现和对应业务规则。BullMQ 消费规则归 `tasks`，Streams 的事件映射与订阅归相应运行功能，底层 Redis 模块不拥有这些业务语义。

### 只有实际共享的能力成为 package

- `contracts`：HTTP、设备命令、运行事件的 Zod schema 与推导类型。按 `tasks`、`sessions`、`execution` 等功能提供明确子路径；不包含数据库表、SDK 对象、启动 env 或所有内部类型。
- `agent-runtime`：上游 Pi SDK/RPC、其他 Agent 协议、进程与流的生命周期。后端的受限 Router 和 CLI 执行使用其所需入口。Pi 依赖及升级适配集中在这里；各云端 provider 不复制 Agent loop。

Web 只依赖需要的协议契约；CLI 不导入 server 内部模块；共享包不导入 apps。运行适配需要协议契约时只依赖 `contracts` 的执行部分，不依赖完整任务结构。

```mermaid
flowchart TD
    Web[apps/web] --> Contracts[packages/contracts]
    Server[apps/server] --> Contracts
    CLI[apps/cli] --> Contracts
    Server --> Runtime[packages/agent-runtime]
    CLI --> Runtime
    Runtime --> Contracts
    Runtime --> SDK[上游 SDK / Agent 协议]
```

## 配置按所有者与生命周期管理

| 配置 | 例子 | 唯一归属 | 何时生效 |
| --- | --- | --- | --- |
| 工程配置 | TS、Biome、Vite、Drizzle、依赖版本 | 仓库中的对应配置文件 | 检查、构建或迁移时 |
| 部署配置 | PG/Redis 地址、端口、对象存储、并发上限 | 进程入口解析的 env | 启动时；修改后重启 |
| 产品设置 | Agent 模型、Router/Worker 选择、工具授权、沙箱连接选择、渠道、计划 | PG，由所属功能管理和校验 | 按明确的下一次调用/Run 规则 |
| 敏感凭据 | 用户模型 key、用户沙箱 token、平台登录密钥 | 用户凭据加密存储；部署密钥由部署系统注入 | 按引用读取与撤销规则 |
| 单次运行参数 | 执行器、工作空间、预算、截止时间、恢复引用 | 该 Run 的已解析输入及持久记录 | 创建/恢复该 Run 时 |
| 本机偏好 | CLI 平台地址、当前 profile、设备身份；Web 主题 | 操作系统应用配置目录；浏览器设置 | 相应客户端读取时 |

不建立跨这六类的万能 `config` 包或配置中心。每一种格式在其入口用 schema 解析；类型从该格式的 schema 推导。协议输入、数据库记录和 SDK 配置可以具有不同形状，不为了“统一类型”互相传播内部字段。

### 后端 env

`bootstrap/env.ts` 提供按角色使用的解析入口，例如 `parseApiEnv`、`parseWorkerEnv`。共享字段的 schema 在该模块复用；API 只要求它需要的配置，Worker 同理，迁移命令只解析数据库配置。每个入口启动时读取一次 `process.env`，业务与共享包不直接读取它，也不在模块导入时创建全局 env 单例。

解析后由 bootstrap 创建 DB、Redis、认证和沙箱等资源，把需要的数据与能力传给功能入口。内部使用含义明确的 camelCase 字段；不向所有函数传一份完整 env。资源创建与优雅停机都由组装入口拥有。

部署变量的初始形状示意如下，密钥占位值需替换，所选 provider 的变量在选型后补入：

```dotenv
NODE_ENV=development
BETTER_AUTH_URL=http://localhost:3001
PORT=3001
DATABASE_URL=postgresql://always_on:always_on_local@localhost:15432/always_on
REDIS_URL=redis://localhost:16379
LOG_LEVEL=info
WORKER_CONCURRENCY=4
BETTER_AUTH_SECRET=replace-with-a-generated-secret
CREDENTIALS_ENCRYPTION_KEY=replace-with-a-generated-key
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=always-on
S3_ACCESS_KEY_ID=replace-with-a-local-access-key
S3_SECRET_ACCESS_KEY=replace-with-a-local-secret-key
```

默认值写在拥有该字段的 schema 一处；`.env.example` 说明用途、单位、默认值、适用进程与必填条件。缺失必要配置在启动时报告变量名和规则，不打印输入值。URL、数字范围、时间单位及条件必填均在这里解析；开关使用明确枚举或 Zod `stringbool`，不能用 `Boolean("false")` 语义的 coercion。[Zod](https://zod.dev/api#stringbools)

选中的平台沙箱 provider 才要求其 URL/token，不要求配置所有候选的凭据。平台预置连接来自部署配置，用户自接连接来自 PG；选择哪一个连接归产品设置。模型与工具执行的应用权限不允许被某个进程 env 或临时 override 绕过。

### 本地、CI 与生产加载

- 本地：根目录 `.env.example` 提交，实际值统一放 `.env.local` 并忽略；开发启动脚本显式按固定工作目录加载它。API/Worker 共用这一文件，各自解析需要的字段。包、CLI 和 Web 不自动向父目录搜索 env。
- Node 启动脚本可使用内置 `--env-file`；shell 已有值优先，文件补足本地配置，不叠加多套自制 dotenv 加载顺序。[Node 文档](https://nodejs.org/api/cli.html#--env-filefile)
- Compose 的 `--env-file` 提供 YAML 插值来源；传给容器的字段仍通过 `environment` 或 `env_file` 明确指定。容器内 DB/Redis 地址采用服务名，与宿主机的 localhost 地址分别配置。[Docker 插值](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)、[容器环境](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/)
- CI/生产：由 CI、容器或托管平台直接注入变量与密钥，应用不依赖仓库中的生产 env 文件。API/Worker 镜像可共用构建产物并使用不同启动命令；生产迁移由发布步骤执行一次，不由每个进程启动时抢跑。

搭建时的忽略规则覆盖 `.env`、`.env.*`，显式保留 `.env.example`；SDK 的会话文件、CLI 登录信息和运行输出也不进入 Git。这个约定不意味着把所有测试夹具都排除，已脱敏的恢复夹具仍应纳入版本控制。

### Web 的公开配置

生产优先同源 `/api`，开发由 Vite 代理；避免把后端地址烘焙进每个环境的前端包。品牌名称、开放登录方式、公开能力等确需部署时变化的字段，由 `/api/public-config` 返回独立白名单 schema，Web 启动时解析。

只有确需构建时决定的非敏感字段使用 `VITE_*`。它们在构建时替换并进入客户端代码，不能作为运行时配置或保密机制；不让 Vite 加载根目录的后端密钥文件。[Vite 文档](https://vite.dev/guide/env-and-mode)

### Agent 设置与 Run 输入

`agents` 拥有可编辑设置及版本，`tasks` 在创建 Run 时解析所需设置、执行位置、工作空间、预算与权限版本，记录足以解释本次执行的已解析输入。运行中的模型或环境不因管理员修改一条设置而静默切换。

覆盖规则集中在一个具名操作中：应用默认值、已保存设置、明确允许的本次覆盖依次解析，再检查部署上限和授权约束。取消与撤销按实时控制规则处理，不被冻结成永远有效的旧权限。运行记录保存凭据引用，不复制明文密钥。

凭据的存储与解密集中在 credentials 模块，模型、渠道、沙箱模块只获得本次所需身份。后台管理密钥和整份 `process.env` 不传入云端 Agent；给沙箱 CLI 的回传凭据应限定到对应运行。具体隔离与注入能力随 provider 验证。

### CLI 的本机配置

使用操作系统应用配置目录保存平台地址、profile、设备引用等非敏感偏好，登录凭据优先进入系统凭据存储。无法使用该能力的部署采用显式受保护的凭据文件。原生 Agent 可以继续使用其已有配置和登录，平台不重复解析它的内部格式。

同一个非敏感连接选项的优先级为：显式 CLI 参数 > 指定的 CLI 环境变量 > 所选本机 profile > 内置默认值。CLI 环境变量使用 `ALWAYS_ON_*` 范围，不继承服务端配置；云端 `run` 主要消费平台给定的已校验输入。参数优先级不赋予额外权限。

## 工具链与版本

使用 pnpm workspace；内部依赖写 `workspace:*`。多包共用的 TS、Zod 等版本放 pnpm catalog，Pi 依赖集中在运行包并按兼容组升级。锁定 pnpm/Node 版本并提交 lockfile，CI 使用冻结安装。catalog 减少重复版本声明，不替代 lockfile。[Workspace](https://pnpm.io/workspaces)、[Catalogs](https://pnpm.io/catalogs)

根目录 `tsconfig.base.json` 只集中 TypeScript 指南要求的共同严格检查。Node 应用用 NodeNext，Web 用 preserve/bundler；包需要声明产物时启用 isolatedDeclarations。正式服务、CLI 与共享包先编译为 ESM JS，包通过 exports 明确暴露 JS 和声明；开发启动负责共享包的先构建与 watch，不让使用方猜测源码与产物入口。

功能内优先相对导入，跨功能走唯一公开入口，跨包走 exports。确需包内别名时使用 package.json imports，并验证开发与产物路径一致；不另造 tsconfig paths 映射。Node 原生类型剥离可以运行适合的小脚本，但不会类型检查，也不读取 tsconfig，不能代替 `tsc`。[Node TypeScript](https://nodejs.org/api/typescript.html)、[Node 包入口](https://nodejs.org/api/packages.html)、[TS 解析规则](https://www.typescriptlang.org/docs/handbook/modules/reference.html)

根目录提供 `dev`、`build`、`typecheck`、`check`、`test` 和数据库迁移命令，调用所属包的脚本；约定 `check` 包含 Biome 与类型检查。初期用 pnpm 执行依赖顺序和并发脚本，实际构建耗时证明需要缓存编排时再引入额外工具。开发依赖与配置文件留在真正使用它们的包，只有共同检查基线集中到根目录。

## 实现时的验收

先验证两种进程只校验所需配置、未启用 provider 不要求密钥、错误与日志不泄露输入、公开配置仅返回白名单、同一前端构建能用于不同部署。再验证 CLI 优先级、设置修改与已有 Run 的关系、取消及撤销、凭据隔离、共享包在生产 JS 入口下可运行。

当前已落实进程环境解析、公开配置、Web 初始化页、CLI 状态查询和安装检测、PG Inbox 去重、BullMQ/Redis Streams 诊断链路，以及三种登录后端和当前用户接口。认证模块集中 SDK、会话和限流；`users` 拥有用户资料入口。成员和资源授权规则仍归后续业务功能。认证配置与限制见 [接入说明](authentication.md)，其他能力与启动步骤见 [README](../README.md)。CI 覆盖静态检查、构建、单元测试、真实 PG/Redis 集成和桌面/移动视口冒烟。取舍记录见 [ADR-0004](adr/0004-project-layout-and-configuration.md)。
