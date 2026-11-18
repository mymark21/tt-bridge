---
name: tt-bridge
description: 优先浏览器接管工具。通过 tt-bridge 直接接管人类正在操作的真实 Chrome 浏览器窗口，复用已有登录态（严禁无痕模式），执行 JS、截图、导航、点击与表单操作。凡涉及登录态或用户当前窗口的场景必须优先使用此工具。内置站点经验库（experience）：每条浏览器命令自动在 stderr 推送该站点经验提示，命中时运行 `experience show <id>`（show/run 后不再重复提醒）；多步任务用 begin/end 事务以断言收工，连续失败自动建 draft。用户提到"站点经验""上次怎么做的""复用脚本""沉淀经验"时必须使用。
---

# Skill: tt-bridge — AI 接管人类浏览器

## 核心铁律：坚决禁止使用无痕模式，直接接管真实登录态
> [!IMPORTANT]
> **使用 tt-bridge 的根本目的就是复用人类已经登录的会话（GitHub、Google、各类 SaaS 平台后台等）。**
> 严禁使用 `--workspace` 打开独立的无痕隔离窗口，必须默认直接接管人类当前活动的标签页（`workspace = human`），充分利用真实浏览器的已有 Cookie 与登录态！

## 触发条件
- 任何需要用户登录态、已有凭证或已有会话的网页操作场景（**绝对优先于其他浏览器自动化方案**）
- 用户说"操控浏览器"、"接管浏览器"、"自动化当前页面"、"用 TT Bridge"
- 需要对人类正在浏览的页面执行操作（读取内容、点击、填表、截图）
- 需要向富文本编辑器（Slate / ProseMirror / Medium / Notion 等）输入真实文字或特殊按键
- 需要把页面切换成手机 / 平板视口来做响应式截图或测试

---

## 架构

```
Claude Code (tt-bridge CLI)
    │ HTTP POST /command  →  127.0.0.1:19826
    ▼
tt-bridge daemon (Node.js)
    │ WebSocket  →  ws://127.0.0.1:19826/ext
    ▼
Chrome Extension (chrome.debugger API / CDP 1.3)
    │
    ▼
人类当前 tab（默认 workspace = human）
```

**默认目标**：CLI 的 workspace 默认为 `human`，即直接操作人类当前活动的 Chrome 标签页，无需加 `--human`。**不要开启无痕模式**。

### 多实例（多 Profile）模型

同一台机器可以同时有多个 Chrome Profile 在 Serving。每个 Profile 在插件弹窗里有一个稳定的**实例名**（Instance 字段，默认 `chrome-xxxx`，可改名）。daemon 采用「先到先得 + 显式指定」：第一个连接的实例成为 owner，之后连接的实例**不会**静默抢走控制权；要切换用 `tt-bridge instance use <label>`（支持 label 或显示名匹配）。实例断开后 daemon 会保留它的**墓碑**（Profile 名与 pin 状态），不会立刻失忆。

```bash
tt-bridge instance list             # 查看当前有哪些实例、谁是 owner
tt-bridge instance use chrome-work  # 指定操作哪个 Chrome 实例
tt-bridge instance clear            # 清除指定（回到先到先得）
tt-bridge instance rename work-mac  # 给当前实例改名（也可在插件弹窗里改）
```

> 分不清哪个实例对应哪个 Profile 时，看弹窗的 `Profile` 行（别名 · 邮箱）或 `tt-bridge profile list` 的 `PROFILE NAME` 列；未登录的 Profile 也能显示用户起的别名。

### 目标锁定与防漂移（v1.4.5）

「我要操作哪个目标」由三层粘性状态决定，优先级从高到低：**tab pin → 窗口选择 → 实例指名**。

