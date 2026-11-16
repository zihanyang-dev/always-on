# Agent / Session 生命周期调研

日期：2026-11-16。目标是给本仓库的云端 Agent 管理和资源回收确定依据。本轮只阅读列出的相关源码与官方资料，不声称完整审计上游项目。实现决定见 [ADR-0003](../adr/0003-agent-session-lifecycle.md)。

## LobeHub

阅读 canary 固定提交 `6fdec2d61516a3a313c1d496a7c7c749ab9f71e9`：

- [Agent lifecycle 路由](https://github.com/lobehub/lobehub/blob/6fdec2d61516a3a313c1d496a7c7c749ab9f71e9/apps/server/src/routers/lambda/agent/lifecycle.ts)：删除先做资源授权，有他人对话时限制级联删除，并把对象交给回收站。
- [Agent 配置路由](https://github.com/lobehub/lobehub/blob/6fdec2d61516a3a313c1d496a7c7c749ab9f71e9/apps/server/src/routers/lambda/agent/config.ts)：更新受资源写权限约束，保护跨用户配置与管理策略。
- [Session 模型删除路径](https://github.com/lobehub/lobehub/blob/6fdec2d61516a3a313c1d496a7c7c749ab9f71e9/packages/database/src/models/session.ts)：在事务内核对可写归属后删关系与会话，再清理无引用 Agent；不是任意按 ID 级联。
- [沙箱停止流程](https://github.com/lobehub/lobehub/blob/6fdec2d61516a3a313c1d496a7c7c749ab9f71e9/apps/server/src/services/sandbox/stopInstance.ts)：核实实际持有者，持久记录停止意图并确认操作中断后释放环境，拒绝持有者变化。
- [Agent 回收站处理](https://github.com/lobehub/lobehub/blob/6fdec2d61516a3a313c1d496a7c7c749ab9f71e9/apps/server/src/services/trash/handlers/agent.ts)：暂存、恢复与物理删除有不同规则，关联内容保持归属。

借鉴的是归属核对、停止与释放顺序、保留中间状态。本产品 Session 始终私人持有，Agent 不级联删别人的 Session；本期采用归档加异步物理删除，没有引入完整回收站、协作编辑锁或其旧 Session 兼容层。上游相关测试仅作源码参考，未在本仓库运行。

## E2B 与 Pi

[E2B 生命周期](https://docs.e2b.dev/sandbox) 明确区分暂停与结束。核对本仓库安装的 E2B 2.64.0：`Sandbox.kill(id, options)` 使用控制面 DELETE，404 返回 false，其他 API 错误抛出，调用可传 signal 与请求超时。它可以针对既有 ID 结束环境，无需为了删除先连接和恢复 VM。本机官方 Embed 实测已覆盖暂停环境和重复删除。请求失败保留删除进度并重试。

[Pi 会话格式文档](https://docs.pi.dev/latest/session-format#deleting-sessions) 允许通过移除 JSONL 文件删除会话。本仓库每次 Run/attempt 都有专属目录，确认 SDK 结束后可清理整个 Session 目录，不需要修改 SessionManager 内部状态。继续使用不透明原生历史，命名/归档是产品元数据，不重写 SDK 文件内容。

E2B 的 NotFoundError 基类已弃用。已安装源码将控制面 404 映射为 SandboxNotFoundError，文件系统 HTTP/RPC 的缺失映射为 FileNotFoundError；生产适配器只把明确的沙箱缺失转换为带绑定身份的应用错误。真实测试分别验证文件缺失后 VM 仍可用、丢失绑定不被替换。使用 Biome 官方 [noRestrictedImports](https://biomejs.dev/linter/rules/no-restricted-imports/) 定向禁止弃用基类导入，并验证允许的新类导入，不增加自制 lint。

## 持久删除与重复投递

[Kubernetes Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/) 提供可借鉴的语义：删除请求先持久化并返回 202，外部清理完成后才最终删除；本项目只采用该顺序，不依赖 Kubernetes 或复制通用 finalizer 框架。

[BullMQ 幂等任务](https://docs.bullmq.io/patterns/idempotent-jobs) 要求重试仍得到相同最终状态；[Job ID 文档](https://docs.bullmq.io/guide/jobs/job-ids) 说明移出队列的 ID 不再阻止后续同 ID 投递。因此 PG 承担待清理意图和重试时间，BullMQ 只唤醒。SDK 删除、专属目录删除、事件删除及最终 PG 删除分别允许重复，不声称队列保证 exactly-once。

[Node fs.rm](https://nodejs.org/api/fs.html#fspromisesrmpath-options) 提供递归删除与 force 的缺失路径处理；force 不掩盖权限和其他真实错误。路径只能由配置的会话根目录和身份组成，测试验证路径穿越拒绝、不同 Session 隔离和符号链接不会删到外部内容。
