//! Browser executables and dependencies owned by the desktop application.
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

const COMPILED_RECEIPT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/browser-receipt.json"));

fn platform() -> Result<(&'static str, &'static str), String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok(("aarch64-apple-darwin", "mac-arm64")),
        ("macos", "x86_64") => Ok(("x86_64-apple-darwin", "mac-x64")),
        ("linux", "aarch64") => Ok(("aarch64-unknown-linux-gnu", "linux-arm64")),
        ("linux", "x86_64") => Ok(("x86_64-unknown-linux-gnu", "linux64")),
        ("windows", "aarch64") => Ok(("aarch64-pc-windows-msvc", "win64")),
        ("windows", "x86_64") => Ok(("x86_64-pc-windows-msvc", "win64")),
        _ => Err("unsupported desktop browser target".into()),
    }
}

fn inventory(root: &Path, dir: &Path, files: &mut BTreeMap<String, String>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err("browser runtime contains a symlink".into());
        }
        if kind.is_dir() {
            inventory(root, &path, files)?;
        } else if kind.is_file() {
            if path == root.join("receipt.json") {
                continue;
            }
            let name = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("non-UTF8 browser resource path")?
                .replace(std::path::MAIN_SEPARATOR, "/");
            let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            let mut digest = Sha256::new();
            let mut buffer = [0u8; 65536];
            loop {
                let length = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if length == 0 {
                    break;
                }
                digest.update(&buffer[..length]);
            }
            files.insert(name, format!("{:x}", digest.finalize()));
        } else {
            return Err("browser resource is not a regular file".into());
        }
    }
    Ok(())
}

fn verify(
    root: &Path,
    expected: &[u8],
    target: &str,
    browser_platform: &str,
) -> Result<[PathBuf; 3], String> {
    let metadata = std::fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.is_symlink() {
        return Err("browser runtime is not an owned directory".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let receipt = std::fs::read(root.join("receipt.json")).map_err(|e| e.to_string())?;
    if receipt != expected {
        return Err("browser runtime identity does not match this executable".into());
    }
    let receipt: serde_json::Value = serde_json::from_slice(&receipt).map_err(|e| e.to_string())?;
    if receipt["schemaVersion"] != 1 || receipt["target"] != target {
        return Err("browser runtime target does not match this executable".into());
    }
    let mut files = BTreeMap::new();
    inventory(&root, &root, &mut files)?;
    let mut digest = Sha256::new();
    for (name, hash) in files {
        digest.update(format!("{name}\0{hash}\n").as_bytes());
    }
    if receipt["filesSha256"] != format!("{:x}", digest.finalize()) {
        return Err("browser runtime files do not match their receipt".into());
    }
    let windows = target.contains("windows");
    let paths = [
        root.join(if windows {
            "node/node.exe"
        } else {
            "node/node"
        }),
        root.join("host.cjs"),
        root.join(format!(
            "chromium/chrome-headless-shell-{browser_platform}/{}",
            if windows {
                "chrome-headless-shell.exe"
            } else {
                "chrome-headless-shell"
            }
        )),
    ];
    for (index, path) in paths.iter().enumerate() {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if !metadata.is_file() || metadata.is_symlink() {
            return Err("browser path is not a regular file".into());
        }
        #[cfg(unix)]
        if index != 1 {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err("browser file is not executable".into());
            }
        }
        #[cfg(not(unix))]
        let _ = index;
    }
    Ok(paths)
}

pub fn resolve(resources: &Path) -> Result<[PathBuf; 3], String> {
    let (target, browser_platform) = platform()?;
    verify(&resources.join("browser-runtime"), COMPILED_RECEIPT, target, browser_platform)
        .map_err(|e| format!("Browser runtime is unavailable or damaged: {e}. Rebuild with npm run tauri:dev or npm run tauri:build."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> Vec<u8> {
        for name in [
            "node/node",
            "host.cjs",
            "chromium/chrome-headless-shell-mac-arm64/chrome-headless-shell",
        ] {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "browser fixture").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let mut files = BTreeMap::new();
        inventory(root, root, &mut files).unwrap();
        let mut digest = Sha256::new();
        for (name, hash) in files {
            digest.update(format!("{name}\0{hash}\n").as_bytes());
        }
        let receipt = serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"target":"aarch64-apple-darwin","filesSha256":format!("{:x}",digest.finalize())})).unwrap();
        std::fs::write(root.join("receipt.json"), &receipt).unwrap();
        receipt
    }

    #[test]
    fn bundled_paths_remain_available_without_the_source_checkout() {
        let temp = tempfile::tempdir().unwrap();
        let receipt = fixture(temp.path());
        let paths = verify(temp.path(), &receipt, "aarch64-apple-darwin", "mac-arm64").unwrap();
        let root = temp.path().canonicalize().unwrap();
        assert!(paths
            .iter()
            .all(|p| p.is_absolute() && p.starts_with(&root)));
        assert!(
            verify(temp.path(), &receipt, "x86_64-apple-darwin", "mac-x64")
                .unwrap_err()
                .contains("target")
        );
        std::fs::write(temp.path().join("host.cjs"), "changed host").unwrap();
        assert!(
            verify(temp.path(), &receipt, "aarch64-apple-darwin", "mac-arm64")
                .unwrap_err()
                .contains("files")
        );
    }
}
