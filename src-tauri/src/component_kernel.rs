//! Stage an authenticated Bamboo executable for the current desktop target.
mod native;

use crate::bamboo_profile::{create_directory, is_link, persist, Profile};
use crate::bamboo_update::{check_executable_version, RELEASES};
use crate::component_channel::{Asset, Candidate, NativeArtifact};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::watch;

const TARGET: &str = env!("BODHI_BUILD_TARGET");

#[derive(Debug, Default, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DownloadSource {
    #[default]
    #[serde(rename = "github")]
    GitHub,
    GhProxy,
    GhFast,
}

impl DownloadSource {
    fn url(self, official: &str) -> String {
        match self {
            Self::GitHub => official.to_owned(),
            Self::GhProxy => format!("https://gh-proxy.com/{official}"),
            Self::GhFast => format!("https://ghfast.top/{official}"),
        }
    }

    fn client(self) -> Result<Client, String> {
        Client::builder()
            .https_only(true)
            .no_gzip()
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                let url = attempt.url();
                let host = url.host_str();
                let release_host = matches!(
                    host,
                    Some(
                        "github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                );
                let selected_mirror = matches!(
                    (self, host),
                    (Self::GhProxy, Some("gh-proxy.com")) | (Self::GhFast, Some("ghfast.top"))
                );
                if attempt.previous().len() < 5
                    && url.scheme() == "https"
                    && url.port_or_known_default() == Some(443)
                    && url.username().is_empty()
                    && url.password().is_none()
                    && (release_host || selected_mirror)
                {
                    attempt.follow()
                } else {
                    attempt.error("unexpected Bamboo release redirect")
                }
            }))
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .timeout(Duration::from_secs(20 * 60))
            .build()
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug)]
pub struct VerifiedKernel {
    pub executable: PathBuf,
    pub version: String,
}

