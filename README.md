# Always On

通用长期运行 Agent 平台的工程骨架。Web、API/Worker、CLI 共用明确的协议契约；产品状态保存在 PostgreSQL，BullMQ 负责后台任务，Redis Streams 负责实时事件。

## 本地启动

使用 `.node-version` 中的 Node 版本和 `package.json` 中锁定的 pnpm，准备可用的 Docker。

```sh
pnpm install --frozen-lockfile
pnpm init:local
pnpm infra:up
pnpm build
pnpm db:migrate
pnpm dev
```

Web：`http://localhost:5173`，API：`http://localhost:3001`。PG 使用 `15432`，Redis 使用 `16379`；不会复用现有项目的服务或数据卷。`infra:down` 停止本项目服务并保留卷。

`.env.example` 是本地后端配置说明，`.env.local` 保存实际值且不会提交。`init:local` 不覆盖现有文件。API/Worker 启动时各自解析所需配置；Web 通过同源 `/api` 获取白名单公开设置。

Web 使用 i18next / react-i18next 支持英文和简体中文。首次访问检测浏览器语言，其他语言回退为英文；页头可切换语言，选择保存在 `localStorage` 的 `always-on.language`。公共文案放在 `app/locales`，功能文案放在对应功能的 `locales`，翻译 key 由资源推导并接受 TypeScript 检查。

Docker Hub 不可达时，可在 `.env.local` 设置 `POSTGRES_IMAGE` / `REDIS_IMAGE`，例如 Google 官方镜像缓存中的 `mirror.gcr.io/library/postgres:17-alpine` 与 `mirror.gcr.io/library/redis:8-alpine`。更换镜像应保留对应服务的主版本与数据目录约定。

## 验证与 CLI

```sh
pnpm check
pnpm test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
pnpm cli status
pnpm cli agents --json
```

集成测试需要已迁移的 PG 和 Redis。浏览器测试自行启动 API 与 Web，使用独立测试进程；运行前释放本项目的 `3001` 和 `5173` 端口。CLI 命令使用已构建产物，修改后运行 `pnpm build`。

`pnpm check` 使用 Biome 和 TypeScript。生产代码的环境变量只能在配置入口读取；浏览器源码禁止导入 Node 运行时模块和 Agent 执行包。默认导出仅对框架配置文件开放。职责划分、注释准确性和函数可读性仍需人工审查，详见[本轮整理记录](docs/reviews/codebase-style-2026-11-15.md)。

`db:generate` 生成迁移；`db:migrate` 应用已提交迁移。生产迁移单独执行，API/Worker 启动不会抢跑迁移。CI 在 PR 和 push 时执行检查、单元测试、构建、真实基础设施测试与桌面/移动浏览器测试，不发布部署。

## 已实现与下一步

- 已实现：pnpm 工作区、严格 TS、Biome、独立环境解析、健康接口、公开配置、中英文 Web 页面、CLI 状态查询与本地程序检测。
- 已实现：Google/GitHub/邮箱密码认证后端、验证与重置邮件、持久登录会话、当前用户接口和 Redis 原子限流；登录前端尚未接入。
- 已实现：Workspace 后端、Owner/Admin/Member/Viewer、成员管理、邮箱邀请生命周期与跨空间授权，使用 Better Auth organization 的官方接口。并发与故障边界见[实现说明](docs/workspaces-and-authorization.md)。
- 已实现：Session 消息校验、PG 原子接收与并发去重；真实 BullMQ Agent Worker 和带过期时间的 Redis Streams。
- 已实现：云端 Agent/Session/Run、模型和推理强度选择、完整 Pi SDK、独立 E2B 沙箱、业务工具、原生会话接续、取消、PG 执行租约、Redis Streams/SSE 补流。M5 本机通过官方开源 E2B Embed + KVM 运行真实 Firecracker 沙箱；一期真实模型调用仅 DeepSeek。
- 尚未实现：登录及 Workspace 前端、Router、长期 Task、设备连接、Timers、跨会话 Memory 整理、审批、Outbox 和对象存储。执行边界与验证范围见[云端 Agent 后端](docs/cloud-agent.md)。

Session 消息接口在同一事务提交 Inbox、queued Run 和用户消息；后台扫描 PG 再唤醒 BullMQ。未配置云端执行能力时，Worker 直接退出，API 的认证和健康接口仍可使用。

## 文档

- [架构总览](docs/architecture.md)
- [目录与配置管理](docs/project-structure.md)
- [TypeScript 规范](docs/typescript-style-guide.md)
- [代码范例索引](docs/code-examples.md)
- [后端认证接入](docs/authentication.md)
- [工作空间与授权方案](docs/workspaces-and-authorization.md)
- [LobeHub 团队权限与 TS 授权调研](docs/research/teams-and-authorization.md)
- [云端 Agent 后端与 API](docs/cloud-agent.md)
- [本机 E2B Embed 部署](deploy/e2b/README.md)
- [沙箱研究](docs/research/sandbox-design.md)
- [Lauren Tan 演讲全程笔记与仓库应用](docs/research/lauren-tan-agent-trust.md)

`AGENTS.md` 保持简短，原始 TypeScript 指南保持完整。
