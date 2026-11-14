# ADR-0001：通用 Always-on Agent 平台的技术栈与工程边界

状态：基础工程已搭建。已落实 PostgreSQL、Redis + BullMQ、Redis Streams、React/Vite、Hono、Zod、Drizzle、CLI 和检查工具链；认证、Pi 与默认云端沙箱等仍待后续接入和验证。当前已实现能力见 [README](../../README.md)。

已确认的基础设施分工见 [后台队列与事件传输研究](../research/queue-and-event-transport.md)。Agent 执行层继续评估 Pi 与自建方案，并将多种本地 Agent 的 CLI 接入纳入设计，见 [执行层提案](0002-agent-execution-and-local-connector.md)。

请求的语义归属由 [Router 提案](0003-request-routing-and-dispatch.md) 说明，执行器与位置选择在其后处理。Pi 集成还需遵守执行层提案中的公开依赖与版本升级约定。

日期：2026-11-14。

最新收敛版见 [架构总览](../architecture.md)，具体目录与配置管理见 [工程设计](../project-structure.md) 和 [ADR-0004](0004-project-layout-and-configuration.md)。本文的细分目录作为设计过程记录；实现按最新总览采用更少的实际功能模块，并纳入原生本地与云端沙箱两种环境。

## 背景与假设

产品是通用的长期运行 Agent 平台。基础架构沿用 Anthropic 文章的 Event Inbox、Timers、Memory、Permissions、Outbox，以及运行于 Session 内的 Agent loop。场景与渠道通过工具、技能、接入和展示扩展。

本提案按 Web 为首个入口、多用户、多 Agent、可自托管的第一版设计。具体吞吐量、合规要求、部署区域和团队规模尚未确定，因此不据此承诺容量或可用性指标。

设计优先级：可恢复、授权可追溯、消息可重投、代码容易理解和修改、部署组件数量可控。遵循 [TypeScript 代码规范](../typescript-style-guide.md)。

## 建议选型

| 范围 | 建议 | 职责 |
| --- | --- | --- |
| 语言与运行时 | TypeScript、Node.js LTS、pnpm workspace | 统一前后端语言与依赖管理；落地时锁定受支持版本 |
| Web | React、Vite、React Router | 登录后控制台、会话、运行记录、审批和配置 |
| 样式与基础组件 | Tailwind CSS、shadcn/ui | 维护产品自己的基础组件与设计约定 |
| 前端数据 | TanStack Query；局部交互用 React state | 管理服务端数据获取、缓存与失效；流式事件独立订阅 |
| API | Hono、REST、OpenAPI | Web、外部接入、Webhook 与管理接口 |
| 输入契约 | Zod | 校验外部输入，推导共享接口类型 |
| 登录 | Better Auth | 登录与用户会话；资源授权由应用维护 |
| 业务数据库 | PostgreSQL、Drizzle、node-postgres | 领域状态、事务、迁移与查询 |
| 后台队列 | Redis + BullMQ，已确认 | 任务投递、延迟与重试 |
| 模型与 Agent 执行 | 待决：优先验证 Pi Agent Core + pi-ai，以及本地 Agent 适配器 | 复用模型和工具循环；平台负责持久状态与长期调度 |
| 工具接入 | 显式注册的工具、MCP SDK | 集中参数解析、执行授权、调用记录与结果 |
| 文件 | S3 兼容对象存储 | 附件、大型工具输出、生成文件 |
| 实时推送 | Redis Streams，已确认；Web 使用 SSE | 运行进展与窗口内补读；关键状态和最终消息持久保存 |
| 观测 | Pino、OpenTelemetry | 按 inbox/session/run/tool-call 关联日志与链路 |
| 检查与测试 | Biome、tsc、Vitest、Playwright | 静态检查、行为测试、真实 Web 与后台执行链路 |
| 部署 | Docker 镜像、Docker Compose 起步 | 分别启动 API、Worker 与数据库；前端可独立静态部署 |

这些名称是建议组合，不代表已完成版本兼容性验证。具体版本在实际搭建时通过安装、类型检查和最小链路验证后锁定。

## 关键取舍

### 一个后端代码库，两个进程入口

API 负责认证、输入解析、接收消息、查询、审批和事件订阅。Worker 负责消费事件、执行 Run、扫描定时器和投递 Outbox。

两者共享应用模块和数据库。API 请求结束、页面关闭和 SSE 断线不取消 Run；取消通过独立命令进入执行控制。

代价：需要管理两个进程及它们的观测和停机。收益：后台工作可以持续运行，也可以与 API 分别扩容。

### 已确认：PostgreSQL 保存事实，Redis 承担调度和实时传输

使用 Redis 后端的 BullMQ 调度任务，Redis Streams 传递运行输出与支持保留窗口内的补读。关键状态、工具结果和最终消息保存在 PostgreSQL。业务事务写入事实和待投递记录，再由投递器发送队列；消费端幂等及定期核对负责重复投递和故障后的补偿。

应用保留 Inbox、Run、Timer、Approval 和 Outbox 的业务记录，队列 job 携带执行所需的身份。来源去重、定时器 occurrence 去重和外部发送去重分别由其所有者维护。队列去重不能代替领域幂等，也不能使任意外部工具获得 exactly-once 语义。

