# Harden the local bridge: auth, anti-CSRF/rebinding, session scoping, tests

## Why

The daemon exposes an **unauthenticated** HTTP endpoint on `127.0.0.1` whose
`/command` route runs arbitrary JS (`chrome.debugger` → `Runtime.evaluate`) and
reads cookies in the user's **real logged-in tabs**. While serving is on, that
endpoint is reachable by (a) any local process on the machine and (b) any web
page the user visits (cross-origin "simple request" CSRF — the body is parsed
regardless of `Content-Type` and no `Origin`/`Host` is checked). No data leaves
the machine today, but the missing local authorization + CSRF/rebinding defenses
are a real cross-boundary escalation. This PR closes those gaps and adds the
scoping, robustness fixes, tests, and docs to keep them closed.

Full findings came from an independent multi-agent security audit; the change set
maps to a prioritized plan in [`IMPROVEMENT_PLAN.md`](IMPROVEMENT_PLAN.md).

## What changed

### P0 — access control
- **Bearer-token auth** on `/command` and `/shutdown`. The daemon mints a 256-bit
  token at startup, stores it `~/.config/tt-bridge/token` (`0600`); the CLI reads
  the same file. Timing-safe compare. `daemon.mjs`, `cli.mjs`.
- **Anti-CSRF + anti-DNS-rebinding**: every HTTP request must carry a loopback
  `Host`; any request with a non-`chrome-extension://` `Origin` is rejected (403).
  `daemon.mjs` (server handler).

### P1
- WS `/ext` now **rejects an empty/foreign Origin** (was: absent Origin passed),
  so a non-browser local client can't impersonate the extension. `daemon.mjs`.
- `cookies` action **requires a domain/url filter** and **never returns httpOnly
  values**. `background.js`.
- **`stopServing` detaches every debugger** (was: banner + CDP lingered). `background.js`.
- Superseded extension socket **rejects in-flight requests** instead of hanging 30s. `daemon.mjs`.
- **Session-scoped serving**: auto-expires after 30 min; the popup shows a live
  countdown and an **audit log** of executed commands. `background.js`, `popup.html`, `popup-*.js`.

### P2
- Request-body cap (413) + in-flight/waiter caps (429). `daemon.mjs`.
- `file://` / `view-source:` / `devtools://` are **non-debuggable** (blocks local-file
  read via injected JS). `background.js` (both `isDebuggableUrl` copies).
- **Port-fallback bug fixed**: the persistent `error` handler `process.exit(1)`
  fired before the fallback loop could advance — the daemon crashed instead of
  trying the next port. Now attached only after a successful listen. `daemon.mjs`.
- `navigate` timer-leak + bogus "timed out" warning fixed. `background.js`.
- Command **schema validation** + **error-code taxonomy**
  (`UNAUTHORIZED`/`FORBIDDEN`/`RATE_LIMITED`/`PAYLOAD_TOO_LARGE`/`EXT_NOT_CONNECTED`/`TIMEOUT`/`BAD_REQUEST`).
- Console→daemon log forwarding **off by default** (was leaking visited URLs). `background.js`.
- Pinned `ws` to an exact version; added `THREAT_MODEL.md`, `SECURITY.md`, a proposed
  MIT license, tests, CI, and a reproducible zip build script.

## Tests

`node --test test/*.test.mjs` — 20 tests, all green:
- **daemon HTTP contract**: no-token→401, wrong-token→401, valid→routed, forged
  Host→403, web Origin→403, chrome-extension Origin→allowed, oversized→413,
  `/shutdown` unauth→401, authed shutdown stops the daemon.
- **extension logic** (real bundle loaded via `node:vm` + a `chrome` mock):
  `validateCommand`, `isDebuggableUrl` file:// blocking, `handleCookies` httpOnly
  redaction + wildcard refusal, `auditFromCommand`.

CI (`.github/workflows/ci.yml`) runs syntax check + tests + a reproducible rebuild.

## Compatibility / review notes
- The CLI is updated in lockstep, so the token is transparent to normal use.
- The extension only ever *reads* `/status` and dials the WS — it needs no token,
  so auth on `/command` doesn't affect it.
- Behavior-preserving for the happy path; the only user-visible additions are the
  popup countdown + audit list and the 30-min auto-stop.
- The extension changes edit the built `dist/background.js` (this repo ships no TS
  source); a source-first follow-up is noted in the plan.

See `changes.diff` for the full unified diff against the current release.
