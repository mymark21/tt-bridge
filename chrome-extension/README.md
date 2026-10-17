# TT-brower-bridge

This package gives you a persistent browser bridge for local AI-agent workflows without repeatedly using `agent-browser --auto-connect` and manually approving Chrome takeover prompts.

Its automation target is a dedicated Chrome incognito window, not your regular browsing window.

It works by splitting the problem in two:

1. A Chrome extension holds the browser-side permission via `chrome.debugger`.
2. A local daemon accepts commands on `127.0.0.1:19826` and forwards them to the extension.

This is a bridge for local automation. It does not modify the upstream `agent-browser` binary or make the upstream CLI speak a custom daemon protocol.

## What You Get

- `manifest.json` and `dist/background.js`
- `tools/daemon.mjs` local daemon
- `tools/bridge.mjs` thin CLI client
- `releases/vX.Y.Z.zip` versioned extension package
- `releases-unzip/latest-version/` stable unpacked extension package

## One-Time Setup

1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run build
```

3. Load the extension in Chrome:

- Open `chrome://extensions/`
- Enable Developer Mode
- Click `Load unpacked`
- Select `releases-unzip/latest-version/`, or select this repo folder's `chrome-extension/` directory after building
- Open the extension details page and enable `Allow in Incognito`

Once installed, the extension service worker will keep trying to connect to the local daemon on `127.0.0.1:19826`.

## Running

The CLI auto-starts the daemon when needed:

```bash
npm run bridge -- status
npm run bridge -- open https://x.com/home --workspace twitter
npm run bridge -- eval "document.title" --workspace twitter
npm run bridge -- tab list --workspace twitter
```

You can also run the daemon explicitly:

```bash
npm run daemon
```

## CLI Examples

```bash
npm run bridge -- open https://x.com/home --workspace twitter
npm run bridge -- eval "JSON.stringify({ title: document.title, url: location.href })" --workspace twitter
npm run bridge -- screenshot output/x-home.png --workspace twitter --full-page
npm run bridge -- sessions --json
npm run bridge -- close-window --workspace twitter
```

## Notes

- The extension still uses Chrome's `debugger` permission, so Chrome may show its normal debugging indicator. The point here is to remove repeated manual takeover approval steps.
- The daemon only listens on `127.0.0.1`.
- The daemon exits after 5 minutes of inactivity by default. Override with `AGENT_BROWSER_BRIDGE_IDLE_TIMEOUT_MS`.
- The extension uses a dedicated incognito automation window so your current browsing window is not repurposed by default.
- If `Allow in Incognito` is not enabled for the extension, bridge commands fail fast with an actionable error instead of silently opening a regular window.

## Packaging

Create the zip bundle with:

```bash
npm run build
npm run package:zip
```

This produces one versioned extension zip and refreshes the latest unpacked directory:

- `releases/vX.Y.Z.zip`
  Extension archive with `manifest.json` at the zip root.
- `releases-unzip/latest-version/`
  Stable unpacked extension path for `Load unpacked`.

For Chrome local development, the reliable path is still:

1. Run `npm run package:zip`
2. Open `chrome://extensions/`
3. Enable Developer Mode
4. Click `Load unpacked`
5. Select `releases-unzip/latest-version/`
