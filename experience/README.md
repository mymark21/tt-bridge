# Experience — 站点经验库

`tt-bridge experience` 把「这个站点上怎么干活」从一次次对话里剥离出来，落成可检索、可执行、可验证的文件：解决同一页面反复摸索、同一个坑反复踩、同一段脚本反复重写。

三种记忆各管一段，不要混用：

| 记忆 | 载体 | 回答的问题 |
|---|---|---|
| 情节记忆 episodic | `_ledger/attempts.json` | 上次在这个站点上，我是成功还是失败？失败几次了？ |
| 语义记忆 semantic | `<host>/<slug>/entry.md` | 这个页面的目标、触发条件、步骤、坑与验证标准是什么？ |
| 程序记忆 procedural | `<host>/<slug>/script.py` | 能不能一条命令直接跑完，不用再想？ |

---

## 存储位置

运行时目录默认 `~/.agents/skills/tt-bridge/experience`，可用 `TT_BRIDGE_EXPERIENCE_DIR` 覆盖。

```
experience/
├── README.md                     本文件
├── _templates/{entry.md,script.py}  条目与脚本骨架
├── index.json                    派生索引（可随时重建，不要手改）
├── _ledger/attempts.json         尝试账本（miss/hit 计数与时间）
├── _episodes/<session>.json      事务状态文件（begin 创建，end 结算后自动删除）
├── _index/<host>.json            按站点分桶的检索索引（advise 热路径只读这一个文件）
├── _trace/YYYY-MM-DD.jsonl       命令级动作流水（自动追加，供失败率聚合）
├── _patterns/<fp>/entry.md       跨站模式条目（scope: pattern）
└── <host>/<slug>/
    ├── entry.md                  必选
    ├── script.py                 可选（kind: script / hybrid）
    └── assets/                   可选（脱敏截图、结构片段）
```

约束：

- 所有读写都在 experience 根目录内，**不写目录之外**；条目目录名 = `<host>/<slug>`，与 frontmatter 的 `id` 一致。
- `index.json`、`_ledger` 与 `_episodes/` 都是运行时数据：前者由 `reindex` 重建，`_ledger` 记录尝试历史，`_episodes/` 记录进行中的事务；写入一律 tmp + rename 原子替换，账本额外用锁文件容忍并发写。

---

## 条目 Schema（v1）

frontmatter 只允许**扁平标量 + 字符串数组**：嵌套 map、`|` / `>` 块标量、多行字符串都会被解析器拒绝。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | int | ✅ | 固定 `1` |
| `id` | string | ✅ | `<host>/<slug>`，slug 为 `[a-z0-9-]`，最长 64，冲突加 `-2` |
| `host` | string | ✅ | 小写主机名，如 `medium.com` |
| `url` | string | ✅ | 匹配用 URL 模式，可含 `*`（glob）或作为前缀 |
| `match` | enum | ✅ | `exact` \| `prefix` \| `glob` |
| `kind` | enum | ✅ | `text` \| `script` \| `hybrid` |
| `description` | string | ✅ | 一句话：什么页面达成什么目标 |
| `created` | ISO8601 | ✅ | 创建时间（UTC） |
| `updated` | ISO8601 | ✅ | 最近内容修改 |
| `last_verified` | ISO8601 | ✅ | 最近一次真实验证通过；draft 可为空字符串 |
| `status` | enum | ✅ | `draft` \| `verified` \| `stale` \| `deprecated` |
| `confidence` | number | ✅ | `0..1`，hit 每次 +0.1（上限 1） |
| `tags` | string[] | ✅ | 站点/技术/动作标签，用于检索 |
| `preconditions` | string[] | ✅ | 执行前必须成立的条件（登录、权限、页面状态） |
| `selectors` | string[] | ✅ | 已验证的选择器（优先 `role=` / 文本定位） |
| `verification` | string[] | ✅ | 「怎么算成功」的可观察断言 |
| `attempts` | int | ✅ | 累计逻辑尝试次数 |
| `misses` | int | ✅ | 累计失败次数 |
| `source` | enum | ✅ | `manual` \| `auto` |
| `script` | string | ⬜ | 脚本的相对文件名，如 `script.py` |
| `triggers` | string[] | ⬜ | 注入触发条件，`<action>:<arg子串>` 形式，如 `key:Enter`、`click:aria-label=Send message`。命中才在命令执行前提示；缺省视为空数组 |

