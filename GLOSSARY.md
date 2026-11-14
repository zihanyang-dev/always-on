# Always On

本平台中的用户身份与持续工作使用以下术语，避免把登录状态、人的团队和 Agent 协作混在一起。

## 身份

**User（用户）**：使用平台的人；同一个用户可以绑定多个登录方式。
_Avoid_：用 Account 同时表示用户和登录方式。

**Login Account（登录账号）**：绑定到用户的一种登录身份，例如邮箱密码、Google 或 GitHub 身份。
_Avoid_：用 User 指代某个 OAuth provider 的账号记录。

**Login Session（登录会话）**：用户一次登录后获得的、可以撤销的访问状态。
_Avoid_：在与 Agent 会话混用时省略 Login。

## 持续工作

**Session（Agent 会话）**：Agent 为一段持续工作保留的对话与执行上下文。
_Avoid_：用它指代浏览器登录会话。
