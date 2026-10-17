# Porting and version policy

TT Bridge is developed in two trees:

| Tree | Location | Purpose |
| --- | --- | --- |
| Public | this repository, branch `main` | Stable, community-supported `v1.0.x` source and releases |
| Dev | private repository | Active development, newest features and experience |

The public tree is not a mirror of the dev tree. It is a curated stable line that must keep working for existing users. Do not assume that a version number in one tree implies the same feature set in the other.

## Version mapping

- Public releases are tagged `v1.0.x`. `v1.0.4` is the current stable source release.
- Dev versions move independently (currently in the `1.4.x` range) and include features that are not part of the public line, including typing and later work.
- The dev commit or tag a public release was promoted from is recorded in that release's notes. A public tag without such a note should be treated as having no direct dev equivalent.
- Version numbers in `chrome-extension/manifest.json`, `chrome-extension/package.json`, and `daemon/package.json` must match within a public release.
- The public line stays on `v1.0.x` for fixes. Starting a new minor line requires an explicit maintainer decision and a separate promotion review.

## Dev to public: curated promotions only

Never merge the private repository's history into this repository.

To publish dev work:

1. Select the specific changes intended for the stable line. Exclude private-only features, internal notes, credentials, and anything not ready for public support.
2. Export those changes as a clean tree or a small, self-contained commit series. Public history must not contain private commits, author identities that should stay private, or internal references.
3. Open a pull request titled `release: promote <summary> from dev <ref>` and describe what is included and deliberately excluded.
4. Verify that the public tree builds from a clean clone with `./scripts/build-release.sh`, that no private feature is reachable from the CLI or extension, and that tests cover the promoted behavior.
5. After review and green CI, merge as a normal public commit (squash is preferred). Tag `v1.0.x`, rebuild the zips, and attach them to the release.

Each promotion is a snapshot, not a sync. Do not add the private repository as a push remote, and do not push public branches from the private working tree.

## Public to dev: forward-port every accepted fix

Every fix accepted in this repository must be forward-ported to the private dev tree, especially security fixes. Public and dev code will diverge; the fix still needs to exist in both.

- The maintainer applies or cherry-picks the public change onto the dev trunk, adapting it to the dev architecture as needed.
- Regression tests from the public pull request must be ported with the fix.
- Security fixes are forward-ported before or together with the next dev release; they are never left to a later cleanup.
- If a public fix cannot be applied to dev because the code no longer exists, record that decision in the dev change and close the porting item instead of leaving it silently open.

Contributors do not need access to the dev tree. Opening a public pull request is enough; the maintainer owns the forward port.

## Labels

Maintainers use these labels to track the process:

| Label | Meaning |
| --- | --- |
| `bug` | Confirmed defect in the public line |
| `enhancement` | In-scope improvement for the public line |
| `needs-forward-port` | Accepted public fix that must be ported to dev |
| `forward-ported` | Fix has landed in dev |
| `release` | Release or promotion work |

Security reports are handled through private advisories, not public labels. Never put vulnerability details in an issue, pull request, or label.

## Do not

- Merge dev history into public or public history into dev.
- Push directly to `main` or rewrite published history.
- Add private-only features to this repository.
- Hand-edit the release zips; always rebuild with `scripts/build-release.sh`.
- Change the protocol or CLI surface in a patch release.