正文固定六节，顺序不要改：

`## 目标` / `## 触发条件` / `## 步骤` / `## 坑与修正` / `## 验证` / `## 脚本说明`

「坑与修正」是条目里最值钱的部分：写清**症状 → 原因 → 修正**，而不是复述步骤。抓取到的页面数据、评论原文、cookie 值都不进正文。

---

## URL 归一化与匹配

`find` 之前先归一化，避免同一页面因参数不同被当成两个站点：

1. 主机名转小写；
2. 去掉默认端口（`http:80` / `https:443`）；
3. 丢掉 `#fragment`；
4. 删除追踪参数 `utm_*`、`fbclid`、`gclid`，以及敏感参数 `token`、`key`、`secret`、`code`、`sig`、`signature`、`session`、`auth`、`password`、`access_token`、`id_token`、`refresh_token`、`api_key`、`apikey`、`jwt`；
5. 去掉路径尾部多余的 `/`（根路径保留 `/`）。

匹配优先级：`exact` > `glob` > `prefix`。同级再按特异度、状态、confidence、intent token 重合度排序。实际打分：

| 分量 | 取值 |
|---|---|
| 匹配类型 | `exact` 4000 / `glob` 3000 / `prefix` 2000 |
| 特异度 | `url` 字面量长度（glob 去掉 `*` 后计算） |
| 状态 | `verified` +300 / `draft` 0 / `stale` -200 / `deprecated` -1000 |
| confidence | `round(confidence × 100)` |
| intent 重合 | 与 `id`/`description`/`tags` 的 token 交集 × 15 |

`glob` 里 `*` 匹配单段（不跨 `/`），`**` 跨段；`prefix` 要求 URL 等于模式或以「模式 + `/`」开头。

`--intent` 会把候选**精确过滤到同名 slug**（`host/<intent>`），不是模糊搜索。默认启用 URL 匹配与状态过滤，按 `score` 降序；`--all` 关闭 URL 匹配与状态过滤（仍限定在 host 内），用于排查「为什么没命中」。`find --json` 直接输出**数组**，每项含 `id`、`host`、`slug`、`url`、`match`/`matchType`、`kind`、`description`、`status`、`confidence`、`score`、`tags`、`updated`、`script`（相对文件名或 `null`）、`scriptPath`、`file`、`dir`；**不含正文**——需要正文时再 `show <id>`，避免发现阶段污染上下文。

```bash
tt-bridge experience find "https://medium.com/@someone/post-123?utm_source=x" --intent submit-comment
tt-bridge experience find https://example.com --all --json
```

---

## 学习状态机（miss / hit）

记账的 key 是 `host|intent-slug`，不是完整 URL：同一站点上「提交评论」这件事，跨文章共享经验，但跨目标不共享。

**什么算 miss**：逻辑尝试没有达成目标——选择器找不到、eval 报错或返回空、抽取结果为空、没有可观察的验证结果、断言脚本返回 `false`。命令报错但已达成目标不算 miss；成功跑完但结果为空算 miss。

流程：

| 条件 | 结果 |
|---|---|
| 第 1 次 miss | 记账，继续 |
| 连续 2 次 miss | 标记 `candidate`：该意图可能本该用文本流程而非脚本。**不写正文、不建条目** |
| 第 3 次尝试（无论 miss 还是 hit）且无条目 | 触发自动捕获，返回 `captureRequired=true`、`suggestedId`、`draftPath`，CLI 同步自动建 **draft** 条目（frontmatter + 观察日志） |
| 已有 draft / 正式条目 | 自动记账不覆盖正文与选择器；改版失效时可通过 `update` 显式修正；draft 需人工 `finalize` 转正后才进入 verified 注入池 |
| 自动捕获首次命中（第 3 次是 hit） | 同样建 draft：命中说明方法可复现，值得沉淀 |
| 已有条目 + 连续 2 次 miss | 条目转 `stale`，`updateRequired=true` |
| 任一 hit | 连续 miss 归零，`confidence +0.1`（上限 1），刷新 `last_verified`；`stale` 自动恢复 `verified` |

