# TT Bridge — 安全加固改进计划

> 基于一次多 agent 对抗式安全审计(93 agent / 6 攻击面 / 42 条已验证发现)。
> 目标:在**不改变正常用法**的前提下,堵住"本机任意进程 / 恶意网页"能驱动你登录态浏览器这一核心风险,并修若干健壮性 bug。
> 审计结论:**代码无后门、零数据外传**;问题集中在「零鉴权的本地命令通道」+「分发信任模型」。

---

## 一、核心判断(为什么要改)

`daemon` 在 `127.0.0.1` 上开了个 HTTP 端口,`POST /command` **没有任何鉴权、也不检查 Origin/Host**。只要 "Start Serving" 开着:

- **本机任意进程**(npm postinstall、后台 app)扫端口即可发 `exec`,在你登录着的标签页跑任意 JS、读 cookie;
- **你 serving 期间访问的任意网站**可通过跨域「简单请求」CSRF 盲发命令(浏览器读不到响应,但注入的 JS 能自行外传)。

这是设计层的信任缺口(CWE-306 缺失认证 + CSRF/DNS-rebinding),不是某一行的笔误。

---

## 二、改动清单(按优先级 · 勾选=本次已实现)

### P0 — 必须(不做就别对敏感浏览器用)

- [x] **P0-1 命令通道加 token 鉴权**
  daemon 启动生成 256-bit 随机 token → 写 `~/.config/tt-bridge/token`(0600)。
  `/command`、`/shutdown` 要求 `Authorization: Bearer <token>`(timing-safe 比对),否则 401。
  CLI 读同一文件自动带上;扩展不碰这两个端点,故不受影响。
  *落点:* `daemon.mjs`(getOrCreateToken / isAuthorized / 路由守卫)、`cli.mjs`(readToken / fetch header)。
- [x] **P0-2 Host + Origin 检查(堵 CSRF 与 DNS-rebinding)**
  所有 HTTP 请求:`Host` 必须精确是 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`(rebinding 用攻击者域名做 Host → 拒);
  带 `Origin` 且非 `chrome-extension://` 的一律 403(网页 fetch 一定带 http(s) Origin → 拒;合法 CLI 无 Origin、扩展是 chrome-extension Origin → 放行)。
  *落点:* `daemon.mjs` createServer 顶部守卫。
- [~] **P0-3 换分发方式(部分:需作者账号才能上架)**
  上 Chrome 商店(拿签名+审核+自动更新)= 需作者 Google 开发者账号,未做。
  **已附:** `scripts/build-zips.sh` 确定性打包 + `SHA256SUMS.txt` 校验和 + `SECURITY.md` 里写了 `shasum -c` 校验步骤。

### P1 — 强烈建议

- [x] **P1-1 WS `/ext` 拒绝空 Origin**:`if(!origin || !origin.startsWith('chrome-extension://')) destroy()`,堵本地非浏览器客户端冒充扩展。
- [x] **P1-2 cookies 动作收紧**:必须带 `domain`/`url` 过滤(拒绝整库 dump);**httpOnly cookie 不再返回 `value`**。
- [x] **P1-3 停服时 detach 调试器**:`stopServing` 遍历 `attached` 逐个 `chrome.debugger.detach`,消除"停了服务黄条还在、CDP 仍挂着"。
- [x] **P1-4 被取代的扩展连接**:supersede 时立即 `rejectPendingRequests`,不让在途请求空挂到 30s。
- [x] **P1-5 同意 UX**:serving **30 分钟自动过期**(persist + alarm 驱动,抗 SW 回收)+ popup 显示**倒计时** + **已执行命令审计日志**(action/时间/目标,`textContent` 防 XSS)。`background.js` + `popup.html` + `popup-*.js`。(域名白名单留作后续。)
- [x] **P1-6 供应链**:`ws` 精确 pin `8.21.0`;lockfile 已带 integrity;生成 `sbom.cdx.json`(CycloneDX 1.5)。

### P2 — 应做