- 执行 `tab pin` 后，扩展会立刻重新上报 `pinnedTabId`，daemon 在没有显式指定时**自动锚定该实例**——pin 落在哪个 Profile，后续命令就发给哪个 Profile。
- 目标实例断开（窗口被关 / MV3 SW 休眠）时，daemon 保留它的**墓碑**（实例名 + Profile 名 + pinnedTabId）：命令会先等它重连最多 3 秒（`AGENT_BROWSER_BRIDGE_TARGET_WAIT_MS`），仍不在线就返回**富身份 409**，明确写出是哪个 Profile、钉的是哪个 tab、当前在线的是谁，并拒绝静默漂移。
- 此时只有两种正确做法：让人类把那个 Profile 的窗口打开，或显式 `--force` 换目标。用 `window use 0` / `instance use <label>` 盲切默认会被 `PIN_HELD` 拦截。
- 墓碑 30 分钟后自动过期（`AGENT_BROWSER_BRIDGE_TOMBSTONE_TTL_MS`），避免永久阻塞。
- 状态读数：`status` 的 `pinnedTabId` / `disconnectedAt` / `ownerOnline`；`window list` 在目标离线时会多打一行告警。

```bash
tt-bridge status                    # ownerOnline / pinnedTabId / disconnectedAt
tt-bridge instance use chrome-work --force   # 明确放弃原 pin，换到另一个 Profile
```

### 多窗口与多 Profile 感知（Window & Profile Awareness, v1.4.0 引入）

v1.4.0 引入了跨 Profile / 跨窗口的全局感知、精准切换与热更能力：

1. **窗口感知（Window Awareness）**：
   ```bash
   tt-bridge window list             # 列出跨 Profile 的所有窗口及状态
   tt-bridge window status           # 查看当前目标窗口详情
   ```
   - 字段：`IDX`（全局索引 `[0]`、`[1]`...，供 `window use` 快速切换）、`INST`（所属实例名，后带 `*` 表示 owner 实例）、`PROFILE`（Profile 显示名）、`WIN`（Chrome windowId）、`FOCUS`（是否聚焦）、`STATE`（窗口状态 normal/maximized 等）、`TABS`（标签页数量）、`ACTIVE TAB`（当前活动标签页标题与 URL）。
   - 标记：`→` 指向当前被 bridge 接管的目标窗口。

2. **Profile 感知（Profile Awareness）**：
   ```bash
   tt-bridge profile list            # 列出本机 Chrome 所有 Profile 及连接状态
   ```
   - 字段：`DIR`（目录名 Default/Profile 1...）、`PROFILE NAME`（用户起的别名；Chrome 默认名显示为 `(default name)`）、`EMAIL`（脱敏邮箱）、`INSTANCE`（对应实例名）、`CONNECTED`（是否在线）、`WINDOWS`（窗口数）。
   - **名称映射机制**：Chrome 扩展自身在沙箱中无法直接读取 Profile 显示名。扩展连接时上报 `email` + `gaia_id`，由 daemon 读取宿主 Chrome 的 `Local State`（`profile.info_cache`）自动映射出显示名称；若映射不到则保持空白/unknown，绝不盲目猜测。
   - **弹窗与显示优先级**：插件弹窗的 Profile 字段按「用户别名 > Chrome Profile 别名 > 邮箱 > `Not signed in`」显示，Chrome 的默认名（`is_using_default_name: true`）跳过。`Profile` 是只读摘要，下面的 `Profile name` 才可编辑：写入的别名作为 override 上报 daemon 并优先采用，清空即删除 override。未登录时若本机只有一个未登录 Profile，daemon 直接归给它；多个未登录 Profile 无法区分，保持空白不猜。

3. **目标窗口切换（Window Shift）**：
   ```bash
   tt-bridge window use 0                      # 按全局索引即时切换（可跨 Profile），默认不抢焦点
   tt-bridge window use chrome-d31e:1539990026 # 按 "实例:windowId" 切换
   tt-bridge window use 1 --focus              # 切换并置顶目标窗口
   tt-bridge window focus 1                    # 等价于 use --focus
   ```
   - **核心语义与边界**：
     - `window use` 默认**不抢焦点**，在后台完成接管目标重定向，避免打扰用户当前前台操作。
     - 只有 `focus` 命令或 `--focus` 标志才会请求置顶；v1.4.1 起 macOS 上由 daemon 调系统级 activate 真正把 Chrome 拉到最前，JSON 响应含 `osActivated` 字段。
     - 索引越界会明确报错并给出合法范围提示（如 `Window index 99 out of range (valid range: 0..2)`）。