阈值可调：`--threshold`（默认 2，连续几次 miss 触发候选）、`--capture-after`（默认 3，第几次尝试触发捕获），或环境变量 `TT_BRIDGE_EXPERIENCE_MISS_THRESHOLD` / `TT_BRIDGE_EXPERIENCE_CAPTURE_AFTER`。自动建 draft 可用 `--no-auto-capture` 关闭（仍返回 `captureRequired`）。`experience run` 只执行 `status: verified` 的脚本；draft/stale 需先 `show` 审核，确需执行时显式加 `--force`。`run` 会**自动记账**（exit 0 → hit，非 0 → miss，stderr 尾部作为 error），所以跑过 `run` 的任务不要再手动记一次。

推荐 `kind`：misses ≥ 2 → `text`（说明步骤有歧义、需要人类判断）；否则 `script`。调用方可以覆盖。

---

## 错误分类与 errclass

收工结算时，系统根据失败根因区分**页面未达成**与**环境异常**：

| errclass | 包含情形 | 记账处理 | 退出码 |
|---|---|---|---|
| `page` | 业务选择器未找到、表单验证不通过、页面报错、断言脚本返回 `false` | 正常累加 `misses` 与 `consecutiveMisses`；连续 2 次触发候选/stale | `1` |
| `env` | 标签页 pin 失效、debugger 端口占用、扩展断开连接、daemon 未启动、执行超时（>5s）、断言脚本语法错或自身异常抛出 | 标记为 `env` 错误，记录到日志但**不累加 misses**、**不把条目打成 stale** | `3` |

这样设计的目的：**工具链和外部环境的偶然抖动，不应惩罚经过验证的站点经验**。

---

## 三种 kind 怎么选

| kind | 什么时候用 | 入口 |
|---|---|---|
| `text` | 依赖人工判断、风格、一次性决策；步骤会变；不适合固化 | 按 `entry.md` 的步骤手工执行 CLI |
| `script` | 步骤稳定、输入输出明确、可断言；重复执行 | `tt-bridge experience run <id> --url <url>` |
| `hybrid` | 大部分可脚本化，但有一两步需要判断或人类确认 | 先 `run`，失败或需决策时回落到 `entry.md` |

判断口径：同一意图已经手打超过两遍 → 写脚本；脚本里出现「视情况而定」→ 降级 `hybrid`。最终提交类动作（发布、支付、删除）一律留人工确认，不写进脚本。

---

## 先查后做的工作流（事务化 begin / end）

`begin` + `end` 是**唯一推荐的自动记账入口**；手动敲 `hit` / `miss` 仅作为开发调试与无断言场景的手工兜底。

```bash
# 1. 查：这个页面有没有已知经验？
tt-bridge experience find "$URL" --intent submit-comment --json

# 2. 开工：声明事务（写 <root>/_episodes/<session>.json；同 session 重复 begin 为幂等覆盖）
tt-bridge experience begin --url "$URL" --intent submit-comment [--session <id>] [--json]

# 3. 执行：有 verified 脚本且环境支持先 run；否则 show 查步骤手动做
tt-bridge experience show <host>/<slug>

# 4. 收工：真实断言记账（自动验收、结算并删除 session 文件）
tt-bridge experience end --session <id> --assert ./assert-comment.js [--error <msg>] [--json]
```

### 事务命令：begin / end

- **`tt-bridge experience begin --url <u> --intent <slug> [--session <id>] [--json]`**
  - 在经验库写入 `<root>/_episodes/<session>.json`，记录 `{ schema: 1, session, url, intent, startedAt, steps: [] }`。
  - 未指定 `--session` 时默认使用 `crypto.randomUUID()` 自动生成。
  - 同一 `session` 重复执行 `begin` 视为**幂等覆盖**，不会报错。
