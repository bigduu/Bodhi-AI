use super::{
    asset, bamboo_version, hex, native_asset_name, producer_client, read_limited, Asset,
    BambooRelease, BrowserRuntimeArtifact, NativeArtifact, ReleaseCheckError, NATIVE_TARGETS,
};
use crate::{bamboo_update::RELEASES, component_download::DownloadSettings};
use reqwest::{Client, Url};
use serde::{de::DeserializeOwned, Deserialize};
use sha2::{Digest, Sha256};
use std::time::Duration;

const API: &str = "https://api.github.com/repos/bigduu/Bamboo-agent";
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
    body: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    state: String,
    digest: Option<String>,
    size: u64,
    browser_download_url: String,
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

    fn asset_url(&self, name: &str) -> String {
        format!("{RELEASES}/{}/{name}", self.tag_name)
    }

    fn asset(&self, name: &str, min: u64, max: u64) -> Result<Asset, String> {
        let mut matching = self.assets.iter().filter(|item| item.name == name);
        let item = matching
            .next()
            .ok_or_else(|| format!("Bamboo release is missing {name}"))?;
        if matching.next().is_some()
            || item.state != "uploaded"
            || item.browser_download_url != self.asset_url(name)
        {
            return Err(format!("Invalid official Bamboo asset {name}"));
        }
        let identity = Asset {
            sha256: item
                .digest
                .as_deref()
                .and_then(|digest| digest.strip_prefix("sha256:"))
                .unwrap_or_default()
                .to_owned(),
            size_bytes: item.size,
        };
        if !asset(&identity, min, max) {
            return Err(format!("Invalid digest or size for Bamboo asset {name}"));
        }
        Ok(identity)
    }
}

