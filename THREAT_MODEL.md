# TT Bridge — Threat Model

TT Bridge lets a local AI agent drive Chrome through a local daemon and a browser
extension. Its power (arbitrary JS + cookies + screenshots in your **real, logged-in**
tabs) is also its risk surface. This document states what is trusted, what is defended,
and what remains the operator's responsibility.

## Components & trust boundaries

```
 CLI / agent  --HTTP(127.0.0.1:19826-35)-->  daemon  --WS(/ext)-->  extension  --CDP-->  Chrome tabs
   (holds token)         [B1]                          [B2]                    [B3]
```

- **B1 — HTTP loopback (CLI ↔ daemon).** Anyone who can open a socket to the loopback
  port. On a single-user desktop that is "any process running as you".
- **B2 — WebSocket (daemon ↔ extension).** The extension dials out to the daemon.
- **B3 — CDP (extension ↔ tab).** `chrome.debugger` → `Runtime.evaluate`, `chrome.cookies`,
  `Page.captureScreenshot`. This is full control of the page and its session.

## Assets
- The user's **authenticated web sessions** (mail, bank, SaaS, work SSO) via the human workspace.
- **httpOnly session cookies**.
- **Local files** (reachable if a tab can be pointed at `file://`).
- The user's **attention/consent** (they must know when the browser is being driven).

## Actors
- **Co-resident local process** — malware, a rogue `npm postinstall`, another app running as the user.
- **Malicious web page** — any site the user visits while serving is on (CSRF / DNS-rebinding against the loopback daemon).
- **Supply-chain attacker** — tampered download, or a future malicious extension update.
- Out of scope: a remote network attacker (daemon binds `127.0.0.1` only) and an attacker who already has root / can read the user's `0600` files.

## Defenses implemented in this hardened build
| Boundary | Attack | Defense |
|---|---|---|
| B1 | Any local process issues commands | **Bearer token** minted at daemon start, stored `~/.config/tt-bridge/token` (0600); required on `/command` + `/shutdown` (timing-safe compare). |
| B1 | Web-page CSRF (simple POST) | Reject any request carrying a non-`chrome-extension://` **Origin** (403). |
| B1 | DNS-rebinding | Reject any request whose **Host** ≠ our loopback authority (403). |
| B1 | Memory/handle DoS | Request-body cap (413), in-flight + waiter caps (429). |
| B2 | Non-browser client impersonates the extension | WS upgrade requires a `chrome-extension://` Origin (empty Origin rejected). |
| B3 | Local-file read via `file://` | `isDebuggableUrl` denylists `file://`, `view-source:`, `devtools://`. |
| B3 | httpOnly cookie theft | `cookies` requires a domain/url filter and never returns httpOnly values. |
| B3 | Silent/opaque control | Chrome's debugger banner (always on) **plus** a session countdown, auto-expiry, and an in-popup audit log of executed commands. |

## Residual risks (operator's responsibility)
1. **Any local code running as you can still read the token file** and drive the browser while serving is on. The token defends against *unprivileged* peers, not against code with your filesystem rights.
2. **The extension is loaded unpacked** — no Web Store review, and whoever ships updates can change its behavior. Verify the source and the release checksums (`SHA256SUMS.txt`) on every update.
3. **Human workspace = your real session.** Run against a dedicated Chrome profile that is *not* logged into sensitive accounts; keep serving off when not actively in use (a 30-min auto-expiry backstops this).
4. **`AGENT_BROWSER_BRIDGE_HOST=0.0.0.0`** would expose this to the LAN. Don't set it.

## Reporting
See [SECURITY.md](SECURITY.md).
