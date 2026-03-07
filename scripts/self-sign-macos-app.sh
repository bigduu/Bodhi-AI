#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Self-sign an unsigned Bodhi macOS app bundle.

Usage:
  scripts/self-sign-macos-app.sh --input <path-to-.app-or-.dmg> [--install-dir /Applications] [--open]

Examples:
  scripts/self-sign-macos-app.sh --input ~/Downloads/Bodhi_2026.3.11_aarch64.dmg
  scripts/self-sign-macos-app.sh --input /Applications/Bodhi.app --open
EOF
}

input_path=""
install_dir="/Applications"
open_after="false"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --input)
      input_path="${2:-}"
      shift 2
      ;;
    --install-dir)
      install_dir="${2:-}"
      shift 2
      ;;
    --open)
      open_after="true"
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [ -z "$input_path" ]; then
  usage
  exit 1
fi

if [ ! -e "$input_path" ]; then
  echo "Input not found: $input_path"
  exit 1
fi

mounted_volume=""
cleanup() {
  if [ -n "$mounted_volume" ]; then
    hdiutil detach "$mounted_volume" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

resolve_from_dmg() {
  local dmg_path="$1"
  local attach_out
  attach_out="$(hdiutil attach "$dmg_path" -nobrowse -readonly)"
  mounted_volume="$(echo "$attach_out" | awk '/\/Volumes\// {print substr($0, index($0, $3))}' | tail -n1)"

  if [ -z "$mounted_volume" ] || [ ! -d "$mounted_volume" ]; then
    echo "Failed to mount dmg: $dmg_path"
    exit 1
  fi

  local source_app
  source_app="$(find "$mounted_volume" -maxdepth 2 -type d -name "*.app" | head -n1)"
  if [ -z "$source_app" ]; then
    echo "No .app found in mounted dmg: $mounted_volume"
    exit 1
  fi

  mkdir -p "$install_dir"
  local dest_app="$install_dir/$(basename "$source_app")"
  echo "Copying app to: $dest_app" >&2
  ditto "$source_app" "$dest_app"
  echo "$dest_app"
}

app_path=""
case "$input_path" in
  *.dmg)
    app_path="$(resolve_from_dmg "$input_path")"
    ;;
  *.app)
    app_path="$input_path"
    ;;
  *)
    echo "--input must point to a .dmg or .app"
    exit 1
    ;;
esac

if [ ! -d "$app_path" ]; then
  echo "Resolved app path is not a directory: $app_path"
  exit 1
fi

echo "Removing quarantine attributes..."
xattr -dr com.apple.quarantine "$app_path" || true

echo "Applying ad-hoc signature..."
codesign --force --deep --sign - "$app_path"

echo "Verifying signature..."
codesign --verify --deep --strict --verbose=2 "$app_path"

echo "Gatekeeper assessment (informational):"
spctl --assess -vv "$app_path" || true

echo "Done: $app_path"
if [ "$open_after" = "true" ]; then
  open "$app_path"
fi
