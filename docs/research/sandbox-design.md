# 沙箱：LobeHub 源码与代表性实现对照

日期：2026-11-14；2026-11-15 更新云端 Pi 的部署边界。

范围：LobeHub 固定提交 `11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e` 的产品侧源码；E2B、Vercel Sandbox、Daytona、OpenSandbox、Onlyboxes 的官方文档及所列公开实现。没有统一的市场占有率依据，不将其排名为行业第一。最初对照未部署或运行基准；下方 2026-11-15 补充已完成的本机 E2B 功能验证，不代表容量基准。

## 用户约束与结论

- 本地 Agent 直接使用用户电脑的原生环境，通过 CLI 接入平台。
- 云端执行需要默认沙箱，也能接入 E2B 一类服务。
- 保留 Claude 的五个部件和 DSH Router/Worker，工程组织保持简单。
- Pi 依赖跟随上游升级，使用公开 SDK/RPC，避免改写底层循环。
- 云端平台自有 Pi 的 Runner、用户代码 Sandbox 和会话持久存储分别管理；Runner 不放进用户代码 Sandbox。依据与公开工具接入方式见 [云端执行方案](cloud-agent-runtime.md)。

推荐借鉴 LobeHub 的 provider 接入，以及成熟沙箱的工作空间、实例与生命周期分工。平台自有云端 Pi 采用沙箱外的 SDK Runner；LobeHub 的共用 CLI 路径作为后续第三方 Agent 接入的参考。产品的“默认沙箱”是平台预配置的一项服务，不要求我们自己实现容器调度、虚拟化和快照系统。默认服务和用户自接服务使用相同的产品入口。

当前实现选择已由用户明确为 E2B，直接使用官方 SDK。OpenSandbox、Onlyboxes 等内容保留为研究对照，不作为默认后端或并行实现。不能据此宣称这些服务的功能或部署成本相同。

2026-11-15 核对并部署官方开源 E2B Embed，固定上游提交 `c7bbb196b479b532d4218b47e1c3ce78b6370ae6`。M5 Mac 使用独立 Colima/VZ 虚拟机，开启嵌套虚拟化，升级至 Linux 7.0、4 KiB 页；实测 KVM API 为 12。官方 Compose 构建并运行真实 Firecracker 沙箱，SDK 2.64.0 的创建、文件/命令、非零退出、凭据隔离、取消及暂停后恢复均通过实际测试。具体安装与限制见 [部署记录](../../deploy/e2b/README.md)。这验证了一台机器上的功能，不是生产容量或稳定性结论。

取消测试发现 E2B 的进程 kill 只针对单 PID；上游 `packages/envd/internal/services/process/handler/os_unix.go` 的 `sysSignal` 也直接向该进程发信号。因此接入层使用 SDK 的公开 shell 选项建立独立进程组，取消时终止整组并等待输出结束；终止失败保留错误，不能报告已安全取消。

## LobeHub：确切实现

### Provider 与产品服务

`services/sandbox/deployment.ts` 默认返回 `market`；`factory.ts` 只选择 `market` 与 `onlyboxes`，再组装 `SandboxMiddlewareService`。

- `MarketSandboxProvider` 经 `@lobehub/market-sdk` 调用远端 `plugins.runBuildInTool` 等接口。它传递 topic/user、工作目录、模式、实例身份和配置。
- `OnlyboxesSandboxProvider` 直接调用远端 REST，支持同步终端命令、异步任务、取消及文件操作，以 user/topic 派生稳定 session ID，附带租约和 JIT token。
- `SandboxMiddlewareService` 集中环境初始化、附件同步、图片读取转换和文件导出。输入文件通过预签名 URL 下载；产物上传对象存储后创建产品文件记录。

本轮完整读取 factory、deployment、session、service、stopInstance、bootstrap、credsEnv、Onlyboxes provider，以及 sandboxRunner；Market provider 的工具与导出主线及 workspace 契约按相关职责阅读。检查部分 session 测试。没有通读全部沙箱 UI、所有存储管理接口或所有测试。

公开产品仓库展示了 Market 的调用契约，没有展示其底层虚拟机、快照与存储服务的全部实现。不能把 Market 的 provider 名当作 E2B、Docker 或 Firecracker 的证据。

### 会话与工作空间

`resolveSandboxSessionConfig` 先结合用户、工作区、topic 选择和访问范围解析一次运行的放置与授权，再交给 provider。`workspace.ts` 区分：

| 模式 | 保留的内容 |
| --- | --- |
| ephemeral | 临时执行环境 |
| drive | 持久目录；不代表恢复全部安装环境或进程 |
| persistent | 环境实例的目录与安装状态，按该实例恢复/捕获 |

