# 后端认证接入

已实现 Google、GitHub、邮箱密码登录，验证邮箱、找回密码、退出和当前用户查询。前端尚未增加登录页面。Workspace 与成员管理已在同一认证实例中接入，接口、角色与故障边界见 [工作空间与授权](workspaces-and-authorization.md)。

## 配置

API 启动时解析以下变量；Worker 和迁移命令不要求认证配置。

| 变量 | 用途 |
| --- | --- |
| `BETTER_AUTH_URL` | 对外认证地址，本地为 `http://localhost:3001`；生产必须使用 HTTPS |
| `BETTER_AUTH_SECRET` | 至少 32 字符的随机密钥；`pnpm init:local` 为新配置自动生成 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 成对配置后启用 Google |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 成对配置后启用 GitHub |
| `RESEND_API_KEY` | 配置后启用邮箱密码登录和认证邮件 |
| `EMAIL_FROM` | 发件人，默认 `Always On <onboarding@resend.dev>` |
| `REDIS_PREFIX` | API 限流与 Worker 使用的部署前缀 |

已保存的本地密钥放在 `.env.local`，不提交。`init:local` 不覆盖已有文件。未配置的 OAuth provider 不会注册；未配置 Resend 时，邮箱密码登录关闭。公开配置的 `authentication.methods` 返回实际启用的方法，不返回凭据。

OAuth 回调分别为：

```text
http://localhost:3001/api/auth/callback/google
http://localhost:3001/api/auth/callback/github
```

Resend 的 `resend.dev` 测试发件人只向 Resend 账号绑定的邮箱投递。正式向其他用户发信前，验证自己的发信域名并更新 `EMAIL_FROM`。当前邮件正文为英文。

## API

以下路径直接使用 Better Auth 的协议；请求和 Cookie 都由 SDK 解析。应用自己的用户资料入口只返回白名单字段。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/auth/sign-up/email` | 注册，字段为 `name`、`email`、`password` |
| POST | `/api/auth/sign-in/email` | 邮箱密码登录，邮箱必须已验证 |
| POST | `/api/auth/sign-in/social` | 开始 Google 或 GitHub OAuth |
| POST | `/api/auth/send-verification-email` | 重发验证邮件 |
| GET | `/api/auth/verify-email` | 使用邮件中的链接验证邮箱 |
| POST | `/api/auth/request-password-reset` | 请求密码重置邮件 |
| POST | `/api/auth/reset-password` | 使用邮件中的 token 和 `newPassword` 更新密码 |
| POST | `/api/auth/sign-out` | 退出并撤销当前会话 |
| POST | `/api/auth/link-social` | 登录后显式绑定另一个 OAuth 身份 |
| GET | `/api/me` | 当前用户；未登录返回 401；响应禁止缓存 |

密码至少 12 字符。验证和重置链接有效期为一小时。登录 Cookie 默认有效七天，按 SDK 的一天更新间隔续期。密码重置成功后，旧会话失效，重置 token 不能重复使用。

本地可以通过 API 客户端操作，不需要登录前端：

```sh
curl -i http://localhost:3001/api/auth/sign-up/email \
  -H 'Origin: http://localhost:3001' \
  -H 'Content-Type: application/json' \
  --data '{"name":"Your Name","email":"your-resend-account@example.com","password":"replace-with-a-long-password"}'

curl -i -c /tmp/always-on-cookies.txt \
  http://localhost:3001/api/auth/sign-in/email \
  -H 'Origin: http://localhost:3001' \
  -H 'Content-Type: application/json' \
  --data '{"email":"your-resend-account@example.com","password":"replace-with-a-long-password"}'

curl -b /tmp/always-on-cookies.txt http://localhost:3001/api/me
```

OAuth 的 `callbackURL` 可以先使用 `/api/me`。密码重置暂时通过 API 提交 token；对应表单随前端接入再实现。浏览器可信来源目前只有 `BETTER_AUTH_URL` 的 origin，后续接前端时再明确加入实际 origin。

## 数据与生命周期

`users` 是唯一用户身份。`auth_accounts` 关联密码或 OAuth 身份，`auth_sessions` 保存可撤销会话，`auth_verifications` 保存临时验证和 OAuth 状态。注册所需的关联写入由 Drizzle adapter 在事务中提交。

Redis 限流实现 SDK 的原子 consume 协议，避免并发请求绕过计数。来源检查和 CSRF 检查保持开启，连接地址覆盖客户端伪造的内部 IP 头。反向代理部署目前以代理 IP 计数，不能直接把任意 `X-Forwarded-For` 当作可信用户 IP。

API 关闭顺序为 HTTP、认证后台工作、Redis、PostgreSQL。认证邮件当前在进程内后台发送并等待正常收尾，尚无持久投递队列；进程异常退出或发送失败时，可通过重发接口重新申请。

## 验证

集成测试使用真实 PostgreSQL、Redis 和内存收件箱，不向真实用户发信。覆盖注册、密码哈希、验证前拒绝登录、验证后登录、退出、重置 token 单次使用、旧会话撤销、可信来源、OAuth 授权地址和并发限流。Resend 传输测试验证请求格式和错误脱敏。

2026-11-14 已在浏览器完成 Google 和 GitHub 的真实授权、回调、会话建立、`/api/me` 资料查询及退出验证。真实邮件投递尚未发信验证。

参考：[Better Auth Hono](https://better-auth.com/docs/integrations/hono)、[Drizzle adapter](https://better-auth.com/docs/adapters/drizzle)、[邮件](https://better-auth.com/docs/concepts/email)、[限流](https://better-auth.com/docs/concepts/rate-limit)。
