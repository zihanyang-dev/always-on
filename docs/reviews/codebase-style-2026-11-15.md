# 全仓代码审查与整理

日期：2026-11-15。首轮审查对应提交 29a059e；后续整理在文末单列。

按根目录 AGENTS.md 重读完整 TypeScript 规范，并对照 `/Users/zane/Dev/pexo-agent-refactor/agent/src/harness/openai/execute.ts`、Session 资源对象和 PostgreSQL admission 的写法。参考重点是清楚的执行主线、明确的资源所有者和逻辑段落，具体实现仍遵守本仓库规范。

## 审查范围

阅读全文检查 apps、packages、tests 下的 110 个 TS/TSX 文件，包括具名导出、类型声明、回调、内部辅助函数、测试和功能入口。另检查根目录的五个 TS 测试配置、tsconfig、Biome、包入口、CI、初始化脚本、现有 CSS/HTML、七份 SQL 迁移和 Better Auth 补丁。生成产物、依赖目录及上游参考源码不作为第一方代码修改。

| 范围 | TS/TSX 文件数 | 重点 |
| --- | ---: | --- |
| apps/cli | 7 | 命令分派、配置优先级、本机探测和错误出口 |
| apps/server | 60 | HTTP 输入、事务、授权、执行、流、资源释放及相邻测试 |
| apps/web | 10 | 既有初始化页、查询、i18n、错误处理及构建配置 |
| packages/contracts | 6 | 状态联合、边界解析、公开白名单和唯一类型来源 |
| packages/agent-runtime | 14 | Pi 公开扩展点、会话恢复、事件确认和远端工具 |
| tests | 13 | 真实 SDK/PG/Redis、HTTP、故障时序和夹具清理 |

审查逐项确认职责、输入输出、状态和资源所有者、失败语义、调用者必须知道的顺序，以及函数内部能否顺着主线阅读。自动扫描只辅助查找嵌套、断言、缺失返回类型和相对导入环；通过编译或扫描不等于通过这些判断。

## 具体调整

### 路由直接注册具名处理函数

Agent 和 Session 路由集中展示方法、路径和校验器，随后是处于同一层级的处理函数。删除 Session 的中间 handler 工厂、嵌套订阅工厂及其返回对象。

`AuthenticatedContext` 只绑定 Hono 的认证状态和已校验输入。各处理函数的输入从实际 schema 推导，不手写平行 DTO，不使用断言。HTTP 流的失败报告和取消继续由 stream.ts 管理。

### 事务使用具名操作

Session、Agent 和 Run 的较长事务体改为具名操作，函数签名明确使用 DatabaseTransaction。入口直接声明事务边界，操作内按授权、读取或判定、写入、返回分段。

Session 的重复输入、配置快照、恢复阻断和原子写入仍集中维护。没有按查询或执行阶段分出多套仓储文件，也没有把锁和写入顺序交给路由协调。

用户此前报告的 transaction 隐式 any 在当前 TypeScript 7.0.2 编译及语言服务检查中未复现。六个 Session 事务现在均有明确的操作参数类型；没有通过 any、类型断言、关闭检查或更改编辑器全局设置隐藏诊断。

### 集中当前执行授权

ownership.ts 的 readRunAuthority 集中当前 Agent 权限、取消状态和有效租约的判定，读工具、工具意图和最终提交复用同一规则。删除 store.ts 内重复判定和仅做转换的中间函数。

权限读取可能等待行锁，因此租约检查放在权限读取之后。已经观察到的消息、工具回执和环境绑定继续使用 requireOwnership；权限撤销不能抹掉已经发生的事实。最终状态写入仍再次使用 owner token 和数据库时钟条件，未知工具回执仍阻止自动重跑。

新增真实 PG 用例：持有 Agent 锁，让工具准入等待；在释放锁前使租约过期。等待结束后必须拒绝准入，且不能留下工具意图。测试等待真实阻塞关系，不靠固定 sleep 猜测时序，并在断言前释放锁、等待两边请求结束。

### 减少配置和资源组装的层次

API 启动时分别构造鉴权配置与 Workspace 插件，再组装 SDK；Worker 先绑定本次云端执行依赖，注册处只传入 claim 和 context。Pi Session 设置和 Sandbox 元数据使用有含义的局部对象，减少多层对象收尾。

Pi 的停止 Promise 使用同一处幂等初始化。Shell 大输出的 structuredContent 转换在返回对象之前完成。删除测试中只转发 dispose 的包装；迁移入口直接使用 import.meta.dirname。

### 整理函数内部段落和测试资源

按输入判定、资源准备、执行、提交及结果分隔逻辑段落。英文注释解释锁等待后的租约检查、确认边界、凭据隔离和清理顺序；简单转换保留直接表达，不添加复述代码的注释。

SSE 测试订阅移为独立资源工厂，拥有读取缓冲、取消和 reader 释放，避免塞在会话夹具的内部函数里。鉴权夹具核对收集到的依赖错误；测试主动触发的 SDK 错误必须显式核销，收尾时不再默默丢掉其余错误。

## 复审保留的取舍

