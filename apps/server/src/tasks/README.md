# Run 执行

拥有 Run 的派发、PG 单写者领取、租约、实时工具授权、回执、展示投影和最终提交。Worker 扫描 PG queued 记录再投 BullMQ，队列只负责唤醒。execute.ts 调用组合根绑定的执行函数，不解释 Pi 检查点或 E2B 协议。

ownership.ts 集中 Session 执行所有权；store.ts 集中带 owner fence 的持久变更；workspace.ts 把授权与副作用回执绑定到执行能力；output.ts 维护本次消息投影。原生 SDK 与沙箱在 bootstrap/cloud-agent.ts 组装。

过期 owner 和未知工具结果进入 recovery_required，不自动重跑整轮。只有执行与资源收尾结束才提交 Run 终态。当前没有长期 Task、Router、Timers、审批或通用工作流框架。

Worker 同时扫描 Session 的到期删除请求，复用队列和连接执行 delete-session。业务删除状态归 sessions，实际 E2B 与文件清理由 bootstrap 提供；队列不承担资源所有权或持久重试的真相。

停止时先阻止新工作，等待 SDK、沙箱和文件操作，再给队列传输最多 5 秒完成退出。正常关闭等待最终提交；连接失联时断开本 Worker 自己的 Redis 客户端并报告收尾失败，未完成的删除继续保留 PG 意图。HTTP 和其他 Worker 的连接不受影响。
