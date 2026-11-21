# 0001 应用目录与服务端边界

状态为已采用。

## 目录

```text
apps/
  web/src/{app,features}/
  server/
    src/
      entrypoints/                 # API 与 Worker 的启动和依赖组装
      http/                        # 通用请求处理
      work/{inbox,routing,lifecycle,reminders}/
      execution/{runs,sessions,targets}/
      channels/{github,feishu,webhook,delivery}/
      access/{authentication,workspaces,approvals}/
      billing/
      infrastructure/database/     # 连接与事务能力
    migrations/
  cloud-runner/src/{pi,sandbox,session-storage}/
  device-connector/src/{connection,acp}/
packages/contracts/src/{http,execution}/
deploy/
tests/{integration,e2e}/
```

API 和 Worker 共同使用 `apps/server` 里的领域模块，两者可以分别启动。云端 Runner 和本机 Connector 独立运行，按 `contracts/execution` 与服务端通信。Web 使用 `contracts/http`。应用之间共享协议和校验规则，服务端写入留在拥有该状态的领域里。

## 领域依赖

API 与 Worker 入口负责组装。跨领域导入使用对方的 `index.ts`。

| 调用方 | 可依赖的领域 |
| --- | --- |
| `work` | `access` |
| `execution` | `access`、`billing` |
| `channels` | `access`、`work` |
| `billing` | `access` |

领域可以使用 `http` 和 `infrastructure`。`http` 可以使用 `infrastructure`。基础设施只提供底层能力，领域写入和判断由各自的公开操作表达。

服务端路由直接使用 Hono `Context` 和标准 `Response`。`http/` 统一应用错误的 JSON 形状、输入校验失败和请求体上限。各领域决定错误码对应的 HTTP 状态，成功响应由路由表达。`packages/contracts/http` 放 Web 和服务端共同使用的协议。

`work` 提交工作状态和待派发动作，Worker 读取动作并调用 `execution`。`execution` 提交 Run 结果和待处理记录，再由 Worker 交给 `work` 决定是否继续等待、完成或通知。

## 持久化

领域内的 `*-store.ts` 或 `persistence/` 存放 Kysely 查询、参数化 SQL、条件写入和事务。SQL 迁移定义表结构，`kysely-codegen` 从迁移后的 PostgreSQL 生成表类型。数据库基础设施集中在 `infrastructure/database/`。进程入口通过该目录的公开入口创建连接池，并在组装时将连接交给领域。

调用方使用有业务含义的操作，例如 `readSessionBinding()` 或 `commitRunCompletion()`。需要一并提交的 Run 终态和 Session 检查点由 `execution` 在同一个事务写入。跨领域查询通过状态所有者的公开操作。

`pnpm lint:boundaries` 校验 workspace 入口、跨领域导入、已登记的数据库依赖和数据库入口位置。检查覆盖普通导入、重导出、类型引用和字面量动态导入。新增数据库库依赖时，在同一改动内登记归属。业务表的写入责任、锁和重试语义由评审和行为测试验证。