- Session 的访问、配置、输入、取消和展示规则，以及 Run 的领取、租约、隔离和授权规则，各自在对应模块集中维护。两个文件超过约 300 行的检查提醒，复审后保留其内聚性；拆分不得把事务顺序或共享状态重新暴露给调用者。
- Pi、命令、租约资源对象保留关联状态和释放行为；普通判定与转换继续使用函数。没有新增容器类、策略注册表或通用执行框架。
- SDK 事件映射、检查点和协议仍在 Pi/E2B 实现中，公共契约不包含 DeepSeek 型号、SDK 对象或部署凭据。Runner 和 Pi 继续位于用户沙箱之外。
- 严格类型检查、现有 Better Auth 精确版本补丁、PG 约束、恢复隔离和原生会话持久化规则保持有效。
- 未增加依赖、新业务接口或前端页面；TypeScript 规范原文和根 AGENTS.md 未修改。

## 验证

| 命令 | 结果 |
| --- | --- |
| pnpm check | Biome、生产与测试严格类型检查通过 |
| pnpm test | 45 个单元及受控 SDK 测试通过 |
| pnpm test:integration | 55 个真实 PG/Redis/鉴权/队列/SSE 测试通过 |
| pnpm test:sandbox | 9 个真实 E2B 测试通过 |
| pnpm test:cloud | 2 个真实 DeepSeek + E2B 测试通过 |
| pnpm build | 所有应用和共享包构建通过 |
| pnpm test:e2e | 桌面/移动视口 12 个既有页面测试通过 |
| pnpm db:migrate | 编译后的迁移入口实际执行通过 |

再次审查调用处和实现，确认新增的类型与内部操作只表达实际职责；对照最终差异核对权限、锁、取消、幂等和资源释放顺序。AST 检查未发现生产代码中的 any、非空断言、强制类型断言、超过约定的块/回调嵌套或相对导入循环；JSX 返回类型按规范推断。

本轮是代码结构审查与回归验证。生产容量、完整进程强杀矩阵、SDK 跨版本历史迁移、未知副作用自动对账和资源回收仍属于 [现有实现边界](../cloud-agent.md)。

## 追加整理：注释、废弃实现与自动检查

首轮仍保留了通用 Inbox 入口与诊断 Worker。再次核对调用关系后，确认它们只有旧测试调用，正式 Session/Run 链路已承担相应职责。本轮删除这两条生产路径及仅服务于它们的测试；输入校验、跨 Session 来源隔离和 Redis 断连回归改为验证真实业务链路。无云端执行配置时，Worker 直接退出，认证和健康接口仍可使用。

补充英文函数内注释，说明 Session 锁与输入快照、租约检查时机、工具意图和回执、权限撤销后的事实保存、SDK 停止以及实时传输丢失后的快照补偿。注释需要对应实现，不能替代规则或为绕过错误辩护。

listQueuedRuns 的相关子查询和派发条件改用具名局部变量，减少连续多层括号收尾。仍然只执行一条 SQL，未增加转发函数或查询。

迁移断连测试时发现，正式 Agent Worker 可能无限等待已失联的队列。收尾现在先停止新执行、等待 SDK/沙箱清理，再给队列 I/O 5 秒退出期限；超时只断开自身 Redis 客户端并报告错误。执行清理与队列传输的期限分开管理，真实断连测试确认 PG 取消结果和失败报告。

### Biome 的实际约束

使用现有 Biome 2.6.7，不增加其他 lint 引擎或自定义正则检查。

| 目标 | 规则或范围 |
| --- | --- |
| 参数最多三个 | complexity/useMaxParams |
| 禁用 enum、namespace 和构造器参数属性 | style/noEnum、noNamespace、noParameterProperties |
| 避免嵌套三元、退出后的 else | style/noNestedTernary、noUselessElse |
| 显式类型导出、禁用 ts-ignore | style/useExportType、suspicious/noTsIgnore |
| 具名导出 | style/noDefaultExport；框架配置文件例外 |
| 环境读取归属启动入口 | style/noProcessEnv；精确列出启动文件，测试例外 |
| 浏览器不依赖 Node 执行能力 | Web src 启用 correctness/noNodejsModules；该官方规则允许纯类型导入 |
| 浏览器不依赖 Agent 执行实现 | Web src 启用 style/noRestrictedImports，限制 agent-runtime 包及子路径 |