- **`tt-bridge experience end --session <id> --assert <file> [--error <msg>] [--json]`**
  - 读取对应 episode 状态文件（不存在则报错，退出码 2）。
  - 若传入 `--error <msg>`，跳过断言执行，直接记为 miss。
  - 否则用 Node 运行 `--assert` 指定的 `.js` 脚本（顶层 `return true/false`，超时 5 秒）。
  - `true` 记 `hit`；`false` 记 `miss`。
  - 结果写回状态文件后立即删除该 session 文件（避免堆积）。
  - 输出 JSON：`{ session, result, url, intent, ledgerKey, captureRequired, record }`。
  - 退出码：`0` hit（达成）、`1` page-miss（页面未达成）、`3` env-miss（环境/断言异常）、`2` 用法错误。
- **手工兜底命令**：`tt-bridge experience hit` / `miss` 降级为手动调试与兜底手段，日常开发与任务流程禁止跳过 begin/end 手动敲账。

---

## 断言契约（Assertion Contract）

`experience end --assert <file>` 通过独立 Node 进程执行断言文件，以客观代码验收替代“主观臆断”：

| 项 | 约定 |
|---|---|
| 文件格式 | `.js` 脚本文件 |
| 返回值 | 约定脚本顶层 `return true`（达成，记 hit） / `return false`（未达成，记 miss）。**必须是同步返回值**：返回 Promise 会被判为断言错误（env，exit 3），不会静默记 miss |
| 超时 | 5 秒，到点用 **SIGKILL** 终止（忽略 `SIGTERM` 的脚本无法绕过） |
| 执行环境 | 独立 Node 进程，外层包裹 `new Function` 同步执行 |
| 相对 require | `require('./helper.js')` 相对**断言文件所在目录**解析，不是调用者的 cwd |
| 进程调用 | 脚本内可用 `require('node:child_process')` 调用 `tt-bridge eval` 等做真实页面校验 |
| 环境变量 | 继承并传入 `TT_BRIDGE_EXPERIENCE_DIR`，可在脚本中校验经验库路径 |
| 提前退出 | 脚本内 `process.exit(0)` 视为通过；`process.exit(非0)` 视为失败 |
| 边界红线 | **严禁写死具体的页面瞬时业务数据**（如某条评论文本、用户昵称、订单号）；只断言状态与特征（如关键元素可见、提示文案出现、状态变更等） |

典型断言脚本示例（`assert-comment.js`）。注意 `execSync` 起子进程时**总超时受 5 秒上限约束**；需要更长预算的校验应写进 `experience run` 的脚本而不是断言：

```javascript
const { execSync } = require('node:child_process');
// 调用 tt-bridge eval 检查评论是否在 DOM 中渲染
const res = execSync('tt-bridge eval "Boolean(document.querySelector(\\"div[data-testid=\'comment-success\']\\"))"', { encoding: 'utf8' }).trim();
return res === 'true';
```

---

## 捕获与转正

```bash
# 从当前页面沉淀一条新经验（自动生成 frontmatter + 观察日志）
tt-bridge experience capture \
  --url "https://site.com/page" --intent submit-comment \
  --kind text --description "在文章页提交一条评论" \
  --tags comment,rich-text

# 补齐正文 / 脚本，验证通过后转正
tt-bridge experience finalize site.com/submit-comment \
  --body-file ./body.md --script-file ./script.py --verify-script
```

`capture` 只建 `draft`（默认 `match: prefix`、URL 归一化后写入；可用 `--match exact|prefix|glob` 指定）；`finalize` 才把 `status` 提升为 `verified` 并刷新 `last_verified`、把 confidence 抬到至少 0.6。`--verify-script` 会先按脚本契约试跑一次（URL 优先用 `--url`，否则用条目自身的 `url`），exit 0 才转正，失败则保持 `draft` 并报错；执行已存脚本必须同时给 `--allow-script-exec`，若在同一条命令里用 `--script-file` 刚写入脚本则无需该开关。`kind: text` 不允许带脚本；`script`/`hybrid` 在 `draft` 阶段可以暂时没有脚本，但 `finalize` 前必须补上，否则校验报错。

## 维护

