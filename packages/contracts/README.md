# 协议契约

目前仅提供 `@always-on/contracts/system`：公开部署配置与健康检查格式。

跨进程契约先声明具名类型，再以 `ZodType<Contract>` 约束运行时 schema，以满足 isolatedDeclarations；没有另写一份不受约束的平行类型。业务模块内部由其 schema 推导类型。

新增协议按功能显式列入 package exports。这里不包含数据库表、启动 env、SDK 类型或内部业务状态。浏览器、CLI 和服务端各自在输入处解析。
