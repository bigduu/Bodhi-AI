# Component release preparation

Bamboo publishes native executables and browser assets through GitHub Releases. Lotus Next publishes its frontend through the public `@bigduu/lotus-next` npm package. Bodhi can verify either release independently of installer packaging.

## Independent component preflight

Run from this repository with Node, Python and authenticated GitHub CLI access.

```sh
node scripts/prepare-component-candidate.cjs --component bamboo latest --from 2026.11.42
node scripts/prepare-component-candidate.cjs --component lotus 2026.11.29
```

Omit the version or use `latest` to discover Bamboo's stable GitHub Release or Lotus Next's npm `latest` dist-tag. Preflight resolves that reference to an exact version and verifies the original artifacts and the release source in protected Dev history. If discovery or verification fails, the run fails. Pass an exact published version to check another release. Pass `--from <previous-version>` to include commit history between two exact published revisions of that component.

The JSON has kind `bodhi-single-component-candidate/v1` and contains `component`, `release`, `changes` and `changeHistory`. `changeHistory` preserves every commit identity and subject with the full comparison link. For long histories, `changes` retains recent entries and links to the complete comparison.

Bamboo verification checks the executable manifest, five platform digests, and Browser Host archive identity. When present, it also matches the browser companion manifest to the exact executable manifest and runtime archive digests at the same tag. The Bamboo result includes `missingBrowserRuntime`, which lists platforms without the companion runtime. Lotus Next verification checks the official npm tarball and its static manifest.

The **Prepare published components** workflow runs this preflight from Main after its source is promoted. Choose `bamboo` or `lotus`, optionally enter that component's exact version and previous version, and leave the other component's fields blank. The workflow uploads `component-candidate.json` for review. This operation reads releases and produces verification evidence. Publishing and applying an update are separate operations.

Use `discover` to check both producers on demand. Each job compares one upstream stable version with the
highest version of that component in the protected catalog and verifies its
published identity. A newer release produces a candidate with the exact catalog
revision, sequence and prior version for compatibility review. An unchanged
release produces a summary only. A producer failure leaves the peer job running.
This workflow also serves as a diagnostic for releases discovered by the shell.

## Catalog publication for older shells and initial bootstrap

The workflow defaults to `pair` for the existing catalog. Enter both exact published versions. If change history is needed, enter both previous versions too. The equivalent local command produces a `bodhi-component-candidate/v1` artifact.

```sh
node scripts/prepare-component-candidate.cjs 2026.11.39 2026.11.26 > component-candidate.json
```

Use `--from <previous-bamboo> <previous-lotus>` to collect the producers' commit descriptions between exact published revisions. The previous paired candidate JSON is also accepted as a local input. Verify compatibility before publishing a pair.

The catalog lives at `channel-v1.json` on the protected `components-stable` branch. Its fields are `schemaVersion: 1`, `shellProtocol: 1` and `combinations`. Copy the verified candidate's `combination` and add the next `sequence`, a `bootstrap` flag for fresh installations and the compatible predecessors in `accepts`. Each predecessor is a pair of `bambooManifestSha256` and `lotusManifestSha256` values. The first pair uses sequence 1, `bootstrap: true` and an empty `accepts`.

Keep the existing catalog available to older shells and as the initial pair for
a fresh installation. Component releases discovered directly by the shell need
no catalog entry.

## Applying an update in Bodhi

Automatic and manual checks read Bamboo's official stable GitHub Release and
Lotus Next's official npm stable dist-tag. Each offer retains the current build
of the other component. An unavailable or invalid producer release leaves the
other producer's offers usable.

In **Versions and Updates**, each component panel shows its running version, the
eligible published version, release notes, and update controls. A previously
verified download remains available if its producer publishes a newer version.
The profile minimum Bamboo version applies at startup and during updates.

Choose **Download update** for the selected target. Bodhi downloads its changed
assets and verifies the cached peer. Large downloads use up to four concurrent
HTTP ranges and write them in order so they can resume after an interruption.
Sources that cannot serve ranges use a single stream. Bodhi checks the final
size and SHA-256 before staging. It starts the exact pair in an isolated
profile and checks Bamboo's live Bootstrap capabilities against the Lotus
frontend requirements. One verified selection can be staged for restart at a
time. The shell rechecks the official release identity before shutdown and the
replacement's Bootstrap before recording activation. The active verified
components can start offline. Choose **Restart and update**
after long-running work finishes. Bodhi requests Bamboo's normal shutdown, waits
for the owned process to release its profile lease and port, then reopens and
checks the effective Bamboo and Lotus versions.

For a one-click switch, choose **Update and restart now** for any downloaded,
verified target that is still eligible. Bodhi rechecks the target and
terminates its current managed Bamboo process immediately. This interrupts
running tasks, which need to be started again. Bodhi confirms the old process
has ended and released the profile writer lease and port before switching to
the exact selected versions.

If an approved update is queued and shutdown takes longer than the wait, use
**Retry restart** after shutdown finishes, or reopen Bodhi to apply the queued
update. Unix kernels without the managed shutdown channel use Bamboo's SIGTERM
shutdown. Automatic restart on Windows requires a kernel that supports the
managed shutdown channel.

## Rolling back Lotus Next

After a Lotus-only update becomes ready, Bodhi records the exact previous
Lotus and Bamboo combination. In the Lotus Next panel, choose **Restart and
roll back to {version}** after finishing running tasks. Bodhi verifies the
cached assets locally, stops its own Bamboo normally, and checks the profile
writer and service port before staging the rollback. It starts the same
Bamboo with the previous Lotus and verifies the served frontend. If the
rollback fails at startup, Bodhi reopens the active combination. If the
existing process is still shutting down, retry the same rollback once it
exits.

Bodhi hides the rolled-away Lotus build from new offers after a successful
rollback. Choose **Show the version I rolled back from** to make it eligible
again. Existing profiles gain this rollback option after their first verified
Lotus-only update with this shell. Changing Bamboo requires new compatibility
evidence for any previously used Lotus build.
