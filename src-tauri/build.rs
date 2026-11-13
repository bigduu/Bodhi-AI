use std::path::PathBuf;

mod build_support;

fn main() {
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    ensure_sidecar_placeholder();
    pin_frontend_receipt();
    build_support::reset_browser_destination(&out_dir)
        .expect("replace only the generated browser resource directory before Tauri copies it");
    build_support::reset_frontend_destination(&out_dir)
        .expect("replace only the generated frontend resource directory before Tauri copies it");
    tauri_build::build();
    // tauri-build derives its resource destination from OUT_DIR, which belongs
    // to Cargo's intermediate build-dir rather than its final target-dir.
    for name in ["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let metadata = std::process::Command::new(std::env::var_os("CARGO").unwrap())
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--offline",
        ])
        .output()
        .expect("resolve Cargo's final artifact directory");
    assert!(
        metadata.status.success(),
        "Cargo metadata failed: {}",
        String::from_utf8_lossy(&metadata.stderr)
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&metadata.stdout).expect("parse Cargo metadata");
    build_support::sync_runtime_resources(
        &out_dir,
        &PathBuf::from(
            metadata["target_directory"]
                .as_str()
                .expect("Cargo target directory"),
        ),
        &std::env::var("TARGET").unwrap(),
    )
    .expect("stage frontend, browser runtime and sidecar beside the final executable");
}

/// Pin the selected assembly in the executable so a missing or changed resource
/// can never switch a local build back to an old embedded frontend. Bare Cargo
/// shell checks get an inert resource; real Tauri hooks must stage the frontend.
fn pin_frontend_receipt() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // Bare Cargo checks can compile without a prepared runtime. Tauri hooks
    // always replace this inert resource with verified browser executables.
    let browser = manifest.join("browser-runtime");
    println!(
        "cargo:rerun-if-changed={}",
        browser.join("receipt.json").display()
    );
    if !browser.exists() {
        std::fs::create_dir(&browser).expect("create browser resource directory");
        std::fs::write(
            browser.join("unassembled.txt"),
            "Run npm run tauri:dev or npm run tauri:build.\n",
        )
        .expect("write inert browser resource");
    }
    let browser_receipt =
        std::fs::read(browser.join("receipt.json")).unwrap_or_else(|_| b"null".to_vec());
    std::fs::write(
        PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("browser-receipt.json"),
        browser_receipt,
    )
    .expect("pin browser runtime receipt");
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