#[derive(Deserialize)]
struct GitHubCommit {
    sha: String,
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

fn parse<T: DeserializeOwned>(bytes: &[u8], label: &str) -> Result<T, String> {
    serde_json::from_slice(bytes).map_err(|_| format!("Invalid {label} JSON"))
}

fn url(address: &str) -> Result<Url, String> {
    Url::parse(address).map_err(|_| "Invalid official Bamboo release URL".into())
}

async fn get_json<T: DeserializeOwned>(
    client: &Client,
    address: &str,
    limit: usize,
    label: &str,
) -> Result<T, ReleaseCheckError> {
    let bytes = read_limited(client, url(address)?, limit, label).await?;
    Ok(parse(&bytes, label)?)
}

fn verify_manifest_bytes(bytes: &[u8], identity: &Asset, name: &str) -> Result<(), String> {
    if bytes.len() as u64 != identity.size_bytes
        || format!("{:x}", Sha256::digest(bytes)) != identity.sha256
    {
        return Err(format!(
            "Bamboo {name} bytes differ from the published identity"
        ));
    }
    Ok(())
}

async fn download_manifest<T: DeserializeOwned>(
    client: &Client,
    release: &GitHubRelease,
    name: &str,
) -> Result<(Asset, T), ReleaseCheckError> {
    let identity = release.asset(name, 1, MANIFEST_LIMIT)?;
    let address = url(&release.asset_url(name))?;
    let bytes = tokio::time::timeout(
        Duration::from_secs(30),
        read_limited(client, address, identity.size_bytes as usize, name),
    )
    .await
    .map_err(|_| ReleaseCheckError::Unavailable(format!("Timed out reading Bamboo {name}")))??;
    verify_manifest_bytes(&bytes, &identity, name)?;
    Ok((identity, parse(&bytes, name)?))
}

fn browser_host(release: &GitHubRelease, host: BrowserHost) -> Result<Asset, String> {
    let mut paths = host.files.each_ref().map(|file| file.path.as_str());
    paths.sort_unstable();
    let published = release.asset(BROWSER_HOST, 1, BROWSER_HOST_LIMIT)?;
    if host.asset_name != BROWSER_HOST
        || host.sha256 != published.sha256
        || host.size_bytes != published.size_bytes
        || paths != BROWSER_HOST_FILES
        || host.files.iter().any(|file| {
            !hex(&file.sha256, 64) || !(1..=BROWSER_HOST_LIMIT).contains(&file.size_bytes)
        })
    {
        return Err("Invalid Bamboo browser host inventory".into());
    }
    Ok(published)
}

fn native_artifact(
    release: &GitHubRelease,
    target: &str,
    sidecar: SidecarArtifact,
    runtime: BrowserRuntimeEntry,
) -> Result<NativeArtifact, String> {
    let asset_name = native_asset_name(target);
    let runtime_asset_name = format!("bamboo-browser-runtime-v1-{target}.tar.gz");
    let executable = release.asset(&asset_name, 65_536, EXECUTABLE_LIMIT)?;
    let archive = release.asset(&runtime_asset_name, 1, RUNTIME_LIMIT)?;
    if sidecar.target != target
        || sidecar.asset_name != asset_name
        || sidecar.build_mode != "embedded"
        || !sidecar.embedded_frontend
        || sidecar.format != "raw"
        || sidecar.sha256 != executable.sha256
        || sidecar.size_bytes != executable.size_bytes
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
        || runtime.archive != archive
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

fn verified_release(
    release: &GitHubRelease,
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
        || runtime.kind != "bamboo-desktop-browser-runtimes/v1"
        || runtime.version != version
        || runtime.source_revision != source_revision
        || runtime.bamboo_manifest_sha256 != manifest.sha256
    {
        return Err("Bamboo manifests do not match the tagged release".into());
    }
    let host = browser_host(release, sidecars.browser_host)?;
    let artifacts = NATIVE_TARGETS
        .into_iter()
        .zip(sidecars.artifacts.into_iter().zip(runtime.artifacts))
        .map(|(target, (sidecar, browser))| native_artifact(release, target, sidecar, browser))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(BambooRelease {
        version: version.to_owned(),
        source_revision,
        manifest,
        browser_host: host,
        artifacts,
    })
}

async fn load(
    settings: &DownloadSettings,
    expected_version: Option<&str>,
) -> Result<(BambooRelease, Vec<String>), ReleaseCheckError> {
    let suffix = match expected_version {
        Some(version) if bamboo_version(version).is_some() => format!("tags/v{version}"),
        Some(_) => return Err("Invalid Bamboo stable release version".into()),
        None => "latest".into(),
    };
    let api = producer_client(settings, "Bamboo release metadata")?;
    let release: GitHubRelease = get_json(
        &api,
        &format!("{API}/releases/{suffix}"),
        MANIFEST_LIMIT as usize,
        "Bamboo release metadata",
    )
    .await?;
    let version = release.version()?;
    if expected_version.is_some_and(|expected| version != expected) {
        return Err("Bamboo release version differs from the requested version".into());
    }
    let download_origin = url(RELEASES)?;
    let client = settings.artifact_client(&download_origin, &download_origin)?;
    let commit_url = format!("{API}/commits/{}", release.tag_name);
    let (commit, sidecars, browser_runtime) = tokio::join!(
        get_json::<GitHubCommit>(&api, &commit_url, 8 * 1024 * 1024, "Bamboo tag commit"),
        download_manifest::<SidecarManifest>(&client, &release, SIDECARS),
        download_manifest::<BrowserRuntimeManifest>(&client, &release, BROWSER_RUNTIMES),
    );
    // Prefer an authoritative rejection over an unavailable parallel request.
    for result in [
        commit.as_ref().err(),
        sidecars.as_ref().err(),
        browser_runtime.as_ref().err(),
    ] {
        if let Some(ReleaseCheckError::Rejected(message)) = result {
            return Err(message.clone().into());
        }
    }
    let (manifest, sidecars) = sidecars?;
    let (_, browser_runtime) = browser_runtime?;
    let verified = verified_release(
        &release,
        version,
        commit?.sha,
        manifest,
        sidecars,
        browser_runtime,
    )?;
    let changes = release
        .body
        .as_deref()
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.trim().strip_prefix("- "))
        .map(str::trim)
        .filter(|line| !line.is_empty() && line.len() <= 2048)
        .take(64)
        .map(str::to_owned)
        .collect();
    Ok((verified, changes))
}

pub(super) async fn load_latest(
    settings: &DownloadSettings,
) -> Result<(BambooRelease, Vec<String>), String> {
    Ok(load(settings, None).await?)
}

pub(super) async fn load_version(
    settings: &DownloadSettings,
    version: &str,
) -> Result<(BambooRelease, Vec<String>), ReleaseCheckError> {
    load(settings, Some(version)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const VERSION: &str = "2026.11.47";
    const SOURCE: &str = "f8f9b0bc98025ae3acd0c771dc98b96e33c1bfba";
    const SHA: &str = "0e9e01b2d19cae262b4171d24bc9a24f297351e9a37c98c27817ac5f1a6de462";

    fn entry(name: &str, size: u64) -> Value {
        json!({
            "name": name,
            "state": "uploaded",
            "digest": format!("sha256:{SHA}"),
            "size": size,
            "browser_download_url": format!("{RELEASES}/v{VERSION}/{name}"),
        })
    }

    fn fixture() -> (GitHubRelease, Asset, Value, Value) {
        let mut assets = vec![entry(BROWSER_HOST, 100), entry(SIDECARS, 1_000)];
        let mut sidecars = Vec::new();
        let mut browsers = Vec::new();
        for target in NATIVE_TARGETS {
            let name = native_asset_name(target);
            let browser_name = format!("bamboo-browser-runtime-v1-{target}.tar.gz");
            assets.extend([entry(&name, 100_000), entry(&browser_name, 100)]);
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
        let release: GitHubRelease = serde_json::from_value(json!({
            "tag_name": format!("v{VERSION}"),
            "draft": false,
            "prerelease": false,
            "published_at": "2026-11-25T13:28:51Z",
            "assets": assets,
        }))
        .unwrap();
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
        let manifest = release.asset(SIDECARS, 1, MANIFEST_LIMIT).unwrap();
        (release, manifest, sidecar_manifest, browser_manifest)
    }

    fn verify(
        release: &GitHubRelease,
        manifest: Asset,
        sidecars: Value,
        browsers: Value,
    ) -> Result<BambooRelease, String> {
        verified_release(
            release,
            release.version()?,
            SOURCE.into(),
            manifest,
            parse(&serde_json::to_vec(&sidecars).unwrap(), SIDECARS)?,
            parse(&serde_json::to_vec(&browsers).unwrap(), BROWSER_RUNTIMES)?,
        )
    }

    #[test]
    fn official_manifests_match_every_target_and_cross_bind_their_digests() {
        let (release, manifest, sidecars, mut browsers) = fixture();
        let verified = verify(
            &release,
            manifest.clone(),
            sidecars.clone(),
            browsers.clone(),
        )
        .unwrap();
        assert_eq!(verified.source_revision, SOURCE);
        assert_eq!(verified.artifacts.len(), ARTIFACT_COUNT);
        assert!(verified
            .artifacts
            .iter()
            .all(|artifact| artifact.browser_runtime.is_some()));
        browsers["bambooManifestSha256"] = json!("1".repeat(64));
        assert!(verify(&release, manifest, sidecars, browsers).is_err());
    }

    #[test]
    fn rejects_wrong_targets_missing_runtime_and_changed_release_asset() {
        let (mut release, manifest, mut sidecars, mut browsers) = fixture();
        sidecars["artifacts"][1]["target"] = sidecars["artifacts"][0]["target"].clone();
        assert!(verify(&release, manifest.clone(), sidecars, browsers.clone()).is_err());
        let (_, _, sidecars, _) = fixture();
        browsers["artifacts"].as_array_mut().unwrap().pop();
        assert!(verify(&release, manifest.clone(), sidecars.clone(), browsers).is_err());
        let (_, _, _, browsers) = fixture();
        let native = native_asset_name(NATIVE_TARGETS[0]);
        release
            .assets
            .iter_mut()
            .find(|asset| asset.name == native)
            .unwrap()
            .digest = Some(format!("sha256:{}", "1".repeat(64)));
        assert!(verify(&release, manifest, sidecars, browsers).is_err());
    }

    #[test]
    fn rejects_unpublished_releases_and_nonofficial_asset_urls() {
        let (mut release, _, _, _) = fixture();
        release.prerelease = true;
        assert!(release.version().is_err());
        release.prerelease = false;
        release.tag_name = format!("v{VERSION}-rc.1");
        assert!(release.version().is_err());
        release.tag_name = format!("v{VERSION}");
        release.assets[0].browser_download_url = "https://mirror.example.test/asset".into();
        assert!(release.asset(BROWSER_HOST, 1, BROWSER_HOST_LIMIT).is_err());
    }

    #[test]
    fn both_manifest_downloads_require_the_exact_published_bytes() {
        let bytes = br#"{"x":1}"#;
        let digest = Asset {
            sha256: format!("{:x}", Sha256::digest(bytes)),
            size_bytes: bytes.len() as u64,
        };
        assert!(verify_manifest_bytes(bytes, &digest, SIDECARS).is_ok());
        assert!(verify_manifest_bytes(br#"{"x":2}"#, &digest, SIDECARS).is_err());
        assert!(verify_manifest_bytes(br#"{}"#, &digest, BROWSER_RUNTIMES).is_err());
    }
}
