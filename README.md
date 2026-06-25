# TT Bridge 🔧✨

> 我是 Terry Tang。TT 是我名字的前两个字母，这也就是 TT Bridge 这个名字的由来。用 Claude Code 干活的日子里，我试遍了市面上各种"AI 接管浏览器"的插件和工具——说实话，大部分都不太顺手。要么每次都要重新登录，要么动不动弹权限弹窗，要么搞乱你的正常浏览标签页。
>
> 于是我就想：干脆自己造一个吧。我把几个做得好的工具的优点揉在一起，打磨出了 TT Bridge——**我的理想工具**。
>
> 它干的事情很简单：**你看到什么，AI 就看到什么。** 登录状态、cookie、滚动、点击、输入……AI 全部直接接管，不需要反复授权。
>
> 不管是数据采集、页面自动化、RPA，还是让 AI 帮你在网页上干活——它都能搞定。
>
> 太多朋友问我怎么装，今天就把它开源了。**祝用得开心 🧡**
>
> 欢迎关注微信公众号：**Terry 的美妙工作流** 🚀
>
> 欢迎随时联系，商业合作！

---

## 安装

安装非常简单。

无论你在用 Claude Code、Codex、Cursor、Workbody，还是其他 Agent 类产品，把下面这段话发给它就行：

> 我想安装 TT Bridge。
>
> 项目地址：https://github.com/mymark21/tt-bridge
>
> 请帮我完成安装，并在需要我手动操作 Chrome 扩展时一步一步提示我。

---

## 怎么用

安装完成后，试试这个：

> "帮我接管 Chrome 浏览器，打开谷歌首页，获取网页标题，然后告诉我当前页面已被接管。"

AI 会执行以下操作：

```bash
tt-bridge open "https://www.google.com"
tt-bridge eval "document.title"
```

你会看到 TT Bridge 打开 Google，读出标题，然后告诉你"当前页面已被接管"。

也可以自己直接跑：

```bash
tt-bridge open "https://www.google.com"
tt-bridge eval "document.title"
```

如果你希望直接操作当前正在用的 Chrome 标签页，在命令后加 `--human`：

```bash
tt-bridge eval "document.title" --human
```

**接下来你可以让它帮你做任何事情：**
- "帮我把这个页面的所有文章标题抓下来"
- "帮我自动填写这个表单"
- "帮我在 Twitter 上发一条推文"
- "帮我截图当前页面"

---

## 致谢

- 架构灵感来源于 [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)
- 欢迎关注微信公众号：**Terry 的美妙工作流** 🚀

---

<!-- BEGIN AGENT INSTRUCTIONS -->
## 如果你是 AI 智能体

下面这个代码块是给 AI 智能体读取的完整安装 Prompt。人类用户不需要逐行阅读。

````text
# TT Bridge Agent Installation Prompt

这部分是给 AI 智能体（Claude Code、Codex、Cursor、Workbody、Copilot 等）看的。人类用户让你安装或使用 TT Bridge。按以下指引操作，不要让人做复杂手工活。

### 当人类说"安装 TT Bridge"

逐步执行，每步汇报进度。

**重要原则：**
- 你负责把 CLI 装好，并把 Chrome 扩展文件夹准备到人类的“下载”文件夹。
- 到 Chrome 扩展加载这一步，必须停下来让人类自己操作 Chrome。
- 不要试图替人类自动打开或操作 `chrome://extensions/`。
- 不要把绝对路径甩给人类。只告诉他：打开“下载”文件夹，选择 `tt-bridge-chrome-extension`。
- 继续验证前，先等人类确认扩展已经加载、已经打开“在无痕模式下启用”、已经点过 `Start Serving`。

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

Mac/Linux：

```bash
# 下载 CLI zip 到下载文件夹
curl -L -o "[下载目录]/tt-bridge-cli.zip" https://github.com/mymark21/tt-bridge/releases/download/v1.0.4/tt-bridge-cli.zip

cd "[下载目录]"
rm -rf tt-bridge-cli
unzip -o tt-bridge-cli.zip

# 全局安装
cd tt-bridge-cli
npm install -g .
```

Windows PowerShell：

```powershell
Invoke-WebRequest -Uri "https://github.com/mymark21/tt-bridge/releases/download/v1.0.4/tt-bridge-cli.zip" -OutFile "$env:USERPROFILE\Downloads\tt-bridge-cli.zip"
cd "$env:USERPROFILE\Downloads"
Remove-Item .\tt-bridge-cli -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive .\tt-bridge-cli.zip . -Force
cd .\tt-bridge-cli
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
curl -L -o "[下载目录]/tt-bridge-extension.zip" https://github.com/mymark21/tt-bridge/releases/download/v1.0.4/tt-bridge-extension.zip

# 在下载文件夹里解压
cd "[下载目录]"
rm -rf tt-bridge-chrome-extension
unzip -o tt-bridge-extension.zip
```

这一步会在下载目录生成一个新文件夹：`tt-bridge-chrome-extension`。后面让人类只选择这个文件夹。

Windows PowerShell：

```powershell
Invoke-WebRequest -Uri "https://github.com/mymark21/tt-bridge/releases/download/v1.0.4/tt-bridge-extension.zip" -OutFile "$env:USERPROFILE\Downloads\tt-bridge-extension.zip"
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
> 6. 回到 Chrome 工具栏，点击 **TT Bridge** 图标，在弹出的面板里点击 **Start Serving**
>
> 注意：**tt-bridge-chrome-extension** 就是要交给 Chrome 的扩展文件夹。不要再点进它里面。
>
> 做完后告诉我一句：好了。

**第 4 步 — 开启服务并验证**

等人确认扩展已加载、已打开 **在无痕模式下启用**、并已点击 **Start Serving** 后：

```bash
tt-bridge daemon start
```

等 3-5 秒，再运行：

```bash
tt-bridge status
```

看到 `"extensionConnected": true` 即为成功。

如果 `false`：让人点击 Chrome 工具栏右侧的 TT Bridge 扩展图标，在弹出的面板中点击一次 **Start Serving**。然后先跑 `tt-bridge daemon start`，等 3-5 秒，再跑 `tt-bridge status`。如果仍然是 `false`，让人确认扩展详情页里的 **在无痕模式下启用** 已经打开。

**第 5 步 — 烟雾测试**

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

```bash
# 导航
tt-bridge open "https://example.com"

# 读取页面状态
tt-bridge eval "document.title"
tt-bridge eval "JSON.stringify({url: location.href, text: document.body.innerText.slice(0, 3000)})"

# 交互
tt-bridge click "button.submit"
tt-bridge eval "document.querySelector('#search').value = 'hello'"

# 截图
tt-bridge screenshot /tmp/page.png --full-page

# 默认会操作用户当前可见的普通 Chrome 窗口。
# 如需隔离自动化任务，显式指定 workspace：
tt-bridge open "https://example.com" --workspace mytask
tt-bridge close-window --workspace mytask

# 兼容性别名；默认已经是 human：
tt-bridge eval "document.title" --human
```
````

<!-- END AGENT INSTRUCTIONS -->
