# Security Policy

## Supported versions

Only the latest release of the public `v1.0.x` line receives security fixes.

| Version | Supported |
| --- | --- |
| `1.0.x` (latest patch, currently `1.0.4`) | Yes |
| Earlier `1.0.x` releases | No, upgrade to the latest patch |
| Private development builds | No public support |

There is no long-term support branch. If you are on an older release, upgrade to the latest `v1.0.x` release zip before reporting an issue.

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

Fixes are shipped in a `v1.0.x` patch release with rebuilt release zips. Accepted public fixes are forward-ported to the private development tree; the public advisory will not expose private code or history.

## Scope

In scope:

- The Chrome extension: permission handling, message validation, origin checks, and use of `chrome.debugger`.
- The local daemon and CLI: the loopback HTTP/WebSocket surface, command handling, and file handling.
- Release artifacts: unexpected files, build output that does not match the source, or a compromised release.
- Installation and setup instructions that could lead users to run unsafe commands.

Typically out of scope:

- An attacker who already runs code as your user or has administrative access to the machine.
- Vulnerabilities in Chrome, Node.js, or other upstream dependencies without a TT Bridge-specific impact.
- Reports that require disabling a security control or using an unsupported, modified build.
- Social engineering and physical access.

## Design notes

The daemon binds to `127.0.0.1` only and intentionally has no user authentication: any local process running as your user can talk to it. Do not expose the daemon port to a network, tunnel it, or run it on a shared host. Reports that demonstrate a bypass of the loopback binding, or cross-origin access from a web page, are in scope and appreciated.
