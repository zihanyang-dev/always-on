# 协议契约

按公开子路径提供 `system`（公开配置/健康）、`users`（用户资料）、`models`（模型目录）和 `agents`（Agent/Session/Run/消息/事件）。契约不枚举部署供应商的型号或推理强度；启用目录由执行端提供。

跨进程契约先声明具名类型，再以 `ZodType<Contract>` 约束运行时 schema，以满足 isolatedDeclarations；没有另写一份不受约束的平行类型。业务模块内部由其 schema 推导类型。

新增协议按功能显式列入 package exports。这里不包含数据库表、启动 env、SDK 类型或内部业务状态。浏览器、CLI 和服务端各自在输入处解析。
