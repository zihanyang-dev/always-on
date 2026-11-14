# 任务与执行编排

后续拥有 Router 判断、长期任务、Run、Timers、审批与执行所有权。明确归属的输入直达已有任务；状态与待执行动作在 PG 同事务提交，再投递 BullMQ。

当前不包含假 Router 或 Agent Worker。system 中的诊断队列只验证基础设施，不执行产品任务。
