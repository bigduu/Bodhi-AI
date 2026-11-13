//! Keep Tauri's generated resources beside the final Cargo executable.
//! Shared with shell unit tests; this helper uses no build/runtime dependencies.
use std::io;
use std::path::{Component, Path, PathBuf};

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

struct CargoOutput {
    profile: PathBuf,
    tauri_staging: PathBuf,
}

fn cargo_output(out_dir: &Path) -> io::Result<CargoOutput> {
    // Validate Cargo's package-specific suffix before using any path for cleanup.
    if !out_dir.is_absolute()
        || out_dir
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid(
            "OUT_DIR must be an absolute Cargo build output path",
        ));
    }
    let parents = out_dir.ancestors().skip(1).take(4).collect::<Vec<_>>();
    let invalid_layout = || {
        invalid("OUT_DIR must end with <profile>/build/bodhi-<hash>/out or <profile>/build/bodhi/<hash>/out")
    };
    if out_dir.file_name() != Some("out".as_ref()) {
        return Err(invalid_layout());
    }
    let is_hash = |hash: &str| hash.len() >= 8 && hash.bytes().all(|byte| byte.is_ascii_hexdigit());
    let [unit, parent, staging, ..] = parents.as_slice() else {
        return Err(invalid_layout());
    };
    let unit_name = unit
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(invalid_layout)?;
    let profile = match parent.file_name().and_then(|name| name.to_str()) {
        Some("build") if unit_name.strip_prefix("bodhi-").is_some_and(is_hash) => staging,
        Some("bodhi") if staging.file_name() == Some("build".as_ref()) && is_hash(unit_name) => {
            parents.get(3).ok_or_else(invalid_layout)?
        }
        _ => return Err(invalid_layout()),
    };
    if !profile
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
    {
        return Err(invalid("invalid Cargo profile directory"));
    }
    for directory in out_dir.ancestors() {
        let metadata = std::fs::symlink_metadata(directory)?;
        if !metadata.is_dir() || metadata.is_symlink() {
            return Err(invalid(
                "Cargo output/profile ancestry must contain real directories, not symlinks",
            ));
        }
        if directory == *profile {
            break;
        }
    }
    let canonical_profile = profile.canonicalize()?;
    let canonical_child = |directory: &Path| {
        directory
            .strip_prefix(profile)
            .map(|relative| canonical_profile.join(relative))
            .map_err(|_| invalid("Cargo output ancestry changed while resolving resources"))
    };
    if out_dir.canonicalize()? != canonical_child(out_dir)? {
        return Err(invalid(
            "Cargo output ancestry changed while resolving resources",
        ));
    }
    // tauri-build 2.5.6 copies three parents above OUT_DIR, which is the
    // profile on the old layout and its build directory on Cargo 1.100.
    let tauri_staging = canonical_child(staging)?;
    Ok(CargoOutput {
        profile: canonical_profile,
        tauri_staging,
    })
}

pub fn reset_frontend_destination(out_dir: &Path) -> io::Result<PathBuf> {
    reset_resource_destination(out_dir, "frontend")
}

pub fn reset_browser_destination(out_dir: &Path) -> io::Result<PathBuf> {
    reset_resource_destination(out_dir, "browser-runtime")
}