环境定义、环境实例和持久目录分别有身份。实例带构建时配置快照；会话的模式和实例选择需要在各次调用中一致，不能由某一次工具调用临时换到另一个位置。

路径的实际挂载位置归执行端，产品请求传经过约束的相对目录与身份。工作区共享目录与成员私有目录还受访问规则约束。

这些模式主要通过 Market 的执行契约和存储接口体现。Onlyboxes provider 虽声明 `persistentSession`，其实现使用 terminal session/lease，并未解释相同的 drive/instance 配置字段；不能仅凭一个能力布尔值认定它实现了完全等价的持久语义。

### 云端 Agent 运行链路

`spawnHeteroSandbox` 通过 provider 的后台 `runCommand`，在已准备环境内启动 `lh hetero exec`。所读该路径的 agentType 限于 Claude Code / Codex，不能把本地执行器清单全部算作已经支持云端。

CLI 使用同一执行/适配/回传链路，将事件批量发到服务端 `heteroIngest` / `heteroFinish`。本地 `lh connect` 派发也启动同一 CLI 执行入口。云端路径不要求 HTTP 请求一直等待 Agent 完成。

代码特别处理“启动请求超时，但 Agent 其实已经开始回传”的竞争：判断实际运行事实后再决定是否记录启动失败。停止实例时也先保存停止约束、核对当前占用者、确认中断相关运行，再释放沙箱。

### 值得借鉴与需要另外选择的规则

值得借鉴：provider 独占协议细节；SDK/CLI 执行入口共用；配置解析集中；工作空间和实例分别管理；启动确认与执行结果分开；文件产物进入对象存储；停止顺序由生命周期所有者维护。

不能机械复制：Market 的商业授权与共享盘配额；大量历史模式及兼容分支；初始化的 best-effort 策略；环境不可解析时降级到临时环境。我们的长期任务如果明确绑定一个工作空间，失去绑定后应报告不可用并等待恢复或明确重建，不能让 Agent 在空目录里继续并让用户误以为原工作仍在。

## 代表性方案对照

| 方案 | 核对到的设计 | 对本产品的启示与代价 |
| --- | --- | --- |
| E2B | Firecracker VM、模板快照、控制与执行分工；支持暂停/恢复，默认可保存文件系统与内存；也有仅文件系统方式 | 适合托管沙箱与完整 Agent 进程。需要处理超时、生命周期、模板与数据留存；不能把暂停当作任务完成 |
| Vercel Sandbox | Firecracker、受管理或自定义镜像、持久 sandbox；停止/超时可自动保存文件系统快照，并独立管理快照留存 | 产品可以暴露简单的启动/停止/继续；所查快照文档承诺文件系统恢复，不应推断与 E2B 的进程内存恢复相同 |
| Daytona | 持久沙箱、独立 volume；container 与 VM 类型的 stop/start、pause/resume、snapshot 能力有差异 | 生命周期按能力表达，不能给所有 provider 强制一套“内存暂停”行为。部署完整平台的成本需要另外评估 |
| OpenSandbox | 公开生命周期 API 与执行协议，Docker 单机后端、Kubernetes 后端及额外 runtime；命令/文件服务在环境内；提供安全运行时与网络控制的配置 | 可自托管默认服务的候选，先验证单机路径，不引入其全部部署形态。隔离保证取决于实际 runtime 配置 |
| Onlyboxes | 自托管 console/worker；REST/MCP、状态终端和租约；有 LobeHub 对接 provider 与专用镜像文档 | 接口与部署值得比较，但长期持久语义需要实测，不能因 LobeHub 能接入就视为默认最佳方案 |

文档描述的是研究日所见能力。厂商的性能宣传没有作为本产品容量、延迟或恢复时间的承诺。标准容器、强化容器和 VM 的隔离能力也不能视为等价。

## 对本产品的最小建议

### 三个实际交付物

Web 工作台、同一代码库的后端（API/Worker 两个入口）、CLI（connect/run 两个入口）。沙箱是后端中一个有明确所有权的模块，provider 作为该模块的具体实现。

本地 connect 在原生系统接收任务并调用 run，属于后续设备接入路径。当前平台自有云端 Pi 在可信 Runner 中运行，文件与命令操作经公开工具后端委派到 Sandbox。Pi 和其他 Agent 的适配知识集中在运行实现中，不因换沙箱重新实现一套 Agent loop。后续完整第三方 CLI 是否放入沙箱，按其实际执行协议另行评估。

### 工作空间与执行实例

