# TT Bridge

**AI 智能体与浏览器之间的直接桥梁。**

你的 AI 看到的就是你看到的 — 同一个页面、同一个会话、同一个登录状态。无需重新认证、无需单独浏览器配置、无需反复批准。

TT Bridge 通过一个轻量级的本地守护进程和配套的 Chrome 扩展，让 AI 智能体（Claude Code、Cursor 或任意终端型 agent）直接控制一个专属的 Chrome 窗口。

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
                                                                              │   Chrome 窗口   │
                                                                              │   (无痕模式)    │
                                                                              └────────────────┘
```

1. **CLI** 通过 HTTP 向本地守护进程发送命令（`127.0.0.1:19826–19835`）
2. **守护进程** 通过 WebSocket 将命令转发给 Chrome 扩展
3. **扩展** 使用 `chrome.debugger`（CDP）在专属无痕窗口中执行
4. 结果沿原链路返回

所有流量均在本地回环，不会离开你的机器。

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

- **专属无痕窗口** — 自动化操作与正常浏览完全隔离，日常标签页不受影响
- **一次授权，永久有效** — 扩展持有 `debugger` 权限，安装时批准一次即可
- **工作区隔离** — 每个 `--workspace` 拥有独立的无痕窗口、标签页和 cookie 状态
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
- 默认情况下，自动化运行在独立的无痕窗口中，与正常浏览会话、cookie 和标签页隔离

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

架构灵感来源于 [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)。

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
# 导航（如无自动化窗口则自动创建无痕窗口）
tt-bridge open "https://example.com" --workspace mytask

# 读取页面状态
tt-bridge eval "document.title" --workspace mytask
tt-bridge eval "JSON.stringify({url: location.href, text: document.body.innerText.slice(0, 2000)})" --workspace mytask

# 交互
tt-bridge click "button.submit" --workspace mytask
tt-bridge eval "document.querySelector('#search').value = 'hello'" --workspace mytask

# 可视化检查
tt-bridge screenshot --workspace mytask --full-page
# 或保存到文件：
tt-bridge screenshot /tmp/page.png --workspace mytask --full-page

# 读取 cookie
tt-bridge eval "document.cookie" --workspace mytask

# 标签页管理
tt-bridge tab list --workspace mytask --json
tt-bridge tab new "https://other.example" --workspace mytask
tt-bridge tab select 0 --workspace mytask

# 结束会话
tt-bridge close-window --workspace mytask
```

### AI 智能体使用最佳实践

1. **需要结构化输出时始终加 `--json`**
2. **用 `--workspace` 隔离任务** — 每个工作区拥有独立的无痕窗口，并行任务互不干扰
3. **需要返回值时用 `eval` 而非 `click`** — `eval` 返回数据，`click` 只管点击
4. **用 `--full-page` 截图** 以捕获首屏以下的内容
5. **`open` 等待页面加载完成** — 最多 15 秒超时。检查响应中的 `timedOut` 字段
6. **开始长时间任务前先运行 `tt-bridge status`** 确认守护进程和扩展已连接
7. **自动化窗口是无痕模式** — cookie 和 localStorage 按工作区独立。如需人类的登录状态，使用 `--human`（操作人类当前标签页）或在自动化窗口内手动登录
8. **未指定文件路径时截图输出 base64 到 stdout** — 用 `base64 -d > file.png` 解码，或直接传文件路径

### 故障排除

| 症状 | 可能原因 | 解决方法 |
|---|---|---|
| `Daemon is not running` | 空闲超时已终止 | 运行任意命令，守护进程会自动启动 |
| `Extension not connected` | 扩展未服务 | 告知人类：点击扩展图标 → Start Serving |
| `Tab no longer exists` | 自动化窗口已关闭 | 重新运行命令，窗口会自动创建 |
| `Another debugger is already attached` | 其他扩展占用了 CDP | 告知人类禁用冲突的调试扩展 |
| `Allow in Incognito` 错误 | 扩展权限缺失 | 告知人类：`chrome://extensions/` → TT Bridge 详情 → 启用"允许无痕模式" |

### 何时使用 --human

`--human` 参数操作人类当前活跃的浏览器标签页而非自动化窗口：

```bash
tt-bridge eval "document.title" --human
tt-bridge screenshot --human > /tmp/what-human-sees.png
```

在以下情况使用 `--human`：
- 人类已在某网站登录，你需要其现有会话
- 人类希望你操作他们正在看的页面
- 你需要访问人类正常浏览器配置中的 cookie 或 localStorage

谨慎使用 `--human` — 你在操作人类真实的浏览会话。不要在人类正在使用的页面上随意导航。
<!-- END AGENT INSTRUCTIONS -->
