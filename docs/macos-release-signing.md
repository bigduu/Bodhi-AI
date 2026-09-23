# macOS distribution signing gate

The release workflow builds macOS arm64 and x86_64 apps with a `Developer ID Application` certificate. It has no ad-hoc fallback. Ordinary CI and local browser smoke builds continue to use ad-hoc signing and do not count as distribution evidence.

Configure these Actions secrets in `bigduu/Bodhi-AI` before dispatching the release train:

| Secret | Purpose |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of a password-protected Developer ID Application `.p12` containing its private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_API_KEY_BASE64` | Base64 of the matching `AuthKey_<key ID>.p8` |

Only one valid Developer ID Application identity may be present in the temporary release keychain. The workflow selects its certificate fingerprint for both the nested Chromium/Node executables and the outer Bodhi app. Tauri uses the API key for notarization and stapling. The temporary keychain and API key file are deleted at job end.

Before publication, each macOS job verifies the built `.app`, the app extracted from the exact `.app.tar.gz`, and the app inside the exact `.dmg`. It checks every browser Mach-O, Bamboo sidecar, and Bodhi executable for a valid signature from the same Developer ID certificate, hardened runtime, and timestamp. It also checks the app's stapled ticket and Gatekeeper assessment, the DMG's stapled ticket, bundle ID/version, target architecture, and pinned Node/Chromium revisions. Any failure blocks the release finalization job.

Each verified candidate produces `bodhi-<target>-distribution-receipt.json` in both the draft release and workflow artifacts. It records the Bodhi/Bamboo source commits, app version and CDHash, signing team and certificate fingerprint, browser revisions and content hashes, and SHA-256 of the exact app archive and DMG. No certificate, private key, or password is included.

References: [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) and [Apple notarization workflow](https://developer.apple.com/documentation/Security/customizing-the-notarization-workflow).
