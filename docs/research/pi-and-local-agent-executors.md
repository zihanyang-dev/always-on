# Pi 执行层与多种本地 Agent 接入研究

日期：2026-11-14。

状态：正文保留最初的静态源码评估范围；2026-11-15 已接入 Pi 1.5.2，并验证 DeepSeek + 独立 E2B 云端链路，见 [实现说明](../cloud-agent.md)。本地 Connector 仍未实现。

2026-11-15 补充：[云端 Agent、恢复与流式传输复核](cloud-agent-runtime.md) 已重新追踪 LobeHub 的 Agent 定义、PG/Redis 状态、工具结果复用和 Gateway 重连，并将下一阶段收敛为平台自有云端 Pi Agent；本地设备接入另行实施。该文仍是待验证提案，不代表执行已经接入。

## 结论与建议

2026-11-15 根据“多模型、尽量减少自有 harness 维护、专注效果”的目标，调整为优先验证完整 Pi Coding Agent SDK 的云端集成，复用其会话、压缩、工具和扩展生命周期。Agent Core + pi-ai 保留为出现明确能力缺口后的备选，不再默认由平台重建这些能力。原始源码评估保留在下文，最新职责和恢复验收见[云端方案](cloud-agent-runtime.md)。本地执行器接入仍应支持多种 Agent，不能把接口和产品入口限定为 Codex。

Pi 执行层选型仍是提案。PostgreSQL 持久化、Redis + BullMQ 调度、Redis Streams 运行事件已获用户确认。

后续约束：跟随 Pi 上游发布升级，使用公开导出和扩展能力，把 SDK 类型、生命周期语义和恢复格式集中在对应 Adapter。所读 Agent Core changelog 已记录工具 schema、回合钩子以及 durable 导出拆分等 breaking changes，不能只凭类型检查或版本号声明兼容。具体依赖、旧状态验证和发布规则见 [ADR-0002](../adr/0002-agent-execution-and-local-connector.md)。

Pi 旧仓库 `badlogic/pi-mono` 当前重定向到 `earendil-works/pi`。本次克隆固定于 `c815ddaa3736bd0b009ce6a997ee5003f8a3a532`，含 4,571 个受版本控制文件；agent 包 manifest 版本为 `1.5.2`，包名为 `@earendil-works/pi-agent-core`。这是所读提交的信息，不代表已核对 npm 发布状态。

## 阅读范围

- Pi 完整读取 `packages/agent/src/agent-loop.ts`、`agent.ts`、`packages/coding-agent/src/core/sdk.ts`；追踪工具和事件类型、会话持久化处理及 RPC 文档。
- pi-durable 读取公开导出、存储与单写者约束、Storage 契约相关部分、Harness 组装、工具执行意图/恢复阶段及 park 逻辑。未完整阅读其大型 scheduler、所有工具实现或整个仓库。
- LobeHub 固定于 `11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e`，追踪 CLI connect → agentRun → hetero exec → 协议适配 → BatchIngester → 服务端 ingest/finish 的关键实现。完整读取 connect handlers、agentRun、BatchIngester 以及 Codex 单次执行 handle；Pi RPC session 按执行生命周期阅读。未完整审计全部执行器或整个仓库。
- Codex 官方 App Server 文档核对 stdio 握手、thread resume、turn interrupt 和交互审批。其余 Agent 的能力不由 Codex 的能力外推。

## Pi 的几个不同层次

| 方案 | 已提供的能力 | 平台仍需承担的工作与适用判断 |
| --- | --- | --- |
| 使用 AI SDK 等模型库自己组织循环 | 模型调用、流输出和工具调用原语；具体取决于所选库 | 自己维护循环、工具编排、上下文、流事件及恢复；控制最直接，开发和维护范围最大 |
| Pi Agent Core + pi-ai | 通用模型/工具循环、流事件、工具参数解析、前后钩子、steering/follow-up、取消和回合边界 | 平台承担更多恢复、审批、上下文整理及资源隔离；原评估方向，当前改为备选 |
| Pi Coding Agent SDK | AgentSession、SessionManager、压缩、技能/扩展、资源发现、配置及编程工具 | 默认约定围绕工作目录和本地配置/会话；适合作为完整的 Pi 执行器；将其整个会话模型接入 PostgreSQL 需要明确的格式转换和所有权 |
| Pi Coding Agent RPC | 通过子进程 JSONL 使用完整 Pi；可启动、追加输入、查询和取消 | Connector 维护子进程、会话引用、协议版本、输出回传和关停；适合本地 Pi 接入 |
| pi-durable | 已有持久 conversation/task/document、模型与工具检查点、恢复、等待/睡眠、重放策略和审批 hook 示例 | 明确标为实验性；当前内置存储与单写者约束需要额外适配 PostgreSQL 和多 Worker 的所有权；暂不作为平台默认持久运行时 |

