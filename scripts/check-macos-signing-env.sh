#!/usr/bin/env bash
set -euo pipefail

required_vars=(
  APPLE_CERTIFICATE
  APPLE_CERTIFICATE_PASSWORD
  APPLE_SIGNING_IDENTITY
  APPLE_ID
  APPLE_PASSWORD
  APPLE_TEAM_ID
)

missing=()

for var_name in "${required_vars[@]}"; do
  if [ -z "${!var_name:-}" ]; then
    missing+=("${var_name}")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing required macOS signing/notarization secrets:"
  for var_name in "${missing[@]}"; do
    echo "  - ${var_name}"
  done
  echo
  echo "Configure these as GitHub repository secrets before running release workflow."
  echo "Without them, macOS apps may fail Gatekeeper checks with 'damaged' errors."
  exit 1
fi

echo "macOS signing/notarization secrets detected."
