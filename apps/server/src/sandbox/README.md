# 云端执行环境

拥有 E2B 的创建、连接、文件与命令能力、取消和暂停。默认使用官方 SDK，通过连接配置区分自托管 Embed 与 E2B Cloud；本地用户 Agent 的原生执行不经过该模块。

`openE2bWorkspace` 返回运行端需要的文件与命令能力，释放时严格暂停同一个 VM。旧绑定不存在时报告失败，不能悄悄替换成空环境。命令进入独立进程组，取消时终止整组并等待退出；SDK 的单 PID kill 不足以终止子进程。

可信 Runner、Pi 会话和模型凭据留在沙箱外。真实验证使用 `pnpm test:sandbox`，不混入日常单元测试。部署见 [E2B Embed](../../../../deploy/e2b/README.md)，研究依据见 [沙箱设计](../../../../docs/research/sandbox-design.md)。Session 的持久绑定与后台 Run 编排仍待接入。