代价：增加 Redis 运维、内存与保留策略、跨存储投递协调。收益：任务和高频运行输出可以分别管理资源与生命周期。Graphile Worker 的同库事务方案保留在研究材料中，不纳入当前实现路径。

### 持久定时器与队列调度分工

用户及 Agent 设置的 follow-up/schedule 保存在应用 Timer 表，包含时区、下一次到期时间、启停和版本信息。

周期扫描任务在事务中领取到期 Timer，写入具有唯一 occurrence 身份的 Inbox 事件，推进下一次到期时间并写入任务或待投递记录。重复扫描不重复制造同一个 occurrence。

由队列或进程调度少量扫描任务。用户计划统一保存在 Timer 表。唤醒扫描可有进程内时钟，但到期事实始终来自数据库；重启后重新扫描。漏执行时采用补跑还是跳过，属于 Timer 模块的明确策略。

### 模型 SDK 与运行恢复分工

模型和工具循环优先验证 Pi Agent Core + pi-ai；也支持通过适配器调用外部 Agent。Session 的产品记录、Run 生命周期、工具调用记录和授权归本应用。外部 Agent 自己的会话状态由对应运行时维护，平台保存恢复引用和同步记录，不能承诺把任意外部执行状态完全迁移到 PostgreSQL。

持久化完成的模型消息、待执行工具调用及工具结果，恢复时从已确认的边界继续。外部调用成功而本地尚未记账的情况，应依靠工具的幂等键、查询核对或明确的待人工处理状态恢复。

代价：采用 Agent Core 仍需要实现和验证应用的执行状态机、上下文整理及审批恢复。Pi Coding Agent SDK、实验性的 pi-durable 和 AI SDK 的 WorkflowAgent 有各自的状态与恢复机制，需要分别评估，避免两套恢复机制同时管理同一段执行。

### 本地 Agent 通过 Connector 接入

在用户电脑运行独立 CLI Connector，主动连接平台，报告已安装执行器及其实际能力；平台派发任务，Connector 调用对应 Agent 并回传事件。支持多种 Agent，首批适配器范围及 Pi 选型见 [ADR-0002](0002-agent-execution-and-local-connector.md)。

平台记录执行引擎和执行位置两个独立维度。用户电脑离线时保留待执行状态；恢复本地会话需要其运行时和工作目录仍可用。

### 控制台使用 SPA，API 使用开放协议

React + Vite 满足客户端控制台交互，REST/OpenAPI 可被 Web、CLI 和外部来源共同使用。共享包只放明确的接口 schema 与事件契约，不让浏览器依赖数据库表或服务端实现类型。

代价：数据获取与 API 集成需要显式维护。若后续出现公开页面的 SSR/SEO 需求，可为该展示入口评估服务端渲染方案。

## 文章组件的落点

| 原文组件 | 应用模块与持久化 | 后台行为 |
| --- | --- | --- |
| Event Inbox | inbox；来源事件、处理状态、稳定去重身份 | 批量领取事件、选择新建或恢复 Session |
| Timers | timers；follow-up/schedule、时区、occurrence | 扫描到期记录并转成 Inbox 事件 |
| Memory | memory；内容、作用域、来源和版本 | 按需加载、写回、整理 |
| Permissions | permissions；授权、工具规则、待决审批 | 自有工具执行前检查；支持时保存待决调用并释放本次执行，外部运行时按能力衔接 |
| Outbox | outbox；待发消息、目的地、发送回执 | 投递、退避重试、终止无效目的地 |
| Session / Run | sessions、runs；消息、调用记录、检查点 | 执行模型工具循环并保存进度 |

同一 Inbox 的处理串行，不同 Inbox 可并行。多 Worker 使用有所有者、到期时间和递增版本的领取机制；续租和提交进度必须条件匹配当前领取版本，阻止过期 Worker 写入进度。外部调用不会因租约过期自动撤销，仍须独立处理幂等与结果核对。

Memory 先支持明确的指令、笔记、已告知信息和任务进度。是否引入 pgvector 由实际语义检索需求决定。模型上下文压缩和长期记忆分别维护。

## 建议目录

以下为职责归属图；实现相应能力时再创建目录和文件。

