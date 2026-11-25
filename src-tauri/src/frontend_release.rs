//! Verify and stage a Lotus Next frontend using its published release identity.
use super::{
    download, file_inventory, hash_bytes, owned_directory, safe_relative, valid_sha256,
    VerifiedFrontend,
};
use crate::bamboo_profile::{is_link, publish_directory, Profile};
use crate::component_channel::{Asset, LotusRelease};
use crate::component_download::{acquire_asset, DownloadSettings, DownloadSource};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tokio::sync::watch;

const MANIFEST: &str = "lotus-next-manifest.json";
const MAX_MANIFEST: u64 = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    package_name: String,
    package_version: String,
    source_revision: String,
    source_dirty: bool,
    entrypoint: String,
    resources_sha256: String,
    resources: Vec<Resource>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    path: String,
    size: u64,
    sha256: String,
}

fn release_slot(profile: &Profile, release: &LotusRelease) -> Result<PathBuf, String> {
    if !valid_sha256(&release.tarball.sha256)
        || !(1..=download::MAX_DOWNLOAD as u64).contains(&release.tarball.size_bytes)
    {
        return Err("Invalid Lotus Next tarball identity".into());
    }
    Ok(profile
        .state_dir
        .join(format!("lotus-npm-{}", release.tarball.sha256)))
}

pub(crate) fn reopen_release(
    profile: &Profile,
    release: &LotusRelease,
) -> Result<VerifiedFrontend, String> {
    verify_release(&release_slot(profile, release)?, release)
}

