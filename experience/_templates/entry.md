---
schema: 1
id: example.com/do-something
host: example.com
url: "https://example.com/path"
match: exact
kind: text
description: "一句话说明在什么页面达成什么目标"
created: "2026-01-01T00:00:00Z"
updated: "2026-01-01T00:00:00Z"
last_verified: "2026-01-01T00:00:00Z"
status: draft
confidence: 0.5
tags:
  - example
preconditions:
  - 已登录站点账号
selectors:
  - 'role=button[name="Save"]'
verification:
  - 页面出现保存成功提示
attempts: 1
misses: 0
source: manual
---

<!--
模板：复制到 experience/<host>/<slug>/entry.md 后替换所有占位值。
- 只允许扁平标量 + 字符串数组，不要嵌套 map、不要 | / > 块标量。
- id 必须等于 <host>/<slug>，并与目录路径一致。
- match: exact | prefix | glob；kind: text | script | hybrid。
- status: draft | verified | stale | deprecated；confidence 0..1。
- script 字段可选，写目录内的相对文件名（如 script.py）。
- 优先用 `tt-bridge experience capture ... --body-file` 自动生成，再手工补齐正文。
-->

## 目标

<!-- 一段话：在哪个页面、完成什么、成功的长什么样。 -->

## 触发条件

<!-- 什么 URL / 什么前置条件 / 什么用户请求才适用。写清不适用的情况。 -->

## 步骤

<!-- 可复现的最短路径：命令、选择器、顺序、等待条件。一步一个编号。 -->

1.

## 坑与修正

<!-- 真实踩过的坑：症状 -> 原因 -> 修正。这是条目里最值钱的部分。 -->

| 坑 | 症状 | 修正 |
|---|---|---|
|  |  |  |

## 验证

<!-- 不靠"看起来成功"的判断标准：DOM 断言、计数变化、接口返回、页面文案。 -->

-

## 脚本说明

<!-- kind: text 时写"无需脚本"；kind: script/hybrid 时写入口、参数、输出字段、退出码含义。 -->
