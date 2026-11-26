use super::{
    asset, bamboo_version, hex, native_asset_name, producer_client, read_limited, Asset,
    BambooRelease, BrowserRuntimeArtifact, NativeArtifact, ReleaseCheckError, NATIVE_TARGETS,
};
use crate::{bamboo_update::RELEASES, component_download::DownloadSettings};
use reqwest::{Client, Url};
use serde::{de::DeserializeOwned, Deserialize};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::io::Read;
use std::path::Path;
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
const IDENTITY_CHANGED: &str = "The official Bamboo release identity changed after discovery";

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

impl BrowserRuntimeManifest {
    fn matches_release(&self, version: &str, revision: &str, manifest: &Asset) -> bool {
        self.kind == "bamboo-desktop-browser-runtimes/v1"
            && self.version == version
            && self.source_revision == revision
            && self.bamboo_manifest_sha256 == manifest.sha256
    }

    fn matches_selected(&self, selected: &BambooRelease) -> bool {
        self.matches_release(
            &selected.version,
            &selected.source_revision,
            &selected.manifest,
        ) && self.artifacts.len() == selected.artifacts.len()
            && self
                .artifacts
                .iter()
                .zip(&selected.artifacts)
                .all(|(runtime, artifact)| {
                    runtime.target == artifact.target
                        && artifact.browser_runtime.as_ref().is_some_and(|asset| {
                            runtime.asset_name == asset.asset_name
                                && runtime.archive == asset.archive
                                && runtime.receipt_sha256 == asset.receipt_sha256
                        })
                })
    }
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
    if &manifest_identity(bytes) != identity {
        return Err(format!(
            "Bamboo {name} bytes differ from the published identity"
        ));
    }
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

async fn download_manifest<T: DeserializeOwned>(
    client: &Client,
    release: &GitHubRelease,
    name: &str,
) -> Result<(Asset, T), ReleaseCheckError> {
    let identity = release.asset(name, 1, MANIFEST_LIMIT)?;
    let address = url(&release.asset_url(name))?;
    let bytes = download_manifest_bytes(client, address, identity.size_bytes, name).await?;
    verify_manifest_bytes(&bytes, &identity, name)?;
    Ok((identity, parse(&bytes, name)?))
}

async fn prioritize_rejection<T>(
    check: impl Future<Output = Result<T, ReleaseCheckError>>,
) -> Result<Result<T, ReleaseCheckError>, ReleaseCheckError> {
    match check.await {
        Err(error @ ReleaseCheckError::Rejected(_)) => Err(error),
        result => Ok(result),
    }
}

fn verify_selected_assets(release: &GitHubRelease, selected: &BambooRelease) -> Result<(), String> {
    if release.asset(SIDECARS, 1, MANIFEST_LIMIT)? != selected.manifest
        || release.asset(BROWSER_HOST, 1, BROWSER_HOST_LIMIT)? != selected.browser_host
    {
        return Err(IDENTITY_CHANGED.into());
    }
    for artifact in &selected.artifacts {
        let browser = artifact.browser_runtime.as_ref().ok_or(IDENTITY_CHANGED)?;
        if release.asset(&artifact.asset_name, 65_536, EXECUTABLE_LIMIT)? != artifact.executable
            || release.asset(&browser.asset_name, 1, RUNTIME_LIMIT)? != browser.archive
        {
            return Err(IDENTITY_CHANGED.into());
        }
    }
    Ok(())
}

async fn tag_revision(
    read: impl Future<Output = Result<GitHubCommit, ReleaseCheckError>>,
    selected: Option<&BambooRelease>,
) -> Result<String, ReleaseCheckError> {
    let GitHubCommit { sha } = read.await?;
    if !hex(&sha, 40) || selected.is_some_and(|release| release.source_revision != sha) {
        return Err(IDENTITY_CHANGED.into());
    }
    Ok(sha)
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

fn verified_release(
    release: &GitHubRelease,
    version: &str,
    source_revision: String,
    manifest: Asset,
    sidecars: SidecarManifest,
    runtime: BrowserRuntimeManifest,
) -> Result<BambooRelease, String> {
    let verified = verify_manifests(version, source_revision, manifest, sidecars, runtime)?;
    verify_selected_assets(release, &verified)?;
    Ok(verified)
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

async fn load(
    settings: &DownloadSettings,
    selected: Option<&BambooRelease>,
) -> Result<(BambooRelease, Vec<String>), ReleaseCheckError> {
    let expected_version = selected.map(|release| release.version.as_str());
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
    if let Some(selected) = selected {
        verify_selected_assets(&release, selected)?;
    }
    let download_origin = url(RELEASES)?;
    let client = settings.artifact_client(&download_origin, &download_origin)?;
    let commit_url = format!("{API}/commits/{}", release.tag_name);
    // An available rejection must reach the caller even if a sibling stalls.
    let (revision, sidecars, browser_runtime) = tokio::try_join!(
        prioritize_rejection(tag_revision(
            get_json(&api, &commit_url, 8 * 1024 * 1024, "Bamboo tag commit"),
            selected,
        )),
        prioritize_rejection(download_manifest::<SidecarManifest>(
            &client, &release, SIDECARS
        )),
        prioritize_rejection(async {
            let (_, runtime) =
                download_manifest::<BrowserRuntimeManifest>(&client, &release, BROWSER_RUNTIMES)
                    .await?;
            if selected.is_some_and(|release| !runtime.matches_selected(release)) {
                return Err(IDENTITY_CHANGED.into());
            }
            Ok(runtime)
        }),
    )?;
    let (manifest, sidecars) = sidecars?;
    let verified = verified_release(
        &release,
        version,
        revision?,
        manifest,
        sidecars,
        browser_runtime?,
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
    selected: &BambooRelease,
) -> Result<(BambooRelease, Vec<String>), ReleaseCheckError> {
    load(settings, Some(selected)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const VERSION: &str = "2026.11.47";
    const SOURCE: &str = "f8f9b0bc98025ae3acd0c771dc98b96e33c1bfba";
    const SHA: &str = "0e9e01b2d19cae262b4171d24bc9a24f297351e9a37c98c27817ac5f1a6de462";

    #[tokio::test(start_paused = true)]
    async fn release_rejection_is_returned_even_when_another_request_stalls() {
        let result = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::try_join!(
                prioritize_rejection(async {
                    Err::<(), _>(ReleaseCheckError::Unavailable("offline".into()))
                }),
                prioritize_rejection(std::future::pending::<Result<(), ReleaseCheckError>>()),
                prioritize_rejection(async { Err::<(), _>("Bamboo manifest changed".into()) }),
            )
        })
        .await
        .expect("the authoritative rejection must arrive before the offline deadline");
        assert!(
            matches!(result, Err(ReleaseCheckError::Rejected(message)) if message == "Bamboo manifest changed")
        );
    }

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
    fn manual_release_uses_the_exact_tagged_manifests_for_every_target() {
        let (_, _, sidecars, mut browsers) = fixture();
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
        let (_, _, sidecars, mut browsers) = fixture();
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
        let (_, _, mut sidecars, _) = fixture();
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

    #[tokio::test(start_paused = true)]
    async fn changed_tag_revision_rejects_the_staged_release_before_a_manifest_finishes() {
        let (release, manifest, sidecars, browsers) = fixture();
        let selected = verify(&release, manifest, sidecars, browsers).unwrap();
        let changed_tag = tag_revision(
            async {
                Ok(GitHubCommit {
                    sha: "1".repeat(40),
                })
            },
            Some(&selected),
        );
        let outcome = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::try_join!(
                prioritize_rejection(changed_tag),
                prioritize_rejection(std::future::pending::<Result<(), ReleaseCheckError>>()),
            )
        })
        .await
        .expect("the tag identity check must finish before the offline deadline");
        assert!(
            matches!(outcome, Err(ReleaseCheckError::Rejected(message)) if message == IDENTITY_CHANGED)
        );
    }

    #[test]
    fn returned_release_assets_and_runtime_bindings_must_match_the_staged_release() {
        let (mut release, manifest, sidecars, browsers) = fixture();
        let selected = verify(&release, manifest, sidecars, browsers.clone()).unwrap();
        let mut runtime: BrowserRuntimeManifest = serde_json::from_value(browsers).unwrap();
        assert!(verify_selected_assets(&release, &selected).is_ok());
        assert!(runtime.matches_selected(&selected));

        release.assets[0].digest = Some(format!("sha256:{}", "1".repeat(64)));
        assert_eq!(
            verify_selected_assets(&release, &selected).unwrap_err(),
            IDENTITY_CHANGED
        );
        runtime.artifacts[0].receipt_sha256 = "1".repeat(64);
        assert!(!runtime.matches_selected(&selected));
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