- [x] **P2-1 `readBody` 大小上限**(>5MB → 413),`pendingRequests`/`extensionWaiters` 封顶(→ 429),防本地内存/句柄 DoS。
- [x] **P2-2 `file://`(及 `view-source:`/`devtools://`)默认拉黑**:防"导航到 file:/// 再注入 JS 读本地文件";去掉重复的 `isDebuggableUrl`。
- [x] **P2-3 端口回退死代码修复**:顶层 `server.on('error')→process.exit(1)` 抢在回退循环前触发,导致 19826 被占时直接崩;改为 listen 成功后再挂持久错误处理。
- [x] **P2-4 navigate 定时器泄漏**:早退后清理 100ms/15s 两个定时器,消除已 settle 后仍打印的假"timed out"。
- [x] **P2-5 console 转发默认关**:`forwardLog` 收窄为默认不外传页面 URL(防日志泄漏),经 flag 才开。
- [x] **P2-6 命令 schema 校验 + 错误分类**:`validateCommand`(白名单 action、类型/数值边界)+ 结构化 `code` 字段(`UNAUTHORIZED/FORBIDDEN/RATE_LIMITED/PAYLOAD_TOO_LARGE/EXT_NOT_CONNECTED/TIMEOUT/BAD_REQUEST`)。
- [x] **P2-7 许可 + 威胁模型**:`LICENSE-MIT.proposed`(建议换掉 CC BY-NC,待作者决策)+ `THREAT_MODEL.md` + `SECURITY.md`。
- [x] **P2-8 测试 + CI**:`test/`(20 用例:daemon HTTP 契约 + 用 `node:vm` 加载**真实扩展 bundle** 验证 file:// / cookie / 校验逻辑)+ `.github/workflows/ci.yml`(syntax+test+确定性重打包)。**TS 源码迁移**属结构性改造,仍留后续。

---

## 三、验证方式

- **Node 侧(daemon+cli)可完整本地验证**:`node --check` 语法;起 daemon 后用 curl 断言
  ① 无 token → 401;② 带 token → 放行/正常路由(无扩展时 503);③ 伪造 Host → 403;
  ④ 带网页 Origin → 403;⑤ `/shutdown` 无 token → 401;⑥ 超大 body → 413。
- **扩展侧(background.js)**:此处只做 `node --check` 语法验证;**运行时行为需在 Chrome 里实测**(detach、cookies 收紧、file:// 拦截),因当前环境无法驱动真实 Chrome —— 已在报告中标注为"待浏览器验证"。

---

## 四、残余风险 / 明确未覆盖

- P0-3 / P1-5 / P1-6 / P2-6~8 需作者侧或 UX 改造,**本地补丁未含**。
- 扩展仍是**未打包加载**,信任模型不变(作者可静默更新)——加固不改变这一点。
- 加固后:CLI 与 daemon 通过共享 token 文件互认;若攻击者已能**读你 home 目录的 0600 文件**,则已越过此防线(那是更高权限的沦陷,不在本层威胁模型内)。

---

## 五、产物

**加固后代码**
- `x-cli/tt-bridge-cli/bin/{daemon,cli}.mjs`、`package.json`(pin ws)
- `x-ext/tt-bridge-chrome-extension/dist/{background.js,popup.html,assets/popup-*.js}`

**测试 / CI / 构建**
- `test/daemon.test.mjs`(HTTP 契约,11 用例)+ `test/extension-logic.test.mjs`(真实 bundle 逻辑,9 用例)—— `npm test` 全绿
- `scripts/check-syntax.mjs`、`scripts/build-zips.sh`(确定性打包)、`.github/workflows/ci.yml`、根 `package.json`

**文档 / 供应链**
- `THREAT_MODEL.md`、`SECURITY.md`、`LICENSE-MIT.proposed`、`PR_DESCRIPTION.md`、`sbom.cdx.json`

**发布物**
- `tt-bridge-cli-hardened.zip` / `tt-bridge-extension-hardened.zip` + `SHA256SUMS.txt`
- `changes.diff` — 相对原版的完整 diff(可直接给作者提 PR)
