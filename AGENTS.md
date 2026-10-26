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

The feature workflow implements the first phase. The prepared schema-v2
`release.yml` connects frozen-dev admission (#121) to original-output retention
and publication (#122). It requires the real trusted `main` controller `C`, an
explicit separate product checkout `S`, a confirmed protected-dev PR receipt and
its exact successful feature run. Never relabel GitHub's SHA/ref variables.
This branch does not activate trusted-main bootstrap, required checks or main
promotion. An unconfirmed merge, including the observed #118 metadata
inconsistency, fails admission even when Git trees match.

New releases use v2 only. Preserve `scripts/release-finalizer.cjs` byte-for-byte
and its frozen v1 workflow fixtures; `recover-release.yml` selects v1 explicitly
for historical runs, including the active #116 train. Do not reinterpret v1
runtime gates or original artifact identities as v2 receipts.

GitHub may copy a successful job into a later attempt without executing it
again. Preserve its original physical job/attempt and logs, and record the latest
logical result separately. Only identical complete job/step execution times can
establish that reuse; a later failure or ambiguous attempt still blocks admission.

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
- Reserve the final version in the existing GitHub draft and version concurrency
  domain before building. The Tauri hook alone stages upstream artifacts. Each
  supported target builds once, passes static version/architecture/resource and
  existing signing checks, and retains its installer bytes plus job/attempt
  receipt before finalization. Include RPM alongside AppImage/deb.
- A rerun restores successful targets by immutable artifact ID and SHA-256;
  earlier successful siblings keep their original attempts. A recorded
  successful Build with missing/expired output is a hard stop, never permission
  to rebuild it. Classify an unsuccessful build before retrying: source defects
  require feature/dev acceptance and a new cut; an infrastructure retry keeps
  the same source/version. Finalization/recovery execute no product commands.
  An active current selector may revalidate originals after a selector-only API
  failure whose Build/capture/retention steps never ran. Finalization still
  requires the latest logical job to succeed; real Build failures remain fatal.
- Native builders have read permissions only; publisher credentials belong to
  version reservation and finalization/recovery. Preserve original release and
  asset IDs after partial uploads or lost responses. Never delete/overwrite
  conflicting assets to make a rerun pass. Cache contents are not release proof.
- Immediately before publication, recheck the frozen ref/tree, dev protection
  and normal dev ancestry from the original admission. Refuse unknown API state
  or a rewrite; preserve the original manifest and admission identities.
- Controller static checks read the frozen source's browser lock as Git data,
  passing it explicitly to the existing verifiers. Never load source scripts or
  mutate the controller's default lock to validate another product source.
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
