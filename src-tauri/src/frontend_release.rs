//! Resolve Lotus from a release identity authenticated by the component channel.
use super::{
    download, file_inventory, hash_bytes, owned_directory, safe_relative, valid_sha256,
    VerifiedFrontend,
};
use crate::bamboo_profile::{is_link, Profile};
use crate::component_channel::LotusRelease;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;

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

/// Reuse a verified local frontend or acquire the approved release from npm.
/// The caller supplies a release identity from the authenticated channel.
pub async fn prepare_release(
    profile_data: &Path,
    release: &LotusRelease,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<VerifiedFrontend, String> {
    if !valid_sha256(&release.tarball.sha256) {
        return Err("Invalid Lotus Next tarball identity".into());
    }
    let profile = Profile::open(profile_data).map_err(|error| error.to_string())?;
    let slot = profile
        .state_dir
        .join(format!("lotus-npm-{}", release.tarball.sha256));
    if let Ok(frontend) = verify_release(&slot, release) {
        return Ok(frontend);
    }
    let bytes = download::fetch(&release.version, Some(&release.tarball), progress).await?;
    let release = release.clone();
    tokio::task::spawn_blocking(move || {
        if bytes.len() as u64 != release.tarball.size_bytes
            || hash_bytes(&bytes) != release.tarball.sha256
        {
            return Err("The Lotus Next tarball differs from the signed component release".into());
        }
        let scratch =
            tempfile::tempdir_in(&profile.state_dir).map_err(|error| error.to_string())?;
        let staged = scratch.path().join("frontend");
        download::extract_dist(&bytes, &staged.join("dist"), None)
            .map_err(|error| error.to_string())?;
        download::publish(&profile, &staged, &slot, |root| {
            verify_release(root, &release)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn verify_release(root: &Path, release: &LotusRelease) -> Result<VerifiedFrontend, String> {
    let dist = owned_directory(&owned_directory(root)?.join("dist"))?;
    let path = dist.join(MANIFEST);
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > MAX_MANIFEST {
        return Err("Invalid Lotus Next manifest file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .map_err(|error| error.to_string())?
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST || hash_bytes(&bytes) != release.manifest_sha256 {
        return Err("The Lotus Next manifest differs from the signed component release".into());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
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
        return Err("The Lotus Next resources differ from the signed release".into());
    }
    Ok(VerifiedFrontend {
        static_dir: Some(dist),
        index_hash: Some(index_hash),
        manifest_sha256: Some(release.manifest_sha256.clone()),
    })
}
