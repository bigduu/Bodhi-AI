# Publish Bodhi independently

Bodhi's only publishing entrypoint is this repository's [release.yml](../.github/workflows/release.yml). It accepts an explicit unused app version and the full Bodhi source SHA selected by the workflow ref. Zenith is an optional integration checkout; its gitlinks, configuration, credentials and workflows are not release prerequisites. Bamboo and Lotus Next publish separately, and Bodhi consumes their accepted artifacts.

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

The feature CI phase is implemented here. The existing release and recovery
workflows below deliberately retain their original native gates and exact-source
contract until the dependent feature-evidence and trusted-main-controller slice
is reviewed and activated. Moving those gates is not authorized by a successful
feature job alone. The current publisher therefore still performs its historical
assembly/E2E checks; this is a pending cutover, not the final release policy.

## Prepare and dispatch

Land source and lock updates through Bodhi's normal reviewed pull-request flow. Keep source manifest versions at `0.0.0`; the workflow stamps the requested app version only in temporary publishing checkouts. Use numeric `YYYY.M.N`, with month 1–12 and counter 1–65535, without leading zeros. The app version is independent of both upstream versions.

The committed identities are authoritative:

| Lock | What remains fixed |
|---|---|
| `scripts/bamboo-sidecar-lock.json` | Published Bamboo version, full source SHA, embedded mode, exact native target contract and manifest name/SHA-256; v1 has four targets and v2 has ARM macOS, Windows x64 and Linux x64. The manifest binds executable and browser host assets |
| `scripts/frontend-package-lock.json` | Exact `@bigduu/lotus-next` version, clean source SHA, universal manifest and resource digests |

There are no upstream version overrides, `latest` resolution, source-build fallback, Bamboo crates.io check or Zenith source tag requirement. Accept a new upstream identity in a separate reviewed lock update after verifying its real published bytes and native compatibility.

Select a merged Bodhi commit, then dispatch directly (replace `YYYY.M.N` with the unused version):

```sh
source_sha="$(gh api repos/bigduu/Bodhi-AI/commits/main --jq .sha)"
gh workflow run release.yml -R bigduu/Bodhi-AI --ref main \
  -f expected_source_sha="$source_sha" -f bodhi_version=YYYY.M.N
```

If `main` moves before dispatch, the source check stops before native builds. Select the current reviewed commit and dispatch again. A Bodhi-owned immutable branch/tag ref may also be selected with its matching full SHA; no Zenith tag is needed. Release and recovery workflows share a per-version concurrency group and do not cancel an active assembly.

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

## Acceptance and publication

Preflight checks the exact clean source, version, both committed locks and absence of the final release/tag before starting the matrix. Every native job then downloads the accepted Bamboo executable and browser host, installs the locked Lotus Next package, builds the Tauri shell and passes the existing assembly, bundled actor/HTTP/static-dir and bundled browser gates:

| Runner | Target |
|---|---|
| `macos-latest` | `aarch64-apple-darwin` |
| `ubuntu-22.04` | `x86_64-unknown-linux-gnu` |
| `windows-latest` | `x86_64-pc-windows-msvc` |

Jobs upload only to `bodhi-draft-v<VERSION>-<RUN_ID>-<ATTEMPT>`. After all three supported platforms pass, finalization independently reads that exact attempt's successful gates and verifies one matching source-bound draft with all six original assets: the ARM64 DMG and macOS app archive, AppImage, deb, rpm and Windows NSIS installer. It checks unique asset IDs, uploaded state, minimum sizes, SHA-256 digests and GitHub download URLs.

Before publishing, it uploads `bodhi-release-evidence-<RUN_ID>-<ATTEMPT>` containing the exact version, source, run, attempt, release ID and every asset ID/size/digest. It promotes only that original release ID to `app-v<VERSION>` and confirms its unchanged assets and source tag. A different existing release or tag is refused. A lost PATCH response triggers readback of that exact publication, never a blind write retry. Signing and the native acceptance gates for ARM64 macOS, Linux x86_64 and Windows x64 are unchanged. Intel macOS is excluded from this release and its Homebrew cask remains ARM-only. The locked Bamboo manifest is validated against its exact producer contract: historical v1 requires all four targets; v2 requires exactly ARM macOS, Linux x64 and Windows x64. This selection does not change Bodhi's existing three-platform packaging matrix or reopen any historical release.

Watch the Bodhi run directly and verify the final release:

```sh
gh run watch <RUN_ID> -R bigduu/Bodhi-AI --exit-status
gh release view app-v<VERSION> -R bigduu/Bodhi-AI
```

## Recover finalization without rebuilding

Use [recover-release.yml](../.github/workflows/recover-release.yml) only when all three original native jobs passed and **Publish the completed draft** was the only failing finalizer step, after the original evidence artifact was uploaded. Use the original run, attempt, SHA and version:

```sh
gh workflow run recover-release.yml -R bigduu/Bodhi-AI --ref main \
  -f release_run_id=<ORIGINAL_RUN_ID> -f release_attempt=<ORIGINAL_ATTEMPT> \
  -f expected_source_sha=<ORIGINAL_FULL_SHA> -f bodhi_version=<ORIGINAL_VERSION>
```

Recovery verifies the original run/version/source and all three gates, rejects missing, expired or duplicate evidence, and downloads the single immutable artifact by ID from that original run and attempt. It checks the evidence against the unchanged original draft/assets before publishing. If GitHub already published that identical release after a lost response, recovery confirms it without another PATCH. Conflicting IDs, source, assets or final tag stop recovery. The artifact is retained for 90 days, subject to repository retention limits.

Do not use a later failed-jobs rerun or a new build's assets to repair finalization. If native builds failed, or finalization never retained evidence, fix the cause and dispatch a fresh full three-platform run with the still-unused version. This recovery contract applies to runs produced by this workflow format; historical train runs without its version-bound run identity and original evidence artifact cannot be recovered through it.
