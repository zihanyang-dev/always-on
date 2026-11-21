# 0002 登录身份与 Workspace 成员权限

状态为已采用。

Better Auth 管理用户、登录账号和登录会话。Workspace 通过用户 ID 引用用户，在 `workspace_members` 中保存角色。每个 `(workspace_id, user_id)` 对应一条成员记录。角色变更从数据库读取，登录会话继续代表用户身份。Better Auth 组织插件包含自己的组织和成员接口。当前由 `access/workspaces` 直接拥有成员记录和事务，后续 Work 和 Execution 通过 `access` 的公开入口使用这些权限。 [Better Auth 用户和账号](https://better-auth.com/docs/concepts/users-accounts) · [Better Auth 组织插件](https://better-auth.com/docs/plugins/organization)

LobeHub 也用 `(workspace_id, user_id)` 标识成员记录，并在关系库中对成员变更加锁。它还为订阅和支付指定唯一主 Owner。Always On 允许多个 Owner，同时保证至少一位 Owner 可以继续管理 Workspace。创建 Workspace 与创建其首位 Owner 同时提交。 [LobeHub 表结构](https://github.com/lobehub/lobehub/blob/c4895b461c6f7de7baed1a70ba4eedc9a16cb342/packages/database/src/schemas/workspace.ts) · [LobeHub 成员操作](https://github.com/lobehub/lobehub/blob/c4895b461c6f7de7baed1a70ba4eedc9a16cb342/packages/database/src/models/workspaceMember.ts) · [GitHub 所有权连续性](https://docs.github.com/en/organizations/managing-peoples-access-to-your-organization-with-roles/maintaining-ownership-continuity-for-your-organization)

| 操作 | Owner | Admin | Member | Viewer |
| --- | --- | --- | --- | --- |
| 查看当前 Workspace 和成员 | 可 | 可 | 可 | 可 |
| 改名、发出和取消邀请 | 可 | 可 |  |  |
| 将成员调整为 Member 或 Viewer，或移除成员 | 可 | 目标为 Member 或 Viewer 时可 |  |  |
| 授予或移除 Owner、Admin 角色 | 可 |  |  |  |
| 主动退出 | 保留其他 Owner 时可 | 可 | 可 | 可 |

邀请只授予 Member 或 Viewer，七天有效。收件人使用对应的已验证邮箱查看、接受或拒绝。接受邀请与创建成员记录在同一个事务内完成。重发会让先前的待处理链接失效。 [GitHub 邮箱邀请语义](https://docs.github.com/en/organizations/managing-membership-in-your-organization/inviting-users-to-join-your-organization)

涉及权限变更的操作先锁住 Workspace，再以 `READ COMMITTED` 读取成员角色或邀请状态。撤权提交后，排队中的请求能看到新的角色。并发退出由同一行锁排序，最后一位 Owner 的退出会返回 `last_owner`。外部非成员读写返回 `404`，权限不足的成员返回 `403`。 [PostgreSQL 事务隔离](https://www.postgresql.org/docs/current/transaction-iso.html)
