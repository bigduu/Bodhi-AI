//! Install a target-specific browser runtime from a published Bamboo release.
use crate::bamboo_profile::{publish_directory, Profile};
use crate::bamboo_update::RELEASES;
use crate::browser_runtime::verify_published;
use crate::component_channel::{BrowserRuntimeArtifact, Candidate};
use crate::component_download::{
    acquire_asset, copy_local_asset, DownloadSettings, DownloadSource,
};
use crate::frontend::{safe_relative, valid_sha256};
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek};
use std::path::{Path, PathBuf};
use tokio::sync::watch;

const TARGET: &str = env!("BODHI_BUILD_TARGET");
const MAX_ARCHIVE: u64 = 768 * 1024 * 1024;
const MAX_UNPACKED: u64 = 2 * 1024 * 1024 * 1024;

pub(crate) fn reopen_runtime(
    profile: &Profile,
    candidate: &Candidate<'_>,
) -> Result<Option<[PathBuf; 3]>, String> {
    candidate
        .artifact
        .browser_runtime
        .as_ref()
        .map(|artifact| {
            validate_artifact(&candidate.artifact.target, artifact)?;
            verify_published(&cache_slot(profile, artifact), &artifact.receipt_sha256)
        })
        .transpose()
}

pub(crate) async fn prepare_runtime(
    profile_data: &Path,
    candidate: &Candidate<'_>,
    settings: watch::Receiver<DownloadSettings>,
    progress: impl FnMut(Option<DownloadSource>, u64, u64) + Send,
) -> Result<[PathBuf; 3], String> {
    let artifact = runtime_artifact(candidate)?;
    let profile = Profile::open(profile_data).map_err(|error| error.to_string())?;
    let slot = cache_slot(&profile, artifact);
    if let Ok(paths) = verify_published(&slot, &artifact.receipt_sha256) {
        return Ok(paths);
    }
    let version = semver::Version::parse(&candidate.combination.bamboo.version)
        .map_err(|error| error.to_string())?;
    let url = format!("{RELEASES}/v{version}/{}", artifact.asset_name);
    let download = acquire_asset(&profile, &url, &artifact.archive, settings, progress).await?;
    let expected = artifact.clone();
    tokio::task::spawn_blocking(move || {
        let download = download;
        install(
            &profile,
            download.file.reopen().map_err(|error| error.to_string())?,
            &expected,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) async fn prepare_local_runtime(
    profile_data: &Path,
    candidate: &Candidate<'_>,
    directory: &Path,
) -> Result<[PathBuf; 3], String> {
    let artifact = runtime_artifact(candidate)?.clone();
    let profile = Profile::open(profile_data).map_err(|error| error.to_string())?;
    let path = directory.join(&artifact.asset_name);
    tokio::task::spawn_blocking(move || {
        let staged = copy_local_asset(&profile, &path, &artifact.archive)?;
        let file = staged.reopen().map_err(|error| error.to_string())?;
        install(&profile, file, &artifact)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn runtime_artifact<'a>(
    candidate: &'a Candidate<'_>,
) -> Result<&'a BrowserRuntimeArtifact, String> {
    let artifact = candidate
        .artifact
        .browser_runtime
        .as_ref()
        .ok_or("The component release has no browser runtime for this target")?;
    validate_artifact(candidate.artifact.target.as_str(), artifact)?;
    Ok(artifact)
}

fn validate_artifact(target: &str, artifact: &BrowserRuntimeArtifact) -> Result<(), String> {
    if target != TARGET
        || artifact.asset_name != format!("bamboo-browser-runtime-v1-{TARGET}.tar.gz")
        || !(1..=MAX_ARCHIVE).contains(&artifact.archive.size_bytes)
        || !valid_sha256(&artifact.archive.sha256)
        || !valid_sha256(&artifact.receipt_sha256)
    {
        return Err("The browser runtime does not match the current platform".into());
    }
    Ok(())
}

fn cache_slot(profile: &Profile, artifact: &BrowserRuntimeArtifact) -> PathBuf {
    profile
        .state_dir
        .join(format!("browser-{}", artifact.archive.sha256))
}

fn install(
    profile: &Profile,
    mut file: File,
    artifact: &BrowserRuntimeArtifact,
) -> Result<[PathBuf; 3], String> {
    let mut digest = Sha256::new();
    let length = io::copy(
        &mut (&mut file).take(artifact.archive.size_bytes + 1),
        &mut digest,
    )
    .map_err(|error| error.to_string())?;
    if length != artifact.archive.size_bytes
        || format!("{:x}", digest.finalize()) != artifact.archive.sha256
    {
        return Err("Browser runtime archive differs from the component catalog".into());
    }
    file.rewind().map_err(|error| error.to_string())?;
    let directory = tempfile::tempdir_in(&profile.state_dir).map_err(|error| error.to_string())?;
    extract(file, directory.path()).map_err(|error| error.to_string())?;
    publish_directory(
        profile,
        &directory.path().join("browser-runtime"),
        &cache_slot(profile, artifact),
        |root| verify_published(root, &artifact.receipt_sha256),
    )
}

fn extract(reader: impl Read, directory: &Path) -> io::Result<()> {
    let mut archive = tar::Archive::new(GzDecoder::new(reader).take(MAX_UNPACKED + 1));
    for (index, item) in archive.entries()?.enumerate() {
        let mut entry = item?;
        let bytes = entry.path_bytes();
        let name = std::str::from_utf8(&bytes)
            .map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "non-UTF8 browser runtime path")
            })?
            .trim_end_matches('/');
        let kind = entry.header().entry_type();
        if index >= 32_768
            || !safe_relative(name)
            || !(kind.is_dir() || kind.is_file())
            || !(name.starts_with("browser-runtime/") || name == "browser-runtime" && kind.is_dir())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid browser runtime archive entry",
            ));
        }
        let path = directory.join(name);
        if kind.is_dir() {
            fs::create_dir_all(path)?;
            continue;
        }
        fs::create_dir_all(path.parent().expect("browser runtime parent"))?;
        let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
        io::copy(&mut entry, &mut file)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if entry.header().mode()? & 0o111 != 0 {
                file.set_permissions(fs::Permissions::from_mode(0o755))?;
            }
        }
    }
    let mut unpacked = archive.into_inner();
    io::copy(&mut unpacked, &mut io::sink())?;
    if unpacked.limit() == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "browser runtime archive is too large",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires an independently packed native browser runtime"]
    fn packed_runtime_starts_the_real_browser_after_cache_installation() {
        let artifact_dir = PathBuf::from(std::env::var_os("BODHI_TEST_BROWSER_ASSETS").unwrap());
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(artifact_dir.join("record.json")).unwrap()).unwrap();
        let artifact: BrowserRuntimeArtifact =
            serde_json::from_value(record["artifact"].clone()).unwrap();
        validate_artifact(record["target"].as_str().unwrap(), &artifact).unwrap();
        let profile_dir = tempfile::tempdir().unwrap();
        let profile = Profile::open(profile_dir.path()).unwrap();
        let file = File::open(artifact_dir.join(&artifact.asset_name)).unwrap();
        let paths = install(&profile, file, &artifact).unwrap();
        let root = cache_slot(&profile, &artifact);
        assert!(paths.iter().all(|path| path.starts_with(&root)));
        let tool =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/browser-bundle-smoke.cjs");
        assert!(std::process::Command::new("node")
            .arg(tool)
            .arg(TARGET)
            .arg(root)
            .status()
            .unwrap()
            .success());
    }
}
