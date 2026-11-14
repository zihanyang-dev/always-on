# ADR-0005：使用 Better Auth organization 管理协作身份与角色权限

状态：用户已确认采用 Better Auth；具体工作空间流程处于接入前设计阶段。日期：2026-11-15。

采用现有 Better Auth 的 organization 插件，复用组织、成员、邀请和角色检查；产品统一使用 Workspace 表达这一层协作空间。SDK 的 organization/member/invitation 与数据库中的工作空间记录是一套事实，不维护平行的团队、成员或角色存储。选择这一方式，是因为我们已经接入 Better Auth，而当前重点是完成团队身份和管理流程；单独引入 CASL 或 Casbin 仍需另外实现这些流程。

接受对插件公开协议和模型的依赖，集中维护 SDK 组装、字段映射与生命周期钩子。工作空间角色、资源可见性、执行工具审批分别有明确职责；具体业务的数据库查询和后台执行仍实施授权。首版使用固定角色，关闭动态角色和组织下属 Teams；资源授权按实际功能增长，不预建通用策略服务。完整范围、失败语义和接入验证见 [工作空间与授权方案](../workspaces-and-authorization.md)，证据与比较见 [调研记录](../research/teams-and-authorization.md)。

优先遵循官方 organization 流程和 hooks 扩展方式，保留 SDK 的创建与成员接口。隔离 SQLite 的失败注入与交错探针只作为版本观察，不足以决定替换实际 Drizzle/PG 配置中的官方流程。真实配置复核发现必要缺口时，先评估上游修复与公开扩展，再确定最小改动；不提前引入自定义创建接口或 Owner SQL 触发器。
