# 会话与输入

拥有 Session、用户消息接收、私有会话列表、历史分页、取消请求和 Redis Streams/SSE 订阅。SDK 原始上下文不由消息表重建。

store.ts 集中写入事务、去重和配置规则；access.ts 集中私有归属、当前成员权限与事务锁。queries.ts 负责列表、历史窗口和展示状态选择，records.ts 负责存储记录到公开 Session/Run 的转换。events.ts 管短期传输，stream.ts 管单个订阅生命周期。

提交消息在一个事务创建 Inbox、queued Run 和用户消息，并推进展示版本。当前输入统一经过这个入口：重复来源身份返回原 Run，不同文本冲突；同一个来源身份可以独立用于不同 Session。

列表按创建时间和 ID 倒序；历史向前翻页，每页消息按 position 升序。两者默认 50 条、最多 100 条，游标限定在当前用户及资源范围。HTTP/SSE 快照返回最近 50 条与旧历史游标；客户端按 ID 合并并保留已加载内容。

Session 当前仅创建者可访问，并要求最新 Workspace 权限。浏览器断开只释放订阅，取消需显式写入。接口、快照/补流和合并规则见 [云端 Agent 后端](../../../../docs/cloud-agent.md)；Router、设备和渠道接入未实现。
