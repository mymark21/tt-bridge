# TT Bridge 🔧✨

> 我是 [Terry Tang](https://github.com/mymark21)。用 Claude Code 干活的日子里，我试遍了市面上各种"AI 接管浏览器"的插件和工具——说实话，大部分都不太顺手。要么每次都要重新登录，要么动不动弹权限弹窗，要么搞乱你的正常浏览标签页。
>
> 于是我就想：干脆自己造一个吧。我把几个做得好的工具的优点揉在一起，打磨出了 TT Bridge——**我的理想工具**。
>
> 它干的事情很简单：**你看到什么，AI 就看到什么。** 登录状态、cookie、滚动、点击、输入……AI 全部直接接管，不需要反复授权。
>
> 不管是数据采集、页面自动化、RPA，还是让 AI 帮你在网页上干活——它都能搞定。
>
> 太多朋友问我怎么装，今天就把它开源了。**祝用得开心 🧡**

---

## 安装

**把这两个文件丢给你的 AI（Claude Code、Cursor 都行），然后说：**

> "帮我安装 TT Bridge"

就这么简单。AI 会自己读文件、自己装，不需要你动脑子。

| 文件 | 下载 | 说明 |
|---|---|---|
| CLI + Daemon | [tt-bridge-cli.zip](https://github.com/mymark21/tt-bridge/releases/download/v1.0.4/tt-bridge-cli.zip) | 命令行工具，解压后全局安装 |
| Chrome 扩展 | [tt-bridge-extension.zip](https://github.com/mymark21/tt-bridge/releases/download/v1.0.4/tt-bridge-extension.zip) | Chrome 扩展包，解压后加载到 Chrome |

---

## 怎么用

安装完成后，试试这个：

> "帮我接管 Chrome 浏览器，打开谷歌首页，获取网页标题，然后告诉我当前页面已被接管。"

AI 会执行以下操作：

```bash
tt-bridge open "https://www.google.com"
tt-bridge eval "document.title"
```

你会看到 AI 在你当前正在用的 Chrome 窗口里打开 Google，读出标题，然后告诉你"当前页面已被接管"。

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

> 这部分是给 AI 智能体（Claude Code、Cursor、Copilot 等）看的。人类用户让你安装或使用 TT Bridge。按以下指引操作，不要让人做复杂手工活。

### 当人类说"安装 TT Bridge"

逐步执行，每步汇报进度。

**第 1 步 — 确保 Node.js 已安装（≥ 18）**

```bash
node --version
```

如果没装：

```bash
# Mac
brew install node
# 或去 https://nodejs.org 下载安装包
```

**第 2 步 — 安装 CLI**

先找到人类下载的 `tt-bridge-cli.zip` 路径（通常在 `~/Downloads/`）：

```bash
cd /tmp && unzip -o ~/Downloads/tt-bridge-cli.zip -d tt-bridge-cli && cd tt-bridge-cli && npm install -g .
```

如果路径不对，用 `ls ~/Downloads/tt-bridge*` 确认实际路径。

验证：

```bash
which tt-bridge && tt-bridge --help
```

**第 3 步 — 安装 Chrome 扩展**

找到 `tt-bridge-extension.zip`，解压：

```bash
mkdir -p /tmp/tt-bridge-extension && cd /tmp && unzip -o ~/Downloads/tt-bridge-extension.zip -d tt-bridge-extension
```

然后告诉人类（逐字显示）：

> 现在需要在 Chrome 中加载扩展：
>
> 1. 打开 Chrome，地址栏输入 **chrome://extensions/** 回车
> 2. 打开右上角 **开发者模式** 开关
> 3. 点击左上角 **加载已解压的扩展程序**
> 4. 在弹出的文件选择窗口中，按路径找到并选中：**/tmp/tt-bridge-extension/latest-version/**
> 5. 加载成功后，在扩展列表找到 **TT Bridge**，点击 **详情**，开启 **允许无痕模式**
>
> 扩展的图标是深色圆角方块，之后会出现在 Chrome 工具栏右上角。

**第 4 步 — 开启服务并验证**

等人确认扩展已加载后：

```bash
tt-bridge status
```

看到 `"extensionConnected": true` 即为成功。

如果 `false`：让人点击 Chrome 工具栏右侧的 TT Bridge 扩展图标（深色方块），在弹出的面板中点击一次 **Start Serving**，再跑一次 `tt-bridge status`。

**第 5 步 — 烟雾测试**

```bash
tt-bridge open "https://www.google.com" && tt-bridge eval "document.title"
```

告诉人类：
> "TT Bridge 已安装完成，当前页面已被接管。你现在可以让我浏览网页、操作页面、抓取数据了。"

### 核心使用模式

```bash
# 导航（在人类当前浏览器窗口中操作）
tt-bridge open "https://example.com"

# 读取页面状态
tt-bridge eval "document.title"
tt-bridge eval "JSON.stringify({url: location.href, text: document.body.innerText.slice(0, 3000)})"

# 交互
tt-bridge click "button.submit"
tt-bridge eval "document.querySelector('#search').value = 'hello'"

# 截图
tt-bridge screenshot /tmp/page.png --full-page

# 如需隔离窗口（不影响人类浏览）：
tt-bridge open "https://example.com" --workspace mytask
tt-bridge close-window --workspace mytask
```

### 最佳实践

1. **需要结构化输出时加 `--json`**
2. **默认就在人的浏览器窗口操作** — 不用加额外参数
3. **用 `--workspace` 隔离任务** — 需要后台自动化时创建独立无痕窗口
4. **需要返回值用 `eval`** — `click` 是 fire-and-forget
5. **截图用 `--full-page`** 捕获完整页面

### 故障排除

| 症状 | 原因 | 解决 |
|---|---|---|
| `Daemon is not running` | 空闲超时 | 再跑任意命令即自动启动 |
| `Extension not connected` | 扩展未服务 | 让人点扩展图标 → Start Serving |
| `Another debugger is already attached` | 另有扩展占用 CDP | 让人禁用其他调试类扩展 |
| `Allow in Incognito` 错误 | 权限未开启 | 让人在扩展详情中启用 |
<!-- END AGENT INSTRUCTIONS -->