一个长期工作默认绑定独立工作空间，后续 Run 继续使用它。运行实例按需启动、连接、停止或释放；停止实例不自动结束任务。第一版不要求跨用户共享盘、环境市场或多级模板发布。

PG 保存归属、任务、会话/运行记录、沙箱/工作空间引用和生命周期事实。实际工作文件与依赖保存在执行环境支持的卷或快照，最终产物另存对象存储。平台自有 Pi 的原生会话单独持久化，不挂载到用户代码 Sandbox；后续第三方 CLI 的会话存储按其实际协议评估。PG 中有一个 sandbox ID 不能证明其文件还能恢复。

平台声明默认 provider，用户可选择已接入的其他 provider。绑定记录至少保留提供方、所属范围和环境引用，不能在旧环境不可用时自动换一家并承诺原状态仍在。

### 最小 Interface 与资源归属

只围绕已有需求设计：准备/连接环境、启动命令、访问文件、读取执行状态、停止/释放。实现可集中在一个模块；凭据校验、创建与清理的操作顺序由资源所有者维护。

provider 返回实际能力和恢复结果。暂停进程内存、共享盘、fork、浏览器、网络策略等扩展按实际产品需求接入；不要为覆盖所有厂商提前搭建完整插件框架。

平台自有 Router 和 Worker 的 Pi harness 在可信计算环境运行，用户代码在独立 Sandbox 执行。产品权限由应用和实际执行限制共同实施，沙箱启动令牌不携带平台管理密钥，模型凭据与 Pi 会话目录不进入 Sandbox。凭据管理优先采用最小作用域和可撤销身份，具体代理或注入方式按所选执行器验证。

### 与 Claude、DSH 组合

Inbox 保证事件可恢复，Timer 到期产生输入，Memory 提供连续性，Permissions 管调用与交互，Outbox 负责送达。Router 判断是否新建工作或归入已有工作，Worker 的工具操作在已绑定 Sandbox 执行；明确归属的后续输入可直接交给 Worker。

接受工作、记录状态与待执行动作在一个 PG 事务内提交；投递器发送 BullMQ，运行进展使用 Redis Streams。沙箱调度不能替代这一套产品事实，也不需要为五个部件各启动一个服务。

## 选型验证

对 E2B 官方 SDK 验证最小链路：可信 Runner 中的 Pi 通过公开工具操作访问远端工作目录，验证输出、取消确认、文件导出、停机后工作空间恢复、环境过期、创建请求超时但实际已启动及私有凭据隔离。终止 Sandbox 后，另行核对 Pi 会话和 Runner 仍可用；终止 Runner 后，从独立持久会话验证继续。核对部署成本和网络可达性后再做性能测量。

首轮只接一个默认 provider 和一个明确需要的外部 provider。不同时实现全部候选，不自研快照调度或 Kubernetes 控制器。

## 来源

- [LobeHub factory](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/apps/server/src/services/sandbox/factory.ts)
- [LobeHub 默认 provider](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/apps/server/src/services/sandbox/deployment.ts)
- [Market provider](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/apps/server/src/services/sandbox/providers/market.ts)
- [Onlyboxes provider](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/apps/server/src/services/sandbox/providers/onlyboxes.ts)
- [会话绑定](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/apps/server/src/services/sandbox/session.ts)
- [工作空间契约](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/packages/builtin-tool-cloud-sandbox/src/workspace.ts)
- [云端 CLI 启动](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/apps/server/src/services/heterogeneousAgent/sandboxRunner.ts)
- [停止实例](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/apps/server/src/services/sandbox/stopInstance.ts)
- [E2B 架构](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md)
- [E2B 生命周期](https://docs.e2b.dev/sandbox)
- [E2B 持久化](https://docs.e2b.dev/sandbox/persistence)
- [Vercel Sandbox](https://vercel.com/docs/sandbox)
- [Vercel 快照](https://vercel.com/docs/sandbox/concepts/snapshots)
- [Daytona 持久化](https://www.daytona.io/docs/en/persistence/)
- [Daytona 架构](https://www.daytona.io/docs/en/architecture/)
- [OpenSandbox 架构](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/index.md)
- [OpenSandbox runtime 选择](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/opensandbox_server/services/factory.py)
- [OpenSandbox 安全运行时配置](https://github.com/opensandbox-group/OpenSandbox/blob/main/server/configuration.md)
- [Onlyboxes](https://github.com/Coooolfan/onlyboxes)
- [Onlyboxes Docker worker 与 LobeHub 镜像](https://github.com/Coooolfan/onlyboxes/blob/main/website/src/docs/en/worker-docker.mdx)