除全仓检查外，用临时正反例核对了 19 个场景，包括 Node 子模块、再导出、Agent 子路径、合法公开契约、配置默认导出和启动入口。临时探针没有进入仓库或构成另一套 lint。规则依据 [Biome 官方 Node 模块规则](https://biomejs.dev/linter/rules/no-nodejs-modules/)与[导入限制规则](https://biomejs.dev/linter/rules/no-restricted-imports/)，并以实际安装版本运行验证。

函数职责、逻辑段落、注释准确性及块/回调嵌套仍需人工审查。没有加入括号计数、注释数量或按行数强拆文件的检查。原始 TypeScript 规范及 AGENTS.md 保持完整。

追加整理后的 pnpm check、45 个单元测试、57 个真实基础设施集成测试、9 个真实 E2B 测试、2 个真实 DeepSeek/E2B 测试、构建和 12 个浏览器测试均通过。演讲整场笔记与对本仓库的判断见 [Lauren Tan：Agent 的信任来自工程环境](../research/lauren-tan-agent-trust.md)。

## 按代码范例进行全仓校准

本轮从 20b4221 开始，对当前 apps、packages、tests 下的 107 个 TS/TSX 文件逐模块审查，包含五个范例自身、内部函数、调用处和测试。另检查五个根测试配置、初始化脚本、TS/包配置、CI、既有 CSS/HTML 与翻译资源、七份 SQL 迁移和 Better Auth 补丁。

### 实际修改

- 云端配置按来源分阶段解析：Provider 定义及密钥引用只解析一次，Sandbox 连接独立解析。删除重复的连接 schema 和整份配置的二次复制函数；API 环境校验参数直接从 schema 推导，删除平行字段类型，解析入口放在辅助函数之前。
- Run 事务集中读取和写入事实，resolveRunCompletion 用卫语句集中表达终态优先级：未知工具结果高于取消和 SDK 成功，已提交取消高于普通成功。增加真实 PG 用例，确认取消也不能覆盖未知结果或推进检查点。
- SSE 原先只检查消息载荷中的会话归属，现同时检查 Run 载荷。真实 Redis 订阅分别注入外部 Session 的消息和 Run，确认停止交付并报告 unavailable。
- 初始化页直接使用 TanStack Query 的错误状态，删除额外刷新错误状态和处理函数。核对当前 SDK 的 QueryObserver 实现及[官方 refetch 约定](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)，显式使用 throwOnError: false，由查询结果表达失败。新增浏览器回归覆盖成功后的刷新失败与恢复。语言切换使用具名 async 函数，在其内部处理拒绝。
- 认证测试夹具统一由资源栈负责 SDK 排空、测试记录清理和连接释放，删除手动重复 dispose；SDK 收尾失败时后续清理仍会运行。SSE 测试 reader 在取消失败时也会释放锁。
- CLI 配置测试并发读取三个独立选择，再分别断言结果；Workspace、取消和邀请测试将多层 await/expect 改成命名事实。SDK 测试用具名响应函数和协议对象展开主线，减少长回调与对象括号收尾。
- 删除 tasks 入口中仅供模块内部使用的 executeQueuedRun、listQueuedRuns 再导出，用户路由复用已有 GetRequestUser 契约。保留与公开操作配套的输入、结果和资源类型。
- 补正数据库 schema 注释与初始化页中英文说明，使其符合当前后端已实现、业务界面待接入的状态。

### 自动约束与反例

启用 Biome 官方 suspicious/noImportCycles，设置 ignoreTypes: false。已用实际临时文件验证运行时环、纯类型环均被拒绝，单向类型依赖允许通过；探针已删除。适用规则与选项依据[官方文档](https://biomejs.dev/linter/rules/no-import-cycles/)，并以安装版本实际运行。

CI 迁移检查先使用 git add --intent-to-add，让新生成文件也进入 git diff。临时未跟踪 SQL 探针证明旧命令会漏过，而新命令会失败；清除探针后迁移目录无变化。这个修复不修改已应用迁移。

本轮没有增加依赖或另建 lint 引擎。也评估了 Biome 的 Promise 规则：当前版本仍处于 nursery，未将其整体启用或宣称获得完整类型感知检查；异步处理责任继续结合 SDK 约定人工核对。

### 保留的设计与理由

Session 的锁、访问、接收与展示规则继续在 store.ts 内集中；Run 所有权规则继续集中在 ownership.ts。两者超过文件行数提醒，但拆分会分散同一事务和所有权规则，因此保留内聚性。

Pi 和命令资源对象继续拥有订阅、取消及收尾。原生 SDK 的恢复格式、工具语义和必需空钩子保留；运行与类型依赖环由实际工具检查，生产代码的断言和嵌套由人工及 AST 辅助核对。测试 DSL 的注册与断言回调按既有约定保留，未为消除静态计数提示添加转发函数。React 组件按规范推断 JSX 返回类型。

既有 PG 约束、Better Auth 精确版本补丁、Runner/Pi 与 E2B 的隔离、原生历史持久化、失败事实优先和恢复隔离均继续有效。TypeScript 规范原文与简短 AGENTS.md 没有改动。

### 本轮验证

| 验证 | 结果 |
| --- | --- |
| pnpm check | Biome 与全部严格类型检查通过 |
| pnpm test | 45 个用例通过 |
| pnpm test:integration | 60 个真实基础设施用例通过 |
| pnpm test:sandbox | 9 个真实 E2B 用例通过 |
| pnpm test:cloud | 2 个真实 DeepSeek/E2B 用例通过 |
| pnpm build | 全部应用与共享包构建通过 |
| pnpm test:e2e | 桌面/移动视口 14 个用例通过 |
| pnpm db:generate / db:migrate | 生成检查无变更；编译后的迁移入口执行通过 |

验证覆盖本轮修改和已有回归，生产容量、SDK 跨版本迁移及未知副作用自动对账的边界仍见云端 Agent 文档。
