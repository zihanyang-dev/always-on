# TypeScript 代码规范（AI 编码代理用）

适用于本仓库所有 .ts / .tsx。缩进、分号、引号、换行由 formatter 负责，不要手动调整。
标记：MUST = 必须；PREFER = 默认这样做，有理由可偏离；AVOID = 默认不要；[判断] = 本规范自定的约定，非官方出处。

## 0. 规则冲突时的优先级

1. 正确性与类型安全
2. 所在文件 / 模块的既有约定（不要顺手重构无关代码）
3. 本文件规则
4. 简短

若某条规则让代码明显更难读，选更易读的写法，并在 PR 说明中写原因。

设计以减少理解和修改代码所需的知识为目标。抽取函数、引入 class、拆分文件、合并重复代码时，应能说明它隐藏了哪些细节、集中了什么职责，或减少了哪些调用约束。行数、函数数量和是否使用 class 都不能单独证明设计更好。

- PREFER 模块对外提供含义明确的小接口，将实现细节、关联状态及必须遵守的操作顺序集中在模块内部。
- PREFER 一次修改所需的信息集中在少数相关位置；避免读者沿多层转发调用才能拼出完整流程。
- PREFER 抽象建立在共同的职责和行为约束上；仅有相似代码不足以证明需要共享实现。

### 0.1 分块与组合的验收标准

先确定一块逻辑负责的知识、输入输出、状态和副作用，再决定用函数、闭包、class 或文件表达。拆分后的调用处和实现需要一起审查。

- MUST 一块逻辑能独立解释其职责；输入输出、会修改的状态、失败方式和资源所有者应当明确。独立不代表没有顺序依赖，也不要求把 I/O 伪装成纯函数。
- PREFER 编排函数中的步骤保持同一抽象层级。例如准备输入、打开 SDK、消费输出可以组成主线；编码字节、拼接协议字段和执行顺序的细节分别由对应逻辑负责。
- PREFER 以知识归属和变化原因划分模块。同一会话的恢复规则应集中维护；不机械地为每个执行阶段新建文件，把共享状态和操作顺序重新交给调用者协调。
- PREFER 一个辅助函数即使只使用一次，只要完整表达意图、集中规则或隐藏实现细节，也可以提取。复用次数、函数行数和括号数量不是独立的拆分依据。
- MUST 提取后核对调用者仍需知道什么。如果仍需了解内部字段、覆盖顺序或私有状态变化，应继续调整接口；不能只把复杂代码搬进另一个函数就视为完成重构。
- PREFER 用修改场景检验内聚性：调整问题格式、恢复策略或事件映射时，相关知识应集中在对应模块；不要求所有变更都只涉及一个文件。
- MUST 正确性与可读性分别验收。测试通过、类型通过和文件已读过，都不能代替对代码形状、依赖关系和职责归属的审查。

---

## 1. 控制流与扁平化（不要楼梯）

- MUST 函数内块嵌套不超过 3 层 [判断]。要写第 4 层时，用下面的手段拍平或抽函数。
- MUST 先处理例外：卫语句 return / throw，主流程留在最左列。
- PREFER 只有一条简单 return / throw / continue / break、且没有 else 的卫语句省略大括号。条件较长时，条件和返回语句分成两行也可以；不要仅因 formatter 换行就加大括号。分支包含多条语句时使用大括号。Biome 的 useBlockStatements 不支持这种例外，关闭该规则，按此约定评审。
- MUST return / throw / continue / break 之后不写 else。
- MUST 循环里用 continue 跳过不需要的元素，不把循环体整个包进 if。
- MUST 用 async/await，不写 .then 链；同一函数内不混用 then 和 await。
- MUST 互不依赖的异步操作并发执行（Promise.all / allSettled），不要串行 await。
- PREFER 多分支映射用查表对象（配 satisfies Record<K, V>）或 Map，代替 if/else 链和 switch 套 switch。
- PREFER 对可辨识联合用 switch(x.kind)，每个 case 直接 return。
- MUST 事件分发函数只处理同一层级的分派，不同时展开内部事件的处理流程；例如 SDK 顶层消息分发与流事件分发分别放在具名函数中。
- PREFER 事件类型分派使用 switch，简单 case 就地处理，包含独立复杂逻辑时再抽函数；不为每个事件机械创建函数、文件或注册表。
- PREFER 数组变换用 filter / map / flatMap 的短管道；管道超过 3–4 步或需要 break / await 时改用 for...of [判断]。
- AVOID 用 reduce 构造对象或数组；用 Object.fromEntries、Object.groupBy 或 for...of。
- AVOID 嵌套三元。超过一层改成卫语句、查表或小函数。
- AVOID 用 && / || 做控制流（cond && doThing()）；写 if。
- AVOID 在条件里写复杂表达式；先赋给命名良好的布尔变量。
- MUST 回调嵌套超过 2 层时，把内层回调抽成具名函数。

```ts
if (content.length === 0) return [];

if (message.type !== 'stream_event' || message.parent_tool_use_id !== null)
  return [];
```

```ts
// ✗ 楼梯
async function ship(id: string) {
  const order = await getOrder(id);
  if (order) {
    if (order.paid) {
      if (order.items.length > 0) {
        await send(order);
      } else {
        throw new Error("empty");
      }
    }
  }
}
// ✓ 卫语句
async function ship(id: string): Promise<void> {
  const order = await getOrder(id);
  if (!order?.paid) return;
  if (order.items.length === 0) throw new Error(`Order ${id} has no items`);
  await send(order);
}
```