4. **扩展热重载（Hot Reload）**：
   ```bash
   tt-bridge reload                            # 重载当前目标实例的扩展
   tt-bridge reload --all                      # 一键重载所有已连接 Profile 的扩展
   tt-bridge reload --instance chrome-d31e     # 重载指定实例的扩展
   ```
   - 触发扩展内部 `chrome.runtime.reload()` 自我重载，扩展升级后无需逐个切换 Profile 去 `chrome://extensions` 手动点刷新。
   - **前提**：正在运行的扩展必须已经认识 `reload` 这个 action。比当前版本旧的扩展会回 `Unknown action: reload`，此时不要继续折腾命令行——直接让人类去 `chrome://extensions` 点一次 Reload（每个 Profile 一次），说完就回到正常流程。


### v1.4.1 修复

1. **重连自愈（P0）**：daemon 重启后扩展自动恢复连接，无需人工点开插件（SW 冷启动后顶层 alarm/手势监听先初始化再判断连接状态）。
2. **保活心跳**：连接期间每 0.5 分钟（Chrome 强制最小 30 秒）ping/pong，浏览器静置也不会被 MV3 的 30 秒空闲回收踢下线（实测静置 60s 仍在线）。
3. **macOS 真置顶**：`tt-bridge window focus` / `window use --focus` 由 daemon 调系统级 activate 真正把 Chrome 拉到最前，JSON 响应含 `osActivated` 字段。
4. **实例身份**：扩展上报稳定 `profileId`，两个 Profile 即使实例名相同也不会互相踢下线；同名时内部 key 自动去重。daemon 依靠这个 `profileId` 把实例与 Profile 对上，弹窗的 Profile 字段因此可以显示 daemon 解析出的 Profile 别名（默认名跳过），也可以接受用户输入的别名 override。

### v1.4.2 加固

1. **最小化窗口截图拦截**：目标窗口最小化时 `screenshot` 直接报错（避免 30s 卡死/黑屏），提示加 `--restore`；`tt-bridge screenshot --restore`（仅 human 模式）先把窗口恢复为 normal 再截图。
2. **tab new --mute**：新建 tab 后静音（human 与 workspace 模式均可用），JSON 输出含 `muted` 字段；默认不静音，保持向后兼容。
3. **cookies 默认脱敏**：`tt-bridge cookies [--domain <d>] [--url <u>]` 默认把 value 掩码为前 6 字符 + `***`（空值保持空，≤6 字符只显示 `***`），JSON 输出每项带 `masked` 字段；只有 `--show-values` 才打印明文（明文是真实会话凭据，严禁贴进日志或模型上下文）。

### v1.4.4 绿色盾牌：看得见 agent 正在操作哪个 tab

Chrome 没有任何 favicon API（`chrome.tabs` 无 `setFavicon`，CDP 也没有对应命令），所以扩展改成**页面内改写 `<link rel="icon">`**——这是 Favico / Tab-Edit / Gmail Favicon Customizer 等所有同类扩展的唯一可行路径。

- **触发**：任何 human 模式命令解析出目标 tab 后立刻打标；`tab pin` / `tab select` 立即打标；`open`（整页导航）后重新打标，因为新文档不继承旧 DOM。
- **唯一性**：同一时刻只有一个 tab 带盾牌。目标切走时立刻还原上一个 tab 的站点图标，不等 TTL 过期。
- **自动过期**：页面内定时器在最后一次命令 120 秒后自行摘除并还原站点图标——service worker 被回收也不会留下僵尸盾牌。每 20 秒内重复命令只重打一次，避免频繁注入。
- **不抢焦点**：只改图标，不激活 tab、不弹通知；automation workspace（`--workspace`）的隔离窗口**不打标**，那里本来就不可见。
- **失败不影响命令**：CDP 注入失败（页面已关、DevTools 抢占 debugger）时静默跳过，命令照常执行。
- **SPA 兼容**：页面内每秒重新断言一次图标，站点自己改 favicon（Gmail 未读数）也不会把盾牌顶掉。

