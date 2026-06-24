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
| CLI + Daemon | [tt-bridge-cli.zip](./tt-bridge-cli.zip) | 命令行工具，解压后全局安装 |
| Chrome 扩展 | [tt-bridge-extension.zip](./tt-bridge-extension.zip) | Chrome 扩展包，解压后加载到 Chrome |

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

**第 1 步 — 安装 CLI**

```bash
cd /tmp && unzip -o /path/to/tt-bridge-cli.zip -d tt-bridge-cli && cd tt-bridge-cli && npm install -g .
```

如果人类把 zip 下载到了其他位置，替换 `/path/to/` 为实际路径（通常是 `~/Downloads/tt-bridge-cli.zip`）。没有 npm 就让人先装 Node.js（≥ 18）。

验证安装成功：

```bash
which tt-bridge && tt-bridge --help
```

**第 2 步 — 安装 Chrome 扩展**

```bash
# 解压扩展包
mkdir -p /tmp/tt-bridge-extension && cd /tmp && unzip -o /path/to/tt-bridge-extension.zip -d tt-bridge-extension
```

然后告诉人类：

> 现在需要你在 Chrome 中加载扩展，按以下步骤操作：
>
> 1. 打开 **chrome://extensions/**
> 2. 打开右上角 **开发者模式**
> 3. 点击 **加载已解压的扩展程序**
> 4. 选择文件夹：**/tmp/tt-bridge-extension/latest-version/**
> 5. 在扩展列表中找到 "TT Bridge"，点击 **详情**，开启 **允许无痕模式**

**第 3 步 — 验证并测试**

```bash
tt-bridge status
```

期望看到 `"extensionConnected": true`。如果 `false`，让人点击扩展图标再点 Start Serving。

跑个烟雾测试：

```bash
tt-bridge open "https://www.google.com" && tt-bridge eval "document.title"
```

告诉人类："TT Bridge 已安装完成。当前页面已被接管。你现在可以让我帮你浏览网页、操作页面、抓取数据了。"

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