```ts
// ✗ if/else 链
function label(s: Status) {
  if (s === "active") return "进行中";
  else if (s === "done") return "已完成";
  else return "已取消";
}
// ✓ 查表，新增状态时编译器会提醒补全
const STATUS_LABEL = {
  active: "进行中",
  done: "已完成",
  cancelled: "已取消",
} as const satisfies Record<Status, string>;
```

```ts
// ✗ 串行等待
const user = await getUser(id);
const posts = await getPosts(id);
// ✓ 并发
const [user, posts] = await Promise.all([getUser(id), getPosts(id)]);
```

---

## 2. 类型设计

### 2.1 建模

- MUST 互斥状态用可辨识联合（共同的字面量字段 kind / status / type），不用多个布尔 + 可选字段。让非法状态无法表示。
- MUST 对联合做 switch 时覆盖全部分支，default 里赋给 never 做穷尽检查。
- MUST 类型有唯一的定义来源：schema 拥有的格式用 z.infer，常量定义的集合用 typeof X[number] / keyof typeof X；明确的跨模块数据契约可以先定义命名类型，再用它约束实现。不要另写一份平行类型。
- PREFER 简单的实现类型用 ReturnType / Parameters 推导；表达模块交接的数据应有清楚的名字，不要求调用者用多层 Extract / ReturnType 跨文件反推实现分支。类型推导不能成为模块之间的隐藏耦合。
- PREFER ID、金额、单位等容易混用的原始值用品牌类型（brand），在边界创建，内部只传品牌类型 [判断：业务 ID 多时启用]。
- PREFER 模板字面量类型只用于小而固定的字符串格式（事件名、CSS 单位、路由前缀）；不要用来解析任意字符串。
- AVOID 字符串或数字表示有限集合却声明为 string / number；用字面量联合。

```ts
type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "rect"; width: number; height: number };

function area(s: Shape): number {
  switch (s.kind) {
    case "circle": return Math.PI * s.radius ** 2;
    case "rect": return s.width * s.height;
    default: {
      const _exhaustive: never = s;
      throw new Error(`Unknown shape: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
```

```ts
type UserId = string & { readonly __brand: "UserId" };
type OrderId = string & { readonly __brand: "OrderId" };
const toUserId = (raw: string): UserId => raw as UserId; // 只在边界调用
function getUser(id: UserId) { /* ... */ }
// getUser(orderId) → 编译错误
```

### 2.2 安全性

- MUST 不用 any。不确定的值用 unknown，再用类型守卫收窄。第三方类型确实缺失时，写最小的局部声明。
- MUST 不用 as 让代码“通过”。允许的 as：as const、品牌类型构造、经过运行时校验后的窄化（且就在校验旁边）。其余需注释说明原因。
- MUST 不用双重断言 as unknown as T。
- MUST 不用非空断言 !；用卫语句、?. 或 ??。唯一例外：测试代码。
- MUST 用 satisfies 校验字面量对象的形状，同时保留字面量推断；不要用类型注解抹掉字面量类型。
- MUST 只作类型使用的值用 typeof 推导，不重复写类型。
- MUST 不用 String / Number / Boolean / Object / Function 包装类型；用 string / number / boolean / object / 具体函数签名。
- MUST 不用 {} 表示“任意对象”；用 Record<string, unknown> 或 object。
- MUST 忽略返回值的回调写 () => void，不写 () => any。
- PREFER 自定义类型守卫 (x): x is T 和断言函数 asserts x is T 收窄类型；守卫的实现必须真的检查了那个类型。
- PREFER 开启 noUncheckedIndexedAccess 后，按下标取值要处理 undefined；用 .at()、解构默认值或检查。

```ts
// ✗
const cfg = { port: 3000, mode: "dev" } as Config;
// ✓ 校验形状且保留字面量
const cfg = { port: 3000, mode: "dev" } satisfies Config;

// 类型守卫
function isApiError(e: unknown): e is ApiError {
  return e instanceof Error && "status" in e && typeof e.status === "number";
}
// 断言函数
function assertDefined<T>(v: T, msg: string): asserts v is NonNullable<T> {
  if (v == null) throw new Error(msg);
}
```

### 2.3 泛型

- MUST 泛型参数至少出现两次（例如参数和返回值都用到）；只出现一次的泛型改成具体类型或 unknown。
- MUST 泛型加必要约束 extends，不让 T 过宽。
- PREFER 让调用方推断泛型，不显式写 f<Foo>(x)；需要阻止某个参数参与推断时用 NoInfer<T>（TS 5.4）。
- PREFER 需要字面量推断时用 const 类型参数 <const T>（TS 5.0），不要求调用方写 as const。
- PREFER 泛型名：单个且含义明显时用 T；多个或含义不明显时用描述性名称并加 T 前缀（TKey、TValue、TResult）[判断]。
- AVOID 超过 3 个泛型参数的函数；通常说明函数职责过多。

```ts
// ✗ T 只出现一次
function log<T>(x: T): void {}
// ✓
function log(x: unknown): void {}

function pick<const K extends readonly string[]>(keys: K) { return keys; }
pick(["a", "b"]); // K 推断为 readonly ["a", "b"]