这些方案的职责范围不同。使用 Agent Core 时，优先使用配套 pi-ai 接入模型，减少重复维护两套模型消息和工具 schema 转换的成本；是否需要其他模型库由实际供应商能力缺口决定。

## Agent Core 的源码设计

`agent-loop.ts` 将流程拆成模型响应、工具准备、执行、结果整理及下一回合。`runAgentLoop` 和 `runAgentLoopContinue` 接受可等待的事件接收函数。`Agent` 在上层集中管理单次执行、取消、消息队列、当前转录和监听器；它的状态在内存中，没有数据库后端。

关键扩展边界：

- `prepareRequest` 可在每次模型请求前准备已确认的上下文。
- `beforeToolCall` 在参数解析后运行，可阻止工具；`afterToolCall` 可处理结果。
- 模型完成消息的事件接收完成后才进入工具流程；事件接收器可以形成持久写入屏障，但需要专门验证失败传播。
- 并行工具的完成事件按实际完成顺序到达，最终工具结果消息按模型发出的调用顺序整理。
- `finishTurn` 决定正常回合后是否结束或继续；steering 和 follow-up 有不同的消费时机。

待集成时特别验证：工具钩子抛错会被循环转换为工具错误；`Agent` 也会把部分执行失败转换成事件。存储失败、所有权丢失和等待审批必须由执行边界明确判断，不能只看 `prompt()` 是否 resolve。

`beforeToolCall` 的 block 是产生工具错误结果，`terminate` 的批量规则是全部工具都要求终止才提前停止。因此“拒绝工具”不能直接等同于文章里的“保存调用、等待审批、之后继续”。平台需要独立的审批记录与恢复规则，并验证混合工具批次。

恢复时也不能只把消息加载进新 Agent 然后调用 `continue()`：Core 拒绝从 assistant 消息直接继续。若崩溃时模型已给出工具调用，恢复端需要核对调用记录、重用完成结果、按政策处理安全重放或未知结果，再形成有效的后续上下文。

## Coding Agent SDK 与 durable 的存储归属

Coding Agent 的 `createAgentSession` 默认创建文件相关的模型认证配置、SettingsManager、SessionManager、ResourceLoader 和编程工具。它允许显式提供资源和配置，也可使用内存 SessionManager，所以可以嵌入宿主应用；但不能据此认为只换一个数据库连接即可完成 PostgreSQL 集成。

其 `AgentSession` 在 `message_end` 把消息追加到 SessionManager，SessionManager 负责活动分支与压缩后的上下文。SDK 文档明确要求通过包含历史条目的 manager 恢复上下文，直接赋值 `session.agent.state.messages` 不替换持久上下文。

RPC 的 prompt 成功响应只代表接受/排队/处理。低层 `agent_end` 之后可能仍有重试、压缩或追加输入；完整 Coding Agent 使用 `agent_settled` 判断它不会再自动继续。这个差异必须留在 Pi 适配器中。

pi-durable 已真实提供恢复机制，不能把 Pi 全部描述为纯内存循环。其工具任务先提交执行意图，再调用工具；恢复时检查已记录与当前工具的重放策略，不把未知副作用直接重跑。

但所读版本明确要求一个进程写同一个 storage，未提供跨进程锁。内置存储包含内存、IndexedDB、SQLite、JSONL、Cloudflare Durable Object，以及面向 Chord Store 的适配；没有现成的 PostgreSQL backend。自定义 Storage 需要满足原子提交、序号、文档/任务一致性和持久提交回执等契约，还要解决多进程所有权。仅将 SQLite SQL 改写成 PostgreSQL SQL 不足以证明可用。

若后续改选 pi-durable，应让它明确拥有单次执行内部的检查点与任务恢复，再与平台队列和产品记录对接；不能另外维护一份互相竞争的工具执行真相。

## LobeHub 接入的本地 Agent

所读提交的 `HETEROGENEOUS_AGENT_CONFIGS` 登记 14 种本地 CLI：

Amp、Claude Code、CodeBuddy、Codex、GitHub Copilot、Cursor、Factory Droid、Devin、Grok Build、Kimi Code、OpenCode、Pi、Qoder、TRAE CLI。

另有 `local-runtime` 类别的 DeepSeek Harness，通过用户安装的 `dsh` 的 ACP profile 接入；它不是把 superagent-prototype 仓库本身当作一个 CLI。OpenClaw、Hermes 登记在另一种 `remote-task` 类别，不能混为同一接入方式。

| 接入方式 | 源码证据 |
| --- | --- |
| Pi RPC | `hetero.ts` 的 runtime factory 选择 `createPiRpcAgentHandle`，由 PiRpcSession 管理握手、prompt、settled、取消及关闭 |
| Codex | 有 exec JSON 路径和 App Server 路径；当前 CLI README 说明 App Server 路径需要能力探测及相应开关 |
| Claude Code | 存在 stream-json 与 Agent SDK 的适配与执行路径；具体路径由调用入口选择 |
| ACP | Copilot、Cursor、Droid、Devin、Grok Build、TRAE 与 DSH 有各自的 ACP session/adapter |
| 其他 CLI 结构化输出 | Amp、CodeBuddy、Kimi Code、OpenCode、Qoder 等由各自参数与事件适配逻辑解释 |