/// A source change cancels the current request, discards its temporary file and
/// starts from byte zero using the selected source and the same signed identity.
pub async fn prepare_kernel(
    profile_data: &Path,
    candidate: &Candidate<'_>,
    mut sources: watch::Receiver<DownloadSource>,
    mut progress: impl FnMut(DownloadSource, u64, u64) + Send,
) -> Result<VerifiedKernel, String> {
    let artifact = candidate.artifact;
    validate_artifact(artifact)?;
    let version = &candidate.combination.bamboo.version;
    let parsed = semver::Version::parse(version).map_err(|error| error.to_string())?;
    let official = format!("{RELEASES}/v{parsed}/{}", artifact.asset_name);
    let profile = Profile::open(profile_data).map_err(|error| error.to_string())?;
    let root = profile
        .state_dir
        .join(format!("bamboo-{}", artifact.executable.sha256));
    create_directory(&root).map_err(|error| error.to_string())?;
    let suffix = std::env::consts::EXE_SUFFIX;
    let executable = root.join(format!("bamboo{suffix}"));
    let result = || VerifiedKernel {
        executable: executable.clone(),
        version: version.clone(),
    };
    let cached = executable.clone();
    let expected = artifact.executable.clone();
    if tokio::task::spawn_blocking(move || verify_cached(&cached, &expected))
        .await
        .map_err(|error| error.to_string())?
        .is_ok()
    {
        return Ok(result());
    }

    let mut file = acquire_asset(
        &root,
        &official,
        &artifact.executable,
        &mut sources,
        &mut progress,
    )
    .await?;
    native::verify(file.as_file_mut(), TARGET)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let file = file.into_temp_path();
    check_executable_version(&file, version).await?;
    let _update = profile.update_lock()?;
    if verify_cached(&executable, &artifact.executable).is_ok() {
        return Ok(result());
    }
    let _writer = match fs::symlink_metadata(&executable) {
        Ok(_) => Some(profile.writer()?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    persist(file, &executable).map_err(|error| error.to_string())?;
    Ok(result())
}

pub(crate) async fn acquire_asset(
    root: &Path,
    official: &str,
    expected: &Asset,
    sources: &mut watch::Receiver<DownloadSource>,
    progress: &mut (impl FnMut(DownloadSource, u64, u64) + Send),
) -> Result<tempfile::NamedTempFile, String> {
    loop {
        let source = *sources.borrow_and_update();
        let work = download(root, official, source, expected, progress);
        if let Some(result) = while_source_selected(sources, source, work).await {
            return result;
        }
    }
}

async fn while_source_selected<T>(
    sources: &mut watch::Receiver<DownloadSource>,
    selected: DownloadSource,
    work: impl std::future::Future<Output = T> + Send,
) -> Option<T> {
    tokio::pin!(work);
    tokio::select! {
        output = &mut work => Some(output),
        changed = async { sources.wait_for(|source| *source != selected).await.is_ok() } => {
            if changed { None } else { Some(work.await) }
        }
    }
}

fn validate_artifact(artifact: &NativeArtifact) -> Result<(), String> {
    let asset = &artifact.executable;
    let expected = format!("bamboo-{TARGET}{}", std::env::consts::EXE_SUFFIX);
    if artifact.target != TARGET
        || artifact.asset_name != expected
        || !(65_536..=1024 * 1024 * 1024).contains(&asset.size_bytes)
        || asset.sha256.len() != 64
        || !asset
            .sha256
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("The signed Bamboo executable does not match the current platform".into());
    }
    Ok(())
}

async fn download(
    root: &Path,
    official: &str,
    source: DownloadSource,
    expected: &Asset,
    progress: &mut (impl FnMut(DownloadSource, u64, u64) + Send),
) -> Result<tempfile::NamedTempFile, String> {
    progress(source, 0, expected.size_bytes);
    let mut response = source
        .client()?
        .get(source.url(official))
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    if response.status() != StatusCode::OK {
        return Err(format!(
            "The selected Bamboo source returned HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length != expected.size_bytes)
    {
        return Err("Bamboo download size differs from the signed size".into());
    }
    let extension = if official.ends_with(".exe") {
        ".exe"
    } else {
        ""
    };
    let mut file = tempfile::Builder::new()
        .suffix(extension)
        .tempfile_in(root)
        .map_err(|error| error.to_string())?;
    let mut length = 0u64;
    let mut digest = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| error.without_url().to_string())?
    {
        length += chunk.len() as u64;
        if length > expected.size_bytes {
            return Err("Bamboo download size differs from the signed size".into());
        }
        file.write_all(&chunk).map_err(|error| error.to_string())?;
        digest.update(&chunk);
        progress(source, length, expected.size_bytes);
    }
    if length != expected.size_bytes || format!("{:x}", digest.finalize()) != expected.sha256 {
        return Err("Bamboo executable differs from the component catalog".into());
    }
    file.rewind().map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    Ok(file)
}

fn verify_cached(path: &Path, expected: &Asset) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() != expected.size_bytes {
        return Err("Invalid cached Bamboo executable".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o100 == 0 {
            return Err("The cached Bamboo executable is not executable".into());
        }
    }
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    native::verify(&mut file, TARGET)?;
    file.rewind().map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let length = io::copy(&mut file, &mut digest).map_err(|error| error.to_string())?;
    if length != expected.size_bytes || format!("{:x}", digest.finalize()) != expected.sha256 {
        return Err("Cached Bamboo executable failed the signed digest check".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn changing_the_source_cancels_the_in_flight_work() {
        let (source, mut receiver) = watch::channel(DownloadSource::GitHub);
        let result = while_source_selected(&mut receiver, DownloadSource::GitHub, async {
            source.send(DownloadSource::GhProxy).unwrap();
            std::future::pending::<()>().await;
        })
        .await;
        assert!(result.is_none());
        let selected = *receiver.borrow_and_update();
        let result = while_source_selected(&mut receiver, selected, async { selected }).await;
        assert_eq!(result, Some(DownloadSource::GhProxy));
    }

    #[test]
    fn source_setting_wraps_only_the_same_official_asset() {
        let official = "https://github.com/bigduu/Bamboo-agent/releases/download/v2026.11.39/bamboo-x86_64-pc-windows-msvc.exe";
        assert_eq!(DownloadSource::GitHub.url(official), official);
        assert_eq!(
            DownloadSource::GhProxy.url(official),
            format!("https://gh-proxy.com/{official}")
        );
        assert_eq!(
            DownloadSource::GhFast.url(official),
            format!("https://ghfast.top/{official}")
        );
    }

    #[tokio::test]
    #[ignore = "downloads the original public executable for the running platform"]
    async fn downloads_the_published_bamboo_and_reuses_its_verified_cache() {
        let channel = crate::component_channel::tests::fixture_channel().await;
        let candidate = channel.select(None).unwrap().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let (_, source) = watch::channel(DownloadSource::GitHub);
        let mut downloaded = 0;
        let kernel = prepare_kernel(
            scratch.path(),
            &candidate,
            source.clone(),
            |source, bytes, total| {
                assert_eq!(source, DownloadSource::GitHub);
                assert_eq!(total, candidate.artifact.executable.size_bytes);
                assert!(bytes >= downloaded && bytes <= total);
                downloaded = bytes;
            },
        )
        .await
        .unwrap();
        assert_eq!(downloaded, candidate.artifact.executable.size_bytes);
        assert_eq!(kernel.version, candidate.combination.bamboo.version);
        let cached = prepare_kernel(scratch.path(), &candidate, source, |_, _, _| {
            panic!("a verified native cache should need no download");
        })
        .await
        .unwrap();
        assert_eq!(cached.executable, kernel.executable);
    }
}