function createFsm<S extends string>(initial: NoInfer<S>, states: S[]) {}
```

### 2.4 工具类型与可选性

- PREFER 用内置工具类型（Pick、Omit、Partial、Required、Readonly、Record、ReturnType、Awaited、NonNullable、Extract、Exclude）派生类型，不复制字段。
- AVOID 多层嵌套工具类型（Partial<Omit<Pick<...>>>）；超过两层就写出一个命名类型。
- AVOID Omit 用于可辨识联合（会丢失联合）；需要时写分布式版本或直接重写联合。
- MUST 区分“可以不传”和“传了但是 undefined”：开启 exactOptionalPropertyTypes 时，需要显式传 undefined 的字段写 key?: T | undefined。
- PREFER 函数参数“可省略”用 ?；“必须传但可能为空”用 T | undefined 且不加 ?。
- PREFER Record<K, V> 用于键在编译期已知的静态表；Map 用于运行时增删、键非字符串、需要保持插入顺序或频繁增删的场景。
- AVOID 类型体操：多层条件类型、递归类型、infer 链只放在库的公共边界，并配类型测试；业务代码写直白类型。

---

## 3. 已定的争议点（直接照做）

- type vs interface：默认用 type。仅两种情况用 interface：(a) 对象继承 interface X extends A, B，不用 A & B & {...}；(b) 需要声明合并（扩展全局或第三方类型）。
- enum：禁止。用 as const 对象 + 派生的字面量联合。
- namespace：禁止。一个文件就是一个模块。
- class：无状态逻辑优先用函数；需要共同维护关联状态与不变量时，可使用 class。少量局部状态也可用闭包。按状态归属和可读性选择，见第 9 节。
- 构造器参数属性 constructor(private x: T)：禁止，显式声明字段。
- 私有成员：用 #field，不用 private 关键字 [判断]。
- 返回类型：导出的顶层函数显式写；内部函数、回调、返回 JSX 的组件依赖推断。
- 导出：只用具名导出，禁止 export default（框架强制的除外，如路由 / 页面文件、配置文件）。
- 类型导入：只作类型使用的导入写 import type（verbatimModuleSyntax 会强制）。
- 可擦除语法：只写 Node 类型剥离能直接擦掉的 TS 语法（开启 erasableSyntaxOnly）。

```ts
// ✗
enum Role { Admin = "admin", Guest = "guest" }
// ✓
export const ROLE = { Admin: "admin", Guest: "guest" } as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];

// ✗ 交叉
type Admin = User & Permissions & { level: number };
// ✓ 继承用 interface
interface Admin extends User, Permissions { level: number }
```

---

## 4. 函数设计

- MUST 一个函数表达一个完整、连贯的意图；编排函数可以协调多个步骤，步骤的细节按需提取，不能仅因包含多个操作或名字里有“and”就拆开。
- PREFER 函数体约 40 行作为检查提醒 [判断]。较长时先检查职责、抽象层级和阅读顺序；只有拆分能表达独立意图、隐藏细节或集中职责时才提取函数。连贯且容易理解的实现可以适当更长。
- PREFER 编排函数按“资源准备 → 执行 → 收尾 → 结果”展示主线。需要捕获本次调用状态的局部函数声明集中放在主流程之后；独立的纯转换函数放在模块级，避免辅助函数隔断主线。
- PREFER 当事务、锁或资源作用域已经表达操作边界，且回调体是入口的唯一主线时，就地写回调。回调的名字能够表达独立步骤，或提取后更容易看见调用顺序时，再采用具名函数。
- PREFER 已有资源对象负责的操作顺序由该对象集中表达，例如按序交付一批事件并等待确认；编排函数协调这些操作。提取必须集中真实职责，不只隐藏一层括号。
- PREFER 函数接收完成自身职责所需的数据与能力。资源所有者可以传递其明确接口；不要为了减少参数数量，把整份环境、配置或 dependencies 传给只使用一两个字段的纯转换函数。
- PREFER 配置合并规则在一个明确位置完成；静态配置、受管理状态和每次调用的控制参数应各有所有者。调用者不应靠阅读多次 spread 的先后顺序，才能判断谁有权改变会话、取消或错误政策。
- PREFER 返回 `never` 的失败调用直接写成语句，不加 `return`，避免把异常退出写得像普通返回。
- PREFER 需要等待资源释放后再判断结果时，用局部词法作用域明确 `await using` 的结束位置，保留清楚的入口主线与集中处理错误的 catch。
- PREFER 清理函数专注释放资源、等待已发生的工作；执行结果及失败／取消的判断集中在执行边界。
- PREFER 资源工厂的返回对象只表达组装；异步清理写成具名函数，再通过 `[Symbol.asyncDispose]: dispose` 绑定，避免在返回对象里展开清理流程。
- AVOID 将资源内部的多个错误字段、布尔状态逐个包装成 getter。确需查询时提供一个含义明确的读取入口，调用边界据此判断结果。
- MUST 参数超过 3 个，或有两个以上同类型参数相邻，改为一个对象参数并解构。
- MUST 不用布尔标志参数切换行为（render(true)）；拆成两个函数，或用选项对象里的具名字段 / 字面量联合。
- MUST 导出函数显式写返回类型；内部函数依赖推断。
- PREFER 纯函数：同输入同输出、不修改参数、不读写外部可变状态。副作用集中在调用链最外层。
- PREFER 默认参数写在签名里（{ retries = 3 }: Options），不在函数体里补默认值。
- PREFER 用联合类型或可选参数代替重载；只有返回类型随参数类型变化且无法用泛型表达时才写重载。
- PREFER 函数声明（function f）用于模块顶层具名函数；箭头函数用于回调和需要捕获 this 的地方 [判断]。
- PREFER SDK 注册或工厂组装中，承载完整执行流程的长回调先提为具名函数，调用处只表达组装；需要捕获当前配置和依赖时，可将具名函数放在工厂内。
- PREFER 已有模块级执行入口时，由它集中处理完整请求和执行生命周期；工厂只构造与绑定依赖，不在工厂闭包中再维护一套命令分派、输入准备或执行状态。
- AVOID 返回多种不相关的形状；需要时返回可辨识联合。
- AVOID 输出参数（修改传入对象来返回结果）。

```ts
// ✗ 位置参数 + 布尔标志
createUser("Ann", "ann@x.com", true, false);
// ✓
createUser({ name: "Ann", email: "ann@x.com", role: "admin", sendWelcome: false });

