# Publish Bodhi independently

The prepared v2 publisher is this repository's [release.yml](../.github/workflows/release.yml).
It runs a trusted `main` controller `C` against a separate disposable checkout of
an accepted, frozen dev merge `S`. Bamboo and Lotus Next remain independent
producers; Bodhi consumes their exact committed artifact locks. Zenith is not a
release prerequisite.

This branch prepares #122 under tracker #119; it does not activate the trusted
main bootstrap, protection changes or a main promotion workflow. Do not dispatch
a new production release until that separate cutover is reviewed. Existing v1
runs, including #116, keep their original workflow snapshots, source locks,
runtime gates and recovery contract. The new publisher never silently falls
back to v1 when source admission fails.

## Feature Unit and E2E

Feature and integration PRs target `dev`. The [CI workflow](../.github/workflows/ci.yml)
runs Unit and E2E there; it does not run on main pushes or build installers.
`Unit Tests` aggregates Node script tests and the three native test jobs. `E2E Tests`
aggregates those same native jobs after their actor, static frontend and browser
checks. Each native job stages the locked Bamboo/Lotus inputs once and invokes
Cargo once in its debug/test profile. No second shell build or Tauri packaging
job is required for those tests.

Run the script Unit suite locally with:

```sh
npm run test:build
actionlint .github/workflows/ci.yml
```

For native Unit/E2E, install the accepted frontend package and use the current
host's target (`aarch64-apple-darwin`, `x86_64-unknown-linux-gnu` or
`x86_64-pc-windows-msvc`). The following Bash example stages test resources and
does not create an installer:

```sh
native_target="$(rustc -vV | sed -n 's/^host: //p')"
frontend_version="$(node -p "require('./scripts/frontend-package-lock.json').packageVersion")"
npm ci --prefer-offline --no-audit
npm install --no-save --ignore-scripts --package-lock=false "@bigduu/lotus-next@$frontend_version"
export LOTUS_SOURCE=package BAMBOO_SIDECAR_SOURCE=release
export BAMBOO_SIDECAR_TARGET="$native_target" TAURI_ENV_TARGET_TRIPLE="$native_target"
export APPLE_SIGNING_IDENTITY=-
npm run build:sidecar:dev
cargo test --locked --manifest-path src-tauri/Cargo.toml --target "$native_target"
npm run verify:assembly -- "$native_target" --assembly=debug
node scripts/sidecar-bundle-smoke.cjs "$native_target" --assembly=debug
node scripts/browser-bundle-smoke.cjs "$native_target" "target/$native_target/debug/browser-runtime"
```

The debug checks require the actual sidecar, frontend and browser files copied by
that Cargo invocation. Missing or changed debug output fails; a staged input or
an old release bundle is not a fallback. These tests exercise the real actor,
HTTP/static-dir and browser chain, not the complete desktop GUI.

## Delivery policy and cutover

The shared target flow is feature Unit/E2E → accepted `dev` → frozen
`release/<cut-SHA>` → stable `main`. Fixes belong to feature branches. Release
selects an explicit version and builds/packages each final target once; it does
not rerun Unit/E2E or accumulate a repair batch. A defect requires tested dev
admission and a new cut. Main keeps stable source and the immutable version
record (tag, Release manifest/provenance and promotion references). Main
push/promotion events perform no product build/test, and there is no post-build
source-record commit. A trusted main-ref controller may execute the release
dispatch for its selected frozen source; the controller ref does not create a
second product build phase.

Feature CI is implemented. The v2 release path now connects
`scripts/release-source.cjs` to source admission and output retention. Admission
keeps trusted controller `C`, accepted dev merge `S`, PR base/head and actual
tested snapshot `M` distinct. New admission uses schema 2, kind
`bodhi-accepted-dev`. It requires a confirmed GitHub PR merge, normal merge
parents, tested/accepted tree equality, exact successful Unit/E2E jobs and
protected Dev ancestry. `verifyAcceptedDev` checks that source without a release
ref; the release wrapper `admitFeature` additionally requires `release/<S>` to
point to `S` before and after verification. The historical #118 open/merged-false
state remains a negative case; a matching Git tree does not supply a merge receipt.

