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

The **Prepare published components** workflow runs this preflight from Main.
Choose `bamboo` or `lotus`, optionally enter that component's exact version and
previous version, and leave the peer fields blank. The workflow uploads
`component-candidate.json` for review.

The workflow checks both producers hourly and on demand in `discover` mode.
Each job reads its component's fixed client catalog and verifies that the bytes
match the protected branch revision. It compares the upstream stable release
with the catalog's explicit recommendation. A newer release produces a
candidate with the exact baseline catalog revision, SHA-256, branch commit, and
prior version. An unchanged recommendation produces a summary. The peer job
continues after a producer or catalog failure. Use `catalog` mode and enter one
exact version to verify a specific release against that same baseline. This
workflow has read permissions and uploads candidate evidence.

## Maintaining the installed-client stable catalogs

The protected `components-stable` branch serves one static file per component.
These are the URLs checked by installed Bodhi clients.

- [bamboo-v1.json](https://raw.githubusercontent.com/bigduu/Bodhi-AI/components-stable/bamboo-v1.json)
- [lotus-v1.json](https://raw.githubusercontent.com/bigduu/Bodhi-AI/components-stable/lotus-v1.json)

Each file contains `schemaVersion: 1`, a positive `revision`, a
`recommendedVersion`, and `releases`. Each entry has the preflight's exact
`release` identity and `changes`. Keep each file within 1 MiB with at most
64 entries in ascending numeric version order. Increment its revision for every change.
`recommendedVersion` selects one listed version, or `null` to pause new offers.
Keep superseded releases listed while their downloaded updates should remain
eligible. Remove an entry to withdraw that version, updating the recommendation
in the same change if needed. A verified downloaded version remains eligible
when it is listed and still applicable to the active pair.
For an artifact-wide withdrawal, review the paired `channel-v1.json` bootstrap
entries in the same PR so fresh and older installations use safe artifacts too.

Before recommending a candidate, verify its original release evidence and test
the exact changed component alongside the currently recommended peer. Include
the candidate's run and compatibility results in a PR to `components-stable`.
Prepare and check the replacement file from the Bodhi source checkout.

```sh
node scripts/prepare-component-candidate.cjs --recommend-catalog bamboo component-candidate.json > bamboo-v1.json
node scripts/prepare-component-candidate.cjs --validate-catalog bamboo bamboo-v1.json
```

The preparation command rejects a stale component baseline and changes to a
retained release identity. It accepts an intervening peer catalog update when
the component's baseline bytes still match. Recheck compatibility if the
recommended peer changed. To prepare a withdrawal, run
`--withdraw-catalog bamboo VERSION [RECOMMENDATION|none]` in place of
`--recommend-catalog bamboo component-candidate.json`. Provide a replacement
recommendation or `none` when withdrawing the currently recommended version.
After merging, check the exact client URL against both the protected branch
and the reviewed file. Retry the read after CDN propagation if those bytes differ.

```sh
node scripts/prepare-component-candidate.cjs --verify-catalog bamboo bamboo-v1.json
```

Run the equivalent commands with `lotus` and `lotus-v1.json` for Lotus Next.
Publish the first two files before shipping a shell or activating the scheduled
workflow that reads them. Seed revision 1 from the reviewed bootstrap pair in
[catalog PR #396](https://github.com/bigduu/Bodhi-AI/pull/396).

```sh
seed_dir=$(mktemp -d)
curl -fsSL https://raw.githubusercontent.com/bigduu/Bodhi-AI/de5fe271a39fd30adeef6dce37d9cdbf82e50c10/channel-v1.json -o "$seed_dir/channel-v1.json"
echo "3015fd6c2549ee5b44cc6f85987752b28a00efbf2af703f1cc27443b334c6e60  $seed_dir/channel-v1.json" | shasum -a 256 -c -
node scripts/prepare-component-candidate.cjs --seed-catalog bamboo "$seed_dir/channel-v1.json" 9 > "$seed_dir/bamboo-v1.json"
node scripts/prepare-component-candidate.cjs --seed-catalog lotus "$seed_dir/channel-v1.json" 9 > "$seed_dir/lotus-v1.json"
```

## Catalog publication for older shells and initial bootstrap

The workflow defaults to `pair` for the existing catalog. Enter both exact published versions. If change history is needed, enter both previous versions too. The equivalent local command produces a `bodhi-component-candidate/v1` artifact.

```sh
node scripts/prepare-component-candidate.cjs 2026.11.39 2026.11.26 > component-candidate.json
```

Use `--from <previous-bamboo> <previous-lotus>` to collect the producers' commit descriptions between exact published revisions. The previous paired candidate JSON is also accepted as a local input. Verify compatibility before publishing a pair.

The catalog lives at `channel-v1.json` on the protected `components-stable` branch. Its fields are `schemaVersion: 1`, `shellProtocol: 1` and `combinations`. Copy the verified candidate's `combination` and add the next `sequence`, a `bootstrap` flag for fresh installations and the compatible predecessors in `accepts`. Each predecessor is a pair of `bambooManifestSha256` and `lotusManifestSha256` values. The first pair uses sequence 1, `bootstrap: true` and an empty `accepts`.

Maintain the legacy catalog for older shells and the initial pair for a fresh
installation. Verify each new bootstrap pair before marking it eligible.

## Applying an update in Bodhi

Automatic and manual checks read the two Bodhi stable catalogs. Each offer
retains the current build of the other component. An unavailable or invalid
catalog leaves the peer component's offers usable.

Bodhi checks for component updates automatically every three hours by default.
In **Versions and Updates**, set the automatic interval in hours. Set it to
zero to check only when you choose **Check for updates**. Bodhi keeps the last
attempt time across restarts and retains verified downloads in either mode.

In **Versions and Updates**, each component panel shows its running version, the
eligible published version, release notes, and update controls. A verified
download is still available after Bodhi recommends a newer release while the
downloaded version remains listed and compatible with the running pair.
The profile minimum Bamboo version applies at startup and during updates.

Choose **Download update** for the selected target. Bodhi downloads its changed
assets and verifies the cached peer. Large downloads use up to four concurrent
HTTP ranges and write them in order so they can resume after an interruption.
Sources that cannot serve ranges use a single stream. Bodhi checks the final
size and SHA-256 before staging. It starts the exact pair in an isolated
profile and checks Bamboo's live Bootstrap capabilities against the Lotus
frontend requirements. One verified selection can be staged for restart at a
time. The shell rechecks the listed stable release identity before shutdown and
the replacement's Bootstrap before recording activation. The active verified
components can start offline. Choose **Update Bamboo** for Bamboo-only updates
or **Restart and update** for other component updates after long-running work
finishes. Bodhi requests Bamboo's normal shutdown, waits for the owned process
to release the profile lease and port, then verifies the effective versions.

For a one-click switch, choose **Update and restart now** for any downloaded,
verified target that is still eligible. A Bamboo process with immediate
checkpoint support can discard an in-progress model response and flush the
session's completed history. Bodhi verifies the durable handoff before
terminating that process. After restarting, Bamboo resumes eligible sessions
under their original IDs. Bamboo may still wait for an active tool to reach a
durable boundary. A failure to confirm the handoff keeps the current version
selected.

Older Bamboo versions offer **Force update and restart**. This action
terminates the managed process and running tasks need to be started again. Both
paths confirm that the old process released the profile writer lease and port
before switching to the exact selected versions.

If the catalog check is unreachable or times out, Bodhi can recheck the exact
cached bytes of a previously verified selection. A returned withdrawal or
release identity change blocks the update.

If an approved update is queued and shutdown takes longer than the wait, use
**Retry restart** after shutdown finishes, or reopen Bodhi to apply the queued
update. Unix kernels without the managed shutdown channel use Bamboo's SIGTERM
shutdown. Automatic restart on Windows requires a kernel that supports the
managed shutdown channel.

## Updating Bamboo in the same Bodhi window

A Bamboo-only update keeps the Bodhi process and its windows. Bodhi prepares
the files and checks the replacement before opening its built-in transition
page. It hands off sessions through the managed local control channel when
available, waits for the old process to release the writer and port, and
starts the exact verified Bamboo at the same loopback origin. During the
switch it uses the local component cache.

After verifying the new process and Lotus resources, Bodhi reconnects the
main window to its previous workspace route and resumes eligible saved sessions.
The update window distinguishes shutdown, startup, reconnecting and session
recovery. If a handoff fails after shutdown has begun, open **Versions and
Updates** and use **Retry Bamboo update**. If the old process exits without
confirming the handoff, Bodhi can restore the verified original release before
a replacement trial begins. A profile already opened by a newer Bamboo keeps
its minimum-version guard. Session recovery requires a valid checkpoint.

Lotus reloads its document when the workspace returns. Recovery for an unsent
composer draft is developed in [Lotus Next #737](https://github.com/bigduu/lotus-next/issues/737).

## GitHub credentials for the Bamboo endpoint test

In **Versions and Updates**, use **Test token** to check optional GitHub
credentials through the current proxy route. A fine-grained token with public
repository read access is sufficient. Bodhi sends it only to the official
Bamboo GitHub REST API during that test. Stable catalog reads and the configured
download sources use their own requests. A GitHub rate-limit response gives a
retry time. Changing or removing the token clears that cooldown.

Bodhi shows whether the token is stored in macOS Keychain or Windows Credential
Manager, or held only for the current session. Linux uses session storage in
the running Bodhi process. Use **Remove token** to return to anonymous checks.

## Importing a Bamboo update from local files

If the GitHub Release API is unavailable, download three files from the same [official Bamboo release](https://github.com/bigduu/Bamboo-agent/releases) into one folder:

- `bamboo-sidecars-v3.json`
- `bamboo-<target>` (add `.exe` on Windows)
- `bamboo-browser-runtime-v1-<target>.tar.gz`

On Apple Silicon, the target is `aarch64-apple-darwin`. In **Versions and Updates**, choose **Import local update…** in the Bamboo panel and select `bamboo-sidecars-v3.json`.

Bodhi reads the two small official release manifests over HTTPS, using the configured **Proxy URL** if present. This skips the GitHub REST API and reads the executable and browser runtime from the selected local folder. **Download source** controls automatic artifact downloads. It is independent of **Proxy URL** and does not route release metadata. Import verifies each local file against the official release and checks compatibility with the running Lotus Next. After verification, choose **Restart and update** when ready. A verified import can be applied without internet access.

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