### 钉 Tab 模型（人机共存的关键）

默认 `--human` 跟随「人类当前前台 tab」——人类切换 tab，agent 的目标就跟着变。执行 `tt-bridge tab pin` 后，agent 固定在它锁定的 tab 上：

- 人类可以自由切换 tab / 窗口，agent 的操作不受影响（后台 tab 可正常 eval / 截图 / 注入输入）
- 钉住后相关命令不会激活页面、不抢焦点（human 模式下的 `tab select` 只改目标、不激活）
- **静默开新页**：用 `tt-bridge tab new <url>`——human 模式下会在**后台**新开标签页（`active:false`），你的可见页面完全不动。不要用键盘/鼠标去激活 `target="_blank"` 链接（浏览器标准行为会把新页在前台打开，抢走视线）
- **后台作业的边界**：隐藏标签页有浏览器节流（定时器降频、动画暂停），但 DOM 读取、可信输入注入、截图不受影响；个别站点会检查 `document.hasFocus()`（后台时为 false），行为可能与前台略异。若某站点必须前台运行：**由人类手动点开该 tab**——工具本身不会自动把页面切到前台。注意：后台窗口 `requestAnimationFrame` 为 0，依赖 rAF 的无限滚动（小红书/微博/Twitter 类瀑布流）后台不会加载更多内容——需人类把窗口切到前台，或改用直接 DOM 派发/接口方式，别误判为页面崩溃
- 任务结束后用 `tt-bridge tab unpin` 释放；被钉 tab 关闭时 pin 自动失效并**明确报错**（不会静默换目标）

```bash
tt-bridge tab list              # human 模式：列出真实浏览器所有窗口的可用 tabs（含 tabId 与 📌 标记）
tt-bridge tab pin               # 钉住当前前台 tab
tt-bridge tab pin --tab 123     # 钉住指定 tab
tt-bridge tab status            # 查看当前 pin
tt-bridge tab unpin             # 解除 pin（回到跟随前台）
tt-bridge tab new <url> --mute  # 后台新开 tab 并静音（默认不静音）
```

推荐 agent 工作流：`status`（核对实例）→ `tab list` → `tab pin --tab N`（或 `tab pin` 钉当前）→ 执行操作 → `tab unpin`。

---

## 前置条件（一次性安装）

1. **安装 CLI**（已安装则跳过）：
   从 GitHub Release 下载 `tt-bridge-cli.zip`，解压后进入 `tt-bridge-cli` 目录执行：
   ```bash
   npm install -g .
   ```
   zip 已内置 daemon 需要的 `ws` 依赖，不需要联网安装；不要用 npm registry 上的同名包，也不要 `npx tt-bridge`。

2. **安装 Chrome 插件**：
   - 从 GitHub Release 下载 `tt-bridge-extension.zip`，解压到一个固定目录（例如 `~/Downloads/tt-bridge-chrome-extension`）。
   - 打开 `chrome://extensions`，开启开发者模式，Load unpacked → 选择解压出来的 `tt-bridge-chrome-extension` 文件夹。
   - 打开扩展面板，首次点一次 **允许 AI 控制**；连上后面板主按钮变为 **复制连接指令**。

   > **所有 Profile 用同一个解压目录**，不要从 git 仓库目录加载：切分支或回退会让 Chrome 在下次启动时悄悄降级。
   > 扩展热重载用 `tt-bridge reload`，不需要逐个 Profile 去 `chrome://extensions` 点刷新。

   **一次性迁移**（历史上从仓库目录加载过的 Profile）：`chrome://extensions` → 移除 TT Bridge → Load unpacked → 选上面那个解压目录。每个 Profile 各做一次。