```bash
tt-bridge experience begin --url "$URL" --intent <slug> [--session <id>] [--json]
tt-bridge experience end --session <id> --assert <file> [--error <msg>] [--json]
tt-bridge experience list --host medium.com --status stale   # 该修的条目
tt-bridge experience update <id> --status verified --description "新描述"
tt-bridge experience deprecate <id> --reason "站点改版，流程失效"
tt-bridge experience reindex          # 索引丢失/漂移时重建，不要手改 index.json
tt-bridge experience validate         # 必填字段、枚举、url/host 一致性、路径、script 存在性；缺 ## 目标/## 步骤/## 验证 只告警
tt-bridge experience ledger list
tt-bridge experience ledger show 'medium.com|submit-comment'
tt-bridge experience ledger prune --older-than 90d
tt-bridge experience ledger reset     # 清空学习计数，条目本身不动
```

`validate` 应在提交新条目、批量导入、迁移后各跑一次。`prune` 只清账本历史，不影响条目状态。

---

## 注入协议（advise）— 经验怎么被看见

写入只解决一半问题。经验要被"主动看见"，靠执行前的注入决策 `advise()`：

```bash
tt-bridge experience advise --host gemini.google.com --action key --arg Enter --json
```

每执行一条浏览器命令前，CLI 会走同一条决策路径，命中才往 **stderr** 打一行（≤200 字符），stdout 契约一律不动。

| 层 | 命中条件 | 输出 |
|---|---|---|
| 1 `entry` | 该 host 的 `verified` 条目，且 `triggers` 匹配当前动作 | 下一步动作（`run` / `show`） |
| 2 `pattern` | `_patterns/` 里的跨站模式命中同一动作或错误文本 | 症状警告 |
| 3 `atom` | `_trace/` 近 7 天该 host+action 失败率 ≥0.5 且样本 ≥2 | 失败统计 |
| 4 静默 | 以上都不命中 | 不打任何字 |

规则：

- **命中即返回，绝不叠加**——一行提示比三条提示有用。
- **按动作匹配，不按 URL 匹配**：URL 匹配会在整站每条命令上重复，立刻沦为噪音。
- **每 session 每个 trigger 只提示一次**，去重状态存 `$TMPDIR/tt-bridge-seen-<session>.json`。
- **懒验证**：命中的条目若 `last_verified` 超过 30 天，先跑它的 `assert.js`。通过则刷新时间戳；不通过则转 `stale`，提示改为"暂无有效经验"，**不再给出可执行步骤**。不做任何定时降级任务——时间本身不产生维护压力，只有真实使用才产生。
- **失败后**额外允许 pattern 层按错误文本匹配一次——已经失败了，任何提示都不算打扰。
- 关闭：`--quiet` 或 `TT_BRIDGE_EXPERIENCE_SILENT=1`；关流水：`TT_BRIDGE_EXPERIENCE_NO_TRACE=1`。

---

## 脚本契约

```bash
python3 script.py --url <url> [--json] [-- <args>]
```

| 项 | 约定 |
|---|---|
| 输入 | `--url`；env `TT_BRIDGE_URL`、`TT_BRIDGE_ENTRY_ID`、`TT_BRIDGE_EXPERIENCE_DIR` |
| 输出 | stdout 单个 JSON：`{"ok":true,"steps":[],"evidence":{}}` |
| 退出码 | `0` 达成目标，`1` 未达成，`2` 用法错误 / 前置条件不满足 |
| 交互 | 非交互，禁止读 stdin、禁止弹窗 |
| 依赖 | 只用 Python 标准库；调用浏览器走 `tt-bridge` 子进程 |
| 定位 | 优先 `role=`、可见文本、`data-testid`，少用深层 CSS 链 |
| 密钥 | 不落盘、不打印、不写进 `evidence` |

`steps` 记录做了什么（每步可带 `ok` 与关键观察），`evidence` 存能复核的产物（URL、计数、断言结果），不要把整页正文塞进去。失败时额外给 `error`，方便 `miss --error` 直接复用。模板见 `_templates/script.py`：参数解析、`tt-bridge` 子进程调用、轮询等待与退出码都已就绪，只需补站点流程、把 `STEPS_IMPLEMENTED` 置为 `True`、并设定 `GOAL_SELECTOR`（或传 `--expect`，或设 `TT_BRIDGE_EXPECT_SELECTOR`）；未改完的模板以 exit 2 拒绝执行，避免误记 hit。

