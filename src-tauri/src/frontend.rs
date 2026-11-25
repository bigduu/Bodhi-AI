//! Verified frontend resources, resolved from the profile or the application.
use crate::bamboo_profile::{is_link, Profile};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

#[path = "frontend_download.rs"]
mod download;
#[path = "frontend_release.rs"]
mod release;
pub(crate) use release::{prepare_release, reopen_release};

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
    artifact_manifest_sha256: Option<String>,
    artifact_resources_sha256: Option<String>,
    content_hash: String,
    files: BTreeMap<String, String>,
}

pub struct VerifiedFrontend {
    pub static_dir: Option<PathBuf>,
    pub index_hash: Option<String>,
    pub(crate) manifest_sha256: Option<String>,
}

pub fn uses_managed_frontend() -> bool {
    serde_json::from_slice::<Receipt>(COMPILED_RECEIPT)
        .map(|receipt| receipt.package_name == "@bigduu/lotus-next")
        .unwrap_or(false)
}

pub(crate) fn resolve<R: Runtime>(
    app: &AppHandle<R>,
    profile: &Profile,
) -> Result<VerifiedFrontend, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    resolve_profile(&resources, COMPILED_RECEIPT, profile)
        .map_err(|e| format!("Frontend resources are unavailable or damaged: {e}. Rebuild this app with npm run tauri:build."))
}

pub(crate) async fn prepare<R: Runtime>(
    app: &AppHandle<R>,
    profile: &Profile,
) -> Result<VerifiedFrontend, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    resolve_or_download(&resources, COMPILED_RECEIPT, profile).await
}

pub(crate) async fn resolve_or_download(
    resources: &Path,
    expected: &[u8],
    profile: &Profile,
) -> Result<VerifiedFrontend, String> {
    let original = match resolve_profile(resources, expected, profile) {
        Ok(frontend) => return Ok(frontend),
        Err(error) => error,
    };
    let receipt: Receipt = serde_json::from_slice(expected).map_err(|error| error.to_string())?;
    if !receipt.published() {
        return Err(original);
    }
    log::info!(
        "Restoring published Lotus Next {} from npm",
        receipt.version
    );
    download::acquire(profile, expected, &receipt)
        .await
        .map_err(|error| format!("Cannot restore Lotus Next {}: {error}", receipt.version))
}

impl Receipt {
    fn published(&self) -> bool {
        self.mode == "package" && self.package_name == "@bigduu/lotus-next"
    }
}

fn cache_slot(profile: &Profile, expected: &[u8]) -> PathBuf {
    profile
        .state_dir
        .join(format!("lotus-{}", hash_bytes(expected)))
}

pub(crate) fn resolve_profile(
    resources: &Path,
    expected: &[u8],
    profile: &Profile,
) -> Result<VerifiedFrontend, String> {
    let receipt: Receipt = serde_json::from_slice(expected).map_err(|error| error.to_string())?;
    let bundled = resources.join("frontend");
    if !receipt.published() {
        return verify_resource(&bundled, expected);
    }

    let slot = cache_slot(profile, expected);
    if let Ok(frontend) = verify_resource(&slot, expected) {
        return Ok(frontend);
    }

    let frontend = verify_resource(&bundled, expected)?;
    // Publish a complete immutable directory. An existing slot can be in use
    // by an owned child, so use the verified bundle if that slot is damaged.
    if matches!(fs::symlink_metadata(&slot), Err(error) if error.kind() == io::ErrorKind::NotFound)
    {
        if let Ok(_lock) = profile.update_lock() {
            match seed_cache(&slot, &frontend, expected, &receipt) {
                Ok(cached) => return Ok(cached),
                Err(error) => log::warn!("Cannot cache Lotus Next {}: {error}", receipt.version),
            }
        }
    }
    Ok(frontend)
}

