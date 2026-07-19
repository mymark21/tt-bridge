# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for
an unfixed vulnerability.

- Preferred: GitHub → *Security* → *Report a vulnerability* (private advisory).
- Or contact the maintainer directly (see the repository profile).

Please include: affected version/commit, a description, and a proof-of-concept
if you have one. Expect an initial acknowledgement within a few days.

## Scope

In scope: the daemon (`bin/daemon.mjs`), the CLI (`bin/cli.mjs`), and the
extension service worker (`dist/background.js`). See [THREAT_MODEL.md](THREAT_MODEL.md)
for boundaries and residual risks.

Out of scope: attacks that require code already running with the user's
filesystem rights (they can read the `0600` token), and exposing the daemon on a
non-loopback interface via `AGENT_BROWSER_BRIDGE_HOST` (unsupported configuration).

## Hardening baseline (this build)

- Bearer-token auth on the daemon's mutating endpoints (`/command`, `/shutdown`).
- Host + Origin checks (anti CSRF / DNS-rebinding) on every HTTP request.
- WS `/ext` requires a `chrome-extension://` origin.
- `file://` / `view-source:` / `devtools://` are non-debuggable.
- `cookies` requires a filter and never returns httpOnly values.
- Session auto-expiry (default 30 min) + in-popup audit log.

## Supply-chain integrity

Release archives ship with `SHA256SUMS.txt`. Verify before installing:

```
shasum -a 256 -c SHA256SUMS.txt
```

The extension is distributed unpacked; re-verify the source and checksums on every update.
