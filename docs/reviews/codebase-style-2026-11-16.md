# 全仓代码品味与正确性审查

日期：2026-11-16。基线：2c1041d。

重新阅读 AGENTS.md、完整 TypeScript 规范和代码范例，从实际调用处核对职责、状态、资源所有者、事务范围、失败方式、类型边界、逻辑段落和注释。对照 pexo-agent-refactor 的 Harness 执行与会话实现，参考其清楚的主线和资源归属；不照搬 SDK 或增加本仓库尚未需要的抽象。

## 范围

审查全部第一方 TS/TSX，包括 CLI、API/Worker、Workspace、Agent、Session、执行所有权、Pi、E2B、基础设施、契约、既有 Web/i18n、内部辅助函数和测试。另检查初始化脚本、包入口、TS/Biome/测试配置、CI、CSS/HTML/翻译、九份 SQL 迁移和 Better Auth 版本补丁。生成产物、依赖和上游参考项目不作为第一方修改范围。

## 已修复的问题

### P2：过期清理尝试覆盖新尝试的进度

Session 删除允许对相同不可复用身份重复释放资源，但失败记录和取消后的重排原来只检查 Session ID 与 deleting 状态。旧尝试超时后，新尝试已经开始，旧失败仍能覆盖新尝试的期限和错误码。

真实 PostgreSQL 回归先复现了这一行为：第二次尝试仍在运行时，第一次尝试的失败把约 60 秒期限缩短到约 2 秒，并写入旧错误。现使用已有 cleanupAttempts 约束两处进度更新；无需新表、令牌或租约框架。成功释放相同资源的旧尝试仍可幂等最终提交。领取只返回后续实际需要的 sandboxId 和尝试次数。

对应实现：[sessions/deletion.ts](../../apps/server/src/sessions/deletion.ts)。回归：[lifecycle.test.ts](../../tests/integration/lifecycle.test.ts)。

### P2：创建 Agent 与删除 Workspace 并发时返回基础设施错误

Agent 创建原先先锁成员，再通过插入获取 Workspace 外键锁；SDK 删除先锁 Workspace，再检查资源和删除成员。受控锁等待回归复现了删除检查后 Agent 仍可提交的时序：数据被外键保护，但删除返回 500，而非业务冲突。

创建现先在事务内对 Workspace 取共享行锁，再锁成员并插入。创建先完成时删除读取到 Agent 并返回 409；删除先完成时创建返回资源不可用。共享锁允许多个创建并行，并阻止同一行的更新和删除；依据 [PostgreSQL 17 官方行锁规则](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS)。两个先后顺序均由真实 PG 回归保护，测试按连接的锁等待链控制时序，不依赖 sleep。

对应实现：[agents/store.ts](../../apps/server/src/agents/store.ts)。回归：[agents.test.ts](../../tests/integration/agents.test.ts)。

### P3：同类型位置参数与过时说明

Session 存储路径与 Redis 游标比较的内部接口改用具名对象参数。路径变量明确区分 sessionDirectory 和 runDirectory，调用处可直接看出根目录、身份和边界，减少参数传反的风险。

Worker 的资源等待只关心 Promise 的生命周期，不检查执行结果。移除其不必要的 RunCompletion | void 泛型约束及类型导入，保留输入与输出的类型关系，消除 Biome 的 noConfusingVoidType 警告；没有将 Promise<void> 强行断言为 Promise<undefined>。

范例索引改为现有 Worker 的 processJob / executeRun，并补充资源收尾与队列传输收尾的区别。Workspace 和云端文档同步更新并发与清理约束，移除仍把 Agent 接入描述为下一步的过时说明。

## 保留的设计

事务继续由对应功能存储模块集中维护，路由只解析输入并映射结果。Pi 原生恢复格式由 Pi 模块解释，平台保存不透明引用；Runner 与 E2B 保持独立。执行资源对象继续拥有取消、订阅及待确认事件，Worker 关闭先等待资源，再处理有期限的队列传输。

本轮未发现仍需删除的旧执行分支；未新增兼容兜底，也未为相似 SQL、测试控制步骤或文件行数另建通用框架。源码注释解释新增的锁顺序、尝试归属与等待约束。TypeScript 指南原文和简短 AGENTS.md 保持不变。

将现有 Biome 的 [noConfusingVoidType 官方规则](https://biomejs.dev/linter/rules/no-confusing-void-type/javascript/)从默认警告提升为错误。实际临时文件证明 string | void 约束会以错误退出，而回调的 () => void 和 Promise<void> 允许通过；验证后删除了探针。两处竞态依赖跨请求状态和数据库时序，用行为回归保护；具名参数按规范人工评审。未引入其他 lint 引擎、括号计数、注释配额或正则 lint。

## 验证

| 检查 | 结果 |
| --- | --- |
| pnpm check | Biome 无警告；应用/共享包/测试的严格 TS 检查通过 |
| pnpm test | 48 个单元及受控 SDK 用例通过 |
| pnpm test:integration | 89 个真实 PG/Redis 用例通过，包含新增的 3 个并发回归 |
| pnpm test:sandbox | 10 个真实 E2B 用例通过 |
| pnpm test:cloud | 3 个真实 DeepSeek/E2B 用例通过，包含删除 Worker 和全部会话文件回收 |
| pnpm build | 所有应用与共享包构建通过 |
| pnpm test:e2e | 桌面和移动视口 14 个用例通过 |
| pnpm db:generate | 无 schema 漂移；九份已提交迁移未改动 |

真实模型验证覆盖 DeepSeek；第二个 Provider 使用受控 HTTP SDK 回归验证，未据此声称完成所有 Provider 的真实调用验证。