```text
always-on/
├── apps/
│   ├── web/
│   │   └── src/
│   │       ├── app/                 # 路由、应用入口、providers
│   │       ├── features/            # agents、sessions、runs、approvals、memory
│   │       └── shared/              # 已实际共用的 UI 与浏览器基础能力
│   ├── connector/                   # 本地 CLI、设备连接、派发与事件回传
│   └── server/
│       ├── migrations/
│       └── src/
│           ├── bootstrap/
│           │   ├── api.ts           # 创建依赖，启动 HTTP 服务
│           │   └── worker.ts        # 创建依赖，启动后台执行
│           ├── api/                 # 按功能组织路由和 HTTP 边界
│           ├── application/
│           │   ├── agents/
│           │   ├── devices/
│           │   ├── inbox/
│           │   ├── routing/         # 请求归属、路由决定与应用校验
│           │   ├── sessions/
│           │   ├── runs/
│           │   ├── timers/
│           │   ├── memory/
│           │   ├── permissions/
│           │   └── outbox/
│           ├── harness/             # 单次执行边界、上下文及执行资源生命周期
│           ├── tools/               # 具体产品工具实现，按能力组织
│           ├── channels/            # Web、飞书等来源翻译与目的地发送
│           └── infrastructure/      # postgres、queue、storage、auth 等适配
├── packages/
│   ├── contracts/                   # 按功能导出的 API、设备协议与事件契约
│   └── agent-executors/             # Pi、外部 Agent 协议与进程适配
├── tests/
│   ├── integration/                 # 跨模块、真实数据库、API/Worker/Web 链路
│   └── sdk/                         # 第三方 SDK 行为研究
├── docs/
│   ├── research/
│   ├── adr/
│   └── typescript-style-guide.md
├── AGENTS.md
├── biome.json
├── compose.yaml
└── pnpm-workspace.yaml
```

每个功能通过一层显式入口暴露能力。模块内部的类型、规则和单元测试相邻存放；没有通用 services/types/utils 目录集中所有功能的代码。

## 边界与依赖

- bootstrap 选择实现、创建连接、组装工具与调用入口，拥有进程的启动和停机。
- api/channels 将外部输入解析成应用命令。应用模块处理职责范围内的状态与用例。
- 应用执行编排调用 Harness；Harness 只接收本次执行需要的上下文、能力和回调，不拥有产品工具清单和租户数据库。
- PostgreSQL 适配器集中事务、锁与条件写入，在事务中调用必要的应用判定。调用者不自行拼装多次读取和更新来完成一个原子命令。
- SDK 消息解释、流事件分派和协议错误转换归具体适配逻辑；不把供应商 SDK 事件传播给整个应用。
- 账号凭据在服务端按作用域管理；身份登录与 Agent 的工具执行授权分开。具有不受信任代码执行能力的工具应使用独立执行环境，不与 API 进程共享用户脚本执行权限。
- 跨功能传递所需 ID 和能力，不向文件、存储或工具模块传入完整运行状态与启动配置。

## 实时与运维

SSE 用于服务端向浏览器推送，用户命令走 HTTP。运行事件保存顺序游标，重连时按游标补读。取消 SSE 订阅只释放订阅资源。

Redis Streams 传递运行输出；超过保留窗口时，从 PostgreSQL 中的持久状态与消息快照重新同步。是否要求逐事件长期重放需要另行明确，避免把所有 token 默认永久保存。Connector 使用经认证的 WebSocket/HTTPS 连接平台，Redis 由服务端访问。

应有数据库备份与恢复流程、迁移执行流程、Run/工具超时和费用预算、优雅停机、失败记录与人工重试、会话和大文件保留策略。容量目标明确后再确定连接池、扫描间隔、Worker 数与历史清理参数。

## 备选方案

| 方案 | 优点 | 当前取舍 |
| --- | --- | --- |
| Next.js 全栈应用 | SSR、页面和 API 集成 | 当前控制台选 SPA；后台执行仍需要独立生命周期 |
| PostgreSQL + Graphile Worker | 同库事务入队、部署组件少 | 本轮已选择 Redis + BullMQ，取舍证据保留在研究材料中 |
| Temporal / WorkflowAgent | 提供持久执行与恢复机制 | 需要验证部署约束、执行模型和既有 Session/审批模型的映射；复杂恢复需求上升时重新评估 |
| 直接使用某供应商 Agent SDK | 可以直接利用其工具与会话能力 | 可作为具体执行路径；产品的跨来源 Inbox、Timer、Memory、Permissions、Outbox 仍需明确归属 |

## 验证要求

本提案尚无运行验证。搭建时优先验证：重复来源事件、并发领取、到期 Timer 重投、Run 中途进程退出、审批后恢复、外部成功但本地回执未保存、页面断线、取消与停机、跨用户资源隔离。单元/集成测试负责状态与故障行为，Playwright 负责页面中实际可见的运行和审批结果。

## 参考

- [Anthropic：Building always-on agents](https://claude.com/resources/articles/building-always-on-agents)
- [Vite](https://vite.dev/guide/)
- [Hono Node.js](https://hono.dev/docs/getting-started/nodejs)
- [Hono SSE](https://hono.dev/docs/helpers/streaming)
- [Hono Zod/OpenAPI](https://hono.dev/examples/zod-openapi)
- [Better Auth Hono 集成](https://better-auth.com/docs/integrations/hono)
- [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)
- [shadcn/ui](https://ui.shadcn.com/docs)
- [Drizzle 事务](https://orm.drizzle.team/docs/transactions)
- [Graphile Worker 的执行语义](https://worker.graphile.org/docs)
- [Graphile Worker SQL 入队](https://worker.graphile.org/docs/sql-add-job)
- [Graphile Worker 定时扫描使用范围](https://worker.graphile.org/docs/cron)
- [AI SDK](https://ai-sdk.dev/docs/introduction)
- [WorkflowAgent](https://ai-sdk.dev/docs/agents/workflow-agent)
- [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