适配器登记证明代码存在，不保证用户安装的任意版本均具有相同功能；本次没有逐个真实启动这些 CLI。

## LobeHub 的设备接入链路

1. `lh connect` 建立主动的设备 Gateway WebSocket 连接，处理认证、心跳、重连和能力查询。
2. 平台发送 `agent_run_request`，包含 operation、执行器、工作目录和恢复引用等信息。
3. 设备调用 `spawnHeteroAgentRun` 启动当前 CLI 的 `hetero exec` 子进程，登记进程及取消所需身份。启动 ACK 与完成结果是不同消息。
4. 子进程选择 Pi RPC、Codex App Server、ACP 或 CLI 输出路径，转换成平台事件。
5. `BatchIngester` 按序批量调用服务端 ingest。它具有有限内存缓冲和重试，输出被服务端拒绝或缓冲溢出时让运行失败；该实现本身不是跨 Connector 崩溃的磁盘事件日志。
6. 服务端把消息和执行状态写入产品记录、发布运行事件，finish 路径保存恢复所需的外部 session 引用。

可以借鉴统一投影、执行器适配和身份隔离。若我们的产品要求设备进程重启后仍补传事件，需要另外设计本地发送日志及服务端确认游标。

## 对本产品的含义

平台 Agent 的角色、记忆、来源和计划不绑定某个编程 CLI。执行引擎与执行位置分别选择：Pi 可以运行于云端或设备，外部 Agent 也可以运行于受管理环境。跨引擎继续对话需要创建新的执行会话并明确上下文转换，不承诺原状态无损迁移。

Connector 上报执行器和已验证的能力。恢复、实时追加输入、审批、取消和用量等差异保留在协议及界面中。MCP 接入工具，ACP/RPC/SDK 接入完整 Agent；有命令行程序不等于具有完整交互协议。

平台自有工具能执行逐调用授权。第三方 Agent 内部工具的审批与限制取决于其协议和执行环境，单靠事后事件展示不能实施权限控制。设备断线后的执行、取消确认和输出回传应有明确状态；设备离线时平台可以持续接收事件和推进 Timer，本地工作等待设备可用。

具体边界、目录和验证计划见 [ADR-0002](../adr/0002-agent-execution-and-local-connector.md)。

## 主要来源

- [Pi Agent Core 循环](https://github.com/earendil-works/pi/blob/c815ddaa3736bd0b009ce6a997ee5003f8a3a532/packages/agent/src/agent-loop.ts)
- [Pi Agent 状态与生命周期](https://github.com/earendil-works/pi/blob/c815ddaa3736bd0b009ce6a997ee5003f8a3a532/packages/agent/src/agent.ts)
- [Pi Agent Core 升级记录](https://github.com/earendil-works/pi/blob/c815ddaa3736bd0b009ce6a997ee5003f8a3a532/packages/agent/CHANGELOG.md)
- [Pi Coding Agent SDK](https://github.com/earendil-works/pi/blob/c815ddaa3736bd0b009ce6a997ee5003f8a3a532/packages/coding-agent/src/core/sdk.ts)
- [Pi SDK 使用约定](https://github.com/earendil-works/pi/blob/c815ddaa3736bd0b009ce6a997ee5003f8a3a532/packages/coding-agent/docs/sdk.md)
- [Pi RPC](https://github.com/earendil-works/pi/blob/c815ddaa3736bd0b009ce6a997ee5003f8a3a532/packages/coding-agent/docs/rpc.md)
- [pi-durable 与 Storage 约束](https://github.com/earendil-works/pi/blob/c815ddaa3736bd0b009ce6a997ee5003f8a3a532/packages/durable/README.md)
- [pi-durable 工具恢复](https://github.com/earendil-works/pi/blob/c815ddaa3736bd0b009ce6a997ee5003f8a3a532/packages/durable/src/harness/tool.ts)
- [LobeHub 执行器目录](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/packages/types/src/agent/heterogeneousAgent.ts)
- [LobeHub 设备派发](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/apps/cli/src/commands/connect/handlers.ts)
- [LobeHub Agent 子进程启动](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/apps/cli/src/device/agentRun.ts)
- [LobeHub 执行入口](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/apps/cli/src/commands/hetero.ts)
- [LobeHub Pi RPC Session](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/packages/heterogeneous-agents/src/rpc/piRpcSession.ts)
- [LobeHub 事件上传](https://github.com/lobehub/lobehub/blob/11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e/apps/cli/src/utils/BatchIngester.ts)
- [Codex App Server 官方文档](https://developers.openai.com/codex/app-server/)
