//! Verified local frontend resources, owned by the installed application.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

const COMPILED_RECEIPT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/frontend-receipt.json"));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema_version: u32,
    mode: String,
    package_name: String,
    version: String,
    source_revision: Option<String>,
    source_dirty: bool,
    content_hash: String,
    files: BTreeMap<String, String>,
}

pub struct VerifiedFrontend {
    pub static_dir: Option<PathBuf>,
    pub index_hash: Option<String>,
}

pub fn is_local_build() -> bool {
    serde_json::from_slice::<Receipt>(COMPILED_RECEIPT)
        .map(|receipt| receipt.mode == "local")
        .unwrap_or(false)
}

pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<VerifiedFrontend, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    verify_resource(&resources, COMPILED_RECEIPT)
        .map_err(|e| format!("Frontend resources are unavailable or damaged: {e}. Rebuild this app with npm run tauri:build."))
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn safe_relative(file: &str) -> bool {
    !file.is_empty()
        && !file
            .chars()
            .any(|c| c == '\\' || c == ':' || c.is_ascii_control())
        && file
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn file_inventory(
    root: &Path,
    dir: &Path,
    files: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = entry.path();
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err(format!("frontend symlink {}", target.display()));
        }
        if kind.is_dir() {
            file_inventory(root, &target, files)?;
        } else if kind.is_file() {
            let name = target
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("non-UTF8 frontend path")?
                .replace(std::path::MAIN_SEPARATOR, "/");
            if !safe_relative(&name) {
                return Err(format!("unsafe frontend path {name}"));
            }
            files.insert(
                name,
                hash_bytes(&std::fs::read(target).map_err(|e| e.to_string())?),
            );
        } else {
            return Err("frontend resource is not a regular file".into());
        }
    }
    Ok(())
}

fn content_hash(files: &BTreeMap<String, String>) -> String {
    let mut digest = Sha256::new();
    for (name, hash) in files {
        digest.update(name.as_bytes());
        digest.update(b"\0");
        digest.update(hash.as_bytes());
        digest.update(b"\n");
    }
    format!("{:x}", digest.finalize())
}

fn owned_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !metadata.is_dir() || metadata.is_symlink() {
        return Err(format!(
            "not an owned frontend directory: {}",
            path.display()
        ));
    }
    path.canonicalize().map_err(|e| e.to_string())
}