---

## 每次使用前：确认连接状态

```bash
tt-bridge status
```

**结果判断：**

| 状态 | 处理方式 |
|------|---------|
| `extensionConnected: true` | 直接用；多实例时核对 `ownerLabel` 是否是你想要的那个（不对就 `instance use`）。`ownerOnline: false` 表示 owner 当前离线（pin 可能被孤儿化），先等它重连，或用 `--force` 放弃 |
| `running: false` | `tt-bridge daemon start`，再检查插件面板状态 |
| `running: true` 但 `extensionConnected: false` | 让人类打开扩展面板：显示「允许 AI 控制」就点一次；显示「复制连接指令」就复制发给你，按口令接管。反复失败再去 `chrome://extensions` 刷新插件 |
| 409 `TARGET_OFFLINE` | 目标实例离线但它的 pin 还在。打开那个 Profile 的窗口等它重连；确认要放弃原 pin 才加 `--force`，不要换实例盲切 |
| 409 `PIN_HELD` | 原目标仍持有活跃 pin，拒绝切到别的 Profile。先 `tab unpin`，或明确 `--force` |
| 报 `Tab <id> is a restricted page` | 目标标签是浏览器 / 扩展 / file / view-source / devtools 页面，切到普通网页后重试，或 `tt-bridge tab pin --tab <id>` 重新指定 |

---

## 人类粘贴过来的接管口令

人类在插件面板点击「复制连接指令」后，可能粘贴包含如下指令的文本：
```bash
tt-bridge instance use <instanceLabel>
tt-bridge window use <instanceLabel>:<windowId>
tt-bridge tab pin --tab <tabId>
```
收到后按命令依次执行以接管目标。若仅需读取页面可跳过 `window use`；`tab pin` 让后续命令固定在该标签页。

---

## 面板状态怎么读

- 面板主按钮：未连接时是「允许 AI 控制」；连上后是「复制连接指令」；旁边的「暂停」临时断开服务。
- 面板显示「等待服务 / 本地服务未启动」= daemon 没起来。人类可以点「复制启动指令」粘贴给你；你收到后运行 `tt-bridge daemon start` 和 `tt-bridge status --json`，确认 `extensionConnected: true`。服务起来后扩展会自动接通，不需要人类回面板再点。
- 断链图标 = 扩展未连上 daemon；实心绿链 = 已连接；绿链带光晕 = AI 正在该标签页操作；微弱余晖 = 5 分钟内操作过。
- Chrome 标签页图标变成绿色盾牌 = 该标签是当前接管目标；盾牌会在最后一次命令 120 秒后自动摘除。
- 状态行显示「AI 正在其他标签页」说明目标标签和你当前看的不一致，用 `tt-bridge tab pin` 对齐。

---

## 经验库（Experience）— 开工声明与收工验收

解决同一页面反复摸索与踩坑。本地轻量读写（`~/.agents/skills/tt-bridge/experience`，可由 `TT_BRIDGE_EXPERIENCE_DIR` 覆盖），三层记忆结构：`_ledger` 情节记忆（尝试与命中）、`<host>/<slug>/entry.md` 语义记忆（步骤与坑）、`script.py` 程序记忆（确定性自动化）。

### 自动注入（stderr [exp] 提示）— 你不必先手动 find

每条浏览器命令（open / eval / click / focus / type / key 等）执行前，CLI 会自动在 **stderr** 打一行 `[exp] ...` 提示，命中即返回、绝不叠加。优先级链：

| 层 | 触发 | 输出 |
|---|---|---|
| 0 catalog | 该 host 首次有交互 | 列出该站 verified 经验 + `tt-bridge experience show <id>` |
| 1 similar | 当前命令 arg（+ 最近 3 条 trace arg）的 token 与某条目 codeTokens/descTokens/tags 重合 ≥15% | 命中条目 + 可执行 `tt-bridge experience show <id>` |
| 2 entry | 条目 `triggers` 精确匹配动作 | `experience run <id>` 或 `show <id>` |
| 3 pattern / 4 atom | 跨站模式 / 近 7 天失败率 ≥50% | 警告 / 统计 |