Admission also requires the confirmed PR merge timestamp. All six original
physical jobs, including the Unit/E2E aggregates, must have completed at or
before that timestamp. The final PR readback must preserve it. A copied logical
success may appear later while retaining the original execution; an actual
post-merge test run cannot supply feature-before-dev evidence. The source proof
records the verified merge time without changing the context writer or schema.

The Node job and all three native jobs run the same literal, byte-pinned workflow
source step immediately after checkout, before staging or tests. It uses only
Node built-ins and Git; it never loads a candidate source module to record its
own identity. This records the actual clean merge and
its raw parents, including in a shallow checkout, without changing `GITHUB_*`.
Each original log contains one `Feature source:` line and one canonical bounded
`Feature context:` record with schema `bodhi-feature-context/v1`, repository,
run ID, physical attempt, PR, base/head, actual merge `M` and tree. Admission
requires all four records to agree with their original job/attempt and API
source evidence. The accepted `S` and tested `M` remain distinct commit identities.

GitHub can return `run.pull_requests=[]` after a real PR merge. Only the new
explicitly pinned producer's original context supplies that missing link. If an
association is present it must still match exactly; missing API fields, conflicting
or multiple contexts and unknown workflows reject admission. The old producer
`492770d810a8c51df8f63057ed95f1446426c7c6` has no original PR context and cannot
authorize a new release/bootstrap, even if its tests passed. Its historical
source-line parser remains available as data, without a fallback into the new
schema. No real v2 run or manifest existed when this evidence contract changed;
historical v1 publication/recovery and frozen workflow bytes remain unchanged.
Do not create a fake release ref to run the accepted-Dev verifier. A successful
source check alone does not authorize Main bootstrap or promotion.

`verifyPublished` in `scripts/release-finalizer-v2.cjs` is a read-only structural
manifest component for a future consumer. Its caller must authenticate the
expected controller/source/run; this export alone does not authorize main
promotion. Bootstrap, required-check activation and that promotion boundary are
separate work. Main receives stable source and references to the immutable
published record, without a new source JSON file or another build.

Successful jobs copied by GitHub into a later attempt keep their original
physical job/attempt and source logs in the proof. The latest logical job is
recorded separately and must pass; matching complete execution/step timestamps
are required before recognizing a copy. Different executions, missing times,
same-attempt ambiguity and later failures cannot be hidden as reuse.

## Prepare and dispatch after activation

Keep source manifests at `0.0.0`. Land fixes and lock updates through feature
Unit/E2E into protected dev, select the exact accepted merge, and freeze
`release/<40-character-cut-SHA>` without later repair commits. A defect found
while packaging goes back through feature/dev and gets a new cut.

The selected source owns both upstream identities:

| Lock | Fixed identity |
|---|---|
| `scripts/bamboo-sidecar-lock.json` | Exact published version/source, full embedded native target contract and manifest SHA-256; executable and browser-host bytes |
| `scripts/frontend-package-lock.json` | Exact `@bigduu/lotus-next` package/version, clean source, universal manifest and resource digests |