fn verify_resource(resources: &Path, expected: &[u8]) -> Result<VerifiedFrontend, String> {
    let root = owned_directory(&resources.join("frontend"))?;
    let receipt_path = root.join("receipt.json");
    if std::fs::symlink_metadata(&receipt_path)
        .map_err(|e| e.to_string())?
        .is_symlink()
    {
        return Err("frontend receipt is a symlink".into());
    }
    let bytes = std::fs::read(receipt_path).map_err(|e| e.to_string())?;
    if bytes != expected {
        return Err("frontend identity does not match this executable".into());
    }
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if receipt.schema_version != 1
        || receipt.version.is_empty()
        || content_hash(&receipt.files) != receipt.content_hash
    {
        return Err("invalid frontend receipt".into());
    }
    let index_hash = receipt
        .files
        .get("index.html")
        .ok_or("missing production index")?
        .clone();
    if receipt.mode == "package"
        && receipt.package_name == "@bigduu/lotus"
        && receipt.source_revision.is_none()
        && !receipt.source_dirty
    {
        // Explicit release assembly retains the existing Bamboo embed. This
        // exception is pinned at compilation, never inferred from missing files.
        return Ok(VerifiedFrontend {
            static_dir: None,
            index_hash: None,
        });
    }
    if receipt.mode != "local"
        || receipt.package_name != "@bigduu/lotus-next"
        || !receipt
            .source_revision
            .as_deref()
            .is_some_and(|sha| sha.len() == 40 && sha.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("expected a local @bigduu/lotus-next artifact with a source revision".into());
    }
    let dist = owned_directory(&root.join("dist"))?;
    let mut files = BTreeMap::new();
    file_inventory(&dist, &dist, &mut files)?;
    if files != receipt.files {
        return Err("frontend files do not match the verified content hashes".into());
    }
    log::info!(
        "Verified frontend {} revision {} dirty={} content_sha256={} static_dir={}",
        receipt.package_name,
        receipt.source_revision.unwrap_or_default(),
        receipt.source_dirty,
        receipt.content_hash,
        dist.display()
    );
    Ok(VerifiedFrontend {
        static_dir: Some(dist),
        index_hash: Some(index_hash),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_root_filenames_match_the_javascript_canonical_hash() {
        let files = BTreeMap::from([
            ("2".to_string(), hash_bytes(b"two")),
            ("10".to_string(), hash_bytes(b"ten")),
        ]);
        assert_eq!(
            content_hash(&files),
            "7b0c2eb6e494ca5000c68d513c21b0ce1cb1fff55b5077d0036c7ff62e951b3b"
        );
    }

    fn fixture() -> (tempfile::TempDir, Vec<u8>) {
        let temp = tempfile::tempdir().unwrap();
        let frontend = temp.path().join("frontend");
        std::fs::create_dir_all(frontend.join("dist/assets")).unwrap();
        std::fs::write(
            frontend.join("dist/index.html"),
            "<script type=\"module\" src=\"./assets/app.js\"></script>",
        )
        .unwrap();
        std::fs::write(
            frontend.join("dist/assets/app.js"),
            "console.log('Lotus Next')",
        )
        .unwrap();
        let mut files = BTreeMap::new();
        file_inventory(&frontend.join("dist"), &frontend.join("dist"), &mut files).unwrap();
        let receipt = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "mode": "local", "packageName": "@bigduu/lotus-next", "version": "0.0.0",
            "sourceRevision": "d8a77943ce9ef7486d0d141ec8ad313ac74bb610", "sourceDirty": false,
            "contentHash": content_hash(&files), "files": files
        })).unwrap();
        std::fs::write(frontend.join("receipt.json"), &receipt).unwrap();
        (temp, receipt)
    }

    #[test]
    fn resolves_resources_after_bundle_is_moved() {
        let (original, receipt) = fixture();
        let moved = tempfile::tempdir().unwrap();
        std::fs::rename(
            original.path().join("frontend"),
            moved.path().join("frontend"),
        )
        .unwrap();
        let verified = verify_resource(moved.path(), &receipt).unwrap();
        assert_eq!(
            verified.static_dir.unwrap(),
            moved.path().join("frontend/dist").canonicalize().unwrap()
        );
    }

    #[test]
    fn rejects_missing_changed_and_extra_assets() {
        for change in ["missing", "changed", "extra"] {
            let (temp, receipt) = fixture();
            let asset = temp.path().join("frontend/dist/assets/app.js");
            match change {
                "missing" => std::fs::remove_file(asset).unwrap(),
                "changed" => std::fs::write(asset, "old Lotus").unwrap(),
                _ => std::fs::write(temp.path().join("frontend/dist/unexpected.js"), "extra")
                    .unwrap(),
            }
            assert!(verify_resource(temp.path(), &receipt).is_err());
        }
    }

    #[test]
    fn missing_or_replaced_receipt_cannot_select_legacy_embed() {
        let (temp, receipt) = fixture();
        let file = temp.path().join("frontend/receipt.json");
        std::fs::write(&file, "{\"mode\":\"package\"}").unwrap();
        assert!(verify_resource(temp.path(), &receipt).is_err());
        std::fs::remove_file(file).unwrap();
        assert!(verify_resource(temp.path(), &receipt).is_err());
    }

    #[test]
    fn explicit_compiled_package_assembly_remains_embedded() {
        let (temp, receipt) = fixture();
        let mut value: serde_json::Value = serde_json::from_slice(&receipt).unwrap();
        value["mode"] = "package".into();
        value["packageName"] = "@bigduu/lotus".into();
        value["sourceRevision"] = serde_json::Value::Null;
        let package = serde_json::to_vec(&value).unwrap();
        std::fs::write(temp.path().join("frontend/receipt.json"), &package).unwrap();
        std::fs::remove_dir_all(temp.path().join("frontend/dist")).unwrap();
        assert!(verify_resource(temp.path(), &package)
            .unwrap()
            .static_dir
            .is_none());
        assert!(verify_resource(temp.path(), &receipt).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_resources() {
        let (temp, receipt) = fixture();
        std::fs::rename(
            temp.path().join("frontend/dist"),
            temp.path().join("outside"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            temp.path().join("outside"),
            temp.path().join("frontend/dist"),
        )
        .unwrap();
        assert!(verify_resource(temp.path(), &receipt).is_err());
    }
}
