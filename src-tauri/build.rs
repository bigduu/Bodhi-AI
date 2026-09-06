use std::path::PathBuf;

mod build_support;

fn main() {
    ensure_sidecar_placeholder();
    pin_frontend_receipt();
    build_support::reset_frontend_destination(&PathBuf::from(std::env::var("OUT_DIR").unwrap()))
        .expect("replace only the generated frontend resource directory before Tauri copies it");
    tauri_build::build()
}

/// Pin the selected assembly in the executable so a missing or changed resource
/// can never switch a local build back to an old embedded frontend. Bare Cargo
/// shell checks get an inert resource; real Tauri hooks must stage the frontend.
fn pin_frontend_receipt() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let resource = manifest.join("../.bodhi-frontend");
    let receipt = resource.join("receipt.json");
    println!("cargo:rerun-if-changed={}", receipt.display());
    std::fs::create_dir_all(&resource).expect("create frontend resource directory");
    let bytes = std::fs::read(&receipt).unwrap_or_else(|_| b"null".to_vec());
    if !receipt.exists() {
        std::fs::write(
            resource.join("unassembled.txt"),
            "Run npm run build:sidecar before packaging.\n",
        )
        .expect("write inert shell-check resource");
    }
    let output = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("frontend-receipt.json");
    std::fs::write(output, bytes).expect("pin frontend receipt");
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
    let ext = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
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
