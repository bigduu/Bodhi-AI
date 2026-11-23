use std::path::PathBuf;

mod build_support;

fn main() {
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    println!(
        "cargo:rustc-env=BODHI_BUILD_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    let root_present = pin_component_root(&out_dir);
    if thin_build() {
        assert!(
            root_present,
            "A thin Bodhi installer requires src-tauri/component-update-root.json"
        );
        // Keep the historical launcher compilable while excluding its
        // resources from this assembly profile.
        for name in ["frontend-receipt.json", "browser-receipt.json"] {
            std::fs::write(out_dir.join(name), b"null").expect("write unused bundled receipt");
        }
        tauri_build::build();
        return;
    }
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

fn thin_build() -> bool {
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let feature = std::env::var_os("CARGO_FEATURE_THIN_SHELL").is_some();
    let overlay: serde_json::Value = std::env::var("TAURI_CONFIG")
        .ok()
        .map(|json| serde_json::from_str(&json).expect("invalid TAURI_CONFIG"))
        .unwrap_or_default();
    let without_components = ["externalBin", "resources"]
        .into_iter()
        .all(|key| overlay["bundle"][key].as_array().is_some_and(Vec::is_empty));
    assert_eq!(
        feature, without_components,
        "Use both --features thin-shell and --config src-tauri/tauri.thin.conf.json"
    );
    if feature {
        assert!(
            overlay["build"]["beforeBuildCommand"].is_null(),
            "Thin Bodhi cannot run the bundled component staging hook"
        );
    }
    feature
}

fn pin_component_root(out_dir: &std::path::Path) -> bool {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let path = manifest.join("component-update-root.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => {
            assert!(
                bytes.len() <= 128 * 1024 && !bytes.is_empty(),
                "Invalid component update root size"
            );
            let root: serde_json::Value =
                serde_json::from_slice(&bytes).expect("invalid component trust root JSON");
            assert_eq!(
                root["signed"]["_type"], "root",
                "expected TUF root metadata"
            );
            assert_eq!(
                root["signed"]["consistent_snapshot"], true,
                "component updates require consistent snapshots"
            );
            bytes
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("Cannot read the published component update root: {error}"),
    };
    std::fs::write(out_dir.join("component-update-root.json"), &bytes)
        .expect("pin component update root");
    !bytes.is_empty()
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
