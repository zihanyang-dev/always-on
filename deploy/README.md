# 部署入口

当前 compose.yaml 提供独立的本地 PostgreSQL 与 Redis。数据使用命名卷，端口仅绑定 127.0.0.1；开发凭据不能直接用于公网部署。

云端 Agent 的本地执行环境使用 [E2B Embed](e2b/README.md)，在独立的 Colima 虚拟机运行官方开源部署，与应用数据库和 Redis 分开管理。

API 与 Worker 共用 server 构建，通过 start:api / start:worker 启动，部署系统注入环境变量。Web 构建产物在 apps/web/dist，由静态服务器提供并将 /api 代理到 API。发布前由独立步骤运行数据库迁移。

认证已接入 Better Auth；生产镜像、对象存储与完整云端部署仍待交付，不将开发 Compose 描述为完整的生产部署。