export function createUser({
  name,
  email,
  role = "member",
  sendWelcome = true,
}: CreateUserInput): Promise<User> { /* ... */ }
```

---

## 5. 异步

- MUST 不留悬空 Promise：每个 Promise 要么 await，要么 return，要么显式 void 并在内部处理错误（如事件处理器里）。
- MUST 不把 async 函数传给不处理 Promise 的地方（forEach、事件回调期望 void 的位置）而不处理错误；需要遍历时用 for...of + await 或 Promise.all(xs.map(...))。
- MUST 并发独立任务用 Promise.all；需要部分失败也继续时用 Promise.allSettled 并逐个检查 status。
- MUST 大量任务限制并发数（p-limit 或分批），不要一次 Promise.all 上千个请求。
- MUST 可取消的操作接受 signal?: AbortSignal 并向下传递（fetch、子任务）；超时用 AbortSignal.timeout(ms)。
- PREFER 能用 await 的地方不写 new Promise；只在包装回调式 API 时用，且优先用 util.promisify 或库自带的 Promise 版本。
- PREFER ES 模块入口文件可以用顶层 await；库模块避免顶层 await（会阻塞导入方）。
- AVOID return await 以外的多余 await；但在 try 块内返回 Promise 时必须 return await，否则 catch 接不到。
- AVOID 在循环里串行 await 互不依赖的请求。

```ts
// ✗ forEach 不等待 async
ids.forEach(async (id) => await sync(id));
// ✓
await Promise.all(ids.map((id) => sync(id)));

// 可取消
export async function fetchUser(id: UserId, signal?: AbortSignal): Promise<User> {
  const res = await fetch(`/api/users/${id}`, { signal });
  return UserSchema.parse(await res.json());
}
await fetchUser(id, AbortSignal.timeout(5_000));
```

---

## 6. 错误处理

- MUST 决定规则：可预期的业务失败（校验不通过、未找到、权限不足、余额不足）作为返回值 Result；程序错误、不变量被破坏、不可恢复的基础设施故障用 throw。
- MUST throw 的只能是 Error 或其子类，不 throw 字符串或对象字面量。
- MUST 包装或转换错误时用 new XError(msg, { cause: err }) 保留原始错误。
- PREFER 仅在补充新的上下文时包装错误；中间层为触发取消或释放资源而捕获时，原样重抛已有 Error。不要沿调用链重复添加同一句失败说明；外部边界抛出的非 Error 值先转换为 Error。
- PREFER 同时等待工作与收尾时，先收集失败，再按明确优先级处理；避免嵌套枚举 Promise 状态组合。同一 Error 去重，独立失败用 AggregateError 保留，不另建错误处理框架。
- PREFER 故障后的资源清理具有独立流程时，由具名操作负责清理与清理失败的上下文，执行边界保留平铺的结果判断。避免在 catch 中继续展开 try/catch 和重复错误包装；不为消除语法嵌套创建通用包装器。原始故障与清理故障必须同时保留，不能把清理失败当作普通取消。
- MUST catch (e) 中的 e 是 unknown（useUnknownInCatchVariables，strict 已含），先收窄再用；不要写 catch (e: any)。
- MUST 不吞错误：空 catch、只 console.log 后继续都禁止。确实可忽略时写注释说明原因。
- MUST 在边界处统一 catch（HTTP handler、任务入口、UI 错误边界）；中间层仅在需要加上下文、转换错误或履行取消／资源清理职责时捕获。
- MUST 错误消息说明发生了什么、涉及哪个对象（带 ID），不写 "Something went wrong"。
- PREFER 自定义错误类设置 name，并带结构化字段（code、status）供调用方判断，不靠匹配 message 字符串。
- PREFER try 的范围与错误处理责任一致。局部错误转换只包相关操作；执行入口和资源生命周期允许覆盖完整的一次执行。避免捕获无关操作或拆出仅为缩短 try 块的转发函数。

```ts
type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export function parseAge(input: string): Result<number> {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: `Invalid age: ${input}` };
  return { ok: true, value: n };
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
  readonly resource: string;
  readonly id: string;
  constructor(
    { resource, id }: { readonly resource: string; readonly id: string },
    options?: ErrorOptions,
  ) {
    super(`${resource} ${id} not found`, options);
    this.resource = resource;
    this.id = id;
  }
}

try {
  await save(order);
} catch (e) {
  throw new Error(`Failed to save order ${order.id}`, { cause: e });
}
```

---

## 7. 外部输入与边界校验

- MUST 所有外部输入在进入系统的那一处解析：HTTP 请求体 / 参数、第三方 API 响应、文件、环境变量、localStorage、postMessage、数据库 JSON 字段。
- MUST 用仓库已选的 schema 库（Zod / Valibot / ArkType），类型由 schema 推导；不另写一份 interface。
- MUST 解析而不是校验：边界函数返回已收窄的类型，内部代码不再重复判空或检查形状。
- MUST 环境变量启动时一次性解析成一个类型化的 env 对象，其他地方不直接读 process.env。
- MUST 不把 JSON.parse 的结果直接当某类型使用；它的结果视为 unknown。
- PREFER 用 safeParse 在可预期失败的边界返回 Result；在启动配置等不可恢复处用 parse 直接抛错。

```ts
const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  age: z.number().int().nonnegative(),
});
export type User = z.infer<typeof UserSchema>;

