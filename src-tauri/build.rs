use std::path::PathBuf;

fn main() {
    ensure_sidecar_placeholder();
    tauri_build::build()
}

/// Tauri validates the `externalBin` sidecar at build time, so a bare `cargo build`
/// (e.g. CI's shell-compile check) needs `binaries/bamboo-<target-triple>` to exist
/// even though the *real* binary is produced by `scripts/build-sidecar.cjs` during
/// `tauri build` / dev. When it's missing, write a non-functional placeholder so the
/// compile resolves; the real binary is assembled by the sidecar build script or in
/// the zenith superproject.
fn ensure_sidecar_placeholder() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let target = std::env::var("TARGET").unwrap_or_default();
    let ext = if target.contains("windows") { ".exe" } else { "" };
    let bin = manifest
        .join("binaries")
        .join(format!("bamboo-{target}{ext}"));
    println!("cargo:rerun-if-changed=binaries");
    if bin.exists() {
        return;
    }
    if let Some(dir) = bin.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        &bin,
        b"#!/bin/sh\necho 'bamboo sidecar placeholder - run scripts/build-sidecar.cjs' >&2\nexit 1\n",
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755));
    }
}
