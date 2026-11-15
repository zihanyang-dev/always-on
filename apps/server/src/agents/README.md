# Agent 定义

拥有 Workspace 内 Agent 的指令、模型/推理强度、可见性和创建权限。公开入口 index.ts 提供 HTTP 组装及事务内授权读取；数据库查询随功能维护，连接和表定义由 infrastructure 提供。

模型目录由 bootstrap 调用 Pi 获得，公共契约无厂商枚举；凭据不存入 Agent。当前支持创建、按 Workspace 查询和内部使用授权。Session 创建时复制默认配置；Run 再保存当次快照。

存在 Agent 时阻止 Workspace 删除，避免沙箱与会话文件失去归属。尚无 Agent 更新/删除、记忆整理或细粒度工具审批。执行与限制见 docs/cloud-agent.md。