**关键行为**：
- 运行 `tt-bridge experience show <id>` 或 `experience run <id>` 会写入 `ack::<id>`，此后该条目不再重复提醒。
- 若提示后连续 5 步仍未 ack（你在盲试），会以更强语气重提醒一次。
- 同 session+host 同一提示只出现一次；失败时允许 pattern 层按错误文本再匹配一次。
- 关闭：`--quiet` 或 `TT_BRIDGE_EXPERIENCE_SILENT=1`。

**所以开工流程改为**：先直接干活，**留意 stderr 的 [exp] 提示**；命中时立即运行给出的 `experience show <id>`，不要忽略后继续盲试。`experience find` 仍可用，但不再是必经步骤。

### 苦战提醒（Harvest Nudge）

同一 session+host 连续执行 ≥ 8 条交互命令（且未 ack 任何经验）→ stderr 提醒跑 `tt-bridge experience capture` 沉淀；若已 ack 经验但仍调试 ≥ 8 步 → 提醒 `experience update <id>` 修正过时条目。提示只出现一次。

### 开工声明与收工验收（begin / end）

```bash
tt-bridge experience begin --url "$URL" --intent <slug> [--session <id>] # 开工：声明事务
# ... show 查阅步骤 / verified 脚本直接 run ...
tt-bridge experience end --session <id> --assert <assert.js>             # 收工：真实断言记账
```

- **MUST**：
  1. 具体站点的多步任务，开工 begin，收工 end --assert。
  2. 收工必须真跑断言，不能用"看起来对了"代替。
  3. 条目因站点改版失效时，立刻 update 修正，不要放着。
  4. 最终提交 / 支付 / 删除仍必须人类确认。
- **SHOULD**：同一 intent 手打超过两遍就补 script.py；首次成功且预计重复，补 assert 让 draft 自动成型。
- **NEVER**：不要手动 hit/miss（begin/end 已覆盖）；不要写 cookie/token/页面数据/快照；不要把经验正文抄进 SKILL.md。
- **无须计数**：账本与 draft 由命令自动维护，你不需要计数。
- **kind 路由**：依赖判断/风格/一次性 → `text`；步骤稳定、可断言 → `script`；大部分可脚本化但有一两步要人判断 → `hybrid`。
- **未 begin 的手工兜底**：连续 2 次 miss → 该意图记为候选（大概率该走文本流程而非脚本）；第 3 次尝试仍无条目 → CLI 返回 `captureRequired` 并自动建 draft，按 `draftPath` 补完正文后 `finalize`。已有条目连续 2 次 miss → 转 `stale`，先修再复用。
- **按需加载**：字段 schema、URL 匹配与排序、脚本契约、`validate`/`reindex`/`deprecate`/`ledger prune` 等维护命令见 `experience/README.md`。不要预先读取。

---

## 核心命令（默认即操作人类当前窗口，无需 `--human`）

### 读取当前页面

```bash
tt-bridge eval "document.title"
tt-bridge eval "document.URL"
tt-bridge eval "document.body.innerText.substring(0, 3000)"
```

### 截图

```bash
tt-bridge screenshot /tmp/page.png
tt-bridge screenshot /tmp/page.png --full-page
tt-bridge screenshot /tmp/page.png --restore   # 目标窗口最小化时，先恢复为 normal 再截图（仅 human 模式）
```

窗口最小化时 `screenshot` 会直接报错（macOS 已卸载硬件渲染表面，硬等会 30s 卡死或黑屏）——按提示加 `--restore` 即可。

### 导航

```bash
tt-bridge open https://example.com
```

### 点击元素（CSS selector）

```bash
tt-bridge click "button.submit"
tt-bridge click "#login-btn"
```

### 执行任意 JS

