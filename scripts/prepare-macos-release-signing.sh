#!/usr/bin/env bash
set -euo pipefail

# This runs only in the macOS release matrix. CI's ad-hoc build deliberately
# does not use this script or need Apple credentials.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "::error::Developer ID signing requires a macOS runner."
  exit 1
fi

for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_BASE64 GITHUB_ENV RUNNER_TEMP; do
  if [ -z "${!name:-}" ]; then
    echo "::error::Missing ${name} for a notarized macOS release."
    exit 1
  fi
done
if [[ ! "$APPLE_API_KEY" =~ ^[A-Z0-9]{10}$ ]] ||
   [[ ! "$APPLE_API_ISSUER" =~ ^[A-Fa-f0-9-]{36}$ ]]; then
  echo "::error::The App Store Connect key ID or issuer ID has an invalid format."
  exit 1
fi

umask 077
signing_dir="$(mktemp -d "${RUNNER_TEMP}/bodhi-release-signing.XXXXXX")"
certificate_path="${signing_dir}/certificate.p12"
api_key_path="${signing_dir}/AuthKey_${APPLE_API_KEY}.p8"
keychain_path="${signing_dir}/release.keychain-db"
keychain_password="$(openssl rand -hex 32)"
prepared="false"
cleanup() {
  rm -f "$certificate_path"
  if [ "$prepared" != "true" ]; then
    security delete-keychain "$keychain_path" >/dev/null 2>&1 || true
    rm -rf "$signing_dir"
  fi
}
trap cleanup EXIT

printf '%s' "$APPLE_CERTIFICATE" | base64 -D > "$certificate_path"
printf '%s' "$APPLE_API_KEY_BASE64" | base64 -D > "$api_key_path"
if [ ! -s "$certificate_path" ] || [ ! -s "$api_key_path" ] ||
   [ "$(head -n 1 "$api_key_path")" != '-----BEGIN PRIVATE KEY-----' ]; then
  echo "::error::The Apple certificate or App Store Connect API key is invalid."
  exit 1
fi

security create-keychain -p "$keychain_password" "$keychain_path"
security default-keychain -s "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security set-keychain-settings -t 3600 -u "$keychain_path"
security import "$certificate_path" -k "$keychain_path" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain_path"

# Select exactly one Developer ID Application identity from the isolated
# keychain. Its SHA-1 is passed to both the nested browser signer and Tauri.
identity="$(security find-identity -v -p codesigning "$keychain_path" | node -e '
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { text += chunk; });
  process.stdin.on("end", () => {
    const matches = [...text.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"Developer ID Application: [^"\n]+ \(([A-Z0-9]{10})\)"\s*$/gm)];
    if (matches.length !== 1) {
      console.error("::error::Expected exactly one valid Developer ID Application identity in the release keychain.");
      process.exitCode = 1;
      return;
    }
    console.log(matches[0][1].toUpperCase() + " " + matches[0][2]);
  });
')"
read -r signer_sha signing_team <<< "$identity"

{
  printf 'APPLE_SIGNING_IDENTITY=%s\n' "$signer_sha"
  printf 'BODHI_SIGNING_TEAM=%s\n' "$signing_team"
  printf 'APPLE_API_KEY_PATH=%s\n' "$api_key_path"
  printf 'BODHI_SIGNING_DIR=%s\n' "$signing_dir"
} >> "$GITHUB_ENV"
prepared="true"
echo "Developer ID Application identity ready for team ${signing_team}; nested browser and outer app will use the same certificate."
