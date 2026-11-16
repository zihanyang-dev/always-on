# Agent 定义

拥有 Workspace 内 Agent 的指令、模型/推理强度、可见性和创建权限。公开入口 index.ts 提供 HTTP 组装及事务内授权读取；数据库查询随功能维护，连接和表定义由 infrastructure 提供。

模型目录由 bootstrap 调用 Pi 获得，公共契约无厂商枚举；凭据不存入 Agent。支持创建、按 Workspace 查询、部分编辑、停用和空定义删除。Session 创建时复制默认配置；Run 再保存当次快照。更新模型/强度时在锁内合并后校验，维护旧定义不要求旧模型仍启用。

创建者可管理自己的定义，Owner/Admin 可管理 Workspace 可见定义；私人资源不因管理员身份公开。停用由原有执行授权检查观察，保留会话管理与取消能力。任何 Session 仍引用定义时拒绝删除，避免清掉别人的历史。

存在 Agent 时阻止 Workspace 删除，避免沙箱与会话文件失去归属。记忆整理和细粒度工具审批尚未实现。执行与限制见 [云端 Agent 后端](../../../../docs/cloud-agent.md)。
