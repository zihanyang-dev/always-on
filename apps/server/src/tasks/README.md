# Run 执行

拥有 Run 的派发、PG 单写者领取、租约、实时工具授权、回执、展示投影和最终提交。Worker 扫描 PG queued 记录再投 BullMQ，队列只负责唤醒。execute.ts 调用组合根绑定的执行函数，不解释 Pi 检查点或 E2B 协议。

ownership.ts 集中 Session 执行所有权；store.ts 集中带 owner fence 的持久变更；workspace.ts 把授权与副作用回执绑定到执行能力；output.ts 维护本次消息投影。原生 SDK 与沙箱在 bootstrap/cloud-agent.ts 组装。

过期 owner 和未知工具结果进入 recovery_required，不自动重跑整轮。只有执行与资源收尾结束才提交 Run 终态。当前没有长期 Task、Router、Timers、审批或通用工作流框架。
