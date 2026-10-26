# Bodhi delivery contract

Use one owner, Issue, branch and isolated worktree per acceptance slice. Preserve
other workers' checkouts, outputs and original failure evidence. Feature and
integration PRs target `dev`; `main` records stable source and published versions.
Follow [releasing.md](docs/releasing.md) for current commands and activation state.
The common phase contract is
[delivery-flow/v1](https://github.com/bigduu/Zenith/blob/main/docs/delivery-workflow.md).

## Phase ownership

- Feature branches own implementation, bug fixes, Unit tests and E2E. Pass the
  current-head checks and review before merging into `dev`. Native tests compile
  once in Cargo's debug/test profile and exercise the resulting assembly; do not
  build versioned installers in feature CI.
- `dev` is the long-lived integration branch. A release owner records its exact
  accepted cut and freezes `release/<40-character-cut-SHA>` at that commit.
- The target release phase only stamps the chosen version, builds/packages each
  supported target once, verifies the resulting artifacts and publishes them.
  It does not rerun Unit/E2E or collect a repair batch. A defect returns to a
  feature branch, passes Unit/E2E into `dev`, and gets a new recorded cut.
- `main` keeps the stable source and version record. Its push/promotion events
  perform no product build or test. A release dispatch may use trusted controls
  from main while building only its selected frozen release source; this is the
  sole release phase, not another main build.
  The version record is the immutable tag, Release assets/manifest/provenance
  and promotion PR/merge references. Never mutate a frozen release head or add
  a post-build JSON source commit to create that record.

The feature workflow implements the first phase. The current `release.yml` and
`recover-release.yml` still use their historical source/controller contract and
native gates. Preserve those gates until the dependent feature-evidence and
trusted-main-controller changes are reviewed and activated. Do not claim this
feature CI change completes the release cutover or bypass existing gates.

The staged `scripts/release-source.cjs` helper (#121 under tracker #119) validates frozen-dev source and
controller identity without publishing. It is not connected to `release.yml`.
Target output retention, publication schema v2, main promotion and bootstrap
remain dependent work (#122 and guarded activation). An unconfirmed PR merge, including the observed #118
metadata inconsistency, is a hard admission failure even when Git trees match.

## Inputs and evidence

- Consume the exact published Bamboo and Lotus identities in
  `scripts/bamboo-sidecar-lock.json` and `scripts/frontend-package-lock.json`.
  Download and verify their bytes; never rebuild them as an automatic fallback.
- Use `BAMBOO_SIDECAR_SOURCE=release` and `LOTUS_SOURCE=package` in CI and
  publication. Explicit local source builds remain development commands.
- Keep source manifest versions at `0.0.0`. Stamp the explicit Bodhi version in
  disposable release checkouts only. Distinguish workflow controller, tested
  merge, frozen source and final main merge identities in every receipt.
- Preserve original run/attempt, artifact IDs and hashes. Publication recovery
  reuses the original successful native assets; it does not rebuild them.
- Keep `Unit Tests` and `E2E Tests` as real aggregates. Failed, cancelled, skipped
  or missing selected jobs must not become a successful admission result.

## Validation and review

Run `npm run test:build` and the affected native Unit/E2E commands from
[releasing.md](docs/releasing.md#feature-unit-and-e2e). Run `actionlint` when
changing workflows. Record exact source, commands, results and unrun native
platforms in the PR. Debug assembly checks are not a claim that a signed
installer, complete desktop GUI E2E or production release was accepted.

Use Conventional Commits, current-head/base review and actual required checks.
Recheck remote head/base and mergeability immediately before guarded merge.
Never force-push, override protection, dispatch a production release or modify
published tags/assets merely to obtain a green result.
