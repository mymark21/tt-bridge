# TT Bridge · 威胁模型

TT Bridge 让本机 AI agent 通过一个本地 daemon + 浏览器扩展来驱动 Chrome。它的能力(在你**真实登录态**标签页里跑任意 JS + 读 cookie + 截图)正是它的风险面。本文说明:什么是被信任的、什么是被防护的、什么仍是使用者的责任。

## 组件与信任边界

```
 CLI / agent  --HTTP(127.0.0.1:19826-35)-->  daemon  --WS(/ext)-->  扩展  --CDP-->  Chrome 标签页
   (持 token)          [B1]                           [B2]                   [B3]
```

- **B1 — HTTP 环回(CLI ↔ daemon)**:任何能连上环回端口的进程。单用户桌面上 = "任何以你身份运行的进程"。
- **B2 — WebSocket(daemon ↔ 扩展)**:扩展主动外连 daemon。
- **B3 — CDP(扩展 ↔ 标签页)**:`chrome.debugger` → `Runtime.evaluate`、`chrome.cookies`、`Page.captureScreenshot`。这是对页面及其会话的**完全控制**。

## 资产

- 用户的**已登录 Web 会话**(邮箱、银行、SaaS、公司 SSO)—— 经 human 工作区。
- **httpOnly 会话 cookie**。
- **本地文件**(若标签页能被指向 `file://`)。
- 用户的**注意力 / 知情权**(必须知道浏览器正在被驱动)。

## 攻击者

- **同机进程** —— 木马、恶意 npm postinstall、其他以你身份运行的 app。
- **恶意网页** —— serving 期间你访问的任意站点(对环回 daemon 的 CSRF / DNS-rebinding)。
- **供应链攻击者** —— 被篡改的下载,或未来某次恶意的扩展更新。
- **不在范围内**:远程网络攻击者(daemon 只绑 `127.0.0.1`);以及已能读你 `0600` 文件的 root / 高权限攻击者。

## 本加固版已实现的防御

| 边界 | 攻击 | 防御 |
|---|---|---|
| B1 | 任意本地进程发命令 | **Bearer token**:daemon 启动生成、存 `~/.config/tt-bridge/token`(0600),`/command`+`/shutdown` 必需(timing-safe 比对) |
| B1 | 网页 CSRF(简单请求) | 拒绝任何带非 `chrome-extension://` **Origin** 的请求(403) |
| B1 | DNS-rebinding | 拒绝 **Host** ≠ 本机环回权威的请求(403) |
| B1 | 内存 / 句柄 DoS | 请求体上限(413)、在途 / 等待封顶(429) |
| B2 | 非浏览器客户端冒充扩展 | WS 升级要求 `chrome-extension://` Origin(空 Origin 拒) |
| B3 | 经 `file://` 读本地文件 | `isDebuggableUrl` 拉黑 `file://` / `view-source:` / `devtools://` |
| B3 | httpOnly cookie 窃取 | `cookies` 强制带过滤,且不返回 httpOnly 的 value |
| B3 | 隐蔽 / 不透明的控制 | Chrome 调试黄条(始终在)+ 会话倒计时、自动过期、popup 审计日志 |

## 残余风险(使用者的责任)

1. **任何以你身份运行的代码仍能读到 token 文件**、从而驱动浏览器(serving 开着时)。token 防的是**无此权限**的同类进程,不是有你文件系统权限的代码。
2. **扩展是未打包加载** —— 无商店审核,且发布更新者可改其行为。每次更新请核对源码 + 校验和(`SHA256SUMS.txt`)。
3. **human 工作区 = 你的真实会话**。请用一个**没登敏感账号**的专用 Chrome profile 跑;不用时关掉 serving(有 30 分钟自动过期兜底)。
4. **`AGENT_BROWSER_BRIDGE_HOST=0.0.0.0`** 会把它暴露到局域网。别设。

## 上报

见 [SECURITY.md](SECURITY.md)。
