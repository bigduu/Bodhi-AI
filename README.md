# Bodhi Shell

Bodhi is the Tauri desktop shell for Lotus. After the project split, Lotus owns frontend product code, while Bodhi owns desktop runtime concerns: native commands, window lifecycle, packaging, and release behavior.

## Ownership and Scope

- `lotus`: frontend source of truth (React/Vite UI, web tests, E2E)
- `bodhi`: desktop shell (`src-tauri`), app packaging, native integrations
- `bamboo`: backend agent service/framework

Bodhi can currently source Lotus assets from either:
- a local sibling checkout (`../lotus`), or
- the published npm package (`@bigduu/lotus`)

## Architecture

```text
+-------------------------+        +----------------------+
|      Bodhi (Tauri)      | <----> |   bamboo-agent API   |
|  - native Rust commands |        |  local/remote backend|
|  - desktop packaging    |        +----------------------+
|  - bundles Lotus assets |
+------------+------------+
             |
             v
       Lotus frontend
   (local checkout or npm package)
```

## Repository Layout

```text
bodhi/
├── src-tauri/              # Tauri app (Rust)
├── scripts/                # Lotus source/rebrand helpers
├── docs/                   # Bodhi-specific documentation
├── e2e-backend/            # backend fixtures/helpers
└── src/                    # legacy mirrored frontend files (not source of truth)
```

## Prerequisites

- Node.js LTS (20+ recommended)
- Rust stable (`rustup`)
- Optional local `../lotus` checkout (required for `tauri:dev` and local web scripts)

## Development

```bash
cd bodhi
npm install
npm run tauri:dev
```

Useful commands:

```bash
npm run tauri:build         # build desktop app
npm run web:build           # stage Lotus dist into .lotus-dist
npm run web:source:info     # print Lotus source resolution
npm run type-check          # delegates to ../lotus
npm run test:run            # delegates to ../lotus Vitest
npm run test:e2e            # delegates to ../lotus/e2e
cargo test --manifest-path src-tauri/Cargo.toml
```

## Lotus Source Modes

`npm run web:build` stages frontend assets into `bodhi/.lotus-dist`, which Tauri consumes as `frontendDist`.

- `LOTUS_SOURCE=auto` (default): local `../lotus` first, then npm package
- `LOTUS_SOURCE=local`: force local mode
- `LOTUS_SOURCE=package`: force package mode
- `LOTUS_LOCAL_PATH`: override local path (default `../lotus`)
- `LOTUS_PACKAGE_NAME`: override package name (default `@bigduu/lotus`)

Package-mode build example:

```bash
cd bodhi
npm install @bigduu/lotus@<version>
LOTUS_SOURCE=package LOTUS_PACKAGE_NAME=@bigduu/lotus npm run tauri:build
```

## Build Profiles

- `npm run tauri:dev:public`
- `npm run tauri:dev:internal`
- `npm run tauri:build:public`
- `npm run tauri:build:internal`

These profiles control shell mode/rebrand behavior while keeping app identity as Bodhi.

## CI Boundary

- Lotus CI: web checks and frontend artifacts only
- Bodhi CI: Tauri build and desktop packaging

## macOS Local Self-Signing

Releases may provide unsigned macOS app bundles. End users can self-sign locally after download.

Use:

```bash
bash scripts/self-sign-macos-app.sh --input ~/Downloads/Bodhi_2026.3.11_aarch64.dmg
```

Or sign an existing app directly:

```bash
bash scripts/self-sign-macos-app.sh --input /Applications/Bodhi.app --open
```

What the script does:
- mounts `.dmg` and copies `Bodhi.app` to `/Applications` (configurable via `--install-dir`)
- removes quarantine attribute
- applies ad-hoc deep signature (`codesign --force --deep --sign -`)
- runs verification commands (`codesign` and `spctl`)