fn reset_resource_destination(out_dir: &Path, name: &str) -> io::Result<PathBuf> {
    let destination = cargo_output(out_dir)?.tauri_staging.join(name);
    match std::fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.is_symlink() => {
            // Unlink only the generated destination itself. A link's target may
            // contain user data and must never be traversed or removed.
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x10 != 0 {
                    std::fs::remove_dir(&destination)?;
                } else {
                    std::fs::remove_file(&destination)?;
                }
            }
            #[cfg(not(windows))]
            std::fs::remove_file(&destination)?;
        }
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(&destination)?,
        Ok(metadata) if metadata.is_file() => std::fs::remove_file(&destination)?,
        Ok(_) => return Err(invalid("generated frontend destination is a special file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    std::fs::create_dir(&destination)?;
    Ok(destination)
}

/// Sync from Tauri's copy directory to Cargo's final target/profile directory.
pub fn sync_runtime_resources(out_dir: &Path, target_dir: &Path, triple: &str) -> io::Result<()> {
    let CargoOutput {
        profile,
        tauri_staging: source,
    } = cargo_output(out_dir)?;
    if !target_dir.is_absolute()
        || target_dir
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid(
            "target directory must be absolute without traversal",
        ));
    }
    let profile_name = profile
        .file_name()
        .ok_or_else(|| invalid("missing Cargo profile name"))?;
    let mut destination = target_dir.to_path_buf();
    // Explicit --target builds (including the host triple) nest both layouts.
    if profile.parent().and_then(Path::file_name) == Some(triple.as_ref()) {
        destination.push(triple);
    }
    destination.push(profile_name);
    std::fs::create_dir_all(&destination)?;
    let destination = destination.canonicalize()?;
    if source.canonicalize()? == destination {
        return Ok(());
    }
    for name in ["frontend", "browser-runtime"] {
        let frontend = destination.join(name);
        // Reuse the constrained cleanup path for the intermediate copy; here only
        // the generated final frontend tree is replaced, never the whole profile.
        match std::fs::symlink_metadata(&frontend) {
            Ok(metadata) if metadata.is_symlink() => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x10 != 0 {
                        std::fs::remove_dir(&frontend)?;
                    } else {
                        std::fs::remove_file(&frontend)?;
                    }
                }
                #[cfg(not(windows))]
                std::fs::remove_file(&frontend)?;
            }
            Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(&frontend)?,
            Ok(_) => std::fs::remove_file(&frontend)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        if source.join(name).is_dir() {
            copy_resource_tree(&source.join(name), &frontend)?;
        }
    }
    let sidecar = if triple.contains("windows") {
        "bamboo.exe"
    } else {
        "bamboo"
    };
    let sidecar_destination = destination.join(sidecar);
    match std::fs::symlink_metadata(&sidecar_destination) {
        Ok(metadata) if metadata.is_file() || metadata.is_symlink() => {
            std::fs::remove_file(&sidecar_destination)?
        }
        Ok(_) => return Err(invalid("sidecar destination must be a file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    std::fs::copy(source.join(sidecar), sidecar_destination)?;
    Ok(())
}

fn copy_resource_tree(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_resource_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), target)?;
        } else {
            return Err(invalid(
                "generated resources must be regular files or directories",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD_OUT: &str = "build/bodhi-0123456789abcdef/out";
    const NEW_OUT: &str = "build/bodhi/0123456789abcdef/out";

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("target/debug");
        let out = profile.join(OLD_OUT);
        std::fs::create_dir_all(&out).unwrap();
        (temp, out, profile)
    }

    #[test]
    fn split_build_directory_updates_final_frontend_and_sidecar() {
        let (temp, out, profile) = fixture();
        let generated = reset_frontend_destination(&out).unwrap();
        let browser = reset_browser_destination(&out).unwrap();
        std::fs::write(browser.join("receipt.json"), "browser receipt").unwrap();
        std::fs::write(browser.join("host.cjs"), "new host").unwrap();
        std::fs::write(generated.join("receipt.json"), "new receipt").unwrap();
        std::fs::create_dir(generated.join("dist")).unwrap();
        std::fs::write(generated.join("dist/new.js"), "new asset").unwrap();
        std::fs::write(profile.join("bamboo"), "new sidecar").unwrap();
        let target = temp.path().join("final");
        std::fs::create_dir_all(target.join("debug/frontend/dist")).unwrap();
        std::fs::write(target.join("debug/frontend/dist/old.js"), "old").unwrap();
        std::fs::create_dir_all(target.join("debug/browser-runtime")).unwrap();
        std::fs::write(target.join("debug/browser-runtime/old.js"), "old").unwrap();
        std::fs::write(target.join("debug/keep.txt"), "keep").unwrap();
        sync_runtime_resources(&out, &target, "aarch64-apple-darwin").unwrap();
        assert_eq!(
            std::fs::read(target.join("debug/frontend/receipt.json")).unwrap(),
            b"new receipt"
        );
        assert_eq!(
            std::fs::read(target.join("debug/bamboo")).unwrap(),
            b"new sidecar"
        );
        assert!(!target.join("debug/frontend/dist/old.js").exists());
        assert_eq!(
            std::fs::read(target.join("debug/browser-runtime/host.cjs")).unwrap(),
            b"new host"
        );
        assert!(!target.join("debug/browser-runtime/old.js").exists());
        assert!(target.join("debug/keep.txt").exists());
        assert!(profile.join("frontend/dist/new.js").exists());
    }

    #[test]
    fn unified_build_directory_keeps_generated_resources() {
        let (_temp, out, profile) = fixture();
        let generated = reset_frontend_destination(&out).unwrap();
        std::fs::write(generated.join("receipt.json"), "receipt").unwrap();
        sync_runtime_resources(&out, profile.parent().unwrap(), "aarch64-apple-darwin").unwrap();
        assert_eq!(
            std::fs::read(generated.join("receipt.json")).unwrap(),
            b"receipt"
        );
    }

    #[test]
    fn split_cross_target_resources_use_target_triple_and_release_profile() {
        let temp = tempfile::tempdir().unwrap();
        let triple = "x86_64-pc-windows-msvc";
        let out = temp
            .path()
            .join("cache")
            .join(triple)
            .join("release")
            .join(OLD_OUT);
        std::fs::create_dir_all(&out).unwrap();
        let generated = reset_frontend_destination(&out).unwrap();
        std::fs::write(generated.join("receipt.json"), "receipt").unwrap();
        let profile = out.ancestors().nth(3).unwrap();
        std::fs::write(profile.join("bamboo.exe"), "sidecar").unwrap();
        let target = temp.path().join("final");
        sync_runtime_resources(&out, &target, triple).unwrap();
        assert!(target
            .join(triple)
            .join("release/frontend/receipt.json")
            .exists());
        assert!(target.join(triple).join("release/bamboo.exe").exists());
        assert!(!target.join("release").exists());
    }

    #[test]
    fn cargo_1_100_syncs_tauri_staging_to_the_actual_profile() {
        let triple = "x86_64-pc-windows-msvc";
        for (split, explicit_target) in [(false, false), (false, true), (true, false), (true, true)]
        {
            let temp = tempfile::tempdir().unwrap();
            let target = temp.path().join("target");
            let build = if split {
                temp.path().join("cache")
            } else {
                target.clone()
            };
            let profile = if explicit_target {
                PathBuf::from(triple).join("release")
            } else {
                PathBuf::from("debug")
            };
            let staging = build.join(&profile).join("build");
            let out = build.join(&profile).join(NEW_OUT);
            std::fs::create_dir_all(&out).unwrap();

            let final_profile = target.join(&profile);
            let frontend = final_profile.join("frontend");
            let browser = final_profile.join("browser-runtime");
            for directory in [&frontend, &browser] {
                std::fs::create_dir_all(directory).unwrap();
                std::fs::write(directory.join("old.js"), "stale").unwrap();
            }
            std::fs::write(final_profile.join("keep.txt"), "preserve").unwrap();
            std::fs::create_dir(staging.join("frontend")).unwrap();
            std::fs::write(staging.join("frontend/old.js"), "stale").unwrap();

            let staged_frontend = reset_frontend_destination(&out).unwrap();
            let staged_browser = reset_browser_destination(&out).unwrap();
            assert_eq!(
                staged_frontend,
                staging.canonicalize().unwrap().join("frontend")
            );
            assert!(!staged_frontend.join("old.js").exists());
            assert!(frontend.join("old.js").exists());
            std::fs::write(staged_frontend.join("receipt.json"), "frontend receipt").unwrap();
            std::fs::write(staged_browser.join("host.cjs"), "browser host").unwrap();
            std::fs::write(staging.join("bamboo.exe"), "sidecar").unwrap();

            sync_runtime_resources(&out, &target, triple).unwrap();
            assert_eq!(
                std::fs::read(frontend.join("receipt.json")).unwrap(),
                b"frontend receipt"
            );
            assert_eq!(
                std::fs::read(browser.join("host.cjs")).unwrap(),
                b"browser host"
            );
            assert_eq!(
                std::fs::read(final_profile.join("bamboo.exe")).unwrap(),
                b"sidecar"
            );
            assert_eq!(
                std::fs::read(final_profile.join("keep.txt")).unwrap(),
                b"preserve"
            );
            assert!(!frontend.join("old.js").exists());
            assert!(!browser.join("old.js").exists());
            assert!(!target.join("release").exists());
        }
    }

    #[test]
    fn repeated_copy_replaces_old_hashed_assets_without_touching_siblings() {
        let (_temp, out, profile) = fixture();
        std::fs::write(profile.join("other-resource.txt"), "preserve").unwrap();
        let first = reset_frontend_destination(&out).unwrap();
        std::fs::create_dir_all(first.join("dist/assets")).unwrap();
        std::fs::write(first.join("dist/assets/app-old.js"), "old").unwrap();
        std::fs::write(first.join("receipt.json"), "old receipt").unwrap();
        let second = reset_frontend_destination(&out).unwrap();
        std::fs::create_dir_all(second.join("dist/assets")).unwrap();
        std::fs::write(second.join("dist/assets/app-new.js"), "new").unwrap();
        std::fs::write(second.join("receipt.json"), "new receipt").unwrap();
        assert!(!second.join("dist/assets/app-old.js").exists());
        assert_eq!(
            std::fs::read_to_string(second.join("dist/assets/app-new.js")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(profile.join("other-resource.txt")).unwrap(),
            "preserve"
        );
    }

    #[test]
    fn a_regular_file_at_the_generated_destination_is_replaced() {
        let (_temp, out, profile) = fixture();
        std::fs::write(profile.join("frontend"), "old generated file").unwrap();
        assert!(reset_frontend_destination(&out).unwrap().is_dir());
    }

    #[test]
    fn malformed_or_relative_output_paths_are_rejected_before_cleanup() {
        let (_temp, out, profile) = fixture();
        std::fs::write(profile.join("frontend"), "preserve").unwrap();
        for candidate in [
            profile.clone(),
            out.with_file_name("other"),
            profile.join("build/another-crate/out"),
            PathBuf::from("target/debug/build/bodhi-0123456789abcdef/out"),
        ] {
            assert!(reset_frontend_destination(&candidate).is_err());
            assert_eq!(
                std::fs::read_to_string(profile.join("frontend")).unwrap(),
                "preserve"
            );
        }
    }

    #[test]
    fn cargo_1_100_rejects_other_packages_and_invalid_hashes() {
        let temp = tempfile::tempdir().unwrap();
        let build = temp.path().join("target/debug/build");
        std::fs::create_dir_all(&build).unwrap();
        let sentinel = build.join("frontend");
        std::fs::write(&sentinel, "preserve").unwrap();
        for suffix in [
            "other/0123456789abcdef/out",
            "bodhi/1234/out",
            "bodhi/0123456789abcdeg/out",
            "bodhi/0123456789abcdef/not-out",
        ] {
            let out = build.join(suffix);
            std::fs::create_dir_all(&out).unwrap();
            assert!(reset_frontend_destination(&out).is_err());
            assert_eq!(std::fs::read(&sentinel).unwrap(), b"preserve");
        }
    }

    #[cfg(unix)]
    #[test]
    fn destination_and_nested_symlinks_never_remove_their_targets() {
        let (temp, out, profile) = fixture();
        let outside = temp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), "preserve").unwrap();
        std::os::unix::fs::symlink(&outside, profile.join("frontend")).unwrap();
        let generated = reset_frontend_destination(&out).unwrap();
        assert!(!std::fs::symlink_metadata(&generated).unwrap().is_symlink());
        std::os::unix::fs::symlink(&outside, generated.join("nested")).unwrap();
        reset_frontend_destination(&out).unwrap();
        assert_eq!(
            std::fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "preserve"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_build_ancestry_is_rejected_before_cleanup() {
        let (temp, out, profile) = fixture();
        let borrowed = temp.path().join("borrowed-build");
        std::fs::rename(profile.join("build"), &borrowed).unwrap();
        std::os::unix::fs::symlink(&borrowed, profile.join("build")).unwrap();
        std::fs::write(profile.join("frontend"), "preserve").unwrap();
        assert!(reset_frontend_destination(&out).is_err());
        assert_eq!(
            std::fs::read_to_string(profile.join("frontend")).unwrap(),
            "preserve"
        );
        assert!(borrowed.join("bodhi-0123456789abcdef/out").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn cargo_1_100_rejects_a_symlinked_package_before_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let build = temp.path().join("target/debug/build");
        let borrowed = temp.path().join("borrowed-package");
        std::fs::create_dir_all(borrowed.join("0123456789abcdef/out")).unwrap();
        std::fs::create_dir_all(&build).unwrap();
        std::os::unix::fs::symlink(&borrowed, build.join("bodhi")).unwrap();
        let sentinel = build.join("browser-runtime");
        std::fs::write(&sentinel, "preserve").unwrap();
        assert!(reset_browser_destination(&build.join("bodhi/0123456789abcdef/out")).is_err());
        assert_eq!(std::fs::read(sentinel).unwrap(), b"preserve");
    }
}
