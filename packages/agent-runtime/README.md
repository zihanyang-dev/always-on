# Agent 运行适配

当前只实现原生 CLI 的安装检测：Pi、Codex、Claude Code、OpenCode。检测不会启动这些程序，也不等于已经支持它们的执行协议。

Pi SDK/RPC 的具体组合仍遵循 ADR-0002 的验证与升级约定。这里不预制假的 Agent loop、会话恢复或云端实现。后续适配器在该包集中维护 SDK 解释、进程、取消与资源释放；不导入 server 的数据库和完整任务结构。