/// Reuse a verified local frontend or acquire the approved release from npm.
/// The caller supplies an independently verified release identity.
pub(crate) async fn prepare_release(
    profile_data: &Path,
    release: &LotusRelease,
    settings: watch::Receiver<DownloadSettings>,
    progress: impl FnMut(Option<DownloadSource>, u64, u64) + Send,
) -> Result<VerifiedFrontend, String> {
    let profile = Profile::open(profile_data).map_err(|error| error.to_string())?;
    let slot = release_slot(&profile, release)?;
    if let Ok(frontend) = verify_release(&slot, release) {
        return Ok(frontend);
    }
    let official = download::archive_url(&release.version)?;
    let download = acquire_asset(&profile, &official, &release.tarball, settings, progress).await?;
    let release = release.clone();
    tokio::task::spawn_blocking(move || {
        let mut download = download;
        let scratch =
            tempfile::tempdir_in(&profile.state_dir).map_err(|error| error.to_string())?;
        let staged = scratch.path().join("frontend");
        download::extract_dist(download.file.as_file_mut(), &staged.join("dist"), None)
            .map_err(|error| error.to_string())?;
        publish_directory(&profile, &staged, &slot, |root| {
            verify_release(root, &release)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn verify_release(root: &Path, release: &LotusRelease) -> Result<VerifiedFrontend, String> {
    let dist = owned_directory(&owned_directory(root)?.join("dist"))?;
    let bytes = manifest_bytes(&dist)?;
    let manifest = parse_manifest(&bytes, release)?;
    verify_inventory(dist, manifest, release)
}

/// Inspect an npm-integrity-verified archive in the caller's private scratch directory.
pub(crate) fn inspect_release_archive(
    version: &str,
    archive: &[u8],
    scratch: &Path,
) -> Result<LotusRelease, String> {
    if archive.is_empty() || archive.len() > download::MAX_DOWNLOAD {
        return Err("Invalid Lotus Next archive size".into());
    }
    let dist = scratch.join("dist");
    download::extract_dist(archive, &dist, None).map_err(|error| error.to_string())?;
    let bytes = manifest_bytes(&dist)?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if manifest.source_revision.len() != 40
        || !manifest
            .source_revision
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("Invalid Lotus Next source revision".into());
    }
    let release = LotusRelease {
        version: version.to_string(),
        source_revision: manifest.source_revision.clone(),
        manifest_sha256: hash_bytes(&bytes),
        resources_sha256: manifest.resources_sha256.clone(),
        tarball: Asset {
            sha256: hash_bytes(archive),
            size_bytes: archive.len() as u64,
        },
    };
    check_manifest(&manifest, &release)?;
    verify_inventory(dist, manifest, &release)?;
    Ok(release)
}

/// Read one optional resource bound to the exact authenticated release manifest.
pub(crate) fn read_release_resource(
    dist: &Path,
    release: &LotusRelease,
    resource_path: &str,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, String> {
    let dist = owned_directory(dist)?;
    let bytes = manifest_bytes(&dist)?;
    let manifest = parse_manifest(&bytes, release)?;
    let Some(resource) = manifest
        .resources
        .iter()
        .find(|item| item.path == resource_path)
    else {
        return Ok(None);
    };
    if !safe_relative(&resource.path)
        || resource.size > max_bytes
        || !valid_sha256(&resource.sha256)
    {
        return Err("Invalid Lotus Next resource identity".into());
    }
    let bytes = regular_file_bytes(&dist.join(&resource.path), max_bytes)?;
    if bytes.len() as u64 != resource.size || hash_bytes(&bytes) != resource.sha256 {
        return Err("A Lotus Next resource differs from its manifest".into());
    }
    Ok(Some(bytes))
}

fn manifest_bytes(dist: &Path) -> Result<Vec<u8>, String> {
    regular_file_bytes(&dist.join(MANIFEST), MAX_MANIFEST)
}

fn regular_file_bytes(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > max_bytes {
        return Err("Invalid Lotus Next artifact file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("Lotus Next artifact file exceeds its size limit".into());
    }
    Ok(bytes)
}

fn parse_manifest(bytes: &[u8], release: &LotusRelease) -> Result<Manifest, String> {
    if hash_bytes(bytes) != release.manifest_sha256 {
        return Err("The Lotus Next manifest differs from the verified release".into());
    }
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    check_manifest(&manifest, release)?;
    Ok(manifest)
}

fn check_manifest(manifest: &Manifest, release: &LotusRelease) -> Result<(), String> {
    if manifest.schema_version != 1
        || manifest.package_name != "@bigduu/lotus-next"
        || manifest.package_version != release.version
        || manifest.source_revision != release.source_revision
        || manifest.source_dirty
        || manifest.entrypoint != "index.html"
        || manifest.resources_sha256 != release.resources_sha256
    {
        return Err("Invalid Lotus Next release manifest".into());
    }
    Ok(())
}

fn verify_inventory(
    dist: PathBuf,
    manifest: Manifest,
    release: &LotusRelease,
) -> Result<VerifiedFrontend, String> {
    let mut expected = BTreeMap::from([(MANIFEST.to_string(), release.manifest_sha256.clone())]);
    let mut inventory_hash = Sha256::new();
    for resource in manifest.resources {
        if !safe_relative(&resource.path) || !valid_sha256(&resource.sha256) {
            return Err("Invalid Lotus Next resource identity".into());
        }
        inventory_hash.update(format!(
            "{}\0{}\0{}\n",
            resource.path, resource.size, resource.sha256
        ));
        let metadata =
            fs::symlink_metadata(dist.join(&resource.path)).map_err(|error| error.to_string())?;
        if !metadata.is_file()
            || is_link(&metadata)
            || metadata.len() != resource.size
            || expected.insert(resource.path, resource.sha256).is_some()
        {
            return Err("A Lotus Next resource differs from its manifest".into());
        }
    }
    if format!("{:x}", inventory_hash.finalize()) != release.resources_sha256 {
        return Err("The Lotus Next resource manifest failed its digest check".into());
    }
    let index_hash = expected
        .get("index.html")
        .ok_or("Missing Lotus Next entrypoint")?
        .clone();
    let mut actual = BTreeMap::new();
    file_inventory(&dist, &dist, &mut actual)?;
    if actual != expected {
        return Err("The Lotus Next resources differ from the verified release".into());
    }
    Ok(VerifiedFrontend {
        static_dir: Some(dist),
        index_hash: Some(index_hash),
        manifest_sha256: Some(release.manifest_sha256.clone()),
    })
}
