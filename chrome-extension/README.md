# TT Bridge — Chrome extension

Chrome-side half of tt-bridge: it holds the browser permission via
`chrome.debugger` and dials the local daemon on `127.0.0.1:19826`. All agent
commands arrive over that socket; this package ships no CLI of its own — the
CLI lives in `../daemon`.

## Layout

- `src/` — TypeScript sources (`background.ts` service worker, CDP plumbing,
  popup, daemon discovery, window state)
- `dist/` — build output produced by `npm run build` (ignored by git)
- `icons/` — extension icons referenced by `manifest.json`
- `reload.html` / `reload.js` — bootstrap page that lets an older installed
  build reload itself from disk (`tt-bridge reload`)
- `tools/` — release packaging (`package-release.mjs` builds `dist/` and writes
  both published zips, to the repo root by default or to `--out-dir <dir>`; it
  also verifies archive contents and version consistency)

## Build

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Load in Chrome

`manifest.json` lives at the package root and points at `dist/background.js`,
so **load the extension root, not `dist/`**.

- Open `chrome://extensions/`
- Enable Developer Mode
- `Load unpacked` → select this `chrome-extension/` directory
- Details → enable `Allow in Incognito` (automation windows are incognito)
- Click the toolbar icon → **允许 AI 控制** (first run only)

Once connected, the popup's primary button becomes **复制连接指令**: the user
copies it, hands it to the AI, and the AI switches to the right instance,
window and tab. No further per-task toggling is required; **暂停** only pauses
serving temporarily.

If the daemon is not running (for example after a reboot), the popup shows
**等待服务 / 本地服务未启动** and offers **复制启动指令**. That copies a prompt for
the AI to run `tt-bridge daemon start` and verify `extensionConnected: true`;
the extension reconnects automatically once the service is up. **暂停** stops
the retry loop without uninstalling the extension.

Once served, the service worker keeps reconnecting to `127.0.0.1:19826`.

## Notes

- Chrome shows its normal debugging indicator while the bridge is attached to a
  tab. The point of the extension is to remove *repeated* takeover approvals.
- The daemon listens on loopback only.
- Idle shutdown defaults to 24h; override with
  `AGENT_BROWSER_BRIDGE_IDLE_TIMEOUT_MS`.
- Without `Allow in Incognito`, bridge commands fail fast with an actionable
  error instead of silently opening a regular window.

## Packaging

```bash
node tools/package-release.mjs   # repo-root tt-bridge-extension.zip + tt-bridge-cli.zip
node tools/package-extension.mjs # chrome-extension/releases/vX.Y.Z.zip + releases-unzip/latest-version/
```
