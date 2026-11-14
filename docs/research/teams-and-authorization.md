# LobeHub 团队权限与 TypeScript 授权方案调研

日期：2026-11-14 至 2026-11-15。本文记录源码证据与方案比较；产品方案见 [工作空间与授权](../workspaces-and-authorization.md)。

## 阅读范围与版本

LobeHub 本地阅读快照为 `11a57dc4c0f04a99441cdd1c883c86c5fc0cd74e`；另获取当次 canary HEAD `f2bf7560c0f9c353c8eb045c49c9453d5df16722`，使用 Git diff 确认下列授权核心实现未变化。此前的 Agent、沙箱阅读仍按各自原始版本记录。

完整阅读了与下述结论对应的角色常量、工作空间/成员/RBAC/资源授权 schema 与 model、资源授权 service 和 router、工作空间查询过滤、公开的业务路由占位实现及 OpenAPI 工作空间/权限中间件。交叉阅读选定的私有资源、协作者授权隔离和成员离开测试。未审计完整仓库，未访问 LobeHub 的私有云端实现，未运行其测试或复现云端行为。

最初按 Better Auth `1.7.23` 核对发布包并运行隔离 SQLite 探针。随后按用户要求补读官方组织实践、同版本组织和回滚测试、Hooks/数据库/Drizzle 文档及相关讨论，并将本仓库 Better Auth 与 Drizzle adapter 升至当次最新稳定版 `1.7.24`。Git diff 确认两个版本间本次涉及的组织插件实现与测试没有变化；尚未验证 organization 的 Drizzle/PostgreSQL 接入。

## 官方实践复核

