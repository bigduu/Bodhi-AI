# Component release preparation

Bamboo publishes native executables and the Browser Host manifest. Lotus Next publishes an npm tarball. Bodhi's component preflight reads those original releases separately from installer packaging.

From this repository, prepare exact published versions with Node, Python and authenticated GitHub CLI access.

```sh
node scripts/prepare-component-candidate.cjs 2026.11.39 2026.11.26 > component-candidate.json
```

Use `--from <previous-bamboo> <previous-lotus>` to collect the producers' commit descriptions between exact published revisions. The previous candidate JSON is also accepted as a local input. The command verifies the Bamboo Git tag, manifest and five platform digests, and the official Lotus npm tarball and its static manifest. Both source revisions must be in their repositories' protected Dev history.

`changeHistory` preserves every commit identity and subject with the full comparison link. For long histories, the app-facing notes retain recent changes and direct readers to the complete comparison.

The `Prepare published components` workflow runs this preflight from Main after its source is promoted. Its artifact has kind `bodhi-component-candidate/v1`. The preflight matches Bamboo's desktop browser companion manifest to the exact executable manifest and the runtime archive digests at the same tag. Publish a pair after verifying compatibility and all native Bamboo executables. A nonempty `missingBrowserRuntime` list identifies platforms that can start Bamboo and Lotus and will receive the managed browser with a later component update.

The catalog lives at `channel-v1.json` on the protected `components-stable` branch. Its fields are `schemaVersion: 1`, `shellProtocol: 1` and `combinations`. Copy the verified candidate's `combination` and add the next `sequence`, a `bootstrap` flag for fresh installations and the compatible predecessors in `accepts`. Each predecessor is a pair of `bambooManifestSha256` and `lotusManifestSha256` values. The first pair uses sequence 1, `bootstrap: true` and an empty `accepts`.

Review catalog changes on the publication branch. The shell fetches its fixed official GitHub URL over HTTPS, selects its native target and verifies the official GitHub and npm downloads against the catalog's SHA-256 digests. Adding a compatible pair lets installed shells discover it without a new installer.

## Applying an update in Bodhi

Automatic and manual checks only read the official catalog. Open **Versions
and Updates**, review the available versions and choose **Download update**.
The verified download stays available for later. Choose **Restart and update**
after your long-running work finishes. Bodhi requests Bamboo's normal
shutdown, waits for the owned process and its profile lease and port to be
released, then reopens and checks the new Bamboo and Lotus pair.

If shutdown takes longer than the wait or the existing kernel cannot accept
the request, the verified update stays pending. Use **Retry restart** after
shutdown finishes, or reopen Bodhi to apply the pending update. Unix kernels
without the managed shutdown channel use Bamboo's SIGTERM shutdown. Automatic
restart on Windows requires a kernel that supports the managed shutdown channel.
