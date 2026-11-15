# Agent 运行适配

包根入口检测 Pi、Codex、Claude Code、OpenCode 的本机安装，不启动程序，也不表示它们的执行协议已经接入。

`./pi` 使用完整 Pi SDK，集中模型目录、原生 SessionManager、检查点、事件映射、工具 operations、取消与资源释放。沿用公开接口，不改写模型循环。`./execution` 与 `./workspace` 提供平台执行观测、不透明 JSON 检查点和文件/命令能力；业务授权、工具清单、数据库和 E2B 组装留在 server。

云端链路及恢复限制见 [实现说明](../../docs/cloud-agent.md)，SDK 升级和后续本地 Connector 的取舍见 [ADR-0002](../../docs/adr/0002-agent-execution-and-local-connector.md)。
