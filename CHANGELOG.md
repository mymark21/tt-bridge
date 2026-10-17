# Changelog

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
