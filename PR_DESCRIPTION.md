# 安全加固:本地鉴权 + 防 CSRF/DNS-rebinding + 会话限时 + 测试/CI

## 为什么

daemon 的 `POST /command` 目前**没有任何鉴权、也不校验 Origin/Host**,而它能通过 CDP 在用户**真实登录态标签页**里跑任意 JS、读 cookie。于是只要 serving 开着:

- **本机任意进程**(比如某个 npm 包的 postinstall)扫端口即可驱动浏览器;
- **用户 serving 期间访问的任意网页**可通过跨域「简单请求」CSRF 盲发命令(body 不看 `Content-Type` 直接 `JSON.parse`,无 `Origin`/`Host` 检查)。

目前没有数据外传,但这层「本地零鉴权 + 可被网页 CSRF」是实打实的越权面。本 PR 把它关上,并顺带修了几个健壮性 bug。逐行改动见 `changes.diff`,优先级见 `IMPROVEMENT_PLAN.md`。

## 改了什么

### P0 · 访问控制
- **Bearer token 鉴权**:daemon 启动生成 256-bit token(`~/.config/tt-bridge/token`,`0600`),`/command`+`/shutdown` 强制校验(timing-safe);CLI 自动读同一文件。**扩展只连 WS、不碰这两个端点,因此完全不受影响。**
- **Host + Origin 校验**:每个 HTTP 请求的 `Host` 必须是本机环回权威(防 DNS-rebinding);带网页 `Origin` 的请求一律 403(防 CSRF)。

### P1
- WS `/ext` 拒绝空 / 非 `chrome-extension://` Origin(防本地客户端冒充扩展)。
- `cookies` 动作强制带 domain/url 过滤,且**不再返回 httpOnly 的 value**。
- `stopServing` 现在会 detach 所有调试器(原先黄条 / CDP 会残留)。
- 被取代的旧扩展 socket 立即 reject 在途请求(原先空挂到 30s)。
- **会话 30 分钟自动过期** + popup 倒计时 + 已执行命令**审计日志**。

### P2
- 请求体上限(413)+ pending/waiter 封顶(429)。
- `file://` / `view-source:` / `devtools://` 不再可调试(防注入 JS 读本地文件)。
- **端口回退崩溃修复**:顶层 `error` 处理器 `process.exit(1)` 注册在回退循环之前 → 起始端口被占时 daemon 直接崩;改为 listen 成功后再挂。
- `navigate` 定时器泄漏 + 假 "timed out" 修复。
- 命令 schema 校验 + 结构化错误码;`console.*` 转发默认关(防 URL 泄漏进日志)。
- pin `ws`;补 `THREAT_MODEL.md`/`SECURITY.md`、测试、CI、SBOM、确定性打包脚本。

## 测试

`node --test test/*.test.mjs` —— **20 用例全绿**:daemon HTTP 契约(401/403/413/503/token/shutdown)+ 用 `node:vm` 加载**真实扩展 bundle** 验 file:// 拦截 / cookie 剥离 / 命令校验。CI(`.github/workflows/ci.yml`)跑语法 + 测试 + 确定性重打包。

## 关于结构(请随意裁剪)

我知道你的 repo 是**只放 zip**的极简结构。为了让这个安全 PR **可评审 + 能跑 CI**,我额外提交了解压后的补丁源码(`x-cli/`、`x-ext/`)、测试与 `changes.diff`,并用加固后的内容重打包了 `tt-bridge-cli.zip` / `tt-bridge-extension.zip`(附 `SHA256SUMS.txt`)。**如果你更想保持 zip-only**,完全可以只取重打包的两个 zip + `THREAT_MODEL.md`/`SECURITY.md`,把其余 loose 文件丢掉 —— 按你的习惯重塑即可。

## 一处自我修正(端口回退那条)

崩溃机制是**由代码审查确定**的(顶层 error handler 先于 fallback 注册,`EADDRINUSE` 时先 `process.exit(1)`),修复也**实跑验证**过(起第二个 daemon 占住起始端口,它正确退到下一端口);但我**没有跑原版去观察崩溃**,20 个测试也**尚未覆盖这条 fallback 路径**——回归测试待补。特此说明,不想给你留"言过其实"的印象。

## 许可

改动是你 CC BY-NC 4.0 作品的衍生,归属仍是你;`LICENSE-MIT.proposed` 只是**给你的一个建议**(CC BY-NC 是内容协议,软件通常用 MIT/Apache-2.0),采纳与否完全由你决定。`README.md` 与 `LICENSE` 均未改动。

感谢做了这个工具 🧡
