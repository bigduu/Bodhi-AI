# Component release preparation

Bamboo publishes native executables and the Browser Host manifest. Lotus Next publishes an npm tarball. Bodhi's component preflight reads those original releases separately from installer packaging.

From this repository, prepare exact published versions with Node, Python and authenticated GitHub CLI access.

```sh
node scripts/prepare-component-candidate.cjs 2026.11.39 2026.11.26 > component-candidate.json
```

Use `--from <previous-bamboo> <previous-lotus>` to collect the producers' commit descriptions between exact published revisions. The previous candidate JSON is also accepted as a local input. The command verifies the Bamboo Git tag, manifest, five platform assets and published digests. It downloads and verifies the official Lotus npm tarball and its static manifest and confirms its source ancestry on Lotus Dev.

The `Prepare published components` workflow runs this preflight from Main after its source is promoted. Its artifact has kind `bodhi-component-candidate/v1`. The preflight matches Bamboo's desktop browser companion manifest to the exact executable manifest and the runtime archive digests at the same tag. A nonempty `missingBrowserRuntime` list identifies the targets that still need browser runtime assets. The signed channel requires complete native compatibility evidence, production role keys and an authenticated publication step. The candidate workflow supplies identity evidence for that step.