fn seed_cache(
    slot: &Path,
    verified: &VerifiedFrontend,
    expected: &[u8],
    receipt: &Receipt,
) -> Result<VerifiedFrontend, String> {
    // Another instance may have seeded the cache before we acquired the lock.
    match fs::symlink_metadata(slot) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Ok(_) => return verify_resource(slot, expected),
        Err(error) => return Err(error.to_string()),
    }
    let source = verified
        .static_dir
        .as_ref()
        .ok_or("missing Lotus Next dist")?;
    let parent = slot.parent().ok_or("missing profile state directory")?;
    let staging = tempfile::tempdir_in(parent).map_err(|error| error.to_string())?;
    let pending = staging.path().join("frontend");
    for path in receipt.files.keys() {
        // Every path was matched against an inventory of regular files in
        // verify_resource. The copy is verified again before publication.
        let destination = pending.join("dist").join(path);
        let directory = destination
            .parent()
            .ok_or("missing Lotus Next path parent")?;
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        fs::copy(source.join(path), destination).map_err(|error| error.to_string())?;
    }
    fs::write(pending.join("receipt.json"), expected).map_err(|error| error.to_string())?;
    let mut cached = verify_resource(&pending, expected)?;
    fs::rename(pending, slot).map_err(|error| error.to_string())?;
    cached.static_dir = Some(owned_directory(&slot.join("dist"))?);
    Ok(cached)
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn safe_relative(file: &str) -> bool {
    !file.is_empty()
        && !file
            .chars()
            .any(|c| matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*') || c.is_control())
        && file.split('/').all(portable_component)
}

fn portable_component(part: &str) -> bool {
    if part.is_empty() || part.ends_with(['.', ' ']) {
        return false;
    }
    let stem = part
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return false;
    }
    !stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|number| {
            matches!(
                number,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
}

fn file_inventory(
    root: &Path,
    dir: &Path,
    files: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = entry.path();
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        if is_link(&metadata) {
            return Err(format!("frontend link {}", target.display()));
        }
        if metadata.is_dir() {
            file_inventory(root, &target, files)?;
        } else if metadata.is_file() {
            let name = target
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("non-UTF8 frontend path")?
                .replace(std::path::MAIN_SEPARATOR, "/");
            if !safe_relative(&name) {
                return Err(format!("unsafe frontend path {name}"));
            }
            let mut digest = Sha256::new();
            io::copy(
                &mut fs::File::open(target).map_err(|e| e.to_string())?,
                &mut digest,
            )
            .map_err(|e| e.to_string())?;
            files.insert(name, format!("{:x}", digest.finalize()));
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

pub(crate) fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_revision(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn owned_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(format!(
            "not an owned frontend directory: {}",
            path.display()
        ));
    }
    path.canonicalize().map_err(|e| e.to_string())
}

fn verify_resource(frontend_root: &Path, expected: &[u8]) -> Result<VerifiedFrontend, String> {
    let root = owned_directory(frontend_root)?;
    let receipt_path = root.join("receipt.json");
    let metadata = fs::symlink_metadata(&receipt_path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() != expected.len() as u64 {
        return Err("invalid frontend receipt file".into());
    }
    let bytes = std::fs::read(receipt_path).map_err(|e| e.to_string())?;
    if bytes != expected {
        return Err("frontend identity does not match this executable".into());
    }
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if receipt.schema_version != 2
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
        && receipt.artifact_manifest_sha256.is_none()
        && receipt.artifact_resources_sha256.is_none()
    {
        // The explicit rollback assembly retains the existing Bamboo embed.
        // This exception is pinned at compilation, never inferred from files.
        return Ok(VerifiedFrontend {
            static_dir: None,
            index_hash: None,
            manifest_sha256: None,
        });
    }
    let revision = receipt
        .source_revision
        .as_deref()
        .filter(|revision| valid_revision(revision))
        .ok_or("expected a Lotus Next source revision")?;
    if receipt.package_name != "@bigduu/lotus-next"
        || !matches!(receipt.mode.as_str(), "local" | "package")
    {
        return Err("expected an owned @bigduu/lotus-next artifact".into());
    }
    if receipt.mode == "package" {
        if receipt.source_dirty {
            return Err("published Lotus Next artifacts must come from clean source".into());
        }
        let manifest_hash = receipt
            .artifact_manifest_sha256
            .as_deref()
            .filter(|value| valid_sha256(value))
            .ok_or("missing Lotus Next universal manifest hash")?;
        if !receipt
            .artifact_resources_sha256
            .as_deref()
            .is_some_and(valid_sha256)
            || receipt
                .files
                .get("lotus-next-manifest.json")
                .is_none_or(|actual| actual != manifest_hash)
        {
            return Err("invalid Lotus Next universal artifact identity".into());
        }
    } else if receipt.artifact_manifest_sha256.is_some()
        || receipt.artifact_resources_sha256.is_some()
    {
        return Err("local source receipts cannot claim a published artifact lock".into());
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
        revision,
        receipt.source_dirty,
        receipt.content_hash,
        dist.display()
    );
    Ok(VerifiedFrontend {
        static_dir: Some(dist),
        index_hash: Some(index_hash),
        manifest_sha256: receipt.artifact_manifest_sha256,
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
        std::fs::write(frontend.join("dist/lotus-next-manifest.json"), "{}\n").unwrap();
        let mut files = BTreeMap::new();
        file_inventory(&frontend.join("dist"), &frontend.join("dist"), &mut files).unwrap();
        let receipt = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 2, "mode": "local", "packageName": "@bigduu/lotus-next", "version": "0.0.0",
            "sourceRevision": "d8a77943ce9ef7486d0d141ec8ad313ac74bb610", "sourceDirty": false,
            "artifactManifestSha256": null, "artifactResourcesSha256": null,
            "contentHash": content_hash(&files), "files": files
        })).unwrap();
        std::fs::write(frontend.join("receipt.json"), &receipt).unwrap();
        (temp, receipt)
    }

    pub(super) fn package_fixture() -> (tempfile::TempDir, Vec<u8>) {
        let (temp, receipt) = fixture();
        let mut value: serde_json::Value = serde_json::from_slice(&receipt).unwrap();
        value["mode"] = "package".into();
        value["version"] = "2026.9.22".into();
        value["artifactManifestSha256"] = hash_bytes(b"{}\n").into();
        value["artifactResourcesSha256"] = "a".repeat(64).into();
        let package = serde_json::to_vec(&value).unwrap();
        fs::write(temp.path().join("frontend/receipt.json"), &package).unwrap();
        (temp, package)
    }

    #[test]
    fn seeds_published_frontend_and_reuses_it_without_bundle_resources() {
        let (bundle, receipt) = package_fixture();
        let data = tempfile::tempdir().unwrap();
        let profile = Profile::open(data.path()).unwrap();
        let first = resolve_profile(bundle.path(), &receipt, &profile).unwrap();
        let first_dir = first.static_dir.unwrap();
        assert!(first_dir.starts_with(&profile.state_dir));
        assert_eq!(
            first.manifest_sha256.as_deref(),
            Some(hash_bytes(b"{}\n").as_str())
        );
        let bundle_path = bundle.path().to_owned();
        drop(bundle);
        let next = resolve_profile(&bundle_path, &receipt, &profile).unwrap();
        assert_eq!(next.static_dir.unwrap(), first_dir);
        assert_eq!(next.index_hash, first.index_hash);
    }

    #[test]
    fn damaged_or_unavailable_profile_cache_uses_only_the_verified_bundle() {
        let (bundle, receipt) = package_fixture();
        let data = tempfile::tempdir().unwrap();
        let profile = Profile::open(data.path()).unwrap();
        let bundled = bundle.path().join("frontend/dist").canonicalize().unwrap();
        let lock = profile.update_lock().unwrap();
        let fallback = resolve_profile(bundle.path(), &receipt, &profile).unwrap();
        assert_eq!(fallback.static_dir.unwrap(), bundled);
        drop(lock);

        let cached = resolve_profile(bundle.path(), &receipt, &profile)
            .unwrap()
            .static_dir
            .unwrap();
        fs::write(cached.join("assets/app.js"), b"altered").unwrap();
        let fallback = resolve_profile(bundle.path(), &receipt, &profile).unwrap();
        assert_eq!(fallback.static_dir.unwrap(), bundled);
        fs::write(bundled.join("assets/app.js"), b"altered").unwrap();
        assert!(resolve_profile(bundle.path(), &receipt, &profile).is_err());
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
        let verified = verify_resource(&moved.path().join("frontend"), &receipt).unwrap();
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
            assert!(verify_resource(&temp.path().join("frontend"), &receipt).is_err());
        }
    }

    #[test]
    fn missing_or_replaced_receipt_cannot_select_legacy_embed() {
        let (temp, receipt) = fixture();
        let file = temp.path().join("frontend/receipt.json");
        std::fs::write(&file, "{\"mode\":\"package\"}").unwrap();
        assert!(verify_resource(&temp.path().join("frontend"), &receipt).is_err());
        std::fs::remove_file(file).unwrap();
        assert!(verify_resource(&temp.path().join("frontend"), &receipt).is_err());
    }

    #[test]
    fn exact_published_package_resources_remain_valid_after_a_move() {
        let (original, package) = package_fixture();
        let moved = tempfile::tempdir().unwrap();
        std::fs::rename(
            original.path().join("frontend"),
            moved.path().join("frontend"),
        )
        .unwrap();
        assert_eq!(
            verify_resource(&moved.path().join("frontend"), &package)
                .unwrap()
                .static_dir
                .unwrap(),
            moved.path().join("frontend/dist").canonicalize().unwrap()
        );
    }

    #[test]
    fn published_package_rejects_a_false_universal_manifest_hash() {
        let (temp, receipt) = fixture();
        let mut value: serde_json::Value = serde_json::from_slice(&receipt).unwrap();
        value["mode"] = "package".into();
        value["version"] = "2026.9.22".into();
        value["artifactManifestSha256"] = "0".repeat(64).into();
        value["artifactResourcesSha256"] = "a".repeat(64).into();
        let package = serde_json::to_vec(&value).unwrap();
        std::fs::write(temp.path().join("frontend/receipt.json"), &package).unwrap();
        assert!(verify_resource(&temp.path().join("frontend"), &package).is_err());
    }

    #[test]
    fn explicit_legacy_rollback_assembly_remains_embedded() {
        let (temp, receipt) = fixture();
        let mut value: serde_json::Value = serde_json::from_slice(&receipt).unwrap();
        value["mode"] = "package".into();
        value["packageName"] = "@bigduu/lotus".into();
        value["sourceRevision"] = serde_json::Value::Null;
        let package = serde_json::to_vec(&value).unwrap();
        std::fs::write(temp.path().join("frontend/receipt.json"), &package).unwrap();
        std::fs::remove_dir_all(temp.path().join("frontend/dist")).unwrap();
        assert!(verify_resource(&temp.path().join("frontend"), &package)
            .unwrap()
            .static_dir
            .is_none());
        assert!(verify_resource(&temp.path().join("frontend"), &receipt).is_err());
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
        assert!(verify_resource(&temp.path().join("frontend"), &receipt).is_err());
    }
}