`experience run` 的调用形态：解释器 + 脚本 + `--url <url>` + `--` 之后的透传参数；`--` 本身不传给脚本。不传 `--url` 时用条目自身的 `url`（可能是 glob）。stdout 会被解析进 `run --json` 的 `data`；单次执行默认 120 秒超时（exit 124）。调试时单独跑脚本（`run` 会自动记一次 hit/miss）：`python3 experience/site.com/submit-comment/script.py --url "$URL"; echo $?`

---

## 隐私与安全红线

`_trace/YYYY-MM-DD.jsonl` 记录每条浏览器命令（`host`/`cmd`/`action`/`arg`/`ok`/`error`），供失败率聚合：

- `input`/`type`/`key` 的正文**一律不落盘**，只记 `<redacted:N>`（长度占位）；
- `open`/`navigate` 的 URL 保留 host 与 path，query 值全部替换为 `[REDACTED]`（参数名保留）；
- `eval` 代码先按同一套规则脱敏（Bearer/token=/userinfo）再截断，避免凭据落盘；
- `error` 走同一套脱敏规则（Bearer/Cookie/token=/userinfo）；
- 文件以 `0600` 创建；设 `TT_BRIDGE_EXPERIENCE_NO_TRACE=1` 可完全关闭。

**断言文件会被执行**：`end --assert` 与懒验证都会用 Node 运行它。只对你自己写或审阅过的断言文件使用 `--assert`；从外部拿到的 playbook 先用 `experience show <id>` 读一遍。


- **不存凭据**：cookie、token、密码、会话 ID 一律不写进条目、脚本、`evidence`、账本。URL 中的敏感 query 参数会在归一化时直接丢弃；错误文本写入账本/草稿前会脱敏 `Bearer`、`Cookie`、`token=` 等模式并压成单行。
- **不存业务数据**：抓到的正文、邮箱、订单、私信只留在当次任务输出里，不进 experience 目录。
- **不存页面快照**：`assets/` 只放脱敏后的选择器样例或结构片段。
- **脚本不自动提交不可逆动作**：发布、支付、删除、注销必须人类确认；脚本最多做到预填与校验。
- **默认接管真实登录态**（`workspace = human`），禁用无痕模式；不要把「换无痕绕过登录」写进条目。
- 发现条目里混入敏感信息：直接 `update` 覆写正文，或 `deprecate` 后重建。

---

## 常见坑

| 症状 | 原因 | 处理 |
|---|---|---|
| frontmatter 解析失败 / 条目被跳过 | 用了嵌套 map 或 `\|` 块标量 | 改成扁平标量 + 字符串数组 |
| `find` 召回一堆同站条目 | 没带 `--intent`（intent 是精确 slug 过滤） | 补 `--intent`；用 `--json` 看 `score` 与 `matchType` |
| 同一页面匹配到多条 | 多个条目 URL 区间重叠 | 提高 match 特异度（`prefix` → `exact`），或把 glob 收窄 |
| 条目一直不改状态 | 只记 hit 或只记 miss | 每个逻辑尝试都记；连续 miss 才会触发候选/stale |
| `stale` 条目仍被选中 | `stale` 只降分不排除 | 确认是否该修；修好后 `hit` 会自动恢复 `verified`，否则 `deprecate` |
| `run` 报找不到脚本 | `kind: text`，或 `script` 字段缺失 | 看 `entry.md` 手工执行，或 `finalize --script-file` |
| 不想自动建 draft | 规则触发 `captureRequired` | 加 `--no-auto-capture`，仍返回 `captureRequired` 供人工决定 |
| 重建后索引仍不对 | entry.md 本身非法 | 先 `validate`，再 `reindex` |
| 账本写入冲突 | 并发 miss/hit | 已有锁文件（`_ledger/attempts.lock`）；不要手动编辑 `attempts.json` |

条目从 `draft` 到 `verified` 的唯一标准是：**按条目步骤（或跑脚本）真做了一遍，且 `verification` 里的断言全部成立。**
