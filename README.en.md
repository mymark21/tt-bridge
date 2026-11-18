# TT Bridge

### What you see is what your AI sees.

**Let your AI agent drive the Chrome you're already using — with your logins, tabs, and real windows intact. No second browser, no cookie export, no repeated authorization.**

[![Release](https://img.shields.io/github/v/release/mymark21/tt-bridge?label=release&color=111111)](https://github.com/mymark21/tt-bridge/releases/latest)
[![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0-111111)](LICENSE)
![Chrome](https://img.shields.io/badge/Chrome-extension-4285F4?logo=googlechrome&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-111111)

[简体中文](README.md) · **English**

**[Quick start](#quick-start)** · **[What it does](#what-it-does)** · **[How it works](#how-it-works)** · **[Security & privacy](#security--privacy)** · **[Documentation](#documentation)** · **[Changelog](CHANGELOG.md)**

---

## What is TT Bridge

TT Bridge has three parts: a Chrome extension, a local-only daemon, and a CLI your agent calls. The agent sends commands through the CLI; the daemon routes them to the extension; the extension drives the Chrome window you already have open through `chrome.debugger` (CDP).

It doesn't launch a fresh headless browser, and it doesn't ask you to export cookies. Your agent can work with whatever you're signed into. It operates on whichever tab you hand over.

```
Claude Code / Codex / Cursor / another agent
        │  tt-bridge CLI
        ▼
local daemon (127.0.0.1:19826–19835)
        │  WebSocket
        ▼
Chrome extension (chrome.debugger / CDP)
        │
        ▼
the Chrome tab you're already using
```

Everything runs on your machine. TT Bridge has no cloud account and no relay server.

## Who it's for

**It's for you if:**

- Your task depends on an account you're already signed into — dashboards, SaaS, social platforms, internal tools.
- You want your agent to work in the window in front of you, not a browser you can't see.
- You use Claude Code, Codex, Cursor, or another agent that can run commands.
- You want repeatable browser workflows: scraping, form filling, screenshots, RPA.

**It's not for you if:**

- You need a cloud browser farm, large-scale concurrency, or multi-tenant automation.
- You can't run a Node.js service on your machine.
- You need a fully isolated crawler that never touches a real login session — Playwright or a similar tool is a better fit.

## Quick start

### Let your AI install it (recommended)

Paste this into your agent:

> I want to install TT Bridge.
>
> Project: https://github.com/mymark21/tt-bridge
>
> Important: install the CLI from the zip attached to this project's GitHub Release. Do not use the same-named `tt-bridge` package on npm/npx.
>
> Please install it for me, and walk me through any Chrome extension steps one at a time. The full steps are in the "Full installation instructions for AI agents" section at the end of the README.

Your agent handles the CLI install, extension download, and verification. You only need to:

1. Open `chrome://extensions`, enable Developer mode, and load the unpacked `tt-bridge-chrome-extension` folder.
2. Click **允许 AI 控制** (Allow AI control) once in the extension popup.

<details>
<summary>Manual install (without an agent)</summary>

**Requirements:** Chrome; Node.js ≥ 18.

> Windows: the PowerShell equivalents are in steps 2 and 3 of the agent instructions at the end of this README.

**1. Install the CLI**

```bash
curl -L -o tt-bridge-cli.zip https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-cli.zip
unzip -o tt-bridge-cli.zip
cd tt-bridge-cli
npm install -g .
tt-bridge --help
```

> The zip already bundles the `ws` dependency the daemon needs. Don't install the same-named `tt-bridge` package from the npm registry, and don't use `npx tt-bridge`.

**2. Install the Chrome extension**

```bash
curl -L -o tt-bridge-extension.zip https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-extension.zip
unzip -o tt-bridge-extension.zip
```

Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the extracted `tt-bridge-chrome-extension` folder. Then click **允许 AI 控制** in the extension popup.

**3. Start and verify**

```bash
tt-bridge daemon start
tt-bridge status --json
```

Look for `"extensionConnected": true`.

</details>

## Your first takeover

On first install, click **允许 AI 控制** once in the extension popup. The extension connects to the local daemon. After that, the primary button becomes **复制连接指令** (Copy takeover command):

1. Click **复制连接指令**.
2. Paste the copied text into your agent.
3. The agent runs the included commands to select the instance / window / tab and pins the target. Every later command applies to that tab.

You don't need to open the popup and toggle the extension for every task, and you don't re-authorize each time. **暂停** (Pause) just disconnects temporarily. A green shield marks the tab currently under takeover, and the activity glow shows where your agent is working.

If the local service isn't running after a reboot, the popup shows **等待服务** (Waiting for service). Click **复制启动指令** (Copy startup command) and paste it into your agent; the agent runs `tt-bridge daemon start`. The extension reconnects automatically — no need to come back to the popup.

## What it does

| Capability | What it means |
| --- | --- |
| **Real browser takeover** | `human` mode by default: operate the Chrome window in front of you, reusing its logins, cookies, extensions, and page state. |
| **Sticky targeting** | Three layers — `instance`, `window`, `tab pin`. If the target goes offline, TT Bridge keeps a tombstone and returns an explicit error instead of silently drifting to another profile. |
| **Multi-profile / multi-window** | List windows across profiles, switch in seconds, raise on demand; hot-reload the extension without visiting `chrome://extensions` in every profile. |
| **Native keyboard input** | `focus` / `type` / `key` send trusted CDP input events, so text goes into Slate, ProseMirror, Medium, Notion, and other rich editors like a real person typed it. |
| **Viewport emulation** | Eight phone/tablet presets, plus custom width, height, DPR, touch, and User-Agent. Screenshots can apply a device preset for one capture. |
| **Screenshots** | Full page, a specific viewport, or mobile. If the target window is minimized, `--restore` brings it back before capturing. |
| **Cookie inspection** | `cookies` masks values by default; only `--show-values` prints them in the clear. |
| **Site experience library** | Save a site's steps, gotchas, and scripts locally; TT Bridge surfaces them on the next visit. |
| **Secure by default** | Loopback-only binding, bearer token, Host/Origin checks, redacted logs, redacted `/status`. |

Common commands:

```bash
tt-bridge status                     # daemon and extension connection
tt-bridge tab list                   # tabs in your real browser
tt-bridge tab pin --tab 123          # keep later commands on this tab
tt-bridge open "https://example.com"
tt-bridge eval "document.title"
tt-bridge screenshot page.png --full-page
tt-bridge type "Some text"; tt-bridge key Enter
tt-bridge emulate iphone14           # mobile viewport
tt-bridge window list                # every window across profiles
tt-bridge instance list              # connected Chrome instances
```

## How it works

**The Chrome extension** holds the debugger attachment, executes CDP commands, and shows connection state, the target tab, and agent activity in the popup.

**The local daemon** serves HTTP and WebSocket on `127.0.0.1:19826–19835`. It discovers the port, checks the token, routes commands to the right extension instance, and keeps pin and tombstone state. Chrome's MV3 service worker sleeps; the daemon gives the CLI a stable endpoint so it doesn't have to care when the extension wakes up.

**The CLI** is what your agent calls. It only talks to the local daemon, reads `~/.config/tt-bridge/token`, and sends commands as JSON.

Ports start at `19826` and walk forward to `19835` if a port is taken. Every route except `/ping` and `/status` requires the bearer token.

## Security & privacy

- The daemon binds to `127.0.0.1` only; it is never exposed to your LAN.
- Every route except discovery requires the bearer token in `~/.config/tt-bridge/token` (mode `0600`).
- Loopback `Host` is validated and browser `Origin` headers are rejected. HTTP bodies are capped at 5 MiB, WebSocket frames at 100 MiB, and in-flight commands at 256.
- `/status` returns masked profile data only: email, Gaia ID, and display name are never exposed raw.
- Log lines forwarded by the extension are scrubbed of bearer credentials, token/cookie assignments, and URL query values; the daemon log is `0600`.
- Cookie values are masked by default. Experience traces keep only redacted `eval` snippets and URLs with query strings removed.
- Debugging and navigation refuse `chrome://`, `chrome-extension://`, `file://`, `view-source:`, and `devtools://`; `navigate` accepts only `http(s)` and `about:blank`.
- Stopping service detaches every debugger, so no "being debugged" banner lingers.
- TT Bridge itself uploads nothing. Whether page content reaches a model depends on the AI tool you use.

Known limitation: the extension's `/ext` WebSocket is not mutually authenticated. Don't expose the daemon port, don't tunnel it, and don't run it on a shared host. The full threat model and reporting process are in [SECURITY.md](SECURITY.md).

## How it compares

| Approach | Difference |
| --- | --- |
| **Playwright / Puppeteer** | Starts a clean browser session; TT Bridge takes over the Chrome you're already using, with your logins and extensions. |
| **Cloud browsers / hosted scraping APIs** | Page content and cookies pass through a third party; TT Bridge's daemon listens only on your machine, with no relay. |
| **Some browser-takeover extensions** | Often require re-authorizing for every task; TT Bridge authorizes once, then hands over the target with a copied command. |

## Documentation

| Document | Contents |
| --- | --- |
| [SKILL.md](SKILL.md) | Full agent guide: targeting, commands, experience library, troubleshooting. |
| [SECURITY.md](SECURITY.md) | Threat model, security design, known limits, vulnerability reporting. |
| [CHANGELOG.md](CHANGELOG.md) | Release history. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development, tests, and commit conventions. |
| [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md) | How public source maps to build artifacts. |
| [PORTING.md](PORTING.md) | Boundary between the public and development trees. |
| [experience/README.md](experience/README.md) | Format and usage of the site experience library. |

## Project status

- Current public version: **v1.4.5**.
- This repository contains source only. `tt-bridge-extension.zip`, `tt-bridge-cli.zip`, and `SHA256SUMS.txt` are built by GitHub Actions on `v*` tags and attached to the GitHub Release; they are never committed.
- This is the free core. Cloud sync, team sharing, hosted site packs, remote relay, audit/SSO/RBAC, orchestration, and record/replay are commercial features and are not in this repository. The public line continues to receive free features and security fixes; see [PORTING.md](PORTING.md) for the boundary.

## Feedback & contributing

- **Bugs / feature requests:** open a GitHub Issue.
- **Security issues:** do not open a public issue. Follow the private reporting process in [SECURITY.md](SECURITY.md).
- **Pull requests:** open an issue first to describe the use case, keep the change focused, and run the tests in [CONTRIBUTING.md](CONTRIBUTING.md) before submitting.
- If TT Bridge saves you from repeated logins and authorization prompts, a Star is the best way to support it.

## Acknowledgements

- Architecture inspired by [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser).

## License

[CC BY-NC 4.0](LICENSE). You may copy, modify, and redistribute with attribution, for non-commercial use. Commercial use requires a separate license from the maintainer.

---

<!-- BEGIN AGENT INSTRUCTIONS -->
## Full installation instructions for AI agents

<details>
<summary>Expand: the full installation prompt (human users don't need to read this)</summary>

````text
# TT Bridge Agent Installation Prompt

This section is for AI agents (Claude Code, Codex, Cursor, Workbody, Copilot, etc.). A human has asked you to install or use TT Bridge. Follow these instructions and don't make the human do complicated manual work.

### When the human says "install TT Bridge"

Work step by step and report progress after each step.

**Important principles:**
- You are responsible for installing the CLI and preparing the Chrome extension folder in the human's Downloads folder.
- **All command-line work is done by you (the AI) in the background.** This includes, but is not limited to: downloading, unzipping, `npm install`, `tt-bridge --help`, `tt-bridge daemon start`, `tt-bridge status`, and smoke-test commands.
- **Never show command-line content to the human.** Don't paste shell / PowerShell / terminal commands, and don't write "please run the following command" or "when done, run `tt-bridge ...`".
- The human can't see and doesn't need to understand the command line. Run it yourself, verify it yourself, and report only the result.
- The human does two things: load the extension in Chrome's GUI, and click **允许 AI 控制** once on first use. After that, for each takeover, the human only clicks **复制连接指令** in the popup and pastes the copied text to you. Installation, startup, verification, and the background daemon are all your job.
- The TT Bridge CLI must be installed from the `tt-bridge-cli.zip` attached to this project's GitHub Release.
- Don't use `npx tt-bridge`, and don't run `npm install -g tt-bridge` to install the same-named package from the npm registry. The npm package is not this browser bridge.
- The `npm install -g .` below registers the command from the local `tt-bridge-cli` folder you just unzipped; it does not install `tt-bridge` from the public npm registry.
- The Chrome extension must be loaded from the `tt-bridge-extension.zip` attached to this project's GitHub Release.
- At the Chrome extension step, stop and let the human operate Chrome themselves.
- Don't try to open or automate `chrome://extensions/` for the human.
- Don't dump absolute paths on the human. Just tell them: open the Downloads folder and select `tt-bridge-chrome-extension`.
- Before continuing verification, wait for the human to confirm that the extension is loaded, **Allow in incognito** is enabled, and they have clicked **允许 AI 控制** once in the popup. After they reply, run `tt-bridge daemon start` and `tt-bridge status` yourself in the background, and report only the verification result — don't show the commands.

**Default targeting policy:**
- TT Bridge takes over the ordinary Chrome window the user currently sees.
- Don't treat a separate incognito automation window as a successful human-browser install.
- During install verification, first ask the user to switch to the Chrome window they want taken over.
- The smoke test should open a new tab in that ordinary Chrome window, not a separate incognito automation window.
- Only enter an isolated automation workspace when the user explicitly passes `--workspace <name>`; non-human workspaces may keep creating dedicated incognito windows.
- `--human` is only a compatibility alias; human is already the default.

**Download path rules:**
- Mac: `~/Downloads/`
- Windows: `%USERPROFILE%\Downloads\`
- Below, `[Downloads]` stands for the right path on the current system.

**Step 1 — Make sure Node.js is installed (≥ 18)**

```bash
node --version
```

If it isn't installed:
- **Mac:** `brew install node`
- **Windows:** download the installer from https://nodejs.org

**Step 2 — Download and install the CLI**

The CLI zip already includes the `ws` dependency the daemon needs. After unzipping, prefer `npm install -g .` to register the `tt-bridge` command.

Note: the trailing dot in `npm install -g .` means "install the local folder you just unzipped". Don't write `npm install -g tt-bridge`; that installs a different same-named package from the public npm registry.

Mac/Linux:

```bash
# Download the CLI zip to Downloads
curl -L -o "[Downloads]/tt-bridge-cli.zip" https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-cli.zip

cd "[Downloads]"
rm -rf tt-bridge-cli
unzip -o tt-bridge-cli.zip

# Register the tt-bridge command from this local folder; do NOT run npm install -g tt-bridge
cd tt-bridge-cli
npm install -g .
```

Windows PowerShell:

```powershell
Invoke-WebRequest -Uri "https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-cli.zip" -OutFile "$env:USERPROFILE\Downloads\tt-bridge-cli.zip"
cd "$env:USERPROFILE\Downloads"
Remove-Item .\tt-bridge-cli -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive .\tt-bridge-cli.zip . -Force
cd .\tt-bridge-cli
# Register the tt-bridge command from this local folder; do NOT run npm install -g tt-bridge
npm install -g .
```

If Windows PowerShell blocks `npm.ps1` because of the execution policy, don't assume the package is corrupt. Use:

```powershell
cmd /c npm install -g .
```

Verify:

```bash
tt-bridge --help
```

**Step 3 — Download and install the Chrome extension**

Mac/Linux:

```bash
# Download the extension zip to Downloads
curl -L -o "[Downloads]/tt-bridge-extension.zip" https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-extension.zip

# Unzip it in Downloads
cd "[Downloads]"
rm -rf tt-bridge-chrome-extension
unzip -o tt-bridge-extension.zip
```

This creates a new folder in Downloads: `tt-bridge-chrome-extension`. The human will select only this folder later.

Windows PowerShell:

```powershell
Invoke-WebRequest -Uri "https://github.com/mymark21/tt-bridge/releases/latest/download/tt-bridge-extension.zip" -OutFile "$env:USERPROFILE\Downloads\tt-bridge-extension.zip"
cd "$env:USERPROFILE\Downloads"
Remove-Item .\tt-bridge-chrome-extension -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive .\tt-bridge-extension.zip . -Force
```

This creates a new folder in Downloads: `tt-bridge-chrome-extension`. The human will select only this folder later.

Before telling the human, confirm the folder really exists in Downloads:

Mac/Linux:

```bash
ls "[Downloads]" | grep tt-bridge-chrome-extension
```

Windows PowerShell:

```powershell
Test-Path "$env:USERPROFILE\Downloads\tt-bridge-chrome-extension"
```

If you don't see `tt-bridge-chrome-extension`, don't send the human hunting through Chrome. Download and unzip the extension package again, then confirm the folder exists.

Then tell the human (show this verbatim):

> Now load the extension in Chrome:
>
> 1. Open Chrome and go to **chrome://extensions/**
> 2. Turn on **Developer mode** in the top right
> 3. Click **Load unpacked** in the top left
> 4. In the file picker, open your **Downloads** folder and select the **tt-bridge-chrome-extension** folder; if the human prefers drag-and-drop, they can drag the folder onto the extensions page
> 5. After it loads, find **TT Bridge** in the extension list (dark rounded-square icon), click **Details**, and enable **Allow in incognito**
> 6. Back in the Chrome toolbar, click the **TT Bridge** icon and click **允许 AI 控制** in the popup (only the first time; after it connects, the primary button becomes **复制连接指令**)
>
> Note: **tt-bridge-chrome-extension** is the folder Chrome needs. Don't open it and select a folder inside it.
>
> When you're done, reply "done".

**Step 4 — Start the service and verify**

After the human confirms the extension is loaded, **Allow in incognito** is enabled, and **允许 AI 控制** has been clicked once, run the following commands yourself in the background; they are for you only, not for the human:

```bash
tt-bridge daemon start
```

Wait 3–5 seconds, then run:

```bash
tt-bridge status
```

Seeing `"extensionConnected": true` means success. Tell the human only the result, for example: "The extension is connected and the service is running."

If it's `false`: ask the human to click the TT Bridge icon in the Chrome toolbar. If the popup shows **允许 AI 控制**, click it once; if it shows **复制连接指令**, click it and send you the copied text, then run the commands inside to take over. Then run `tt-bridge daemon start` yourself, wait 3–5 seconds, and run `tt-bridge status` again. If it's still `false`, ask the human to confirm that **Allow in incognito** is enabled on the extension details page. Never show command-line content to the human.

**Step 5 — Smoke test**

Run all of the following yourself in the background; don't paste them to the human, only report the final result:

```bash
tt-bridge daemon start
tt-bridge status --json
tt-bridge tab new https://www.google.com --json
tt-bridge eval "JSON.stringify({url: location.href, title: document.title})"
tt-bridge sessions --json
```

Acceptance criteria:
- `status --json` must show `"extensionConnected": true`
- The new tab must appear in the ordinary Chrome window the user currently sees
- `eval` must return Google's URL and title
- `sessions --json` must not produce `incognito: true` for this human-browser verification
- If an `incognito: true` automation session appears, verification failed: you took over an automation window, not the ordinary Chrome in front of the user

Tell the human:
> "TT Bridge is installed and the current page is under takeover. You can now ask me to browse, operate pages, and collect data."
>
> Then ask:
> "Would you like me to create a Skill for starting and taking over the browser, named ttbridge? Then you can just say 'start ttbridge' and I'll handle the whole startup and takeover flow."

### Core usage pattern

The takeover commands the human copies from the popup are usually `tt-bridge instance use ...`, `tt-bridge window use ...`, and `tt-bridge tab pin --tab ...`. Run them in order to pin later commands to the tab in front of the human; don't switch windows casually after `tab pin`.

```bash
# Navigation
tt-bridge open "https://example.com"

# Read page state
tt-bridge eval "document.title"
tt-bridge eval "JSON.stringify({url: location.href, text: document.body.innerText.slice(0, 3000)})"

# Interaction
tt-bridge click "button.submit"
tt-bridge eval "document.querySelector('#search').value = 'hello'"

# Native keyboard input: type into rich text editors
tt-bridge focus "div[contenteditable='true']"    # give the target element native focus
tt-bridge type "This is a comment."              # inject trusted text (fires real input events)
tt-bridge key Enter                              # send special keys (Enter/Tab/Backspace/Escape)

# Mobile and multi-device viewport emulation
tt-bridge emulate iphone14                        # apply a built-in device preset
tt-bridge emulate 390 844 --dpr 3 --mobile        # custom width, height, DPR, mobile
tt-bridge emulate reset                           # restore the desktop viewport and UA

# Screenshots (--device / --viewport apply emulation for one capture, then reset)
tt-bridge screenshot /tmp/page.png --full-page
tt-bridge screenshot /tmp/mobile.png --device iphone14
tt-bridge screenshot /tmp/wide.png --viewport 1280x720
tt-bridge screenshot /tmp/page.png --restore      # restore a minimized window before capture (human mode only)

# Multi-window and multi-profile (introduced in v1.4.0)
tt-bridge window list                             # all windows across profiles (IDX / instance / profile / tabs / active page)
tt-bridge window use 0                            # switch target window (does not steal focus by default)
tt-bridge window use 1 --focus                    # switch and raise the target window
tt-bridge window focus 1                          # same as use --focus
tt-bridge window status                           # details of the current target window
tt-bridge profile list                            # all Chrome profiles on this machine and their connection state
tt-bridge reload --all                            # hot-reload the extension in every connected profile
tt-bridge reload --instance <label>               # hot-reload the extension in one profile

# Cookies (values are masked by default; --show-values prints live credentials — never paste them into logs or model context)
tt-bridge cookies --domain localhost
tt-bridge cookies --domain localhost --show-values --json

# The default workspace is human, which operates the ordinary Chrome window the user sees.
# For isolated automation, pass a workspace explicitly:
tt-bridge open "https://example.com" --workspace mytask
tt-bridge close-window --workspace mytask

# Compatibility alias; human is already the default:
tt-bridge eval "document.title" --human
```


### Built-in device presets

| Preset | Spec |
|--------|------|
| `iphone14` | 390×844, DPR 3 |
| `iphone14pro` | 393×852, DPR 3 |
| `iphone14promax` | 430×932, DPR 3 |
| `iphonese` | 375×667, DPR 2 |
| `ipad` | 820×1180, DPR 2 |
| `ipadpro` | 1024×1366, DPR 2 |
| `pixel7` | 412×915, DPR 2.625 |
| `galaxys23` | 360×780, DPR 3 |

Mobile presets enable `mobile` and `touch` by default and set a matching mobile User-Agent. `emulate` accepts `--dpr <n>`, `--mobile`, `--touch`, and `--user-agent <str>` to override preset values; explicit dimensions win when they conflict with a preset. Preset names ignore case and separators: `iPhone 14 Pro`, `iphone-14-pro`, and `iphone14pro` all match.
````

</details>
<!-- END AGENT INSTRUCTIONS -->
