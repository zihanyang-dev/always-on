# 0003 持久 Inbox 与渠道入口

Work 域拥有 Inbox。用户入口通过 Access 校验 Workspace 的发消息权限，渠道适配器负责验签并从已配置的连接确定 Workspace。接收成功后可以确认投递，后续处理由消费者领取。 [GitHub Webhook 投递建议](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks) · [Standard Webhooks 规范](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)

去重键包含 Workspace、来源类型、来源实例和来源事件 ID。用户消息用用户 ID 和客户端消息 ID，渠道事件用连接 ID 和来源事件 ID。同一键和同样的事件内容返回原事件 ID，改用同一键提交不同内容会返回 `event_id_conflict`。渠道事件可以保留外部线程、回复位置和事件发生时间。 [幂等请求与重试](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)

消费者通过 `FOR UPDATE SKIP LOCKED` 批量领取。每次领取分配新的令牌，并将下次可领取时间推进到租约到期时间。完成和重试先锁行，再校验当前令牌和期限。进程中断后事件可以重新领取。消费者对处理过程中的外部副作用仍需做幂等。 [PostgreSQL 行锁](https://www.postgresql.org/docs/current/sql-select.html)

Inbox 提供用户消息 HTTP 接口，以及供消费者调用的领取、完成和重试操作。签名 Webhook 在集成测试中注入连接来验收。在实际配置了连接解析器的 API 实例中，Webhook 路由跟随连接启用。事件归属和执行交接由 Work 域持久化。 [工作归属与执行交接](0004-work-routing.md)
