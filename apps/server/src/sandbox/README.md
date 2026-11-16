# 云端执行环境

拥有 E2B 的创建、连接、文件与命令能力、取消和暂停。默认使用官方 SDK，通过连接配置区分自托管 Embed 与 E2B Cloud；本地用户 Agent 的原生执行不经过该模块。

`openE2bWorkspace` 返回运行端需要的文件与命令能力，释放时严格暂停同一个 VM。旧绑定不存在时报告失败，不能悄悄替换成空环境。命令进入独立进程组，取消时终止整组并等待退出；SDK 的单 PID kill 不足以终止子进程。

`deleteE2bSandbox` 使用控制面的官方 kill，直接结束运行或暂停的绑定，不为了删除恢复 VM；已不存在表示释放已完成。调用方的 Session 删除流程负责准入和持久重试，此模块不删除产品记录。

可信 Runner、Pi 会话和模型凭据留在沙箱外。真实验证使用 `pnpm test:sandbox`，不混入日常单元测试。部署见 [E2B Embed](../../../../deploy/e2b/README.md)，研究依据见 [沙箱设计](../../../../docs/research/sandbox-design.md)。Session 的持久绑定归 sessions/tasks，实际链路与限制见 [云端 Agent](../../../../docs/cloud-agent.md)。文件读取通过官方流限制为 20 MiB，并传递取消；上传中断不能作为远端效果已经终止的确认。
