use super::github_api::GitHubApi;
use super::github_token::GitHubUpdateCredentials;
use super::{
    asset, bamboo_version, hex, native_asset_name, read_limited, Asset, BambooRelease,
    BrowserRuntimeArtifact, NativeArtifact, ReleaseCheckError, NATIVE_TARGETS,
};
use crate::{bamboo_update::RELEASES, component_download::DownloadSettings};
use reqwest::{Client, Url};
use serde::{de::DeserializeOwned, Deserialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

const SIDECARS: &str = "bamboo-sidecars-v3.json";
const BROWSER_RUNTIMES: &str = "bamboo-desktop-browser-runtimes-v1.json";
const BROWSER_HOST: &str = "bamboo-browser-host-v1.tar.gz";
const BROWSER_HOST_FILES: [&str; 3] = [
    "browser-runtime/host.cjs",
    "browser-runtime/package-lock.json",
    "browser-runtime/package.json",
];
const MANIFEST_LIMIT: u64 = 1024 * 1024;
const EXECUTABLE_LIMIT: u64 = 1024 * 1024 * 1024;
const BROWSER_HOST_LIMIT: u64 = 8 * 1024 * 1024;
const RUNTIME_LIMIT: u64 = 768 * 1024 * 1024;
const ARTIFACT_COUNT: usize = NATIVE_TARGETS.len();
#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl GitHubRelease {
    fn version(&self) -> Result<&str, String> {
        if self.draft || self.prerelease || self.published_at.is_none() {
            return Err("Expected a published stable Bamboo release".into());
        }
        self.tag_name
            .strip_prefix('v')
            .filter(|version| bamboo_version(version).is_some())
            .ok_or_else(|| "Invalid Bamboo stable release tag".into())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarManifest {
    schema_version: u32,
    version: String,
    source_revision: String,
    artifacts: [SidecarArtifact; ARTIFACT_COUNT],
    browser_host: BrowserHost,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarArtifact {
    target: String,
    asset_name: String,
    build_mode: String,
    embedded_frontend: bool,
    format: String,
    sha256: String,
    size_bytes: u64,
    binary_name: Option<String>,
    binary_sha256: Option<String>,
    binary_size_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserHost {
    asset_name: String,
    sha256: String,
    size_bytes: u64,
    files: [BrowserHostFile; BROWSER_HOST_FILES.len()],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserHostFile {
    path: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserRuntimeManifest {
    kind: String,
    version: String,
    source_revision: String,
    bamboo_manifest_sha256: String,
    artifacts: [BrowserRuntimeEntry; ARTIFACT_COUNT],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserRuntimeEntry {
    target: String,
    asset_name: String,
    archive: Asset,
    receipt_sha256: String,
}

impl BrowserRuntimeManifest {
    fn matches_release(&self, version: &str, revision: &str, manifest: &Asset) -> bool {
        self.kind == "bamboo-desktop-browser-runtimes/v1"
            && self.version == version
            && self.source_revision == revision
            && self.bamboo_manifest_sha256 == manifest.sha256
    }
}

fn parse<T: DeserializeOwned>(bytes: &[u8], label: &str) -> Result<T, String> {
    serde_json::from_slice(bytes).map_err(|_| format!("Invalid {label} JSON"))
}

fn url(address: &str) -> Result<Url, String> {
    Url::parse(address).map_err(|_| "Invalid official Bamboo release URL".into())
}

pub(crate) async fn test_github_update_token(
    credentials: &GitHubUpdateCredentials,
    settings: &DownloadSettings,
) -> Result<(), &'static str> {
    if credentials.authorization().is_none() {
        return Err("token-missing");
    }
    let api = GitHubApi::new(credentials, settings).map_err(|error| error.test_code())?;
    let label = "Bamboo release metadata";
    let bytes = api
        .read(MANIFEST_LIMIT as usize, label)
        .await
        .map_err(|error| error.test_code())?;
    let release: GitHubRelease = parse(&bytes, label).map_err(|_| "github-api-unavailable")?;
    release.version().map_err(|_| "github-api-unavailable")?;
    Ok(())
}

fn manifest_identity(bytes: &[u8]) -> Asset {
    Asset {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        size_bytes: bytes.len() as u64,
    }
}

async fn download_manifest_bytes(
    client: &Client,
    address: Url,
    limit: u64,
    name: &str,
) -> Result<Vec<u8>, ReleaseCheckError> {
    tokio::time::timeout(
        Duration::from_secs(30),
        read_limited(client, address, limit as usize, name),
    )
    .await
    .map_err(|_| ReleaseCheckError::Unavailable(format!("Timed out reading Bamboo {name}")))?
}

fn browser_host(host: BrowserHost) -> Result<Asset, String> {
    let mut paths = host.files.each_ref().map(|file| file.path.as_str());
    paths.sort_unstable();
    let identity = Asset {
        sha256: host.sha256,
        size_bytes: host.size_bytes,
    };
    if host.asset_name != BROWSER_HOST
        || !asset(&identity, 1, BROWSER_HOST_LIMIT)
        || paths != BROWSER_HOST_FILES
        || host.files.iter().any(|file| {
            !hex(&file.sha256, 64) || !(1..=BROWSER_HOST_LIMIT).contains(&file.size_bytes)
        })
    {
        return Err("Invalid Bamboo browser host inventory".into());
    }
    Ok(identity)
}

fn native_artifact(
    target: &str,
    sidecar: SidecarArtifact,
    runtime: BrowserRuntimeEntry,
) -> Result<NativeArtifact, String> {
    let asset_name = native_asset_name(target);
    let runtime_asset_name = format!("bamboo-browser-runtime-v1-{target}.tar.gz");
    let executable = Asset {
        sha256: sidecar.sha256,
        size_bytes: sidecar.size_bytes,
    };
    let archive = runtime.archive;
    if sidecar.target != target
        || sidecar.asset_name != asset_name
        || sidecar.build_mode != "embedded"
        || !sidecar.embedded_frontend
        || sidecar.format != "raw"
        || !asset(&executable, 65_536, EXECUTABLE_LIMIT)
        || sidecar
            .binary_name
            .as_ref()
            .is_some_and(|name| name != &asset_name)
        || sidecar
            .binary_sha256
            .as_ref()
            .is_some_and(|sha| sha != &executable.sha256)
        || sidecar
            .binary_size_bytes
            .is_some_and(|size| size != executable.size_bytes)
        || runtime.target != target
        || runtime.asset_name != runtime_asset_name
        || !asset(&archive, 1, RUNTIME_LIMIT)
        || !hex(&runtime.receipt_sha256, 64)
    {
        return Err(format!(
            "Invalid Bamboo executable or browser runtime for {target}"
        ));
    }
    Ok(NativeArtifact {
        target: target.into(),
        asset_name,
        executable,
        browser_runtime: Some(BrowserRuntimeArtifact {
            asset_name: runtime_asset_name,
            archive,
            receipt_sha256: runtime.receipt_sha256,
        }),
    })
}

fn verify_manifests(
    version: &str,
    source_revision: String,
    manifest: Asset,
    sidecars: SidecarManifest,
    runtime: BrowserRuntimeManifest,
) -> Result<BambooRelease, String> {
    if !hex(&source_revision, 40)
        || sidecars.schema_version != 3
        || sidecars.version != version
        || sidecars.source_revision != source_revision
        || !runtime.matches_release(version, &source_revision, &manifest)
    {
        return Err("Bamboo manifests do not match the tagged release".into());
    }
    let host = browser_host(sidecars.browser_host)?;
    let artifacts = NATIVE_TARGETS
        .into_iter()
        .zip(sidecars.artifacts.into_iter().zip(runtime.artifacts))
        .map(|(target, (sidecar, browser))| native_artifact(target, sidecar, browser))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(BambooRelease {
        version: version.to_owned(),
        source_revision,
        manifest,
        browser_host: host,
        artifacts,
    })
}

fn verify_manual_manifests(
    version: &str,
    sidecar_bytes: &[u8],
    runtime_bytes: &[u8],
) -> Result<BambooRelease, String> {
    let sidecars: SidecarManifest = parse(sidecar_bytes, SIDECARS)?;
    verify_manifests(
        version,
        sidecars.source_revision.clone(),
        manifest_identity(sidecar_bytes),
        sidecars,
        parse(runtime_bytes, BROWSER_RUNTIMES)?,
    )
}

/// Read the publisher's manifests from the exact public release asset URLs.
pub(crate) async fn load_manual_bamboo_release(
    settings: &DownloadSettings,
    version: &str,
) -> Result<BambooRelease, ReleaseCheckError> {
    if bamboo_version(version).is_none() {
        return Err("Invalid Bamboo stable release version".into());
    }
    let origin = url(RELEASES)?;
    let client = settings.artifact_client(&origin, &origin)?;
    let sidecar_address = url(&format!("{RELEASES}/v{version}/{SIDECARS}"))?;
    let runtime_address = url(&format!("{RELEASES}/v{version}/{BROWSER_RUNTIMES}"))?;
    let (sidecars, runtime) = tokio::try_join!(
        download_manifest_bytes(&client, sidecar_address, MANIFEST_LIMIT, SIDECARS),
        download_manifest_bytes(&client, runtime_address, MANIFEST_LIMIT, BROWSER_RUNTIMES)
    )?;
    Ok(verify_manual_manifests(version, &sidecars, &runtime)?)
}

/// Read the local manifest's version hint and identity for a later exact match.
pub(crate) fn read_local_bamboo_manifest(path: &Path) -> Result<(String, Asset), String> {
    let read_error =
        |error: std::io::Error| format!("Cannot read local Bamboo {SIDECARS}: {error}");
    let file = crate::component_download::open_local_file(path).map_err(read_error)?;
    let metadata = file.metadata().map_err(read_error)?;
    if metadata.len() > MANIFEST_LIMIT {
        return Err("The local Bamboo manifest exceeds its size limit".into());
    }
    let mut bytes = Vec::new();
    file.take(MANIFEST_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(read_error)?;
    if bytes.len() as u64 > MANIFEST_LIMIT {
        return Err("The local Bamboo manifest exceeds its size limit".into());
    }
    let manifest: SidecarManifest = parse(&bytes, SIDECARS)?;
    if manifest.schema_version != 3 || bamboo_version(&manifest.version).is_none() {
        return Err("Invalid local Bamboo v3 manifest version".into());
    }
    Ok((manifest.version, manifest_identity(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const VERSION: &str = "2026.11.47";
    const SOURCE: &str = "f8f9b0bc98025ae3acd0c771dc98b96e33c1bfba";
    const SHA: &str = "0e9e01b2d19cae262b4171d24bc9a24f297351e9a37c98c27817ac5f1a6de462";

    fn fixture() -> (Value, Value) {
        let mut sidecars = Vec::new();
        let mut browsers = Vec::new();
        for target in NATIVE_TARGETS {
            let name = native_asset_name(target);
            let browser_name = format!("bamboo-browser-runtime-v1-{target}.tar.gz");
            sidecars.push(json!({
                "target": target,
                "assetName": name,
                "buildMode": "embedded",
                "embeddedFrontend": true,
                "format": "raw",
                "sha256": SHA,
                "sizeBytes": 100_000,
            }));
            browsers.push(json!({
                "target": target,
                "assetName": browser_name,
                "archive": { "sha256": SHA, "sizeBytes": 100 },
                "receiptSha256": SHA,
            }));
        }
        let sidecar_manifest = json!({
            "schemaVersion": 3,
            "version": VERSION,
            "sourceRevision": SOURCE,
            "artifacts": sidecars,
            "browserHost": {
                "assetName": BROWSER_HOST, "sizeBytes": 100, "sha256": SHA,
                "files": BROWSER_HOST_FILES.map(|path| json!({"path": path, "sizeBytes": 10, "sha256": SHA})),
            },
        });
        let browser_manifest = json!({
            "kind": "bamboo-desktop-browser-runtimes/v1",
            "version": VERSION,
            "sourceRevision": SOURCE,
            "bambooManifestSha256": SHA,
            "artifacts": browsers,
        });
        (sidecar_manifest, browser_manifest)
    }

    #[test]
    fn manual_release_uses_the_exact_tagged_manifests_for_every_target() {
        let (sidecars, mut browsers) = fixture();
        let sidecars = serde_json::to_vec(&sidecars).unwrap();
        let identity = manifest_identity(&sidecars);
        browsers["bambooManifestSha256"] = json!(identity.sha256);
        let browsers = serde_json::to_vec(&browsers).unwrap();
        let verified = verify_manual_manifests(VERSION, &sidecars, &browsers).unwrap();
        assert_eq!(verified.version, VERSION);
        assert_eq!(verified.source_revision, SOURCE);
        assert_eq!(verified.manifest, identity);
        assert_eq!(verified.artifacts.len(), ARTIFACT_COUNT);
        assert_eq!(verified.artifacts[0].executable.sha256, SHA);
        assert_eq!(
            verified.artifacts[0]
                .browser_runtime
                .as_ref()
                .unwrap()
                .receipt_sha256,
            SHA
        );
    }

    #[test]
    fn manual_release_rejects_mismatched_tags_revisions_targets_and_digests() {
        let (sidecars, mut browsers) = fixture();
        let sidecar_bytes = serde_json::to_vec(&sidecars).unwrap();
        assert!(verify_manual_manifests(
            VERSION,
            &sidecar_bytes,
            &serde_json::to_vec(&browsers).unwrap()
        )
        .is_err());
        browsers["bambooManifestSha256"] = json!(manifest_identity(&sidecar_bytes).sha256);
        let browser_bytes = serde_json::to_vec(&browsers).unwrap();
        assert!(verify_manual_manifests("2026.11.46", &sidecar_bytes, &browser_bytes).is_err());

        for (pointer, invalid) in [
            ("/sourceRevision", json!("1".repeat(40))),
            ("/artifacts/0/target", json!("unknown-target")),
            ("/artifacts/0/archive/sizeBytes", json!(RUNTIME_LIMIT + 1)),
            ("/artifacts/0/archive/sha256", json!("unexpected-digest")),
            ("/artifacts/0/receiptSha256", json!("unexpected-receipt")),
        ] {
            let mut invalid_browsers = browsers.clone();
            *invalid_browsers.pointer_mut(pointer).unwrap() = invalid;
            assert!(
                verify_manual_manifests(
                    VERSION,
                    &sidecar_bytes,
                    &serde_json::to_vec(&invalid_browsers).unwrap()
                )
                .is_err(),
                "{pointer}"
            );
        }
    }

    #[test]
    fn local_manifest_supplies_a_bounded_version_hint_and_exact_file_identity() {
        let (mut sidecars, _) = fixture();
        let directory = tempfile::tempdir().unwrap();
        let manifest = directory.path().join(SIDECARS);
        let bytes = serde_json::to_vec(&sidecars).unwrap();
        std::fs::write(&manifest, &bytes).unwrap();
        assert_eq!(
            read_local_bamboo_manifest(&manifest).unwrap(),
            (VERSION.to_owned(), manifest_identity(&bytes))
        );
        assert!(read_local_bamboo_manifest(directory.path()).is_err());
        #[cfg(unix)]
        {
            let link = directory.path().join("linked.json");
            std::os::unix::fs::symlink(&manifest, &link).unwrap();
            assert!(read_local_bamboo_manifest(&link).is_err());
        }
        sidecars["version"] = json!("2026.11.47-rc.1");
        std::fs::write(&manifest, serde_json::to_vec(&sidecars).unwrap()).unwrap();
        assert!(read_local_bamboo_manifest(&manifest).is_err());
        let file = std::fs::File::create(&manifest).unwrap();
        file.set_len(MANIFEST_LIMIT + 1).unwrap();
        assert!(read_local_bamboo_manifest(&manifest).is_err());
    }

    #[test]
    fn github_connectivity_check_requires_a_published_stable_tag() {
        let mut release = GitHubRelease {
            tag_name: format!("v{VERSION}"),
            draft: false,
            prerelease: false,
            published_at: chrono::DateTime::from_timestamp(1_800_000_000, 0),
        };
        assert_eq!(release.version().unwrap(), VERSION);
        release.prerelease = true;
        assert!(release.version().is_err());
        release.prerelease = false;
        release.tag_name = format!("v{VERSION}-rc.1");
        assert!(release.version().is_err());
    }
}
