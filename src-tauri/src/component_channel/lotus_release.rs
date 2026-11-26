//! Verify the Bootstrap declaration included in a pinned Lotus Next archive.
use super::LotusRelease;
use crate::frontend::read_release_resource;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

const PACKAGE: &str = "@bigduu/lotus-next";
const REQUIREMENTS_RESOURCE: &str = "lotus-next-bootstrap-requirements.json";
const REQUIREMENTS_LIMIT: u64 = 64 * 1024;

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
    use crate::frontend::{hash_bytes, inspect_release_archive};
    use flate2::{write::GzEncoder, Compression};
    use serde_json::json;

    const VERSION: &str = "2026.11.31";
    const SOURCE: &str = "6c254fbcc9dafd74524d1f1322606531d21aa5b2";

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
    fn binds_requirements_to_the_verified_archive_and_source() {
        fn inspect(archive: &[u8]) -> Result<Option<Value>, String> {
            let scratch = tempfile::tempdir().unwrap();
            let release = inspect_release_archive(VERSION, archive, scratch.path())?;
            read_requirements(&scratch.path().join("dist"), &release)
        }

        assert_eq!(inspect(&archive(None, false)).unwrap(), None);
        assert_eq!(
            inspect(&archive(Some(declare(VERSION)), false))
                .unwrap()
                .unwrap()["server"]["product"],
            "bamboo"
        );
        assert!(inspect(&archive(Some(declare("2026.11.30")), false)).is_err());
        assert!(inspect(&archive(None, true)).is_err());
    }
}