// ✗
const user = (await res.json()) as User;
// ✓
const user = UserSchema.parse(await res.json());
```

---

## 8. 数据与不可变

- MUST 默认 const；只有确实重新赋值才用 let；禁止 var。
- MUST 不修改函数参数（数组、对象）；返回新值。
- PREFER 参数类型写 readonly T[] / ReadonlyArray<T> / Readonly<T>，表达“不会修改”。
- PREFER 对象字段在构造后不变时标 readonly。
- PREFER 用非破坏性数组方法（ES2023）：toSorted、toReversed、toSpliced、with，代替 sort / reverse / splice / 下标赋值。
- PREFER 浅拷贝用展开 { ...obj } / [...arr]；深拷贝用 structuredClone，不用 JSON.parse(JSON.stringify(x))。
- PREFER 常量表、配置表写 as const。
- PREFER 多行对象／数组字面量嵌套超过两层时，先按业务含义构造具名子对象，再组装外层结构，避免连续多层括号收尾。简单结构就地保留；不为消除括号机械增加变量或转发函数。
- PREFER 分组用 Object.groupBy / Map.groupBy（ES2024），不手写 reduce。
- PREFER 取末尾元素用 .at(-1)。
- AVOID 深层嵌套对象的展开更新超过两层；改用专门的更新函数或 Immer 一类工具（若仓库已有）。

```ts
// ✗ 原地修改入参
function sortUsers(users: User[]) { return users.sort(byName); }
// ✓
function sortUsers(users: readonly User[]): User[] { return users.toSorted(byName); }

const byRole = Object.groupBy(users, (u) => u.role);
const last = items.at(-1);
const copy = structuredClone(state);
```

---

## 9. 类与对象

以函数和组合组织逻辑，用对象封装有状态资源。无状态的逻辑不硬套类，有生命周期的资源不硬拆散。

- PREFER 无状态计算、校验、事件转换、策略判断和配置组装使用模块级函数；普通数据用对象表达。
- PREFER 连接、取消、流和资源释放由明确的资源对象集中负责；对象拥有相关状态和生命周期，执行编排与纯转换不因此全部搬进类。
- PREFER 需要共同维护关联状态与不变量的对象，可使用 class 集中字段和行为，例如 runtime、session、状态机、注册表或资源所有者。少量局部状态使用闭包同样合适。
- MUST 状态的修改与必须满足的约束由明确的模块负责。选择 class 或闭包都应减少调用者需要协调的细节；不能只把局部变量改成字段就认定设计更好。
- MUST 资源的打开、停止和释放有明确归属，包含正在进行的异步工作。不能为了让主线更短，把必须共同维护的资源顺序拆散，也不能用一个包揽所有职责的资源对象掩盖模块耦合。
- PREFER 持有需要显式释放的资源时，实现 [Symbol.dispose] / [Symbol.asyncDispose] 并配合 using / await using。仅维护内存状态的 class 不需要为了符合形式而添加空 dispose。
- Error 子类、框架要求的 class，以及经测量需要共享实例方法的热点数据结构，也可使用 class。
- MUST 不写只有 static 成员的容器类；直接导出函数和常量。
- MUST 不用构造器参数属性；字段显式声明（erasableSyntaxOnly）。
- MUST 不为了“以后可能替换”而先写 interface + 唯一实现类；需要时再抽。
- PREFER 私有状态用 #field [判断]。
- PREFER 继承最多一层（通常只有 extends Error）；复用行为用组合与函数。
- PREFER 覆盖父类成员时写 override（配合 noImplicitOverride）。
- AVOID 在 class 中使用 this 的方法被当作回调传递而丢失 this；需要时用箭头函数字段或在调用处包一层。
- AVOID getter / setter 带副作用或开销大的计算。

```ts
// ✗ 只有 static 的容器类
export class MathUtils {
  static clamp(n: number, min: number, max: number) { /* ... */ }
}
// ✓
export function clamp(n: number, min: number, max: number): number { /* ... */ }

