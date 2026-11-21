# Always On

服务端支持邮箱、GitHub 和 Google 登录、Workspace 成员管理，以及从 Inbox 发起和继续工作。

## 目录与检查

- [应用目录、领域依赖与 ORM 归属](docs/adr/0001-repository-boundaries.md)
- [登录身份与 Workspace 成员权限](docs/adr/0002-workspace-membership.md)
- [持久 Inbox 与渠道入口](docs/adr/0003-durable-inbox.md)
- [工作归属与执行交接](docs/adr/0004-work-routing.md)
- [项目术语](GLOSSARY.md)

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 运行 Biome、TypeScript、依赖边界检查和单元测试。`pnpm test:integration` 使用 `TEST_DATABASE_URL` 在测试实例创建临时数据库，重放迁移、核对生成类型并验证服务端行为。测试连接需要建库权限。

## 服务端开发

参考 [.env.example](.env.example) 配置 `.env.local`。`BETTER_AUTH_SECRET` 可以用 `openssl rand -base64 32` 生成。现有进程环境变量优先于本地文件。生产通过部署平台注入配置。

```sh
pnpm --filter @always-on/server db:migrate
pnpm --filter @always-on/server dev
```

GitHub 和 Google 的回调地址分别是 `BETTER_AUTH_URL` 下的 `/api/auth/callback/github` 和 `/api/auth/callback/google`。配置 Resend 后可以注册和重置邮箱密码，也可以投递 Workspace 邀请。`GET /api/login-methods` 返回已配置的登录方式。

Workspace、成员和待处理邀请的列表默认返回 25 条，`limit` 可设为 1 到 100。把 `nextCursor` 作为下一次请求的 `cursor`，返回 `null` 时到达末页。

`POST /api/inbox/:workspaceId/messages` 接收包含 `clientMessageId` 和 `text` 的 JSON。客户端为每条消息生成 UUID，重试时复用。服务端持久化后返回 `202` 和 `eventId`。

在另一个终端用 `pnpm --filter @always-on/server start:worker` 启动 Inbox 消费进程。

- 消息携带 `"target": {"kind": "new_work"}` 时显式交办。携带 `"target": {"kind": "existing_work", "workId": "..."}` 时继续已有工作。
- `GET /api/work/:workspaceId/receipts/:eventId` 可以查看自己提交的事件归属。`GET /api/work/:workspaceId/:workId` 返回工作及当前进度。
- API 配置连接解析器后，`POST /api/work/:workspaceId/:workId/threads` 接收 `connectionId` 和 `conversationId`。之后所绑定讨论的签名 Webhook 事件会为同一项工作安排下一轮。

## 可观测性

API 以 JSON 将启动、停止和请求日志写到标准输出。请求响应带 `X-Request-Id`。日志包含路由模板、状态码、耗时、请求 ID 和 trace ID。API 接收 W3C `traceparent`，便于和上游串联排查。

设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 后，API 通过 OTLP HTTP/JSON 导出 Trace 和 `http.server.request.duration` 指标，例如使用 `http://localhost:4318` 连接 Collector。`OTEL_SERVICE_NAME` 默认是 `always-on-api`，`LOG_LEVEL` 默认是 `info`。日志由部署平台采集标准输出。指标按方法、路由模板和状态码统计。

## 修改表结构

```sh
pnpm --filter @always-on/server db:migration:create add-inbox
pnpm --filter @always-on/server db:migrate
pnpm --filter @always-on/server db:types
```

迁移文件使用 UTC 毫秒时间戳 `YYYYMMDDHHmmssSSS` 加描述。已执行的迁移保留原名。如果分支的未执行迁移早于已执行的迁移，重新对齐主分支后再给未执行的迁移生成新时间戳。提交迁移文件和生成的表类型文件。

## 开发资料

- [仓库约定](AGENTS.md)
- [TypeScript 代码规范](docs/typescript-style-guide.md)
- [代码范例](docs/code-examples.md)
- [代码审查经验](docs/code-review.md)
- [Lauren Tan 的工程环境与代码质量笔记](docs/research/lauren-tan-agent-trust.md)
- [Biome 规则](biome.json)和 [TypeScript 基础配置](tsconfig.base.json)
