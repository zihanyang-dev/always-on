# Always On 术语表

Always On 接收来自不同渠道的事件，让已交办的工作可以随新输入继续推进。

## 术语

**用户（User）**

Always On 内参与工作和协作的身份。Workspace 成员资格属于用户。

**登录账号（Login Account）**

用于证明用户身份的登录方式，例如邮箱密码、GitHub 或 Google。一个用户可以绑定多个登录账号。

**Workspace**

管理成员与角色的协作范围。用户可以同时参与多个 Workspace，每个 Workspace 内有各自的角色。

**Workspace 成员资格（Workspace Membership）**

用户在某个 Workspace 中的唯一关系，记录该用户的角色和加入时间。移除成员资格会撤销该用户在这个 Workspace 的访问权限。

**Workspace 邀请（Workspace Invitation）**

发给一个邮箱的加入请求。使用已验证的对应邮箱接受邀请后，系统把邀请标记为已接受，并在同一个事务中创建成员资格。

**工作（Work）**

有独立目标和完成条件的一项委派。它可以由多次输入和执行推进，也可以关联多个渠道中的讨论。

**执行（Run）**

Agent 为推进一项工作所做的一轮执行。一项工作可以有多轮执行。

**渠道（Channel）**

Always On 接收外部事件及发送消息的途径，例如 GitHub 或飞书。渠道拥有外部事件身份、讨论位置、回复地址和投递结果。事件与工作的关联由 Work 持有。

**渠道连接（Channel Connection）**

某个 Workspace 启用的一项具体渠道接入，例如一次 GitHub App 安装或一个飞书机器人连接。