There are no upstream version overrides, moving `latest`, source rebuild
fallbacks or Zenith tag requirements. Accept updated artifacts in a separate
reviewed lock change. The original-output implementation (#122) kept its locks
unchanged; the separate stable integration (#125) carries the exact identities
already accepted by main `aef64d4a` in #120 and published with Bodhi27:
Bamboo `2026.10.18` / `d6325a73` and Lotus Next `2026.10.29` / `9446b8d3`.
The lockfiles remain authoritative for every full source and digest. This normal
main-to-dev integration selects no new artifact and activates no publication;
the controller bootstrap and completed-release main gate remain separate work.

After the trusted-main cutover is activated, use an unused numeric `YYYY.M.N`
(month 1–12, counter 1–65535) and the actual confirmed PR/run/attempt:

```sh
gh workflow run release.yml -R bigduu/Bodhi-AI --ref main \
  -f expected_source_sha=<EXACT_ACCEPTED_DEV_MERGE> -f bodhi_version=YYYY.M.N \
  -f feature_pull_request=<CONFIRMED_DEV_PR> \
  -f feature_run_id=<SUCCESSFUL_FEATURE_RUN> -f feature_run_attempt=<EXACT_ATTEMPT>
```

The workflow keeps actual `GITHUB_SHA`/`GITHUB_WORKFLOW_SHA` as `C`; `S` is an
explicit checkout and receipt field. It reserves the version before any formal
build in the existing GitHub draft plus shared per-version concurrency group.
It records source admission, selected lock hashes, controller, run, original
preflight job and attempt in `bodhi-v2-reservation-<RUN_ID>`. A collision with
another v1/v2 draft, final release or tag stops before building. A lost create
response is resolved by readback, without a second reservation request. If a
reservation exists but its original admission artifact was never retained,
stop rather than inventing admission or replacing the reservation.

The following two sections retain historical consumer evidence; their versions
are not overrides for the current source's committed locks.

## First package using the published Bamboo 14 baseline

The first package in this two-release delivery consumes the unchanged, published
Bamboo `2026.10.14`, source `0120712b2a509b955f45f3bf903bdb1f1a5f8186`,
and Lotus Next `2026.10.19` from the committed locks. It does not contain later
Bamboo work in #2092, #2107, #2108 or #2061, or the unfinished company Retry and
text-summary changes. Those belong to a separate later package.

This upstream Bamboo version has known TLS findings
[RUSTSEC-2026-0381](https://rustsec.org/advisories/RUSTSEC-2026-0381.html) and
[RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html).
Its exact source lock fails the current audit; this package does not claim those
findings are repaired or that the upstream security audit passes. Reuse was
explicitly accepted after disclosure. No security check, repository protection
or certificate-verification rule is disabled. Asset integrity, architecture,
version, native/static-dir compatibility and all existing Bodhi assembly gates
remain required. The later package delivers the TLS repair separately without
changing any published Bamboo 14 asset or tag.

## Second package using the published Bamboo 15 repairs

The second package selects [Bamboo `2026.10.15`](https://github.com/bigduu/Bamboo-agent/releases/tag/v2026.10.15),
source `d4e79947805957418b0ed18d4b05ac7bcbb1dc2d`, with manifest SHA-256
`d4886964a66a483afd42294668fcfce965c2c5a3aa1f29e526fea7141bbbdd5c`.
The Lotus Next `2026.10.19` lock remains unchanged. The upstream original F2,
normal release/main promotion, main-push CI and four-platform executable
publication all passed their respective source-bound gates.

This runtime contains the accepted TLS dependency/default-trust repair, versioned
Root/exact-owner/Ask handling, Child finalization, bounded connector recovery,
Project/Sprint planning and RootActor/history-writer/retained-output repairs.
Configuration sharing, unpublished summary changes and unfinished automation
are excluded. It does not certify the user's deployed company Retry/source/endpoint
case or compression efficiency.

The real consumer verified all four published executable architectures,
checksums/sizes and offline installs. The actual ARM executable passed exact
CLI/HTTP version, health/API, index/asset/SPA and external-only `--static-dir`
checks against the locked Lotus19 resources with isolated data and no provider
credentials. Bodhi's normal three-platform assembly gates remain required for
the new app package; earlier Bodhi18 results are not relabeled as this version's
execution. The separate upstream Docker run failed in its cargo-chef path-patch
layer; no Docker image is used by these native/Bodhi workflows, and that failure
is not reported as repaired or passed.

## Original target outputs and publication

Each native job reads the reserved source/version and selected locks, then
stamps only its disposable `S` Cargo manifest, Cargo package-lock entry and Tauri
configuration. Source commits keep their placeholders. The Tauri hook alone
stages the published Bamboo executable/browser host, exact frontend and browser
runtime; there is no preceding second staging or upstream source build.

| Runner | Target | Original installer files |
|---|---|---|
| `macos-latest` | `aarch64-apple-darwin` | DMG and app tar.gz |
| `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | AppImage, deb and RPM |
| `windows-latest` | `x86_64-pc-windows-msvc` | NSIS exe |

The new v2 release phase does no Unit/E2E actor or browser runtime smoke. Those
belong to admitted feature CI. It retains static upstream/resource checks,
shell architecture, package version/architecture and the existing macOS
signature verification. macOS still uses the existing ad-hoc signing override;
this change does not add notarization or claim a distribution certificate.
Controller verification reads the browser lock from the immutable `S` Git blob
and passes that data through staged and bundled checks. It does not execute an
`S` module or change the controller's default browser lock.

Before finalization, each successful target uploads a flat immutable artifact
`bodhi-v2-target-<RUN_ID>-<TARGET_ATTEMPT>-<TARGET>` with its actual installer bytes
and `target-receipt.json`. The receipt binds the reserved source/controller/
version by hash, original job ID/attempt, static checks, all filenames, sizes and
SHA-256 values. RPM is retained alongside the other Linux outputs. Artifact
metadata binds run/controller, creation window, immutable artifact ID and ZIP
digest. Restore verifies the downloaded ZIP digest, exact flat entry set and
individual file hashes, preserving original bytes.

Builders have no publisher token. Finalization runs only controller code on
Ubuntu, restores the three target artifacts by immutable IDs and uploads their
six original installers to the reserved draft. It keeps already-uploaded asset
IDs when bytes match and refuses conflicts; it never deletes or overwrites an
asset. It then attaches `bodhi-release-v2.json` with source admission, controller,
version, source lock hashes, original run/job/attempts, artifact identities and
six installer asset identities. The manifest has no circular self-ID. A separate
immutable `bodhi-v2-evidence-<RUN_ID>-<FINALIZER_ATTEMPT>` binds its hash and asset
ID plus the complete seven-asset set before publication.

Publication revalidates that retained evidence, promotes the same release ID to
`app-v<VERSION>` targeting `S`, and verifies the unchanged IDs/hashes and final
tag. Immediately before PATCH it rechecks the frozen ref/tree, protected-dev
policy and source ancestry, allowing normal dev advancement while refusing a
rewrite or unknown API state. This refresh does not rewrite the original
admission or manifest. A lost upload or PATCH response reads back the same identity; it does not
blindly retry a write. Finalization and recovery run no Cargo, Tauri or Vite
commands. Retention is 90 days, subject to repository limits; expired original
outputs are a hard stop.

## Rerun or recover without replacing successful outputs

For a failed job, first classify the failure. A product defect requires a new
feature/dev acceptance and frozen cut. An infrastructure failure may rerun
failed jobs in the same run/source/version after diagnosis. A target with no
successful Build may retry; a recorded successful Build must have its retained
original files. Missing, expired, ambiguous or changed files stop rather than
being rebuilt. Earlier successful siblings retain their original job/attempts;
a later attempt never relabels them. Even a full rerun selects those originals
and skips toolchain/dependency installation, compilation and packaging.
If a later selector alone failed before Build/capture/retention ran, a current
active selector may retry verification of the original bytes. The finalizer
still waits for that latest logical job's success. A real later Build failure,
second physical build or missing original output cannot use this exception.

A finalizer failure before publication evidence is retained can rerun that
failed finalizer in the same run. Partial uploads keep their original asset IDs.
After the evidence upload, use v2 recovery only if **Publish the original draft**
was the sole failing finalizer step:

```sh
gh workflow run recover-release.yml -R bigduu/Bodhi-AI --ref main \
  -f evidence_schema=2 -f release_run_id=<ORIGINAL_RUN> \
  -f release_attempt=<FAILED_FINALIZER_ATTEMPT> \
  -f expected_source_sha=<ORIGINAL_FROZEN_SHA> -f bodhi_version=<ORIGINAL_VERSION>
```

Recovery authenticates the original controller/run and exact finalizer attempt,
source-admission artifact, original target jobs/attempts and immutable file IDs/
hashes. It downloads the retained publication evidence by ID and promotes only
the unchanged original release. If GitHub published it after a lost response,
recovery confirms it without another PATCH. A newer recovery controller keeps
its own actual GitHub identity and never impersonates the original controller.

For historical v1 runs, including #116, select `-f evidence_schema=1` with their
original run/attempt/source/version. The byte-pinned v1 helper and frozen workflow
fixtures preserve all historical native runtime gates and publication-only
recovery rules. v1 has six release assets; v2 has those same six plus its manifest.
There is no schema fallback or conversion of old runs into v2 evidence.

Local policy/fixture tests and ZIP/Git CLI checks are not native installer,
three-OS signing, production publication or main-promotion evidence. Verify
those separately on the exact reviewed activated controller and admitted source.
