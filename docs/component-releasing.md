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

## Catalog publication for existing shells

The workflow defaults to `pair` for the existing catalog. Enter both exact published versions. If change history is needed, enter both previous versions too. The equivalent local command produces a `bodhi-component-candidate/v1` artifact.

```sh
node scripts/prepare-component-candidate.cjs 2026.11.39 2026.11.26 > component-candidate.json
```

Use `--from <previous-bamboo> <previous-lotus>` to collect the producers' commit descriptions between exact published revisions. The previous paired candidate JSON is also accepted as a local input. Verify compatibility before publishing a pair.

The catalog lives at `channel-v1.json` on the protected `components-stable` branch. Its fields are `schemaVersion: 1`, `shellProtocol: 1` and `combinations`. Copy the verified candidate's `combination` and add the next `sequence`, a `bootstrap` flag for fresh installations and the compatible predecessors in `accepts`. Each predecessor is a pair of `bambooManifestSha256` and `lotusManifestSha256` values. The first pair uses sequence 1, `bootstrap: true` and an empty `accepts`.

Review catalog changes on the publication branch. The shell fetches its fixed official GitHub URL over HTTPS, selects its native target and verifies the official GitHub and npm downloads against the catalog's SHA-256 digests. Adding a compatible pair lets installed shells discover it without a new installer.

## Applying an update in Bodhi

Automatic and manual checks read the official catalog. In **Versions and
Updates**, Bamboo appears on the left and Lotus Next on the right. The panels
stack in a narrow window. Each panel shows its running version, eligible target
versions, release notes, and update controls. Bamboo lists compatible newer
versions highest first. Choose the exact version to download in its panel. A
refresh keeps each selected version while its catalog entry remains eligible.
The profile minimum Bamboo version applies at startup and during updates. When
the catalog requires both components to change together, one combined update
shows both target versions and their release notes.

Choose **Download update** for the selected target. Bodhi downloads its changed
assets and verifies the cached peer for a single-component update. One verified
selection can be staged for restart at a time. Choose **Restart and update**
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
