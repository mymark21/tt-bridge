# TT Bridge

### 你看到什么，AI 就看到什么。

**让 AI 直接接管你正在使用的 Chrome——带着登录态、标签页和真实窗口。不重开浏览器，不导出 Cookie，不反复授权。**

[![Release](https://img.shields.io/github/v/release/mymark21/tt-bridge?label=release&color=111111)](https://github.com/mymark21/tt-bridge/releases/latest)
[![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0-111111)](LICENSE)
![Chrome](https://img.shields.io/badge/Chrome-extension-4285F4?logo=googlechrome&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-111111)

**简体中文** · [English](README.en.md)

**[快速开始](#快速开始)** · **[能做什么](#能做什么)** · **[工作原理](#工作原理)** · **[安全与隐私](#安全与隐私)** · **[文档](#文档)** · **[更新日志](CHANGELOG.md)**

---

## TT Bridge 是什么

TT Bridge 由三部分组成：一个 Chrome 扩展、一个只监听本机的 daemon、一个给 AI 调用的 CLI。AI 通过 CLI 发命令，daemon 把命令转给扩展，扩展再用 `chrome.debugger`（CDP）操作你当前打开的 Chrome。

它不启动新的无头浏览器，也不要求你把 Cookie 导出给别的程序。你在浏览器里登录了什么，AI 就能看到什么；你把哪个标签页交给它，它就操作哪个标签页。

```
Claude Code / Codex / Cursor / 其他 Agent
        │  tt-bridge CLI
        ▼
本机 daemon（127.0.0.1:19826–19835）
        │  WebSocket
        ▼
Chrome 扩展（chrome.debugger / CDP）
        │
        ▼
你正在使用的 Chrome 标签页
```

所有组件都跑在你的机器上。TT Bridge 没有云端账号，也没有中转服务器。

## 适合谁

**适合：**

- 任务依赖你已经登录的账号——后台系统、SaaS、社交平台、内部工具。
- 你希望 AI 操作你眼前的窗口，而不是另一个看不见的浏览器。
- 你在用 Claude Code、Codex、Cursor 或其他能执行命令的 Agent。
- 你需要把网页操作沉淀成可重复的流程：抓取、填表、截图、RPA。

**不适合：**

- 需要云端浏览器农场、大规模并发或多人共享的自动化。
- 无法在本机运行 Node.js 服务。
- 需要完全隔离、不接触真实登录态的爬虫——这类任务用 Playwright 之类的工具更合适。

## 快速开始

### 让 AI 帮你安装（推荐）

把下面这段话发给你的 AI：

> 我想安装 TT Bridge。
>
> 项目地址：https://github.com/mymark21/tt-bridge
>
> 注意：CLI 必须从这个 GitHub Release 里的 zip 安装包安装，不要用 npm/npx 上的同名 `tt-bridge` 包。
>
> 请帮我完成安装，并在需要我手动操作 Chrome 扩展时一步一步提示我。完整步骤见 README 末尾的「给 AI 智能体的完整安装指令」。

AI 会完成 CLI 安装、扩展包下载和后台验证。你只需要做两件事：

1. 在 `chrome://extensions` 打开开发者模式，加载解压后的 `tt-bridge-chrome-extension` 文件夹。
2. 在扩展面板点一次 **允许 AI 控制**。

<details>
<summary>手动安装（不经过 AI）</summary>

**前置条件**：Chrome；Node.js ≥ 18。

> Windows 用户：对应的 PowerShell 命令见文末「给 AI 智能体的完整安装指令」第 2、3 步。

**1. 安装 CLI**

```bash
curl -L -o tt-bridge-cli.zip https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-cli.zip
unzip -o tt-bridge-cli.zip
cd tt-bridge-cli
npm install -g .
tt-bridge --help
```

> zip 里已经包含 daemon 需要的 `ws` 依赖。不要用 npm registry 上的同名 `tt-bridge` 包，也不要 `npx tt-bridge`。

**2. 安装 Chrome 扩展**

```bash
curl -L -o tt-bridge-extension.zip https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-extension.zip
unzip -o tt-bridge-extension.zip
```

打开 `chrome://extensions` → 打开 **开发者模式** → **加载未打包的扩展程序** → 选择解压出来的 `tt-bridge-chrome-extension` 文件夹。加载后点扩展面板里的 **允许 AI 控制**。

**3. 启动并验证**

```bash
tt-bridge daemon start
tt-bridge status --json
```

看到 `"extensionConnected": true` 即接通。

</details>

## 第一次接管

首次安装时，在扩展面板点一次 **允许 AI 控制**，扩展会连上本机 daemon。连上之后，主按钮变成 **复制连接指令**：

1. 点 **复制连接指令**；
2. 把复制到的内容粘贴给 AI；
3. AI 按指令切换实例 / 窗口 / 标签页并固定目标，后续命令都作用在这个标签页上。

不需要每做一个任务就回浏览器开关扩展，也不用反复授权。面板上的 **暂停** 只是临时断开；绿色盾牌标记当前被接管的标签页，AI 操作时的光晕让你一眼看到它正在哪里工作。

如果电脑重启后本地服务还没启动，面板会显示 **等待服务**：点 **复制启动指令**，把内容粘贴给 AI，AI 会运行 `tt-bridge daemon start`；服务起来后扩展自动接通，不需要回面板再点。

## 能做什么

| 能力 | 说明 |
| --- | --- |
| **真实浏览器接管** | 默认 `human` 模式，直接操作你当前可见的 Chrome；登录态、Cookie、扩展和页面状态全部复用。 |
| **目标锁定** | `instance` / `window` / `tab pin` 三层粘性状态。目标离线时保留墓碑并明确报错，不静默漂移到别的 Profile。 |
| **多 Profile / 多窗口** | 跨 Profile 列出窗口、秒级切换、按需置顶；扩展热重载不用逐个 Profile 去 `chrome://extensions` 点刷新。 |
| **原生键盘输入** | `focus` / `type` / `key` 通过 CDP 发送可信输入事件，能往 Slate、ProseMirror、Medium、Notion 等富文本编辑器里真实打字。 |
| **视口仿真** | 8 款手机 / 平板预设，也可自定义宽高、DPR、touch、User-Agent；截图可单次套用设备预设。 |
| **截图** | 整页、指定视口、移动端；目标窗口最小化时可 `--restore` 先恢复再截。 |
| **Cookie 查看** | `cookies` 默认掩码，只有 `--show-values` 才输出明文。 |
| **站点经验库** | 把某个站点的步骤、坑和脚本沉淀到本地，下次自动提示、可复用。 |
| **安全默认** | 仅监听回环地址、Bearer token、Host / Origin 校验、日志脱敏、`/status` 脱敏。 |

常用命令：

```bash
tt-bridge status                     # 服务与扩展连接状态
tt-bridge tab list                   # 列出真实浏览器里的标签页
tt-bridge tab pin --tab 123          # 把后续命令固定到这个标签页
tt-bridge open "https://example.com"
tt-bridge eval "document.title"
tt-bridge screenshot page.png --full-page
tt-bridge type "这是一段文字"; tt-bridge key Enter
tt-bridge emulate iphone14           # 套用移动端视口
tt-bridge window list                # 跨 Profile 查看所有窗口
tt-bridge instance list              # 查看已连接的 Chrome 实例
```

## 工作原理

**Chrome 扩展**持有 debugger 连接，执行 CDP 命令，并把连接状态、目标标签页和 AI 活动状态显示在面板里。

**本机 daemon**在 `127.0.0.1:19826–19835` 上提供 HTTP + WebSocket 接口。它负责发现端口、校验 token、把命令路由到正确的扩展实例，并保存 pin 与墓碑状态。Chrome 的 MV3 service worker 会休眠，daemon 提供一个稳定端点，让 CLI 不必关心扩展何时醒来。

**CLI** 是 AI 实际调用的入口。它只连接本机 daemon，读取 `~/.config/tt-bridge/token`，把命令以 JSON 发出去。

端口从 `19826` 开始，被占用时自动向后寻找，直到 `19835`。除 `/ping`、`/status` 外，所有路由都要求 Bearer token。

## 安全与隐私

- daemon 只绑定 `127.0.0.1`，不暴露到局域网。
- 除发现接口外，所有路由要求 `~/.config/tt-bridge/token` 的 Bearer token；token 文件权限 `0600`。
- 校验 loopback `Host`，拒绝浏览器 `Origin`；HTTP body 上限 5 MiB，WebSocket frame 上限 100 MiB，并发命令上限 256。
- `/status` 只返回脱敏后的 Profile 信息：邮箱、gaia id、显示名都不会原样出现。
- 扩展转发的日志会去掉 Bearer、token / cookie 赋值和 URL query；daemon 日志文件权限 `0600`。
- Cookie 默认掩码；experience trace 只存脱敏后的 `eval` 片段和去掉 query 的 URL。
- 调试与导航拒绝 `chrome://`、`chrome-extension://`、`file://`、`view-source:`、`devtools://`；`navigate` 只接受 `http(s)` 和 `about:blank`。
- 停止服务会 detach 所有 debugger，不留下「正在调试」横幅。
- TT Bridge 本身不上传数据；但 AI 读取的页面内容是否会发给模型，取决于你使用的 AI 工具。

已知边界：扩展的 `/ext` WebSocket 不是双向认证。不要暴露 daemon 端口、不要做隧道、不要在共享主机上运行。完整威胁模型和报告方式见 [SECURITY.md](SECURITY.md)。

## 和常见方案的区别

| 方案 | 差异 |
| --- | --- |
| **Playwright / Puppeteer** | 从干净会话启动新浏览器；TT Bridge 接管你已经在用的 Chrome，登录态和扩展都在。 |
| **云端浏览器 / 托管抓取 API** | 页面和 Cookie 经过第三方；TT Bridge 的 daemon 只监听本机，没有中转。 |
| **部分浏览器接管扩展** | 往往每次任务都要重新点授权；TT Bridge 一次允许后，用「复制连接指令」交接目标。 |

## 文档

| 文档 | 内容 |
| --- | --- |
| [SKILL.md](SKILL.md) | 给 Agent 的完整使用说明：目标锁定、命令、经验库、故障处理。 |
| [SECURITY.md](SECURITY.md) | 威胁模型、安全设计、已知边界和漏洞报告方式。 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更。 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发、测试和提交约定。 |
| [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md) | 公开源码与构建产物的对应关系。 |
| [PORTING.md](PORTING.md) | 公开版与开发版的移植边界。 |
| [experience/README.md](experience/README.md) | 站点经验库的格式与用法。 |

## 项目状态

- 当前公开版本：**v1.4.5**。
- 仓库只包含源码。`tt-bridge-extension.zip`、`tt-bridge-cli.zip` 和 `SHA256SUMS.txt` 由 GitHub Actions 在 `v*` tag 上构建并挂到 Release，不提交进仓库。
- 这是免费核心。云端同步、团队共享、托管站点包、远程中继、审计 / SSO / RBAC、编排、录制回放等商业功能不在这个仓库里。公开版会持续移植免费功能和安全修复，边界见 [PORTING.md](PORTING.md)。

## 反馈与贡献

- **Bug / 功能建议**：开 GitHub Issue。
- **安全漏洞**：不要开公开 issue，按 [SECURITY.md](SECURITY.md) 走私密报告。
- **Pull Request**：先开 issue 说明场景，改动尽量聚焦；提交前跑 [CONTRIBUTING.md](CONTRIBUTING.md) 里的测试。
- 如果 TT Bridge 帮你省掉了重复登录和授权，点一个 Star 就是最大的支持。

## 致谢

- 架构灵感来源于 [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)。

## License

[CC BY-NC 4.0](LICENSE)。可以复制、修改、分发，需署名，不得用于商业用途；商业使用需联系维护者单独授权。

---

<!-- BEGIN AGENT INSTRUCTIONS -->
## 给 AI 智能体的完整安装指令

<details>
<summary>展开：完整安装 Prompt（人类用户不需要阅读）</summary>

````text
# TT Bridge Agent Installation Prompt

这部分是给 AI 智能体（Claude Code、Codex、Cursor、Workbody、Copilot 等）看的。人类用户让你安装或使用 TT Bridge。按以下指引操作，不要让人做复杂手工活。

### 当人类说"安装 TT Bridge"

逐步执行，每步汇报进度。

**重要原则：**
- 你负责把 CLI 装好，并把 Chrome 扩展文件夹准备到人类的“下载”文件夹。
- **所有命令行操作都由你（AI）在后台亲自执行。** 包括但不限于：下载、解压、`npm install`、`tt-bridge --help`、`tt-bridge daemon start`、`tt-bridge status`、烟雾测试命令。
- **任何情况下都不要把命令行内容展示给人类。** 不要贴 shell / PowerShell / 终端命令，不要写“请运行以下命令”“完成后执行 `tt-bridge ...`”。
- 人类看不到、也不需要理解命令行。你自己执行、自己验证，最后只把结果告诉人类。
- 人类只做两件事：在 Chrome 图形界面里加载扩展，并在首次使用时点一次 `允许 AI 控制`。之后每次接管，人类只需要点面板上的 `复制连接指令` 把口令粘贴给你。安装、启动、验证、后台守护进程全部由你完成。
- TT Bridge 的 CLI 必须从本项目 GitHub Release 里的 `tt-bridge-cli.zip` 安装包安装。
- 不要使用 `npx tt-bridge`，也不要执行 `npm install -g tt-bridge` 去安装 npm registry 上的同名包。npm 上的同名包不是这个浏览器桥。
- 下文的 `npm install -g .` 是在解压出来的本地 `tt-bridge-cli` 文件夹里注册命令，不是从 npm 公网安装 `tt-bridge`。
- Chrome 扩展必须从本项目 GitHub Release 里的 `tt-bridge-extension.zip` 安装包解压后加载。
- 到 Chrome 扩展加载这一步，必须停下来让人类自己操作 Chrome。
- 不要试图替人类自动打开或操作 `chrome://extensions/`。
- 不要把绝对路径甩给人类。只告诉他：打开“下载”文件夹，选择 `tt-bridge-chrome-extension`。
- 继续验证前，先等人类确认扩展已经加载、已经打开“在无痕模式下启用”、并已在面板里点过一次 `允许 AI 控制`。人类回复后，你在后台自己执行 `tt-bridge daemon start` 和 `tt-bridge status`，只把验证结果告诉人类，不要把这些命令展示出来。

**默认目标策略：**
- TT Bridge 默认接管用户当前可见的普通 Chrome 窗口。
- 不要把单独创建的无痕自动化窗口当成 human-browser 安装成功。
- 安装验证时，先让用户切到他希望被接管的 Chrome 窗口。
- 烟雾测试应该在这个普通 Chrome 窗口中新建标签页，不应该打开单独的无痕自动化窗口。
- 只有用户显式指定 `--workspace <name>` 时，才进入隔离自动化 workspace；非 human workspace 可以继续创建专用无痕窗口。
- `--human` 只是兼容性别名；默认已经是 human。

**下载路径规则：**
- Mac：`~/Downloads/`
- Windows：`%USERPROFILE%\Downloads\`
- 下文用 `[下载目录]` 代替，执行时替换为对应系统路径。

**第 1 步 — 确保 Node.js 已安装（≥ 18）**

```bash
node --version
```

如果没装：
- **Mac**：`brew install node`
- **Windows**：去 https://nodejs.org 下载安装包

**第 2 步 — 下载并安装 CLI**

CLI zip 已包含 daemon 运行所需的 `ws` 依赖。解压后优先执行 `npm install -g .` 注册 `tt-bridge` 命令。

注意：这里的 `npm install -g .` 最后有一个点，意思是“安装当前解压出来的本地文件夹”。不要写成 `npm install -g tt-bridge`，那会去 npm 公网安装另一个同名包。

Mac/Linux：

```bash
# 下载 CLI zip 到下载文件夹
curl -L -o "[下载目录]/tt-bridge-cli.zip" https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-cli.zip

cd "[下载目录]"
rm -rf tt-bridge-cli
unzip -o tt-bridge-cli.zip

# 从当前本地文件夹注册 tt-bridge 命令；不要写成 npm install -g tt-bridge
cd tt-bridge-cli
npm install -g .
```

Windows PowerShell：

```powershell
Invoke-WebRequest -Uri "https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-cli.zip" -OutFile "$env:USERPROFILE\Downloads\tt-bridge-cli.zip"
cd "$env:USERPROFILE\Downloads"
Remove-Item .\tt-bridge-cli -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive .\tt-bridge-cli.zip . -Force
cd .\tt-bridge-cli
# 从当前本地文件夹注册 tt-bridge 命令；不要写成 npm install -g tt-bridge
npm install -g .
```

如果 Windows PowerShell 报 `npm.ps1` 被执行策略阻止，不要判断为安装包损坏。改用：

```powershell
cmd /c npm install -g .
```

验证：

```bash
tt-bridge --help
```

**第 3 步 — 下载并安装 Chrome 扩展**

Mac/Linux：

```bash
# 下载扩展 zip 到下载文件夹
curl -L -o "[下载目录]/tt-bridge-extension.zip" https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-extension.zip

# 在下载文件夹里解压
cd "[下载目录]"
rm -rf tt-bridge-chrome-extension
unzip -o tt-bridge-extension.zip
```

这一步会在下载目录生成一个新文件夹：`tt-bridge-chrome-extension`。后面让人类只选择这个文件夹。

Windows PowerShell：

```powershell
Invoke-WebRequest -Uri "https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-extension.zip" -OutFile "$env:USERPROFILE\Downloads\tt-bridge-extension.zip"
cd "$env:USERPROFILE\Downloads"
Remove-Item .\tt-bridge-chrome-extension -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive .\tt-bridge-extension.zip . -Force
```

这一步会在下载目录生成一个新文件夹：`tt-bridge-chrome-extension`。后面让人类只选择这个文件夹。

告诉人类前，先确认下载目录里确实有这个文件夹：

Mac/Linux：

```bash
ls "[下载目录]" | grep tt-bridge-chrome-extension
```

Windows PowerShell：

```powershell
Test-Path "$env:USERPROFILE\Downloads\tt-bridge-chrome-extension"
```

如果没有看到 `tt-bridge-chrome-extension`，不要让人类去 Chrome 里找。先重新下载并解压扩展包，再确认一次下载目录里已经有这个文件夹。

然后告诉人类（逐字显示）：

> 现在需要在 Chrome 中加载扩展：
>
> 1. 打开 Chrome，地址栏输入 **chrome://extensions/** 回车
> 2. 打开右上角 **开发者模式** 开关
> 3. 点击左上角 **加载未打包的扩展程序**
> 4. 在弹出的文件选择窗口中，进入你的**下载文件夹**，选择 **tt-bridge-chrome-extension** 这个文件夹；如果人类习惯拖拽，也可以让他把这个文件夹直接拖到扩展页里
> 5. 加载成功后，在扩展列表找到 **TT Bridge**（深色圆角方块图标），点击 **详情**，打开 **在无痕模式下启用**
> 6. 回到 Chrome 工具栏，点击 **TT Bridge** 图标，在弹出的面板里点击 **允许 AI 控制**（只需第一次；连上后面板主按钮会变成 **复制连接指令**）
>
> 注意：**tt-bridge-chrome-extension** 就是要交给 Chrome 的扩展文件夹。不要再点进它里面。
>
> 做完后告诉我一句：好了。

**第 4 步 — 开启服务并验证**

等人确认扩展已加载、已打开 **在无痕模式下启用**、并已点击 **允许 AI 控制** 后，你在后台自己运行下面的命令；这些命令只给你自己看，不要贴给人类：

```bash
tt-bridge daemon start
```

等 3-5 秒，再在后台自己运行：

```bash
tt-bridge status
```

看到 `"extensionConnected": true` 即为成功。这时只告诉人类结果，例如：“扩展已连接，服务已启动。”

如果 `false`：让人点击 Chrome 工具栏右侧的 TT Bridge 扩展图标。面板显示 **允许 AI 控制** 就点一次；显示 **复制连接指令** 就点一下并把复制到的内容发给你，你按里面的命令完成接管。然后你继续在后台自己跑 `tt-bridge daemon start`，等 3-5 秒，再跑 `tt-bridge status`。如果仍然是 `false`，让人确认扩展详情页里的 **在无痕模式下启用** 已经打开。全程不要向人类展示任何命令行内容。

**第 5 步 — 烟雾测试**

下面命令全部由你在后台亲自跑；不要贴给人类，只把最终结果告诉人类：

```bash
tt-bridge daemon start
tt-bridge status --json
tt-bridge tab new https://www.google.com --json
tt-bridge eval "JSON.stringify({url: location.href, title: document.title})"
tt-bridge sessions --json
```

验收条件：
- `status --json` 里必须看到 `"extensionConnected": true`
- 新标签页必须出现在用户当前可见的普通 Chrome 窗口
- `eval` 结果里应该能读到 Google 的 URL 和标题
- `sessions --json` 不应该因为这次 human-browser 验证产生 `incognito: true`
- 如果出现 `incognito: true` 自动化 session，说明验证失败：你接管的是自动化窗口，不是用户眼前的普通 Chrome

告诉人类：
> "TT Bridge 已安装完成，当前页面已被接管。你现在可以让我浏览网页、操作页面、抓取数据了。"
>
> 然后追问：
> "需要我把当前的启动并接管浏览器的方式新建为一个 Skill，并起名为 ttbridge 吗？这样以后你只需要说「启动 ttbridge」，我就能自动完成所有的启动和接管流程。"

### 核心使用模式

人类从面板复制给你的接管口令通常是 `tt-bridge instance use ...`、`tt-bridge window use ...`、`tt-bridge tab pin --tab ...` 这几条。按顺序执行即可把后续命令固定到人类眼前的标签页；`tab pin` 之后不要随便切窗口。

```bash
# 导航
tt-bridge open "https://example.com"

# 读取页面状态
tt-bridge eval "document.title"
tt-bridge eval "JSON.stringify({url: location.href, text: document.body.innerText.slice(0, 3000)})"

# 交互
tt-bridge click "button.submit"
tt-bridge eval "document.querySelector('#search').value = 'hello'"

# 原生键盘输入管线：往富文本编辑器里真实输入
tt-bridge focus "div[contenteditable='true']"    # 让目标元素取得原生焦点
tt-bridge type "这是一段评论内容。"               # 注入可信文本（触发真实 input 事件）
tt-bridge key Enter                               # 发送特殊按键（Enter/Tab/Backspace/Escape）

# 移动端与多设备视口仿真
tt-bridge emulate iphone14                        # 套用内置设备预设
tt-bridge emulate 390 844 --dpr 3 --mobile        # 自定义宽高、DPR、mobile
tt-bridge emulate reset                           # 恢复桌面默认视口与 UA

# 截图（可用 --device / --viewport 做单次仿真截图，截完自动 reset）
tt-bridge screenshot /tmp/page.png --full-page
tt-bridge screenshot /tmp/mobile.png --device iphone14
tt-bridge screenshot /tmp/wide.png --viewport 1280x720
tt-bridge screenshot /tmp/page.png --restore      # 目标窗口最小化时先恢复 normal 再截图（仅 human 模式）

# 多窗口与多 Profile 切换（v1.4.0 引入）
tt-bridge window list                             # 列出跨 Profile 的所有窗口（IDX / 实例 / Profile / 标签 / 活动页）
tt-bridge window use 0                            # 切换目标窗口（默认不抢焦点）
tt-bridge window use 1 --focus                    # 切换并请求置顶目标窗口
tt-bridge window focus 1                          # 等价于 use --focus
tt-bridge window status                           # 查看当前目标窗口详情
tt-bridge profile list                            # 列出本机 Chrome 所有 Profile 及连接状态
tt-bridge reload --all                            # 热重载所有已连接 Profile 的扩展
tt-bridge reload --instance <label>               # 热重载指定 Profile 的扩展

# Cookie 查看（value 默认掩码，--show-values 打印明文=真实会话凭据，别贴进日志/模型上下文）
tt-bridge cookies --domain localhost
tt-bridge cookies --domain localhost --show-values --json

# 默认 workspace 为 human，会操作用户当前可见的普通 Chrome 窗口。
# 如需隔离自动化任务，显式指定 workspace：
tt-bridge open "https://example.com" --workspace mytask
tt-bridge close-window --workspace mytask

# 兼容性别名；默认已经是 human：
tt-bridge eval "document.title" --human
```


### 内置设备预设

| 预设名 | 规格 |
|--------|------|
| `iphone14` | 390×844，DPR 3 |
| `iphone14pro` | 393×852，DPR 3 |
| `iphone14promax` | 430×932，DPR 3 |
| `iphonese` | 375×667，DPR 2 |
| `ipad` | 820×1180，DPR 2 |
| `ipadpro` | 1024×1366，DPR 2 |
| `pixel7` | 412×915，DPR 2.625 |
| `galaxys23` | 360×780，DPR 3 |

移动端预设默认开启 `mobile` 与 `touch`，并附带对应的移动端 User-Agent。`emulate` 支持 `--dpr <n>`、`--mobile`、`--touch`、`--user-agent <str>` 覆盖预设值；显式尺寸与预设参数冲突时，以显式参数为准。预设名不区分大小写与分隔符，`iPhone 14 Pro`、`iphone-14-pro`、`iphone14pro` 均可匹配。
````

</details>
<!-- END AGENT INSTRUCTIONS -->
