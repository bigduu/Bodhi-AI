//! Resolve and verify an exact Lotus Next package from the official npm registry.
use super::{producer_client, read_limited, stable_version, LotusRelease};
use crate::component_download::DownloadSettings;
use crate::frontend::{inspect_release_archive, read_release_resource};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha512};
use std::path::Path;

const NPM_HOST: &str = "registry.npmjs.org";
const PACKAGE: &str = "@bigduu/lotus-next";
const METADATA_LIMIT: usize = 1024 * 1024;
const ARCHIVE_LIMIT: usize = 32 * 1024 * 1024;
const REQUIREMENTS_RESOURCE: &str = "lotus-next-bootstrap-requirements.json";
const REQUIREMENTS_LIMIT: u64 = 64 * 1024;

#[derive(Debug)]
pub(crate) struct DiscoveredLotus {
    pub release: LotusRelease,
    pub changes: Vec<String>,
    pub requirements: Option<Value>,
}

#[derive(Deserialize)]
struct RegistryMetadata {
    name: String,
    version: String,
    dist: Distribution,
}

#[derive(Deserialize)]
struct Distribution {
    tarball: String,
    integrity: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequirementsDeclaration {
    schema_version: u32,
    package_name: String,
    package_version: String,
    source_revision: String,
    source_dirty: bool,
    bootstrap: Value,
}

pub(crate) async fn discover_lotus(
    settings: &DownloadSettings,
    version: Option<&str>,
) -> Result<DiscoveredLotus, String> {
    if version.is_some_and(|version| !stable_version(version)) {
        return Err("Invalid Lotus Next release version".into());
    }
    let client = producer_client(settings, "Lotus Next npm registry")?;
    let metadata_url = Url::parse(&format!(
        "https://{NPM_HOST}/%40bigduu%2Flotus-next/{}",
        version.unwrap_or("latest")
    ))
    .map_err(|error| error.to_string())?;
    let metadata = read_limited(
        &client,
        metadata_url,
        METADATA_LIMIT,
        "Lotus Next npm metadata",
    )
    .await?;
    let (metadata, archive_url) = parse_metadata(&metadata, version)?;
    let archive = read_limited(
        &client,
        archive_url,
        ARCHIVE_LIMIT,
        "Lotus Next npm archive",
    )
    .await?;
    tokio::task::spawn_blocking(move || inspect_archive(metadata, &archive))
        .await
        .map_err(|error| error.to_string())?
}

fn parse_metadata(bytes: &[u8], version: Option<&str>) -> Result<(RegistryMetadata, Url), String> {
    let metadata: RegistryMetadata =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if metadata.name != PACKAGE
        || !stable_version(&metadata.version)
        || version.is_some_and(|version| version != metadata.version)
    {
        return Err("Invalid Lotus Next npm release identity".into());
    }
    let archive_url = format!(
        "https://{NPM_HOST}/{PACKAGE}/-/lotus-next-{}.tgz",
        metadata.version
    );
    if metadata.dist.tarball != archive_url || !valid_integrity(&metadata.dist.integrity) {
        return Err("Invalid Lotus Next npm archive metadata".into());
    }
    let archive_url = Url::parse(&archive_url).map_err(|error| error.to_string())?;
    Ok((metadata, archive_url))
}

fn valid_integrity(value: &str) -> bool {
    value
        .strip_prefix("sha512-")
        .and_then(|value| STANDARD.decode(value).ok())
        .is_some_and(|digest| digest.len() == 64)
}

fn inspect_archive(metadata: RegistryMetadata, bytes: &[u8]) -> Result<DiscoveredLotus, String> {
    let integrity = format!("sha512-{}", STANDARD.encode(Sha512::digest(bytes)));
    if integrity != metadata.dist.integrity {
        return Err("The Lotus Next archive failed its npm SHA-512 integrity check".into());
    }
    let scratch = tempfile::tempdir().map_err(|error| error.to_string())?;
    let release = inspect_release_archive(&metadata.version, bytes, scratch.path())?;
    let requirements = read_requirements(&scratch.path().join("dist"), &release)?;
    let changes = vec![format!(
        "Lotus Next package https://www.npmjs.com/package/{PACKAGE}/v/{}",
        release.version
    )];
    Ok(DiscoveredLotus {
        release,
        changes,
        requirements,
    })
}

/// Bind the Bootstrap declaration to the release before using it for compatibility.
pub(crate) fn read_requirements(
    dist: &Path,
    release: &LotusRelease,
) -> Result<Option<Value>, String> {
    let Some(bytes) =
        read_release_resource(dist, release, REQUIREMENTS_RESOURCE, REQUIREMENTS_LIMIT)?
    else {
        return Ok(None);
    };
    let declaration: RequirementsDeclaration =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if declaration.schema_version != 1
        || declaration.package_name != PACKAGE
        || declaration.package_version != release.version
        || declaration.source_revision != release.source_revision
        || declaration.source_dirty
        || !declaration.bootstrap.is_object()
    {
        return Err("Invalid Lotus Next Bootstrap requirements declaration".into());
    }
    Ok(Some(declaration.bootstrap))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontend::hash_bytes;
    use flate2::{write::GzEncoder, Compression};
    use serde_json::json;

    const VERSION: &str = "2026.11.31";
    const SOURCE: &str = "6c254fbcc9dafd74524d1f1322606531d21aa5b2";

    fn metadata(archive: &[u8]) -> Value {
        json!({
            "name": PACKAGE,
            "version": VERSION,
            "dist": {
                "tarball": format!("https://{NPM_HOST}/{PACKAGE}/-/lotus-next-{VERSION}.tgz"),
                "integrity": format!("sha512-{}", STANDARD.encode(Sha512::digest(archive))),
                "shasum": "registry-only legacy SHA-1 field"
            }
        })
    }

    fn declare(version: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "packageName": PACKAGE,
            "packageVersion": version,
            "sourceRevision": SOURCE,
            "sourceDirty": false,
            "bootstrap": { "schema_version": 1, "server": { "product": "bamboo" } }
        })
    }

    fn archive(declaration: Option<Value>, changed_resource: bool) -> Vec<u8> {
        let mut files = vec![("index.html", b"<!doctype html>".to_vec())];
        if let Some(declaration) = declaration {
            files.push((
                REQUIREMENTS_RESOURCE,
                serde_json::to_vec(&declaration).unwrap(),
            ));
        }
        let resources = files.iter().map(|(path, bytes)| {
            json!({"path": path, "size": bytes.len(), "sha256": hash_bytes(bytes)})
        }).collect::<Vec<_>>();
        let inventory = files
            .iter()
            .map(|(path, bytes)| format!("{path}\0{}\0{}\n", bytes.len(), hash_bytes(bytes)))
            .collect::<String>();
        let manifest = json!({
            "schemaVersion": 1,
            "packageName": PACKAGE,
            "packageVersion": VERSION,
            "sourceRevision": SOURCE,
            "sourceDirty": false,
            "entrypoint": "index.html",
            "resourcesSha256": hash_bytes(inventory.as_bytes()),
            "resources": resources,
        });
        files.push((
            "lotus-next-manifest.json",
            serde_json::to_vec(&manifest).unwrap(),
        ));
        if changed_resource {
            files[0].1 = b"different HTML".to_vec();
        }
        let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
        for (path, bytes) in files {
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o644);
            header.set_size(bytes.len() as u64);
            header.set_cksum();
            tar.append_data(
                &mut header,
                format!("package/dist/{path}"),
                bytes.as_slice(),
            )
            .unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn requires_exact_stable_npm_identity_and_canonical_archive() {
        let published = metadata(b"archive");
        let parse =
            |value: &Value, version| parse_metadata(&serde_json::to_vec(value).unwrap(), version);
        assert!(parse(&published, None).is_ok());
        assert!(parse(&published, Some(VERSION)).is_ok());
        assert!(parse(&published, Some("2026.11.30")).is_err());
        let mut changed = published.clone();
        changed["name"] = json!("lotus-next");
        assert!(parse(&changed, None).is_err());
        changed = published.clone();
        changed["version"] = json!("2026.11.31-rc.1");
        assert!(parse(&changed, None).is_err());
        changed = published.clone();
        changed["dist"]["tarball"] = json!("https://mirror.example/lotus-next.tgz");
        assert!(parse(&changed, None).is_err());
        changed = published.clone();
        changed["dist"]["integrity"] = json!("sha1-aGVsbG8=");
        assert!(parse(&changed, None).is_err());
    }

    #[test]
    fn validates_integrity_inventory_and_optional_source_bound_requirements() {
        let inspect =
            |bytes: &[u8]| inspect_archive(serde_json::from_value(metadata(bytes)).unwrap(), bytes);
        let old = archive(None, false);
        let old_release = inspect(&old).unwrap();
        assert_eq!(old_release.release.source_revision, SOURCE);
        assert_eq!(old_release.release.tarball.sha256, hash_bytes(&old));
        assert_eq!(old_release.requirements, None);
        let declared = archive(Some(declare(VERSION)), false);
        assert_eq!(
            inspect(&declared).unwrap().requirements.unwrap()["server"]["product"],
            "bamboo"
        );
        assert!(inspect(&archive(Some(declare("2026.11.30")), false)).is_err());
        assert!(inspect(&archive(None, true)).is_err());
        let wrong_integrity = serde_json::from_value(metadata(b"different bytes")).unwrap();
        assert!(inspect_archive(wrong_integrity, &old)
            .unwrap_err()
            .contains("SHA-512"));
    }
}
