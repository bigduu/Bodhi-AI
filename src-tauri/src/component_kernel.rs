//! Stage an authenticated Bamboo executable for the current desktop target.
mod native;

use crate::bamboo_profile::{create_directory, is_link, persist, Profile};
use crate::bamboo_update::{check_executable_version, RELEASES};
use crate::component_channel::{Asset, Candidate, NativeArtifact};
use crate::component_download::{
    acquire_asset, copy_local_asset, DownloadSettings, DownloadSource,
};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Seek};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;
use tokio::sync::watch;

const TARGET: &str = env!("BODHI_BUILD_TARGET");

#[derive(Debug)]
pub struct VerifiedKernel {
    pub executable: PathBuf,
    pub version: String,
}

fn cache_root(profile: &Profile, artifact: &NativeArtifact) -> PathBuf {
    profile
        .state_dir
        .join(format!("bamboo-{}", artifact.executable.sha256))
}

fn executable_in(root: &Path) -> PathBuf {
    root.join(format!("bamboo{}", std::env::consts::EXE_SUFFIX))
}

/// Reopen the staged native executable without starting an asset transfer.
pub(crate) async fn reopen_kernel(
    profile: &Profile,
    candidate: &Candidate<'_>,
) -> Result<VerifiedKernel, String> {
    validate_artifact(candidate.artifact)?;
    let root = cache_root(profile, candidate.artifact);
    let version = candidate.combination.bamboo.version.clone();
    let expected = candidate.artifact.executable.clone();
    tokio::task::spawn_blocking(move || {
        let meta = fs::symlink_metadata(&root).map_err(|error| error.to_string())?;
        if !meta.is_dir() || is_link(&meta) {
            return Err("Invalid cached Bamboo executable directory".into());
        }
        let executable = executable_in(&root);
        verify_cached(&executable, &expected)?;
        Ok(VerifiedKernel {
            executable,
            version,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Verify the catalog's executable before placing it in the native cache.
pub(crate) async fn prepare_kernel(
    profile_data: &Path,
    candidate: &Candidate<'_>,
    settings: watch::Receiver<DownloadSettings>,
    progress: impl FnMut(Option<DownloadSource>, u64, u64) + Send,
) -> Result<VerifiedKernel, String> {
    let artifact = candidate.artifact;
    validate_artifact(artifact)?;
    let version = &candidate.combination.bamboo.version;
    let parsed = semver::Version::parse(version).map_err(|error| error.to_string())?;
    let official = format!("{RELEASES}/v{parsed}/{}", artifact.asset_name);
    let profile = Profile::open(profile_data).map_err(|error| error.to_string())?;
    let root = cache_root(&profile, artifact);
    create_directory(&root).map_err(|error| error.to_string())?;
    let executable = executable_in(&root);
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

    let download = acquire_asset(
        &profile,
        &official,
        &artifact.executable,
        settings,
        progress,
    )
    .await?;
    install_kernel(&profile, artifact, version, executable, download.file).await
}

pub(crate) async fn prepare_local_kernel(
    profile_data: &Path,
    candidate: &Candidate<'_>,
    directory: &Path,
) -> Result<VerifiedKernel, String> {
    let artifact = candidate.artifact;
    validate_artifact(artifact)?;
    let version = &candidate.combination.bamboo.version;
    semver::Version::parse(version).map_err(|error| error.to_string())?;
    let profile = Profile::open(profile_data).map_err(|error| error.to_string())?;
    let root = cache_root(&profile, artifact);
    create_directory(&root).map_err(|error| error.to_string())?;
    let path = directory.join(&artifact.asset_name);
    let expected = artifact.executable.clone();
    let staging_profile = profile.clone();
    let file =
        tokio::task::spawn_blocking(move || copy_local_asset(&staging_profile, &path, &expected))
            .await
            .map_err(|error| error.to_string())??;
    install_kernel(&profile, artifact, version, executable_in(&root), file).await
}

async fn install_kernel(
    profile: &Profile,
    artifact: &NativeArtifact,
    version: &str,
    executable: PathBuf,
    mut file: NamedTempFile,
) -> Result<VerifiedKernel, String> {
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
    if verify_cached(&executable, &artifact.executable).is_err() {
        let _writer = match fs::symlink_metadata(&executable) {
            Ok(_) => Some(profile.writer()?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        persist(file, &executable).map_err(|error| error.to_string())?;
    }
    Ok(VerifiedKernel {
        executable,
        version: version.to_owned(),
    })
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
    #[ignore = "downloads the original public executable for the running platform"]
    async fn downloads_the_published_bamboo_and_reuses_its_verified_cache() {
        let channel = crate::component_channel::tests::fixture_channel().await;
        let candidate = channel.select(None).unwrap().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let (_, source) = watch::channel(DownloadSettings::default());
        let mut downloaded = 0;
        let kernel = prepare_kernel(
            scratch.path(),
            &candidate,
            source.clone(),
            |source, bytes, total| {
                assert_eq!(source, Some(DownloadSource::GitHub));
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
