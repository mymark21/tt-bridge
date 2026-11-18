# Security Policy

## Supported versions

Only the latest release of the public `v1.4.x` line receives security fixes.

| Version | Supported |
| --- | --- |
| `1.4.x` (latest patch, currently `1.4.5`) | Yes |
| Earlier `1.0.x` releases | No, upgrade to the latest release |
| Private development builds | No public support |

There is no long-term support branch. If you are on an older release, upgrade to the latest `v1.4.x` release zip before reporting an issue.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security problem.**

Use GitHub private vulnerability reporting:

<https://github.com/mymark21/tt-bridge/security/advisories/new>

This creates a private advisory visible only to you and the maintainers. If the form is unavailable, contact the maintainer through the repository owner profile and ask for a private channel; do not include exploit details in that first message.

Please include:

- Affected TT Bridge version (extension and CLI) and how it was installed.
- Operating system and Chrome version.
- A description of the impact and the conditions required to trigger it.
- Reproduction steps or a minimal proof of concept.
- Any suggested fix, if you have one.

## What to expect

- We aim to acknowledge a report within three business days.
- We aim to complete an initial assessment within seven business days.
- We will keep you informed of progress and may ask for clarification or a retest.
- Please keep the report private until a fix is released and the advisory is published.
- We will credit reporters in the advisory unless you ask to remain anonymous.

Fixes are shipped in a `v1.4.x` patch release with rebuilt release zips. Accepted public fixes are forward-ported to the private development tree; the public advisory will not expose private code or history.

## Scope

In scope:

- The Chrome extension: permission handling, message validation, origin checks, and use of `chrome.debugger`.
- The local daemon and CLI: the loopback HTTP/WebSocket surface, command handling, token handling, and file handling.
- Release artifacts: unexpected files, build output that does not match the source, or a compromised release.
- Installation and setup instructions that could lead users to run unsafe commands.

Typically out of scope:

- An attacker who already runs code as your user or has administrative access to the machine.
- Vulnerabilities in Chrome, Node.js, or other upstream dependencies without a TT Bridge-specific impact.
- Reports that require disabling a security control or using an unsupported, modified build.
- Social engineering and physical access.

## Design notes

The daemon binds to `127.0.0.1` only. Every route except discovery (`/ping`,
`/status`) requires a per-user bearer token stored in
`~/.config/tt-bridge/token` (mode `0600`): that covers `/command`, `/shutdown`,
`/window`, `/instance`, `/reload`, `/windows`, and `/profiles`. The CLI reads the
same file and never sends the token to `/status` or port-discovery probes.

Requests must carry a loopback `Host` header (`127.0.0.1:<port>`,
`localhost:<port>`, or `[::1]:<port>`), and browser `Origin` headers are
rejected; together they raise the bar against DNS rebinding and CSRF from web
pages. HTTP bodies are capped (5 MiB default) and JSON bodies must be objects.
In-flight commands are capped at 256. The WebSocket accepts only
`chrome-extension://` origins, applies a 100 MiB frame cap, and requires the
same loopback `Host`. The public `/status` discovery payload masks the profile
email, gaia id, and display name; it never returns the raw extension `hello`
descriptor. Log lines forwarded by the extension are scrubbed of bearer
credentials, cookie/token assignments, and URL query values before they reach
the daemon log, and the daemon log file is created `0600`. The local experience
trace stores only redacted `eval` snippets and strips URL query values.

Debugging and navigation are restricted to ordinary web pages:
`chrome://`, `chrome-extension://`, `file://`, `view-source:`, and `devtools://`
targets are refused, and `navigate` accepts only `http(s)` URLs or
`about:blank`. Stopping serving detaches every debugger so the "being debugged"
banner and CDP sessions do not linger.

### Persistent serving

Starting with the `v1.4.x` line, serving is intentionally persistent: the
30-minute session expiry introduced in `v1.0.5`/`v1.0.6` is not used. Serving
continues until the user presses **暂停**, closes Chrome, or stops the daemon.
This matches the product's "connect once, then just hand over the takeover
command" workflow. On a shared or unlocked machine, pause serving or close the
browser when you walk away.

### Remaining limitations

The extension WebSocket (`/ext`) is not mutually authenticated. Origin checks
and the loopback binding raise the bar, but a local process that can bind the
daemon port can still impersonate the daemon to the extension, and a local
client that can forge the origin header can connect to `/ext`. Do not expose the
daemon port to a network, tunnel it, or run it on a shared host. Reports that
demonstrate a bypass of the loopback binding, cross-origin access from a web
page, or token leakage are in scope.

### Site experience scripts

The optional experience library stores per-site notes and scripts under
`~/.agents/skills/tt-bridge/experience` (override with
`TT_BRIDGE_EXPERIENCE_DIR`). `tt-bridge experience run <id>` executes that
entry's local `script.py` with the privileges of the current user. Only run
entries you wrote or reviewed; treat the experience directory like any other
local code you trust. The library never stores cookies, tokens, page data, or
screenshots by design, but review entries before sharing or importing them.