官方维护了 [organization-best-practices](https://github.com/better-auth/skills/blob/20c9e88a5c007461a703f1c213572b073196113e/better-auth/organization/SKILL.md)，推荐以 organization/organizationClient、公开组织接口、角色和邀请配置完成接入。我们的服务器阶段先实现前者；前端接入时再使用对应 client plugin。

[Hooks 文档](https://www.better-auth.com/docs/concepts/hooks) 明确建议：调整已有端点时优先使用 hooks。因此撤回根据 SQLite 探针预先决定另写创建入口、禁用 SDK 创建与添加 SQL 触发器的方案。探针不能证明实际 Drizzle/PG 配置必须采用这些替代实现。

[Drizzle 文档](https://www.better-auth.com/docs/adapters/drizzle) 与 [数据库文档](https://www.better-auth.com/docs/concepts/database) 给出的路径是按插件配置生成 schema，再由 ORM 管理迁移。getMigrations/auth migrate 的内置适配器流程不能直接套用于 Drizzle。开启事务支持也不等于所有钩子、全部 HTTP 流程和外部邮件都是一个事务。

官方实践指南用于流程和职责参考，版本 API 仍需对照公开类型。该指南快照中的 hasPermission 字符串示例、嵌套 hooks 和部分分组配置名与本仓库版本的公开接口不同；实际接入采用组织插件文档中的 permissions 对象、success 响应及 organizationHooks，不能逐字复制概略示例。

另外阅读了官方 [组织钩子测试](https://github.com/better-auth/better-auth/blob/v1.7.24/packages/better-auth/src/plugins/organization/organization-hook.test.ts) 全文，和 [组织测试](https://github.com/better-auth/better-auth/blob/v1.7.24/packages/better-auth/src/plugins/organization/organization.test.ts) 中 Owner 保护、权限、私有扩展字段返回及级联失败回滚部分。这些测试明确了当前支持的正常用法；源码中部分旧注释不能取代断言和实际配置。

## 官方仓库讨论的证据等级

- [#3651](https://github.com/better-auth/better-auth/issues/3651) 是 1.3.4 的单 Owner 降权问题，已由维护者关闭；当前源码和官方测试已有相应检查。旧 Issue 下机器人的临时建议不作为今天另写政策的理由。
- [#4718](https://github.com/better-auth/better-auth/issues/4718)、[#7260](https://github.com/better-auth/better-auth/issues/7260) 涉及用户数据库钩子内创建组织的历史行为。当前官方已经有专门测试，不能据旧版讨论推断新版本一律不支持。
- [#12195](https://github.com/better-auth/better-auth/issues/12195) 和 [#11568](https://github.com/better-auth/better-auth/issues/11568) 讨论事务内的组织政策扩展，查询时为开放的社区提案，未见维护者确认的推荐实现。保留跟踪，不把提案中的 API 当作已发布功能。
- [1.7.24 发布说明](https://github.com/better-auth/better-auth/releases/tag/v1.7.24) 未说明组织流程改动；本次涉及的组织源码与测试也没有版本差异。升级不等于这些隔离观察已被修复。

## LobeHub 的实际模型

| 职责 | 公开源码中的实现 |
| --- | --- |
| 协作空间 | `workspaces`，含 `primaryOwnerId` |
| 人类成员 | `workspace_members`，角色为 owner/admin/member/viewer，支持软删除 |
| 邀请 | `workspace_invitations`，包含状态、过期时间与可复用邀请链接 |
| 空间内分组 | `workspace_teams` 与成员表；源码明确目前是组织分组，尚不作为权限隔离范围 |
| 角色能力 | `WORKSPACE_ROLE_PERMISSIONS` 固定代码表；成员角色由数据库记录提供 |
| 具体资源授权 | 资源自己的 visibility，加 `resource_permissions` 的空间默认级别和单成员授权 |

因此，LobeHub 中的 Workspace、空间内 Team、多个 Agent 的协作组是不同概念。我们当前所说的人类团队，对应它的 Workspace。参见 [工作空间 schema](https://github.com/lobehub/lobehub/blob/f2bf7560c0f9c353c8eb045c49c9453d5df16722/packages/database/src/schemas/workspace.ts)。

### 固定角色仍然可以表达明确的权限

当前工作空间内置角色由 `workspace_members.role` 展开为固定权限集合；并非每创建一个空间就复制一套角色与权限关联记录。公开仓库仍有通用 RBAC 表和全局授权查询，两者不能混为一谈；部分“每个空间初始化角色”的源码注释也与当前创建流程不一致，应以实际写入和查询为准。

权限码区分操作与作用范围，例如 `agent:update:owner` 与 `agent:update:all`。这里的 `owner` scope 表示资源创建者范围，区别于工作空间 Owner 角色。Viewer 没有模型调用和写入权限；“只读用户仍能运行模型”不成立。参见 [角色矩阵](https://github.com/lobehub/lobehub/blob/f2bf7560c0f9c353c8eb045c49c9453d5df16722/packages/const/src/rbac.ts)、[权限解析](https://github.com/lobehub/lobehub/blob/f2bf7560c0f9c353c8eb045c49c9453d5df16722/packages/database/src/models/rbac.ts)。

### 角色能力与具体资源权限共同生效

资源判断先检查工作空间，再检查私有可见性，然后检查角色能力，最后按操作和资源级别判定。Agent 支持 view/use/edit；资源授权管理、删除、转移、改变可见性有独立规则。创建者或相应管理者可能越过共享资源的普通访问级别，但不能因此穿透私有资源限制。

授权表的空间级记录与单成员记录分别具有部分唯一索引。单成员授权用于提升共享资源的访问级别，不跨工作空间、不打开私有资源，也不突破角色的能力上限。知识库的级别另有业务语义：use 允许挂载检索，而浏览内部文件列表需要 edit；不能把所有资源机械套用同一种“大小等级”。参见 [资源 schema](https://github.com/lobehub/lobehub/blob/f2bf7560c0f9c353c8eb045c49c9453d5df16722/packages/database/src/schemas/resourcePermission.ts)、[资源判定](https://github.com/lobehub/lobehub/blob/f2bf7560c0f9c353c8eb045c49c9453d5df16722/apps/server/src/services/resourcePermission/index.ts)。

### 撤销成员身份必须处理已有授权

公开的成员移除实现，在事务中软删除成员并清理其资源授权、分组归属与任务分配；授予协作者权限时锁定相同成员行，避免离开与授权并发后遗留可恢复的旧权限。设备清理另有处理步骤，不能将整个移除流程都描述为同一个事务。成员重新加入不自动恢复此前的单资源授权。参见 [成员实现](https://github.com/lobehub/lobehub/blob/f2bf7560c0f9c353c8eb045c49c9453d5df16722/packages/database/src/models/workspaceMember.ts)。

### 公开仓库有真实实现，也有云端占位

公开的 `withRbacPermission`、`withScopedPermission` 和部分 workspace 角色中间件直接继续请求；workspace 创建/邀请路由也有返回空结果或 NOT_IMPLEMENTED 的占位。它们用于被云端实现覆盖，不能当作完整授权拦截器复制。另一方面，公开的资源判定、数据查询过滤和 OpenAPI 中间件包含真实检查，不能反过来说整个公开仓库都没有授权。

证据：[RBAC 中间件占位](https://github.com/lobehub/lobehub/blob/f2bf7560c0f9c353c8eb045c49c9453d5df16722/packages/business-server/src/trpc-middlewares/rbacPermission.ts)、[工作空间角色占位](https://github.com/lobehub/lobehub/blob/f2bf7560c0f9c353c8eb045c49c9453d5df16722/packages/business-server/src/trpc-middlewares/workspaceAuth.ts)、[OpenAPI 工作空间检查](https://github.com/lobehub/lobehub/blob/f2bf7560c0f9c353c8eb045c49c9453d5df16722/packages/openapi/src/middleware/workspace.ts)。

## TypeScript 方案比较

不存在覆盖整个 TS 生态的可靠生产采用率排名。2026-11-07 至 2026-11-13 的 npm 官方下载统计中，`@casl/ability` 为 2,611,295，`casbin` 为 255,004，`accesscontrol` 为 88,787。下载量包括自动化和间接依赖，只用作候选间的采用线索。

2026-11-14 查询 registry 时 latest 分别为 CASL 7.1.3、casbin 5.51.1、accesscontrol 3.1.1。GitHub 对应 CASL 与 Node Casbin 仓库约 7,117 与 2,921 stars；不能把其他语言的 Casbin 主仓库 stars 当成 Node 包采用率。

统计：[CASL](https://api.npmjs.org/downloads/point/2026-11-07:2026-11-13/@casl/ability)、[casbin](https://api.npmjs.org/downloads/point/2026-11-07:2026-11-13/casbin)、[accesscontrol](https://api.npmjs.org/downloads/point/2026-11-07:2026-11-13/accesscontrol)。

| 方案 | 擅长的职责 | 对本项目的意义 |
| --- | --- | --- |
| CASL | 进程内的操作、对象属性与字段级条件判定；支持前后端使用 | 通用 TS 资源授权库的优先候选；本身不提供团队邀请和成员流程 |
| Node Casbin | 策略模型、角色关系、租户 domain、持久策略与多节点同步扩展 | 适合较复杂或跨语言的集中策略；需要维护额外策略及其加载/同步 |
| Better Auth organization | 登录身份上的组织、成员、邀请、角色及 resource/action 权限 | 与现有认证直接衔接，当前团队模块优先复用 |
| accesscontrol | 角色、资源、操作和 own/any 范围的授权表达 | 可作较简单 RBAC/属性授权候选，本次不新增第二套权限库 |

CASL 实现的不止角色查表，也支持按对象属性和字段判定。其当前官方集成包包含 Prisma、Mongoose 等；本次未发现官方 Drizzle adapter。使用 CASL 不会自动为我们的 Drizzle 查询补齐条件。参见 [CASL 指南](https://casl.js.org/v7/en/guide/intro/)、[官方包目录](https://github.com/stalniy/casl/tree/main/packages)。

Casbin 支持让同一用户在不同租户拥有不同角色；其持久化与多节点一致性通过相应适配和同步机制处理。参见 [Node Casbin](https://github.com/apache/casbin-node-casbin)、[租户 domain](https://casbin.apache.org/docs/rbac-with-domains/)。

## Better Auth 能力与边界

organization 提供 owner/admin/member 三种默认角色，可以增加 viewer，使用静态 permission statements 定义资源和操作。也支持多个角色、可选的数据库动态角色和组织下属 Teams。成员、邀请、角色变更、权限查询与生命周期钩子均有公开入口。[官方 organization 文档](https://www.better-auth.com/docs/plugins/organization)。

SDK 的 permission statements 表达“可对这种资源执行哪些操作”，不直接表达“仅可修改创建者为自己的这一条 Agent”。自有路由、数据库查询、后台任务、设备指令和工具执行都需要在真实操作处实施相应判定。前端的静态角色检查只用于交互展示。

### 已核对的 SDK 细节

- 自定义已有角色会覆盖其默认权限，需要在一个明确位置组合既有组织管理权限和应用新增权限。
- 默认允许多个 Owner，并检查最后一个 Owner 的退出或降权；这不等同于 LobeHub 的唯一 primaryOwner 模型，也不能仅凭检查代码宣称所有并发条件下都能保留一个 Owner。
- 邀请接受校验登录用户邮箱，并可显式要求邮箱已验证；首版应启用 `requireEmailVerificationOnInvitation`。
- 邀请接受使用 pending 到 accepted 的条件状态更新，再执行成员创建等事务操作；遇到可捕获失败会尝试恢复 pending。状态领取和成员事务不是一个完整的原子提交，进程崩溃窗口必须另行验证与定义恢复。
- 创建组织与创建初始 Owner 在路由中是连续步骤；不能把 adapter 的 transaction 选项视为整个组织流程的事务保证。
- 邀请邮件经已有后台任务机制发送；创建邀请成功不代表邮件已经投递。组织插件要求应用自行构造邀请落地链接。

以上来自发布包的 `plugins/access/access.mjs`、`plugins/organization/{has-permission,organization,adapter}.mjs`、`routes/{crud-org,crud-members,crud-invites}.mjs` 的相应调用路径。公开版本源代码可见 [访问控制](https://github.com/better-auth/better-auth/blob/v1.7.24/packages/better-auth/src/plugins/access/access.ts)、[组织入口](https://github.com/better-auth/better-auth/blob/v1.7.24/packages/better-auth/src/plugins/organization/organization.ts)、[邀请流程](https://github.com/better-auth/better-auth/blob/v1.7.24/packages/better-auth/src/plugins/organization/routes/crud-invites.ts)、[成员流程](https://github.com/better-auth/better-auth/blob/v1.7.24/packages/better-auth/src/plugins/organization/routes/crud-members.ts)。

### 隔离 SQL 验证结果

2026-11-15 新增 tests/sdk/better-auth-organization.test.ts，使用 SDK 公开测试工具及独立内存 SQLite 数据库；不访问本项目 PG、Redis、真实用户或邮件服务。SDK 工具在用例结束后关闭数据库，快速测试密码散列仅用于 SDK 测试。该文件纳入 pnpm test 与现有 CI。

五个用例已在 1.7.23 与升级后的 1.7.24 上通过，记录的是以下测试配置下的行为；第 3/4 项需要实际 Drizzle/PG 复核，第 5 项首先是产品语义选择：

1. 已授权组织的能力检查正常；拒绝角色能力时 HTTP 为 200、success 为 false；指定非成员组织时拒绝。
2. 已启用的邮箱验证要求阻止未验证收件人；验证后可接受邀请，再次接受拒绝，成员只有一条。
3. 初始 Owner 的 beforeAddMember 钩子抛错后，创建返回 500，但组织记录保留、成员为空。
4. 用公开 beforeRemoveMember 钩子设置并发屏障，让两个 Owner 都完成先前的计数检查后互相移除；两个请求均成功，组织不剩成员。
5. 邀请者被另一位 Owner 移除后，已验证的收件人仍能接受此前发出的邀请。这体现邀请按组织授权、状态与有效期继续存在的默认语义；“离任即撤销”属于额外产品政策，当前不擅自增加。

这些验证说明指定版本、指定 SQL adapter 和钩子配置下的观察，不能替代 Drizzle/PG 的配置和故障测试，也不能据此决定加触发器或替换官方接口。第 3 项采用注入钩子失败，第 4 项采用确定性的交错顺序；未模拟真实进程崩溃或开展线上漏洞验证。它们是升级复核的观察记录，不是希望应用长期维持的失败行为。

1.7.24 升级后，仓库类型/lint 检查、28 项单元与 SDK 测试、10 项现有 PG/Redis 集成测试通过。现有集成测试覆盖已实现的登录和基础设施，不代表 organization 的 PG 接入已完成。

## 本轮结论

用户已确认使用 Better Auth。先完成工作空间身份、成员和固定角色；资源权限随对应业务实现。当前不增加 CASL、Casbin、外部权限服务或动态权限编辑器。保留 CASL 作为出现复杂资源条件后的候选，不预建替换层。

LobeHub 最值得复用的是“成员身份、角色能力、资源授权分别明确；后端和实际操作处执行检查”的设计。它的云端覆盖结构、历史兼容分支与全部资源授权特例，不作为本项目的初始结构。
