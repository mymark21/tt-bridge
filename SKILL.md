---
name: tt-bridge
description: 通过 tt-bridge 接管人类正在操作的 Chrome 浏览器窗口，执行 JS、截图、导航、点击等操作。无需 CDP 端口，无弹窗。
---

# Skill: tt-bridge — AI 接管人类浏览器

## 触发条件
- 用户说"操控浏览器"、"接管浏览器"、"自动化当前页面"
- 需要对人类正在浏览的页面执行操作（读取内容、点击、填表、截图）
- 明确说"用 tt-bridge"

---

## 架构

```
Claude Code (tt-bridge CLI)
    │ HTTP POST /command  →  127.0.0.1:19826
    ▼
tt-bridge daemon (Node.js)
    │ WebSocket  →  ws://127.0.0.1:19826/ext
    ▼
Chrome Extension (chrome.debugger API)
    │
    ▼
人类当前 tab (--human)
```

---

## 前置条件（一次性安装）

1. **安装 CLI**（已安装则跳过）：
   ```bash
   cd ~/.claude/skills/tt-bridge/daemon && npm link
   ```

2. **安装 Chrome 插件**：
   - 打开 `chrome://extensions`
   - 开启开发者模式
   - Load unpacked → 选择 `~/.claude/skills/tt-bridge/chrome-extension/dist`
   - 点击插件图标 → 点 **"Start Serving"**

---

## 每次使用前：确认连接状态

```bash
tt-bridge status
```

**结果判断：**

| 状态 | 处理方式 |
|------|---------|
| `extensionConnected: true` | 直接用 |
| `running: false` | `tt-bridge daemon start`，再检查插件是否 Serving |
| `running: true` 但 `extensionConnected: false` | 在 `chrome://extensions` 刷新插件，点 **Start Serving** |

---

## 核心命令（全部加 `--human` 操作人类窗口）

### 读取当前页面

```bash
tt-bridge eval "document.title" --human
tt-bridge eval "document.URL" --human
tt-bridge eval "document.body.innerText.substring(0, 3000)" --human
```

### 截图

```bash
tt-bridge screenshot /tmp/page.png --human
tt-bridge screenshot /tmp/page.png --human --full-page
```

### 导航

```bash
tt-bridge open https://example.com --human
```

### 点击元素（CSS selector）

```bash
tt-bridge click "button.submit" --human
tt-bridge click "#login-btn" --human
```

### 执行任意 JS

```bash
tt-bridge eval "window.scrollTo(0, document.body.scrollHeight)" --human
tt-bridge eval "document.querySelector('input').value = 'hello'" --human
```

### 查看 tab 列表

```bash
tt-bridge tab list --human
```

---

## 已知行为（不要误判为错误）

### SW 睡眠等待（最长 40 秒）
Chrome MV3 Service Worker 约 30 秒空闲后会被挂起，WebSocket 断开。
daemon 设计上会**等待最多 40 秒**让 SW 自动被 alarm 唤醒重连。
命令看起来"卡住"是正常的，**不需要点弹窗**，等待即可。

### daemon 空闲退出
24 小时无请求 daemon 自动退出。下次发命令会**自动重启**，无需手动操作。

---

## 注意事项

- `--human` = `--workspace human`，操作人类当前 focused 窗口的 active tab
- 不加 `--human` 时，命令在独立的 incognito 隔离窗口执行
- 不能操作 `chrome://` 和 `chrome-extension://` 页面（chrome.debugger 限制）
