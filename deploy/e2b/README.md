# 本地 E2B Embed

使用 E2B 官方开源 [Embed](https://github.com/e2b-dev/runtime/tree/main/embed)，通过同一份 E2B SDK 接入自托管服务与云服务。应用不维护 Firecracker、快照和容器调度实现。

本次核对的上游提交为 `c7bbb196b479b532d4218b47e1c3ce78b6370ae6`。安装文件放在忽略的 `.local/e2b/`，不把上游 Compose 和脚本复制进应用源码。升级时核对上游部署说明、配套镜像和二进制校验，再更新两个文件；不要单独混用不同版本的文件。

## Mac 环境

官方要求 M3 或更新芯片、macOS 15 或更新版本、开启嵌套虚拟化的 Linux 虚拟机。ARM64 内核至少 6.10，基础页大小为 4 KiB，需要 KVM、NBD、cgroup v2。建议 12 GiB 内存和至少 20 GiB 可用系统盘，详见[官方要求](https://github.com/e2b-dev/runtime/blob/c7bbb196b479b532d4218b47e1c3ce78b6370ae6/embed/compose/README.md#requirements)。

为 E2B 单独建立 Colima profile，避免修改现有 PostgreSQL、Redis 和其他项目的 Docker 环境：

```sh
colima start always-on-e2b --vm-type vz --nested-virtualization \
  --cpu 4 --memory 12 --disk 60 --root-disk 40 \
  --activate=false --mount none --binfmt=false --port-forwarder none
```

在该虚拟机安装 Ubuntu 的更新内核与部署工具。当前机器验证使用 `linux-image-7.0.0-43-generic`，安装时应按 Ubuntu 仓库选择受支持的内核；更新后重启该 profile，再检查版本、页大小和 `/dev/kvm`：

```sh
colima -p always-on-e2b ssh -- uname -r
colima -p always-on-e2b ssh -- getconf PAGESIZE
colima -p always-on-e2b ssh -- ls -l /dev/kvm
```

## 安装与连接

从仓库根目录下载配套的两个官方文件：

```sh
mkdir -p .local/e2b
curl -fsSL https://raw.githubusercontent.com/e2b-dev/runtime/c7bbb196b479b532d4218b47e1c3ce78b6370ae6/embed/compose/compose.yaml -o .local/e2b/compose.yaml
curl -fsSL https://raw.githubusercontent.com/e2b-dev/runtime/c7bbb196b479b532d4218b47e1c3ce78b6370ae6/embed/compose/.env -o .local/e2b/.env
docker --context colima-always-on-e2b compose --project-directory .local/e2b up -d --wait
```

官方安装会修改 Linux 虚拟机的内核参数、网络规则和目录，因此应只在专用虚拟机运行。E2B 内部控制端口留在虚拟机中。当前 Colima 0.10.3/Lima 2 的 none 转发规则仍会把 guest loopback 的 PG/Redis 端口转发至宿主 127.0.0.1；本项目使用 15432/16379，未发生冲突。此配置供专用本机开发使用，不能据此宣称所有端口都被隔离；跨主机部署按官方网络要求处理。为 SDK 和可选的管理界面建立仅监听本机的隧道，避开应用的 3001 端口：

```sh
ssh -F "$HOME/.colima/ssh_config" -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:43000:127.0.0.1:3000 \
  -L 127.0.0.1:43002:127.0.0.1:3002 \
  -L 127.0.0.1:43001:127.0.0.1:3001 colima-always-on-e2b
```

在另一个终端读取本次安装自动生成的 API key，不需要 E2B 云账户：

```sh
docker --context colima-always-on-e2b compose --project-directory .local/e2b exec -T ready cat /run/e2b/sdk.env
```

把 key 保存到忽略的 `.env.local`，并配置隧道地址：

```dotenv
E2B_API_KEY=<本次安装生成的 key>
E2B_API_URL=http://127.0.0.1:43000
E2B_SANDBOX_URL=http://127.0.0.1:43002
```

这两个 URL 是当前官方 Embed 的 SDK 接法。SDK 2.64.0 已将对应选项标为后续主版本弃用；接入细节集中在 Sandbox 模块，升级 SDK 时同时核对官方自托管接法，不自行猜测替代协议。

验证应用接入：

```sh
pnpm test:sandbox
pnpm test:cloud
```

该命令创建真实 VM，检查读写、非零退出、凭据隔离、父子进程取消、暂停与恢复、绑定丢失，并在结束后删除测试 VM。它独立于普通测试，不在没有沙箱配置的 CI 中伪装通过。

本机 Docker Hub 直连超时，因此基础服务镜像通过 `mirror.gcr.io` 拉取后标记回官方名称；默认模板通过官方 `Template.build(Template().fromImage('mirror.gcr.io/e2bdev/base'), 'base', ...)` 构建。默认模板就绪后，官方 Compose 的构建步骤会识别并复用它。其他网络环境可直接采用官方默认源。

## 运行与停止

```sh
docker --context colima-always-on-e2b compose --project-directory .local/e2b ps
docker --context colima-always-on-e2b compose --project-directory .local/e2b logs --tail 50 api orchestrator
docker --context colima-always-on-e2b compose --project-directory .local/e2b down
colima stop always-on-e2b
```

普通 `down` 保留数据库、模板和 key。`down -v` 会删除这些卷；不要将它用于日常停止。应用的 Runner、模型凭据和 Pi 原生会话始终留在可信宿主，用户代码仅在 E2B microVM 中执行。
