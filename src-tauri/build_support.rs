//! Replace only Tauri's generated frontend copy before its overlay-style copy.
//! Shared with shell unit tests; this helper uses no build/runtime dependencies.
use std::io;
use std::path::{Component, Path, PathBuf};

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub fn reset_frontend_destination(out_dir: &Path) -> io::Result<PathBuf> {
    // tauri-build 2.5.6 derives its copy destination with exactly three parents:
    // <profile>/build/bodhi-<cargo-hash>/out -> <profile>. Check those directories
    // before doing any removal; never accept a caller-supplied cleanup target.
    if !out_dir.is_absolute()
        || out_dir
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid(
            "OUT_DIR must be an absolute Cargo build output path",
        ));
    }
    let ancestors = out_dir.ancestors().take(4).collect::<Vec<_>>();
    if ancestors.len() != 4
        || out_dir.file_name() != Some("out".as_ref())
        || ancestors[2].file_name() != Some("build".as_ref())
    {
        return Err(invalid(
            "OUT_DIR must end with <profile>/build/bodhi-<hash>/out",
        ));
    }
    let package = ancestors[1]
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid("invalid Cargo package output directory"))?;
    if !package
        .strip_prefix("bodhi-")
        .is_some_and(|hash| hash.len() >= 8 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(invalid(
            "OUT_DIR does not belong to Bodhi's Cargo build script",
        ));
    }
    let profile = ancestors[3];
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
    for directory in ancestors {
        let metadata = std::fs::symlink_metadata(directory)?;
        if !metadata.is_dir() || metadata.is_symlink() {
            return Err(invalid(
                "Cargo output/profile ancestry must contain real directories, not symlinks",
            ));
        }
    }
    let canonical_profile = profile.canonicalize()?;
    if out_dir.canonicalize()? != canonical_profile.join("build").join(package).join("out") {
        return Err(invalid(
            "Cargo output ancestry changed while resolving resources",
        ));
    }
    let destination = canonical_profile.join("frontend");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("target/debug");
        let out = profile.join("build/bodhi-0123456789abcdef/out");
        std::fs::create_dir_all(&out).unwrap();
        (temp, out, profile)
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
}