// ✓ 资源生命周期适合 class
export class DbConnection implements AsyncDisposable {
  #client: Client;
  constructor(client: Client) { this.#client = client; }
  query(sql: string) { return this.#client.query(sql); }
  async [Symbol.asyncDispose]() { await this.#client.end(); }
}
await using db = new DbConnection(await connect());

// A closure is sufficient for a small amount of local state.
export function createCounter(start = 0) {
  let count = start;
  return { inc: () => ++count, get: () => count };
}
```

---

## 10. 模块与文件组织

- MUST 只用具名导出。
- MUST 只作类型使用的导入写 import type { X } 或 import { type X }。
- MUST 按功能（feature）组织目录，不按技术层（不要顶层 components / services / types 各一堆）。一个功能的类型、实现、测试、样式放在同一目录。
- PREFER 服务根目录可以明确区分 bootstrap、API、application、Harness、infrastructure 等依赖边界；各边界内部仍按功能组织。边界要约束真实依赖，不为凑分层增加空目录或只转发参数的模块。
- MUST 组合根可以导入具体 SDK 并创建客户端、选择实现、绑定工具；SDK 事件解释、恢复格式、协议错误转换归对应适配器。不要只为隐藏 SDK import 增加转发层，也不要把业务工具清单移进通用 Harness。
- PREFER 存储无关的应用判定留在应用模块；数据库适配器在事务内读取事实、调用判定并提交。锁、幂等约束和条件更新不拆成调用者自行拼装的多次数据库操作。
- MUST `import type` 同样表达知识依赖。跨功能只传所需身份和能力，不让文件、资产或 Sandbox 模块依赖完整的执行任务、SDK 对象或启动配置。
- PREFER 按文件内函数的知识和状态归属判断拆分，而非按阶段命名。纯编码与长期输入流可以分开；同一取消状态及其释放方法应留在资源所有者内。
- MUST 事件处理模块只解释自身职责相关的事件；消息、工具、交互、会话等职责分别归属对应模块，新增领域行为不得持续追加进一个万能事件处理器。
- MUST 不新建 utils.ts / helpers.ts / common.ts 这类大杂烩；按用途命名（date-format.ts、retry.ts）。
- MUST 不产生循环依赖；发现时把共享部分抽到更底层的模块。
- MUST 依赖方向单向：功能模块 → 共享模块 → 基础库；共享模块不导入功能模块。
- PREFER 跨模块共享抽象建立在已出现多次且职责稳定的行为上，确认调用方和整体实现都更简单；模块内辅助函数可以只使用一次。优先使用 AbortSignal.any 等原生组合，不因几段 try/catch 相似就建立通用执行框架。
- MUST 每个功能目录只通过一个入口（index.ts 或 package.json exports）对外暴露公共 API；外部不深入导入内部文件。
- AVOID 多层 barrel（index.ts 再导出 index.ts）和 export * 全量再导出；会拖慢构建与类型检查、破坏 tree-shaking、易造成循环依赖。只在功能边界放一层显式列名的 barrel。
- PREFER 单个生产文件约 300 行作为检查提醒 [判断]。按独立职责和变更原因决定是否拆分；不为满足行数把紧密关联的实现分散到多个文件。
- PREFER 文件名 kebab-case（user-service.ts）；React 组件文件按仓库惯例（常见为 PascalCase）。
- PREFER 测试文件与源文件同目录，默认一份源码对应一份测试：foo.ts + foo.test.ts。同一模块的不同场景在测试文件内用 describe 分组，不为每个场景另建 foo-control.test.ts、foo-delivery.test.ts 等文件。
- PREFER 测试文件按行为归属组织，不机械套用源码约 300 行的偏好。确实难以阅读时先减少重复准备代码，再判断是否有独立的测试边界；不要为了测试拆分反过来拆生产模块。
- MUST 直接研究第三方 SDK 的测试放在 tests/sdk/；跨应用模块的完整链路测试放在 tests/integration/。对应目录有实际用例时再创建，不预建空目录。
- PREFER 路径别名用 package.json "imports"（#src/*）[判断]，不新增 tsconfig paths。
- PREFER 模块顶层只放声明；不在导入时执行副作用（发请求、改全局、读文件），入口文件除外。

```text
src/
  features/
    checkout/
      index.ts          # 只导出公共 API
      checkout.ts
      checkout.test.ts
      cart-total.ts
      types.ts
  shared/
    money.ts
    retry.ts
```

---

## 11. 命名

- MUST 变量 / 函数 camelCase；类型、类、组件 PascalCase；模块级不可变常量 UPPER_SNAKE_CASE；文件 kebab-case。
- MUST 布尔以 is / has / can / should / did 开头（isActive、hasAccess）。不用否定式（isNotReady → isReady）。
- MUST 函数名动词开头（getUser、parseConfig、sendEmail）；返回布尔的函数用 is / has 开头。
- MUST 不用无意义名字：data、info、obj、tmp、val、handle2、doStuff、Manager、Helper。
- MUST 自定义变量、类型和配置名不用 native / nativeXxx / NativeXxx 这类笼统命名；按实际职责命名，如 inputMessage、sdkEvents、InputContentPart。第三方 SDK 既有字段与 API 保持原名。
- MUST 不用缩写，除非是通用缩写（id、url、api、db、ctx、req、res）；缩写按单词大小写：userId、parseHtml、HttpClient [判断]。
- MUST 同一概念全仓库用同一个词（选定 customer 就不要在别处写 client / user 指同一东西）；新代码沿用已有领域词汇。
- PREFER 命名 lint 允许 SDK 的原字段拼写及 wire 格式，减少逐字段抑制注释；应用自有字段仍按 camelCase 评审，不沿用外部缩写或 snake_case。
- MUST 类型名不加 I / T 前缀（不写 IUser、TUser）；泛型参数除外（见 2.3）。
- PREFER 名字长度与作用域成正比：循环里 i 可以，模块级要完整描述。
- PREFER 集合用复数（users），映射用 xByY（userById）。
- PREFER 单位写进名字：timeoutMs、sizeBytes。
- PREFER 事件处理函数 handleX，作为 prop 传递时 onX。

---

## 12. 注释与文档

- MUST 源码注释与 TSDoc 使用英文。
- MUST 注释写“为什么”，不写“做了什么”；代码能说清楚的不写注释。
- MUST 导出的公共 API（库、跨功能模块的入口函数 / 类型）写 TSDoc：一句话说明 + 必要的 @param / @returns / @throws / @example。
- MUST 不提交注释掉的代码；版本控制会保留历史。
- MUST TODO 格式：// TODO(owner或issue号): 具体要做什么。不写无主无内容的 TODO。
- MUST 修改代码时同步更新相关注释；过时注释比没有更糟。
- PREFER 解释业务规则、绕过的 bug、性能取舍、非常规写法的原因时写注释，并附链接。
- AVOID 在 TSDoc 里重复类型信息（类型已在签名中）。
- AVOID 用 @ts-ignore；必须压制时用 @ts-expect-error 并写原因。

```ts
// ✗ 复述代码
// increment i by 1
i++;
// ✓ 解释原因
// Stripe 在 2xx 时也可能返回 error 字段，见 https://...
if (body.error) throw new PaymentError(body.error);

/**
 * 按用户时区把 UTC 时间格式化为日期字符串。
 * @throws {RangeError} timeZone 不是合法的 IANA 时区时
 */
export function formatLocalDate(at: Date, timeZone: string): string { /* ... */ }
```

---

## 13. 现代语法（TS 5.x / ES2023+）

- PREFER satisfies（TS 4.9）校验形状并保留字面量类型。
- PREFER const 类型参数（TS 5.0）。
- PREFER using / await using（TS 5.2）管理资源，代替手写 try/finally 释放。
- PREFER NoInfer<T>（TS 5.4）控制推断位置。
- PREFER 推断出的类型谓词（TS 5.5）：xs.filter((x) => x !== undefined) 已能收窄，不必手写 (x): x is T。
- PREFER Object.groupBy / Map.groupBy、Array.prototype.at、findLast / findLastIndex、toSorted / toReversed / toSpliced / with、structuredClone、Array.fromAsync（按运行时支持）。
- PREFER import.meta.dirname / import.meta.filename（Node 20.11+）代替 __dirname 的 fileURLToPath 写法。
- PREFER 数字字面量分隔符：1_000_000、5_000。
- PREFER ??=、||=、&&= 简化默认值赋值。
- MUST erasableSyntaxOnly 的影响：禁止 enum、带运行时代码的 namespace、构造器参数属性、import x = require()、export =、尖括号类型断言 <T>x。

```ts
// TS 5.5 起自动收窄
const ids = maybeIds.filter((x) => x !== undefined); // string[]

// using 释放资源
{
  using file = openFile(path);
  process(file);
} // 自动调用 file[Symbol.dispose]()

const root = import.meta.dirname;
cache[key] ??= compute(key);
```

---

## 14. 测试友好与测试风格

- MUST 依赖通过参数传入（函数参数或工厂函数），不在函数内部 new 外部服务或直接 import 单例后调用，便于替换。
- MUST 纯逻辑与 I/O 分开，纯逻辑不需要 mock 就能测。
- MUST 时间、随机数、UUID 通过参数或注入的 clock 获取，不在业务逻辑里直接调 Date.now() / Math.random()。
- PREFER 测试结构 Arrange-Act-Assert；一个测试只验证一个行为，名字描述行为（"returns 0 for empty cart"）。
- PREFER 测试数据用工厂函数（makeUser({ role: "admin" })），只写与该测试相关的字段。
- PREFER 测试公共行为，不测私有实现细节。
- PREFER 用原生断言同时完成校验与类型收窄，如 `assert.ok(result.status === 'failed')`；避免为同一条件先断言，再写 `if + assert.fail`。
- AVOID 测试中使用 any；测试里可以用 ! 和 as 构造数据，但不要绕过被测类型。
- AVOID 过度 mock；能用真实的内存实现就不 mock。

---

## 15. 性能与类型检查性能

- PREFER 对象继承用 interface extends，不用多个 & 交叉（类型检查器会缓存 interface 关系，交叉类型可能产生 never 且显示差）。
- AVOID 超大的联合类型（数百个成员）参与条件类型或映射类型；拆分或改用 string + 运行时校验。
- AVOID 深度递归的条件类型；类型检查变慢时先找这类类型。
- PREFER 库与包的导出函数写显式返回类型，减少声明文件生成成本；库项目开启 isolatedDeclarations（TS 5.5）。
- AVOID 多层 barrel 导出（见第 10 节）。
- PREFER 运行时：先写清晰代码，有测量数据再优化；热点循环里避免反复创建闭包和中间数组。
- PREFER 查找频繁的集合用 Set / Map，不用 array.includes / find 在循环里做 O(n²)。

---

## 16. AI 代理常见反模式（遇到即修正）

- 过度抽象：没有实际职责或变化需求，先堆 interface + 工厂 + 策略类。→ 删除多余层次，选择能直接表达当前职责的函数或对象。
- 无用包装：仅复述已有含义的参数转发或类型改名。→ 直接使用原入口；表达领域意图、隐藏实现选择或提供稳定入口的包装可以保留，但应减少调用者需要理解的细节。
- 假拆分：把一团代码移进 prepare / configure / handle，仍共享整份上下文、状态和隐含顺序。→ 重新确定职责和输入输出，同时审查调用处与被提取的实现。
- 随手 as any / as unknown as T / ! 让编译通过。→ 修正类型或加运行时检查。
- 到处防御：内部函数对已校验的数据反复判空、typeof 检查。→ 只在边界校验，内部信任类型。
- 无处理责任的 try/catch、重复包装错误，或 catch 里 console.log 后继续。→ 在有错误转换、取消或资源清理责任的位置处理；执行边界统一决定对外结果。
- 复述代码的注释、每个函数都写空洞 JSDoc。→ 删掉，只留“为什么”。
- 重新实现标准库：手写 groupBy、深拷贝、debounce（仓库已有库时）、日期计算。→ 用标准 API 或仓库已有依赖。
- 巨型文件：一个文件塞多个不相关功能。→ 按职责拆分。
- 新增依赖解决一行能写完的问题。→ 不加依赖；需要加时先说明。
- 为“兼容性”保留旧代码路径、未使用的参数和导出。→ 删除死代码。
- 同时留两种写法（新旧 API 并存）。→ 只保留一种并迁移调用方。
- 修改与任务无关的代码、重排导入、改格式。→ 只改需要改的。
- 用 enum、namespace、default export、参数属性等本规范禁止的写法。→ 按第 3 节改写。
- 布尔参数堆叠、位置参数过多。→ 对象参数。
- 魔法数字和字符串散落各处。→ 提为命名常量，放在使用它的模块顶部。

以上设计取舍参考 [Parnas 对模块划分与信息隐藏的讨论](https://www.cs.lafayette.edu/~gexia/cs301/resources/parnas.html)、[Ousterhout 的模块设计讲义](https://web.stanford.edu/~ouster/cgi-bin/cs190-spring15/lecture.php?topic=complexity)、[Fowler 对函数意图与长度的讨论](https://martinfowler.com/bliki/FunctionLength.html)、[Sandi Metz 对错误抽象的分析](https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction)、[Google TS 指南的函数长度建议](https://google.github.io/styleguide/tsguide.html#function-length)、[复杂类型建议](https://google.github.io/styleguide/tsguide.html#mapped-and-conditional-types)及 [Google 代码评审指南](https://google.github.io/eng-practices/review/reviewer/looking-for.html)。这些资料对具体拆分尺度存在分歧，本规范据此选择便于理解和修改的约定，不将某一种代码形状视为唯一最佳实践。

2026-11-07 同时核对了 [VS Code 资源管理](https://github.com/microsoft/vscode/blob/6a97f62574ecc6d16fdfc0a74561e5034c19af89/src/vs/base/common/lifecycle.ts#L409)、[TanStack Query 的状态与条件函数](https://github.com/TanStack/query/blob/e676aa7f92e3754c442df8e9d8735e0203963358/packages/query-core/src/queryObserver.ts#L113)、[Hono 的闭包组合](https://github.com/honojs/hono/blob/61f7c59e50244ab4d2dd83c151928cf7ea448510/src/compose.ts#L15)、[tRPC 初始化装配](https://github.com/trpc/trpc/blob/fe64009e62e94f5301082e37eb5d08ec70bde63d/packages/server/src/unstable-core-do-not-import/initTRPC.ts#L173)及 [Vercel AI SDK 的 Agent 入口](https://github.com/vercel/ai/blob/6d21e8e443dfaabd9870bc62a73b8c25811875c6/packages/ai/src/agent/tool-loop-agent.ts#L292)。借鉴相关模块的职责取舍，不把各项目的长函数、断言、继承或兼容分支直接当作本仓库规范。

---

## 17. tsconfig 与 lint 基线

tsconfig 必开：

- strict
- noUncheckedIndexedAccess
- exactOptionalPropertyTypes
- noImplicitOverride
- noFallthroughCasesInSwitch
- verbatimModuleSyntax
- erasableSyntaxOnly（TS 5.8）
- isolatedModules
- isolatedDeclarations（仅库项目，TS 5.5）
- module / moduleResolution：Node 项目用 nodenext；打包器项目用 preserve + bundler
- target：ES2022 或更高

基础配置见 [Biome](../biome.json) 和 [TypeScript](../tsconfig.base.json)。Biome 的 `noFloatingPromises` 检查未处理的 Promise 表达式，`noMisusedPromises` 检查条件与回调等位置的 Promise 误用。主动脱离请求生命周期的任务仍需在所属模块中报告失败并管理释放。
下文列出的 typescript-eslint 规则名用于说明检查目标。导出返回类型、块嵌套深度、职责归属及代码形状仍需人工审查。

项目划定模块边界后，把确定的依赖方向和公开入口纳入自动检查。规则覆盖普通导入、重导出、类型引用和字面量动态导入。新增依赖时核对它为什么属于这个调用方，接口变化时同步更新规则和回归用例。

事务、撤权、取消、恢复、持久化和资源释放通过行为测试验收。对有状态改动，先读入口，再读关键状态的所有者，最后从调用者视角确认失败、重试和收尾。每次提取都应减少调用者必须记住的规则，或者把本来分散的状态决策集中起来。

typescript-eslint（strictTypeChecked + stylisticTypeChecked 预设）中对应的规则：

- no-explicit-any、no-non-null-assertion、no-unsafe-*（assignment / call / member-access / return / argument）
- no-floating-promises、no-misused-promises、await-thenable、return-await
- switch-exhaustiveness-check
- consistent-type-imports、consistent-type-exports
- consistent-type-definitions: ["error", "type"]（需要 interface extends / 声明合并处用行内禁用注释说明原因）
- no-unnecessary-condition、no-unnecessary-type-assertion、prefer-nullish-coalescing、prefer-optional-chain
- only-throw-error、use-unknown-in-catch-callback-variable
- explicit-module-boundary-types 或 explicit-function-return-type（只针对导出）
- 另加：no-restricted-syntax 禁止 TSEnumDeclaration；import/no-default-export；import/no-cycle；max-depth: 3；max-params: 3；no-nested-ternary；no-else-return
