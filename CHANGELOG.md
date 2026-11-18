# Changelog

## v1.4.5 — first public 1.4.x release (free core + security forward-port)

The public line advances from `v1.0.6` to the `v1.4.x` development line. This is
a curated import of the free core, not a dump of the private tree: cloud sync,
team sharing, verified site packs, relay/remote control, audit/SSO/RBAC,
orchestration, record/replay, and premium site packs remain private.

### Features

- extension: redesigned popup. After the one-time **允许 AI 控制**, the primary
  action becomes **复制连接指令**: the user copies a takeover command
  (`instance use` / `window use` / `tab pin`) and hands it to the AI instead of
  toggling the extension for every task. **暂停** temporarily stops serving.
- extension: new **等待服务** state for the "daemon is not running" case. Instead
  of a disabled "正在接通…" dead end, the popup explains that the local service
  is not started and offers **复制启动指令**, a prompt the user pastes into their
  AI so the agent can run `tt-bridge daemon start`. Copying also resets the
  reconnect backoff, and the popup switches to connected automatically once the
  service is up. The secondary action stays **暂停**, so the human can stop the
  retry loop at any time.
- extension: green shield marks the tab currently taken over; the AI activity
  glow shows when and where the agent is working.
- extension/daemon: multi-instance routing, `instance use`, `window use`,
  window/profile awareness, hot reload, `tab pin` and tombstone-based
  anti-drift protection.
- extension: TypeScript/Vite source restored; `chrome-extension/src/` is now the
  source of truth and `dist/` is build output.
- CLI/daemon: native keyboard input (`focus` / `type` / `key`), viewport
  emulation (`emulate`, `screenshot --device/--viewport`), cookie masking,
  `tab new --mute`, minimized-window screenshot guard, and the local site
  experience library (`experience show/run/begin/end`).
- packaging: `chrome-extension/tools/package-release.mjs` gains `--out-dir` and
  now includes `bin/targets.mjs` (the previous CLI zip omitted it and crashed
  with `ERR_MODULE_NOT_FOUND`).

### Security (forward-ported from v1.0.5/v1.0.6)

- daemon: bearer-token authentication on every non-discovery route
  (`/command`, `/shutdown`, `/window`, `/instance`, `/reload`, `/windows`,
  `/profiles`), loopback `Host` validation, browser `Origin` rejection, HTTP
  body cap, in-flight cap, WebSocket payload cap, and `chrome-extension://`
  origin requirement. The CLI sends the token only to authenticated routes.
- extension: debugging/attach refuses `chrome://`, `chrome-extension://`,
  `file://`, `view-source:`, and `devtools://`; `navigate` accepts only
  `http(s)` and `about:blank`; stopping serving detaches all debuggers.
- daemon: the public `/status` discovery payload now masks profile email and
  gaia id instead of returning the raw extension `hello`.
- daemon: updated the bundled `ws` dependency to `8.23.0`, clearing the
  uninitialized-memory and fragmentation-DoS advisories affecting `<=8.20.1`.
- daemon: non-object JSON bodies return `400`, oversized bodies `413`.

### Notes

- Serving is intentionally persistent in the `1.4.x` line; the 30-minute
  session expiry from `v1.0.5`/`v1.0.6` is not reintroduced. See `SECURITY.md`.
- Release artifacts are no longer committed. The repository carries source only;
  `.github/workflows/release.yml` rebuilds `tt-bridge-extension.zip`,
  `tt-bridge-cli.zip`, and `SHA256SUMS.txt` on a `v*` tag and attaches them to
  the GitHub Release. `scripts/build-release.sh` writes the same files to
  `build/` for local verification.
- docs: the README is now a project-style homepage with a language switch and an
  English edition in `README.en.md`; the full agent installation prompt is
  preserved in a collapsed section at the end.
- Older `v1.0.x` releases remain available under their tags but are no longer
  supported.

## v1.0.6 — stability patch

- daemon: reject non-object JSON bodies with `400 BAD_REQUEST` instead of
  crashing on `null`/arrays (pre-existing v1.0.4 bug).
- daemon: restore the 24-hour idle timeout so a 30-minute serving session is
  not cut off by the previous 5-minute idle shutdown.
- daemon: create the auth token with `O_EXCL` and re-read on `EEXIST`, avoiding
  concurrent-start token mismatches.
- source: aligned with the shipped v1.0.5/v1.0.6 artifacts; `scripts/build-release.sh`
  packages the same trees.
- Known limitations remain: extension WebSocket is not mutually authenticated;
  daemon discovery can be spoofed by a local service; session expiry is
  periodic, not per command.

## v1.0.5 — security maintenance

Artifact-based security release built from v1.0.4, incorporating the reviewed
hardening from PR #1 by @noique.

### Security

- daemon: Bearer-token authentication for `/command` and `/shutdown`; `/status`
  and `/ping` remain public.
- daemon: loopback Host validation and browser-Origin rejection (CSRF /
  DNS-rebinding hardening).
- daemon: HTTP body size cap and in-flight command cap.
- daemon: separate WebSocket payload cap (100 MiB default) so full-page
  screenshots are not truncated by the HTTP body limit.
- extension: block `file://`, `view-source:`, and `devtools://` debug/attach targets (navigation validation is being hardened).
- extension: detach all debuggers on `stopServing`.
- extension: 30-minute serving session expiry now applies to profiles upgraded
  from older builds.

### Fixes

- daemon: port-fallback error-handler ordering (no crash when the first port is
  busy).
- cli: never send the auth token to `/status` or port-discovery probes.
- daemon: superseded extension sockets reject in-flight work instead of hanging.

### Notes

- v1.0.4 assets remain frozen under tag `v1.0.4`.
- v1.0.5 is built from the v1.0.4 binaries plus reviewed patches; see
  `SOURCE_PROVENANCE.md`. The first fully source-built release will be v1.0.6.
- Known limitations: the extension WebSocket is not yet mutually authenticated;
  daemon discovery can be spoofed by a local service; session expiry is enforced
  periodically rather than per command. These are targeted for the next patch.
- Thanks to @noique for the security analysis and patch set.
