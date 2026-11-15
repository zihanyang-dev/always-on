# 会话与输入

拥有 Session、用户消息接收、持久展示快照、取消请求和 Redis Streams/SSE 订阅。store.ts 集中 Session 的访问、锁与配置规则，events.ts 管短期传输，stream.ts 管单个订阅生命周期。SDK 原始上下文不由消息表重建。

提交消息在一个事务创建 Inbox、queued Run 和用户消息，并推进展示版本。当前输入统一经过这个入口：重复来源身份返回原 Run，不同文本冲突；同一个来源身份可以独立用于不同 Session。

Session 当前仅创建者可访问，并要求最新 Workspace 权限。浏览器断开只释放订阅，取消需显式写入。快照/补流和合并规则见 docs/cloud-agent.md；Router、设备和渠道接入未实现。
