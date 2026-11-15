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