```bash
tt-bridge eval "window.scrollTo(0, document.body.scrollHeight)"
tt-bridge eval "document.querySelector('input').value = 'hello'"
```

### 查看 tab 列表

```bash
tt-bridge tab list
```

human 模式下会列出真实浏览器所有窗口的可用 tabs（含 `tabId` 与 📌 pin 标记）。选择与管理操作目标用 `tab pin` / `tab unpin` / `tab status`（见上文「钉 Tab 模型」）。

### 跨窗口与跨 Profile 切换

```bash
tt-bridge window list                       # 查看所有窗口（IDX / 实例 / Profile / 标签数 / 活动页）
tt-bridge window use <index>                # 切换接管窗口（默认不抢焦点）
tt-bridge window focus <index>              # 切换并置顶窗口
tt-bridge window status                     # 查看当前接管窗口详情
tt-bridge profile list                      # 查看所有 Chrome Profile 及连接状态
tt-bridge reload --all                      # 热重载所有扩展实例
tt-bridge cookies --domain localhost        # 列 cookie（value 默认掩码，--show-values 打印明文）

---

## 原生键盘输入管线（Native Input Pipeline）

普通 `eval` 里设置 `input.value` 只会改 DOM，不会触发框架的事件监听，富文本编辑器（Slate / ProseMirror / Medium / Notion）会直接忽略。这套命令通过 CDP 发送**可信的底层输入事件**，让页面把它当成真人敲键盘。

### `type` — 输入文本

通过 CDP `Input.insertText` 注入可信文本，会正常触发 `input` 等事件，兼容 React 受控组件、Slate / ProseMirror / Medium / Notion 等复杂富文本编辑器以及普通 `input`。

```bash
tt-bridge type "Hello, world"
```

### `focus` — 让元素获得原生焦点

按 CSS selector 定位元素，滚动到其中心并发送可信鼠标点击，使目标元素取得真实焦点（同时触发 pointer / mousedown / mouseup / click）。常用于输入前的准备步骤。

```bash
tt-bridge focus "div[contenteditable='true']"
tt-bridge focus "#comment-input"
```

### `key` — 发送特殊按键

通过 CDP `Input.dispatchKeyEvent` 发送 keydown / keyup。当前支持：`Enter`、`Tab`、`Escape`、`Backspace`。`Enter` 会附带换行文本，因此在富文本编辑器中能产生真实段落换行。

```bash
tt-bridge key Enter
tt-bridge key Tab
tt-bridge key Backspace
```

### 典型组合：向富文本编辑器输入并提交

```bash
tt-bridge focus "div[contenteditable='true']"
tt-bridge type "这是一段评论内容。"
tt-bridge key Enter
```

---

## 移动端与多设备视口仿真（Device & Viewport Emulation）

通过 CDP `Emulation.*` 覆盖视口尺寸、DPR、touch 与 User-Agent，用于响应式页面测试和移动端截图。

### `emulate <preset>` — 使用内置设备预设

内置 8 款设备预设：

| 预设名 | 说明 |
|--------|------|
| `iphone14` | iPhone 14（390×844，DPR 3，mobile，touch） |
| `iphone14pro` | iPhone 14 Pro（393×852，DPR 3，mobile，touch） |
| `iphone14promax` | iPhone 14 Pro Max（430×932，DPR 3，mobile，touch） |
| `iphonese` | iPhone SE（375×667，DPR 2，mobile，touch） |
| `ipad` | iPad（820×1180，DPR 2，mobile，touch） |
| `ipadpro` | iPad Pro（1024×1366，DPR 2，mobile，touch） |
| `pixel7` | Pixel 7（412×915，DPR 2.625，mobile，touch） |
| `galaxys23` | Galaxy S23（360×780，DPR 3，mobile，touch） |

预设名做了归一化处理，`iPhone 14 Pro`、`iphone-14-pro`、`iphone14pro` 均可匹配。

```bash
tt-bridge emulate iphone14
tt-bridge emulate pixel7
```

### `emulate <width> <height>` — 自定义视口

```bash
tt-bridge emulate 390 844 --dpr 3 --mobile
tt-bridge emulate 1280 720
```

可用参数：

- `--dpr <n>`：设备像素比 / deviceScaleFactor，默认 1
- `--mobile`：模拟移动端视口
- `--touch`：开启 touch 事件（未显式指定时默认跟随 `--mobile`）
- `--user-agent <str>`：覆盖 User-Agent

### `emulate reset` — 恢复桌面默认

一键清除视口覆盖、关闭 touch 仿真、清空 User-Agent 覆盖，回到桌面默认状态。

```bash
tt-bridge emulate reset
```

### 单次仿真截图

`--device` 会先套用设备预设再截图，截完**自动 reset**；`--viewport` 用于自定义尺寸。

```bash
tt-bridge screenshot mobile.png --device iphone14
tt-bridge screenshot wide.png --viewport 1280x720
```

如截图后想保留仿真状态，加 `--no-reset`：

```bash
tt-bridge screenshot mobile.png --device iphone14 --no-reset
```

---

## 已知行为（不要误判为错误）

### SW 睡眠等待（最长 40 秒）
Chrome MV3 Service Worker 约 30 秒空闲后会被挂起，WebSocket 断开。
daemon 设计上会**等待最多 40 秒**让 SW 自动被 alarm 唤醒重连。
命令看起来"卡住"是正常的，**不需要点弹窗**，等待即可。

### daemon 空闲退出
24 小时无请求 daemon 自动退出。下次发命令会**自动重启**，无需手动操作。

### 扩展重载或浏览器重启后 pin 会重置
pin 存在 `chrome.storage.session`：MV3 Service Worker 休眠不丢，但**扩展 Reload、浏览器重启会清空**。
表现为 `tab status` 显示 `pinned: false`，操作回到"跟随当前前台 tab"。任务开始时重新 `tab pin` 即可——
这正好符合"每次任务重新选目标"的使用习惯。

---

## 注意事项

- 默认 workspace 为 `human`，即操作人类当前 focused 窗口的 active tab；**一旦执行过 `tab pin`，则优先操作被钉住的 tab**；无需加 `--human`
- `window use` 默认不抢焦点、静默切换；需将窗口置顶请使用 `window focus` 或 `--focus`（macOS 后台无手势时系统可能降级为 Dock 弹跳）
- `window use` 索引越界会明确报错并给出合法范围；`reload` 支持 `--all` 或 `--instance <label>`
- `--tab <id>` 是一次性目标（不改 pin）；`tab pin` 才是粘性的
- `--force` 只用于「明确要放弃原目标」：跨 Profile 切换时若原目标仍持有 pin，`instance use` / `window use` 会返回 `PIN_HELD`，加 `--force` 才放行。**不要用它绕过 409 的提示**——那正是防止目标漂到别的 Profile 的护栏
- `--human` = `--workspace human`，仅为向后兼容别名
- 显式指定 `--workspace <name>` 时，命令在独立的 incognito 隔离窗口中执行（`tab pin` 仅适用于 human 模式）
- 不能操作 `chrome://` 和 `chrome-extension://` 页面（chrome.debugger 限制）
- **破坏性/不可逆操作的最终提交必须人类确认**：遇到转账/支付、删除（账号/仓库/存储桶/文件）、发布/公开发布、注销/解绑等动作，「预填可以自动、提交必须确认」——表单填写、校验、准备全部可自动完成，但点击最终提交按钮前必须停下来向人类汇报预填内容并等确认，绝不自动提交
- `cookies` 输出默认脱敏；若确需明文（`--show-values`），明文是真实会话凭据，**只能用于当前浏览器内闭环操作，严禁写进日志、文件或回传模型上下文**

---

## 场景化参考文档（按需加载，不要预先读取）

遇到对应站点的具体问题时，**才**去读这些文件，避免污染本精简描述：

- **站点经验库的完整规格**（schema / 匹配排序 / 状态机 / 脚本契约 / 维护命令）：`experience/README.md`
