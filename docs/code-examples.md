# 代码范例索引

按正在修改的职责选择范例，先读入口，再读相关实现、调用处和测试。这里参考的是职责划分、阅读顺序与资源归属，具体行为仍由当前需求和 [TypeScript 规范](typescript-style-guide.md) 决定。

链接直接指向维护中的源码；跨功能调用仍通过对应模块的公开入口。修改范例时同步核对说明，替换旧实现时更新索引。

## HTTP 路由：注册与处理分开阅读

阅读 [agents/routes.ts](../apps/server/src/agents/routes.ts) 的 `createAgentRoutes`，以及其中的 `list`、`create`。

路由注册集中展示方法、路径和校验器；具名处理函数放在主流程之后，捕获当前依赖。处理函数按解析输入、调用应用操作、映射 HTTP 结果展开。事务和授权规则由被调用模块负责。

适合普通请求与响应路由。流订阅有独立生命周期，不能直接套用普通请求的结束规则。

验证参考：[execution.test.ts](../tests/integration/execution.test.ts) 中的真实认证与受保护端点用例，以及 [agents.test.ts](../tests/integration/agents.test.ts) 中的可见性和权限用例。

## 数据库事务：入口拥有完整接收规则

阅读 [sessions/store.ts](../apps/server/src/sessions/store.ts) 的 `submitSessionMessage`，连同 `readSessionAccess`、`readRepeatedSubmission` 和 `recordSessionInput`；调用处是 [sessions/routes.ts](../apps/server/src/sessions/routes.ts) 的 `submit`。

入口明确事务范围，具名事务操作按权限与锁、重复输入、恢复阻断、原子写入展开。重复输入先于恢复阻断判断，保证重试仍能返回原 Run。Inbox、Run、用户消息和展示版本一起提交，路由无需协调表和锁的顺序。

辅助函数按完整职责提取；决定事务语义的检查顺序仍在主流程可见。新业务应根据自身一致性要求确定事务与锁范围。

验证参考：[agents.test.ts](../tests/integration/agents.test.ts) 的并发去重、跨 Session 来源隔离及配置快照用例。

## 有状态资源：执行编排与所有权维护各有归属

阅读 [tasks/execute.ts](../apps/server/src/tasks/execute.ts) 的 `executeQueuedRun` 和 `RunControl`；调用处是 [tasks/worker.ts](../apps/server/src/tasks/worker.ts) 的 `processRun`。

入口按领取、执行、收尾、最终提交展开。`RunControl` 集中维护租约轮询、取消信号和轮询失败，调用者只在执行结束后读取一次失败结果。词法作用域明确租约维护的结束位置：执行函数完成 SDK/沙箱收尾后，才停止续约并判断最终提交。

使用 class 的理由是关联状态与生命周期需要共同维护。无状态转换使用函数；小范围状态也可以由闭包维护。

验证参考：[execution.test.ts](../tests/integration/execution.test.ts) 的真实 Worker 执行与显式取消用例，以及 [agents.test.ts](../tests/integration/agents.test.ts) 的 owner 过期隔离和取消竞态用例。

## SDK 事件：按协议层级解释，保持转换职责单一

阅读 [pi/events.ts](../packages/agent-runtime/src/pi/events.ts) 的 `createSessionObserver`、`mapSessionEvent`、`mapMessage` 和 `mapTextDelta`；调用处是 [pi/execute.ts](../packages/agent-runtime/src/pi/execute.ts) 中的 SDK 订阅。

每次执行的消息序号由一个闭包维护。顶层分派只解释 Session 事件；消息和文本增量各自处理相关载荷。显式列出忽略的 SDK 事件并保留穷尽检查，让 SDK 类型变化触发重新审查。

转换模块不负责持久化、异步交付确认或 SDK 停止；这些职责由调用处的执行资源对象维护。接入其他 SDK 时需重新确认其通知和取消语义。

验证参考：[pi.test.ts](../tests/sdk/pi.test.ts) 的原生流映射、取消时未完成消息、失败确认和最终事件确认用例。

## 配置解析：输入边界与优先级集中维护

阅读 [CLI config.ts](../apps/cli/src/config.ts) 的 `loadCliConfig`、`readPreferences` 和 `getConfigDirectory`；调用处是 [CLI bootstrap.ts](../apps/cli/src/bootstrap.ts)。

环境与 JSON 在入口解析，类型从 schema 推导；环境、平台和主目录由调用处传入。配置优先级在一个位置表达，目录规则和文件读取各自集中。默认配置文件不存在是预期情况，显式指定文件缺失或内容无效会保留原因并报错。

这个范例处理非敏感 CLI 偏好。服务端凭据仍由相应启动配置解析，不能沿用用户偏好的缺省规则。

验证参考：[config.test.ts](../apps/cli/src/config.test.ts) 的配置优先级、显式文件缺失及本地探测配置独立性用例。

## 交付前再读一遍

从实际调用处进入，核对新增抽象是否减少了调用者必须理解的知识，逻辑段落是否清楚，注释是否准确解释约束。正确性与可读性分别验收，并完成与改动相关的验证及废弃路径清理。
