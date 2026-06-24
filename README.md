# TT Bridge 🔧✨

> 我是 [Terry Tang](https://github.com/mymark21)。用 Claude Code 干活的日子里，我试遍了市面上各种"AI 接管浏览器"的插件和工具——说实话，大部分都不太顺手。要么每次都要重新登录，要么动不动弹权限弹窗，要么跟你的正常浏览混在一起搞得一团糟。
>
> 于是我就想：干脆自己造一个吧。我把几个我觉得做得好的工具的优点揉在一起，打磨出了 TT Bridge——**我的理想武器**。
>
> 它干的事情其实很简单：**你看到什么，AI 就看到什么。** 当前页面的滚动位置、点击、输入、登录状态、cookie……AI 全部直接接管，不需要你反复授权，也不会搞乱你的正常浏览器标签页。
>
> 不管是做数据采集、页面自动化、RPA，还是单纯想让 AI 帮你在网页上干点活——它都能搞定。
>
> 太多朋友问我"这个东西怎么装"，今天就把它开源了。**祝用得开心 🧡**

---

**AI 智能体与浏览器之间的直接桥梁。**

你的 AI 看到的就是你看到的 — 同一个页面、同一个会话、同一个登录状态。无需重新认证、无需单独浏览器配置、无需反复批准。

TT Bridge 让 AI 智能体和人类**共用同一个 Chrome 窗口**。人类眼睛看到什么、点到什么、读到什么，Agent 就能读到什么，也能点到什么。不需要切换窗口，不需要打开新的浏览器 — 所有操作发生在你正在用的那一个窗口里。

> [English version →](./README_EN.md)

---

## 工作原理

```
┌──────────────┐    HTTP POST /command     ┌──────────────┐    WebSocket     ┌──────────────────┐
│              │ ────────────────────────►  │              │ ───────────────► │                  │
│  CLI / Agent │                           │   守护进程    │                  │   Chrome 扩展    │
│              │ ◄──────────────────────── │  (127.0.0.1) │ ◄─────────────── │ (Service Worker) │
└──────────────┘    JSON 响应              └──────────────┘    JSON 结果     └────────┬─────────┘
                                                                                     │
                                                                              chrome.debugger API
                                                                                     │
                                                                              ┌──────▼─────────┐
                                                                              │  当前浏览器窗口 │
                                                                              │  (人类正在看的) │
                                                                              └────────────────┘
```

1. **CLI** 通过 HTTP 向本地守护进程发送命令（`127.0.0.1:19826–19835`）
2. **守护进程** 通过 WebSocket 将命令转发给 Chrome 扩展
3. **扩展** 使用 `chrome.debugger`（CDP）在人类正在使用的同一个浏览器窗口中执行
4. 结果沿原链路返回

所有流量均在本地回环。Agent 和人类共享同一个浏览器窗口。

---

## 安装

1. 复制仓库地址：`https://github.com/mymark21/tt-bridge`
2. 告诉你的 AI 智能体：**"请帮我安装 TT Bridge"**

AI 会自动完成 CLI 安装、Chrome 扩展加载和验证。如果你还没有 AI 智能体，请查看[开发](#开发)部分的手动安装说明。

---

## 命令

| 命令 | 说明 |
|---|---|
| `tt-bridge open <url>` | 导航到指定 URL |
| `tt-bridge eval <js>` | 在页面中执行 JavaScript 并返回结果 |
| `tt-bridge click <selector>` | 通过 CSS 选择器点击 DOM 元素 |
| `tt-bridge screenshot [path]` | 截图（输出 base64 到 stdout，或保存到文件） |
| `tt-bridge tab list` | 列出自动化窗口中的所有标签页 |
| `tt-bridge tab new [url]` | 新建标签页 |
| `tt-bridge tab select <index>` | 按索引切换标签页 |
| `tt-bridge tab close <index>` | 按索引关闭标签页 |
| `tt-bridge sessions` | 显示活跃的自动化会话 |
| `tt-bridge close-window` | 关闭自动化窗口 |
| `tt-bridge status` | 显示守护进程和扩展连接状态 |
| `tt-bridge daemon start\|stop\|status` | 管理守护进程生命周期 |

### 参数

| 参数 | 说明 |
|---|---|
| `--workspace <name>` | 按工作区隔离会话（默认：`default`） |
| `--human` | 操作人类当前活跃的标签页，而非自动化窗口 |
| `--json` | 输出机器可读的 JSON 格式 |
| `--full-page` | 截取完整页面的截图 |
| `--format png\|jpeg` | 截图输出格式 |
| `--quality <n>` | JPEG 质量（0–100） |

---

## 设计原则

- **共用窗口，所见即所得** — Agent 和人类共用同一个 Chrome 窗口。你的眼睛看到什么、手指点到什么、屏幕上显示什么，Agent 就能读到什么、也能操作什么。这是 TT Bridge 最核心的设计
- **一次授权，永久有效** — 扩展持有 `debugger` 权限，安装时批准一次即可
- **工作区隔离（可选）** — 需要自动化独立窗口时，用 `--workspace` 创建隔离的无痕窗口，与正常浏览互不影响
- **自动启动 / 自动停止** — 守护进程在首次命令时自动启动，闲置 5 分钟后自动退出
- **仅限本地回环** — 守护进程绑定 `127.0.0.1`，不暴露到网络

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_BROWSER_BRIDGE_HOST` | `127.0.0.1` | 守护进程绑定地址 |
| `AGENT_BROWSER_BRIDGE_PORT` | `19826` | 守护进程起始端口 |
| `AGENT_BROWSER_BRIDGE_MAX_PORT` | `19835` | 最大尝试端口 |
| `AGENT_BROWSER_BRIDGE_IDLE_TIMEOUT_MS` | `300000` | 守护进程空闲超时（5 分钟） |
| `AGENT_BROWSER_BRIDGE_COMMAND_TIMEOUT_MS` | `30000` | 单条命令超时时间 |

---

## 安全性

- 守护进程仅绑定 `127.0.0.1`，不暴露到网络
- 无认证机制 — 安全模型基于本地回环隔离。切勿将守护进程端口暴露到网络接口
- 扩展需要 Chrome 的 `debugger` 权限，可以读取所有页面内容。请仅在本地安装可信扩展
- 默认情况下，Agent 和人类共用同一个浏览器窗口，共享会话、cookie 和标签页

---

## 开发

```bash
# 构建扩展
cd extension && npm install && npm run build

# 前台运行守护进程
tt-bridge serve

# 打包扩展
cd extension && npm run build && npm run package:zip
```

---

## 致谢

- 架构灵感来源于 [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)
- 欢迎关注微信公众号：**Terry 的美妙工作流** 🚀

---

<!-- BEGIN AGENT INSTRUCTIONS -->
## 如果你是 AI 智能体

> 这部分是为 AI 智能体（Claude Code、Cursor、Copilot 等）准备的。人类用户让你安装或使用 TT Bridge。请按照以下说明操作。不要让人类做手动工作。

### 当人类说"安装 TT Bridge"（或类似表述）

逐步执行以下步骤，每步汇报进度。

**第 1 步 — 安装 CLI**

```bash
npm install -g tt-bridge
```

等待完成。如果未找到 `npm`，告知人类先安装 Node.js（版本 ≥ 18）。

**第 2 步 — 克隆仓库（用于 Chrome 扩展）**

```bash
git clone https://github.com/mymark21/tt-bridge /tmp/tt-bridge
```

如果 `/tmp/tt-bridge` 已存在，先删除或换一个路径。

**第 3 步 — 构建扩展**

```bash
cd /tmp/tt-bridge/extension && npm install && npm run build
```

**第 4 步 — 告知人类在 Chrome 中加载扩展**

向人类逐字显示以下指引：

> 现在需要你在 Chrome 中加载扩展，请按以下步骤操作：
>
> 1. 打开 **chrome://extensions/**
> 2. 打开右上角的**开发者模式**
> 3. 点击**加载已解压的扩展程序**
> 4. 选择文件夹：**/tmp/tt-bridge/extension/**
> 5. 在扩展列表中找到"TT Bridge"，点击**详情**，开启**允许无痕模式**

**第 5 步 — 验证安装**

人类确认扩展加载完毕后，运行：

```bash
tt-bridge status
```

预期输出包含 `"extensionConnected": true`。如果显示 `false`，告知人类点击 Chrome 工具栏中的 TT Bridge 扩展图标，**再点一下 Start Serving**。

**第 6 步 — 确认成功**

运行快速烟雾测试：

```bash
tt-bridge open "data:text/html,<h1>TT Bridge Ready</h1>" --workspace test && tt-bridge eval "document.title" --workspace test && tt-bridge close-window --workspace test
```

告知人类："TT Bridge 已安装并正常工作。现在你可以让我浏览网页、与页面交互、截图或执行任何浏览器自动化任务。"

### 核心使用模式

```bash
# 导航到 URL（在人类当前活跃的浏览器窗口中共用操作）
tt-bridge open "https://example.com"

# 读取页面状态
tt-bridge eval "document.title"
tt-bridge eval "JSON.stringify({url: location.href, text: document.body.innerText.slice(0, 2000)})"

# 交互
tt-bridge click "button.submit"
tt-bridge eval "document.querySelector('#search').value = 'hello'"

# 可视化检查
tt-bridge screenshot --full-page
# 或保存到文件：
tt-bridge screenshot /tmp/page.png --full-page

# 读取 cookie
tt-bridge eval "document.cookie"

# 如需隔离的自动化窗口（不影响人类正常浏览）：
tt-bridge open "https://example.com" --workspace mytask
tt-bridge tab list --workspace mytask --json

# 结束隔离工作区
tt-bridge close-window --workspace mytask
```

### AI 智能体使用最佳实践

1. **需要结构化输出时始终加 `--json`**
2. **默认就在人类的浏览器窗口上操作** — Agent 看到的就是人看到的，不需要加任何额外参数
3. **用 `--workspace` 隔离任务** — 如需独立的无痕窗口（不干扰人类浏览），加 `--workspace <name>`，每个工作区互不干扰
4. **需要返回值时用 `eval` 而非 `click`** — `eval` 返回数据，`click` 只管点击
5. **用 `--full-page` 截图** 以捕获首屏以下的内容
6. **`open` 等待页面加载完成** — 最多 15 秒超时。检查响应中的 `timedOut` 字段
7. **开始长时间任务前先运行 `tt-bridge status`** 确认守护进程和扩展已连接
8. **未指定文件路径时截图输出 base64 到 stdout** — 用 `base64 -d > file.png` 解码，或直接传文件路径

### 故障排除

| 症状 | 可能原因 | 解决方法 |
|---|---|---|
| `Daemon is not running` | 空闲超时已终止 | 运行任意命令，守护进程会自动启动 |
| `Extension not connected` | 扩展未服务 | 告知人类：点击扩展图标 → Start Serving |
| `Tab no longer exists` | 自动化窗口已关闭 | 重新运行命令，窗口会自动创建 |
| `Another debugger is already attached` | 其他扩展占用了 CDP | 告知人类禁用冲突的调试扩展 |
| `Allow in Incognito` 错误 | 扩展权限缺失 | 告知人类：`chrome://extensions/` → TT Bridge 详情 → 启用"允许无痕模式" |

### 何时使用 --workspace（隔离窗口）

`--workspace <name>` 创建一个独立的无痕窗口，不影响人类的正常浏览：

```bash
tt-bridge open "https://example.com" --workspace mytask
tt-bridge tab list --workspace mytask --json
```

使用 `--workspace` 的场景：
- 需要后台自动化，不想干扰人类的当前浏览
- 需要独立的 cookie 和 localStorage 空间
- 多个任务并行执行，互不干扰
<!-- END AGENT INSTRUCTIONS -->
