# Build Mode System (Internal/Public)

This project no longer performs product rebranding between internal/public.

- Product name is always **Bodhi**.
- Package/identifier/title remain fixed.
- `internal` / `public` only controls whether startup confirmation dialog is shown.

## Behavior

The frontend (`lotus`) reads:

- `VITE_INTERNAL_BUILD=true`  -> internal mode flag
- `VITE_INTERNAL_BUILD=false` -> public mode flag

The switch is written to `lotus/.env` by `lotus/scripts/rebrand.cjs` (legacy script name kept for compatibility).
For Tauri shell behavior, `bodhi` scripts also inject compile-time env `BODHI_INTERNAL_BUILD=true|false`.

## Commands

From `bodhi/`:

```bash
# Development
npm run tauri:dev:internal
npm run tauri:dev:public

# Build
npm run tauri:build:internal
npm run tauri:build:public
```

From `lotus/`:

```bash
# Set mode only (legacy command name)
npm run rebrand:internal
npm run rebrand:public

# Validate current mode in .env
npm run rebrand:check -- --target=internal
npm run rebrand:check -- --target=public
```

## Notes

1. Shell branding rewrite is disabled; Bodhi shell files are not modified by mode switching.
2. Startup confirmation now lives in `bodhi/src-tauri` (native dialog), not in `lotus` React UI.
3. Internal/public mode affects startup UX only.
4. If mode seems incorrect, run `npm --prefix ../lotus run rebrand:internal` or `...:public` from `bodhi/` to regenerate `lotus/.env`.
