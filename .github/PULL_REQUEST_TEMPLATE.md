## Summary

<!-- What changes, and why? Keep it focused on the stable v1.0.x line. -->

## Related issue

<!-- Fixes #... / Refs #... -->

## Testing

<!-- List the commands you ran and the result. For browser behavior, include manual steps and evidence. -->

```text
cd chrome-extension
npm run typecheck
npm test
npm run build
```

- [ ] `./scripts/build-release.sh` passes (or explain below why it was not run)
- [ ] Manual Chrome steps are included and were run against a disposable profile

## Checklist

- [ ] This targets `main` and stays within the public `v1.0.x` scope.
- [ ] No private/development-only features are included.
- [ ] Source changes include tests for the changed behavior.
- [ ] No generated artifacts are hand-edited (`dist/`, `releases/`, `tt-bridge-*.zip`, `node_modules/`).
- [ ] No secrets, cookies, tokens, or real browser profile data are included.
- [ ] This is not a security report; vulnerabilities go through [SECURITY.md](../SECURITY.md).
- [ ] I understand accepted fixes may be forward-ported to the private dev tree.

## Notes for reviewers

<!-- Compatibility concerns, follow-ups, or anything intentionally left out. -->
