# 部署入口

当前 compose.yaml 提供独立的本地 PostgreSQL 与 Redis。数据使用命名卷，端口仅绑定 127.0.0.1；开发凭据不能直接用于公网部署。

API 与 Worker 共用 server 构建，通过 start:api / start:worker 启动，部署系统注入环境变量。Web 构建产物在 apps/web/dist，由静态服务器提供并将 /api 代理到 API。发布前由独立步骤运行数据库迁移。

认证、生产镜像、对象存储与云端 sandbox 尚未实现；不将开发 Compose 描述为完整的生产部署。
