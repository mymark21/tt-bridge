# TT Bridge

**A direct bridge between AI agents and your browser.**

Your AI agent sees exactly what you see — the same page, the same session, the same logged-in state. No re-authentication. No separate browser profile. No repeated approval prompts.

TT Bridge gives an AI agent (Claude Code, Cursor, or any terminal-based agent) direct control over a dedicated Chrome window via a lightweight local daemon and a companion Chrome extension.

---

## How It Works

```
┌──────────────┐    HTTP POST /command     ┌──────────────┐    WebSocket     ┌──────────────────┐
│              │ ────────────────────────►  │              │ ───────────────► │                  │
│  CLI / Agent │                           │   Daemon     │                  │ Chrome Extension │
│              │ ◄──────────────────────── │  (127.0.0.1) │ ◄─────────────── │ (Service Worker) │
└──────────────┘    JSON response          └──────────────┘    JSON result   └────────┬─────────┘
                                                                                     │
                                                                              chrome.debugger API
                                                                                     │
                                                                              ┌──────▼─────────┐
                                                                              │  Chrome Window  │
                                                                              │   (Incognito)   │
                                                                              └────────────────┘
```

1. **CLI** sends commands to the local daemon via HTTP on `127.0.0.1:19826–19835`
2. **Daemon** forwards commands to the Chrome extension via WebSocket
3. **Extension** executes them in a dedicated incognito window using `chrome.debugger` (CDP)
4. Results flow back the same chain

All traffic stays on loopback. Nothing leaves your machine.

---

## Quick Start

### 1. Install the CLI

```bash
npm install -g tt-bridge
```

Or run on-demand:

```bash
npx tt-bridge <command>
```

### 2. Install the Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` directory from this repository
5. Open the extension details page and enable **Allow in Incognito**

### 3. Start Using It

```bash
tt-bridge open https://x.com/home --workspace twitter
tt-bridge eval "document.title" --workspace twitter
tt-bridge screenshot x-home.png --workspace twitter --full-page
tt-bridge tab list --workspace twitter
```

The daemon auto-starts on first use and shuts down after 5 minutes of idle time.

---

## Commands

| Command | Description |
|---|---|
| `tt-bridge open <url>` | Navigate to a URL |
| `tt-bridge eval <js>` | Execute JavaScript in the page and return the result |
| `tt-bridge click <selector>` | Click a DOM element by CSS selector |
| `tt-bridge screenshot [path]` | Capture screenshot (base64 to stdout, or file if path given) |
| `tt-bridge tab list` | List all tabs in the automation window |
| `tt-bridge tab new [url]` | Open a new tab |
| `tt-bridge tab select <index>` | Switch to a tab by index |
| `tt-bridge tab close <index>` | Close a tab by index |
| `tt-bridge sessions` | Show active automation sessions |
| `tt-bridge close-window` | Close the automation window |
| `tt-bridge status` | Show daemon and extension connection status |
| `tt-bridge daemon start\|stop\|status` | Manage the local daemon lifecycle |

### Flags

| Flag | Description |
|---|---|
| `--workspace <name>` | Isolate sessions by workspace (default: `default`) |
| `--human` | Target the human's currently active tab instead of the automation window |
| `--json` | Output machine-readable JSON |
| `--full-page` | Capture full-page screenshots |
| `--format png\|jpeg` | Screenshot output format |
| `--quality <n>` | JPEG quality (0–100) |

---

## Design Principles

- **Dedicated incognito window** — Automation runs isolated from your normal browsing. Your everyday tabs are never touched.
- **Zero repeated approvals** — The extension holds the `debugger` permission permanently. You approve once on install.
- **Workspace isolation** — Each `--workspace` gets its own incognito window with independent tabs and cookie state.
- **Auto-start / auto-stop** — The daemon starts on first command and exits after 5 minutes idle. No process management needed.
- **Loopback only** — The daemon binds to `127.0.0.1`. Nothing is exposed to the network.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_BROWSER_BRIDGE_HOST` | `127.0.0.1` | Daemon bind address |
| `AGENT_BROWSER_BRIDGE_PORT` | `19826` | Daemon start port |
| `AGENT_BROWSER_BRIDGE_MAX_PORT` | `19835` | Maximum port to try |
| `AGENT_BROWSER_BRIDGE_IDLE_TIMEOUT_MS` | `300000` | Daemon idle timeout (5 min) |
| `AGENT_BROWSER_BRIDGE_COMMAND_TIMEOUT_MS` | `30000` | Per-command timeout |

---

## Security

- The daemon binds exclusively to `127.0.0.1` — no network exposure.
- No authentication mechanism is provided — the security model relies on localhost isolation. Do not expose the daemon port to a network interface.
- The extension requires Chrome's `debugger` permission, which enables reading all page content. Only install trusted extensions locally.
- Automation runs in a separate incognito window by default, isolating your normal browsing session, cookies, and tabs.

---

## Development

```bash
# Build the extension
cd extension && npm install && npm run build

# Run daemon in foreground
tt-bridge serve

# Package extension zip
cd extension && npm run build && npm run package:zip
```

---

## Acknowledgements

Architecture inspired by [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser).

---

<!-- BEGIN AGENT INSTRUCTIONS -->
## If you are an AI agent

> This section is intended for AI agents (Claude Code, Cursor, Copilot, etc.) that need to programmatically install and use TT Bridge. Human readers can ignore it.

### What this tool gives you

TT Bridge provides a CLI for controlling a real Chrome browser from the terminal. You can navigate, execute JavaScript, click elements, screenshot pages, read cookies, and manage tabs. Browser state (logins, sessions, localStorage) persists across commands within a workspace.

### Prerequisites check

Verify the following are in place before using the CLI:

```bash
# 1. Node.js >= 18
node --version

# 2. CLI installed
which tt-bridge || npm install -g tt-bridge

# 3. Daemon running and extension connected
tt-bridge status
```

If `tt-bridge status` reports `"extensionConnected": false`, tell the human:
- Open `chrome://extensions/`
- Locate **TT Bridge** and verify the toggle shows "Serving"
- If not, click the extension icon and press **Start Serving**
- Verify **Allow in Incognito** is enabled in the extension details

### Installation (when nothing is installed yet)

```bash
# Install CLI globally
npm install -g tt-bridge

# Clone to get the extension
git clone https://github.com/mymark21/tt-bridge /tmp/tt-bridge-install

# Then tell the human:
# 1. Open chrome://extensions/
# 2. Enable Developer Mode (top-right toggle)
# 3. Click "Load unpacked"
# 4. Select /tmp/tt-bridge-install/extension/
# 5. Open extension details → enable "Allow in Incognito"
```

### Core usage pattern

```bash
# Navigate (creates an incognito automation window if none exists)
tt-bridge open "https://example.com" --workspace mytask

# Read page state
tt-bridge eval "document.title" --workspace mytask
tt-bridge eval "JSON.stringify({url: location.href, text: document.body.innerText.slice(0, 2000)})" --workspace mytask

# Interact
tt-bridge click "button.submit" --workspace mytask
tt-bridge eval "document.querySelector('#search').value = 'hello'" --workspace mytask

# Visual inspection
tt-bridge screenshot --workspace mytask --full-page
# Or save to file:
tt-bridge screenshot /tmp/page.png --workspace mytask --full-page

# Read cookies
tt-bridge eval "document.cookie" --workspace mytask

# Tab management
tt-bridge tab list --workspace mytask --json
tt-bridge tab new "https://other.example" --workspace mytask
tt-bridge tab select 0 --workspace mytask

# Teardown
tt-bridge close-window --workspace mytask
```

### Best practices for agent use

1. **Always pass `--json`** when you need structured output you can parse
2. **Use `--workspace` to isolate tasks** — each workspace gets its own incognito window, so parallel sessions don't interfere
3. **Prefer `eval` over `click`** when you need a return value — `eval` returns data, `click` is fire-and-forget
4. **Use `--full-page` for screenshots** to capture content below the fold
5. **`open` waits for page load** — up to a 15-second timeout. Check the response for `timedOut`
6. **Check `tt-bridge status`** before starting a long task to confirm the daemon and extension are connected
7. **The automation window is incognito** — cookies and localStorage are fresh per workspace. If you need the human's logged-in state, use `--human` (targets their active tab) or manually log in within the automation window
8. **Screenshots return base64 to stdout** when no file path is given. Pipe to `base64 -d > file.png` to decode, or pass a path directly

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Daemon is not running` | Idle timeout killed it | Run any command — daemon auto-starts |
| `Extension not connected` | Extension not serving | Tell human: click extension icon → Start Serving |
| `Tab no longer exists` | Automation window was closed | Re-run the command; a new window is created automatically |
| `Another debugger is already attached` | Another extension is using CDP | Tell human to disable conflicting debugging extensions |
| `Allow in Incognito` error | Extension permission missing | Tell human: `chrome://extensions/` → TT Bridge details → enable |

### When to use --human

The `--human` flag targets the human's currently active browser tab instead of the automation window:

```bash
tt-bridge eval "document.title" --human
tt-bridge screenshot --human > /tmp/what-human-sees.png
```

Use `--human` when:
- The human is logged into a site and you need their existing session
- The human wants you to interact with the page they are looking at
- You need cookies or localStorage from the human's normal browser profile

Be careful with `--human` — you are targeting the human's real browsing session. Do not navigate away from a page they are actively using.
<!-- END AGENT INSTRUCTIONS -->
