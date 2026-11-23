//! Restore an already approved published frontend from the official npm tarball.
use super::{cache_slot, safe_relative, verify_resource, Receipt, VerifiedFrontend};
use crate::bamboo_profile::Profile;
use crate::component_channel::Asset;
use flate2::read::GzDecoder;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::path::Path;
use std::time::Duration;

const MAX_DOWNLOAD: usize = 32 * 1024 * 1024;
const MAX_UNPACKED: u64 = 128 * 1024 * 1024;
const MAX_ENTRIES: usize = 16_384;

pub(super) async fn acquire(
    profile: &Profile,
    expected: &[u8],
    receipt: &Receipt,
) -> Result<VerifiedFrontend, String> {
    let bytes = fetch(&receipt.version, None, |_, _| {}).await?;
    let expected = expected.to_vec();
    let profile = profile.clone();
    tokio::task::spawn_blocking(move || install(&profile, &expected, &bytes))
        .await
        .map_err(|error| error.to_string())?
}

pub(super) async fn fetch(
    version: &str,
    approved: Option<&Asset>,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<Vec<u8>, String> {
    let version = semver::Version::parse(version).map_err(|error| error.to_string())?;
    let limit = approved.map_or(MAX_DOWNLOAD as u64, |asset| asset.size_bytes);
    if limit == 0 || limit > MAX_DOWNLOAD as u64 {
        return Err("Lotus Next download exceeds its size limit".into());
    }
    let url = format!("https://registry.npmjs.org/@bigduu/lotus-next/-/lotus-next-{version}.tgz");
    let client = reqwest::Client::builder()
        .https_only(true)
        .no_gzip()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("npm returned HTTP {}", response.status()));
    }
    let content_length = response.content_length();
    if content_length.is_some_and(|size| size > limit) {
        return Err("Lotus Next download exceeds its size limit".into());
    }
    let total = approved.map(|asset| asset.size_bytes).or(content_length);
    let mut bytes = Vec::new();
    progress(0, total);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| error.without_url().to_string())?
    {
        if chunk.len() as u64 > limit - bytes.len() as u64 {
            return Err("Lotus Next download exceeds its size limit".into());
        }
        bytes.extend_from_slice(&chunk);
        progress(bytes.len() as u64, total);
    }
    Ok(bytes)
}

fn install(profile: &Profile, expected: &[u8], bytes: &[u8]) -> Result<VerifiedFrontend, String> {
    let receipt: Receipt = serde_json::from_slice(expected).map_err(|error| error.to_string())?;
    let slot = cache_slot(profile, expected);
    let scratch = tempfile::tempdir_in(&profile.state_dir).map_err(|error| error.to_string())?;
    let staged = scratch.path().join("frontend");
    extract_dist(bytes, &staged.join("dist"), Some(&receipt.files))
        .map_err(|error| error.to_string())?;
    fs::write(staged.join("receipt.json"), expected).map_err(|error| error.to_string())?;
    publish(profile, &staged, &slot, |root| {
        verify_resource(root, expected)
    })
}

pub(super) fn publish(
    profile: &Profile,
    staged: &Path,
    slot: &Path,
    verify: impl Fn(&Path) -> Result<VerifiedFrontend, String>,
) -> Result<VerifiedFrontend, String> {
    verify(staged)?;
    let _update = profile.update_lock()?;
    if let Ok(frontend) = verify(slot) {
        return Ok(frontend);
    }
    // New slots may be prepared while Bamboo is running. Replacing the
    // bytes of an existing slot requires the exclusive profile writer lease.
    let (_writer, quarantined) = match fs::symlink_metadata(slot) {
        Ok(_) => {
            let writer = profile.writer()?;
            let quarantine = tempfile::tempdir_in(&profile.state_dir).map_err(|e| e.to_string())?;
            fs::rename(slot, quarantine.path().join("frontend")).map_err(|e| e.to_string())?;
            (Some(writer), Some(quarantine))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => (None, None),
        Err(error) => return Err(error.to_string()),
    };
    if let Err(error) = fs::rename(staged, slot) {
        if let Some(quarantine) = quarantined {
            if let Err(restore) = fs::rename(quarantine.path().join("frontend"), slot) {
                let retained = quarantine.keep();
                return Err(format!(
                    "{error}. Could not restore {}: {restore}",
                    retained.display()
                ));
            }
        }
        return Err(error.to_string());
    }
    verify(slot)
}

pub(super) fn extract_dist(
    bytes: &[u8],
    output: &Path,
    approved_files: Option<&BTreeMap<String, String>>,
) -> io::Result<()> {
    let mut archive = tar::Archive::new(GzDecoder::new(bytes).take(MAX_UNPACKED + 1));
    for (number, item) in archive.entries()?.enumerate() {
        let mut entry = item?;
        let name = entry.path_bytes();
        let name = std::str::from_utf8(&name)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "non-UTF8 package path"))?;
        let name = name.trim_end_matches('/');
        let kind = entry.header().entry_type();
        if number >= MAX_ENTRIES || !safe_relative(name) || !(kind.is_file() || kind.is_dir()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid Lotus Next archive entry",
            ));
        }
        let Some(resource) = name.strip_prefix("package/dist/") else {
            continue;
        };
        if kind.is_dir() {
            continue;
        }
        if approved_files.is_some_and(|files| !files.contains_key(resource)) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unapproved Lotus Next resource",
            ));
        }
        let destination = output.join(resource);
        fs::create_dir_all(destination.parent().expect("dist resource parent"))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        io::copy(&mut entry, &mut file)?;
    }
    let mut unpacked = archive.into_inner();
    // Consume the gzip member, including its checksum, under the same cap.
    io::copy(&mut unpacked, &mut io::sink())?;
    if unpacked.limit() == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Lotus Next archive is too large",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontend::tests::package_fixture;
    use flate2::{write::GzEncoder, Compression};

    fn archive(dist: &Path, unexpected: bool) -> Vec<u8> {
        let mut package = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
        for path in ["index.html", "assets/app.js", "lotus-next-manifest.json"] {
            package
                .append_path_with_name(dist.join(path), format!("package/dist/{path}"))
                .unwrap();
        }
        if unexpected {
            package
                .append_path_with_name(dist.join("index.html"), "package/dist/unknown.html")
                .unwrap();
        }
        package.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn published_cache_commits_only_after_verification_and_repairs_when_idle() {
        let (bundle, expected) = package_fixture();
        let dist = bundle.path().join("frontend/dist");
        let data = tempfile::tempdir().unwrap();
        let profile = Profile::open(data.path()).unwrap();
        let correct = archive(&dist, false);
        let wrong_inventory = archive(&dist, true);
        fs::write(dist.join("assets/app.js"), b"unverified bytes").unwrap();
        let wrong_bytes = archive(&dist, false);
        assert!(install(&profile, &expected, &wrong_inventory).is_err());
        assert!(install(&profile, &expected, &wrong_bytes).is_err());
        assert!(install(&profile, &expected, &correct[..correct.len() - 4]).is_err());
        assert!(!cache_slot(&profile, &expected).exists());

        let frontend = install(&profile, &expected, &correct).unwrap();
        let app_js = frontend.static_dir.unwrap().join("assets/app.js");
        fs::write(&app_js, b"damaged cache").unwrap();
        let active_writer = profile.writer().unwrap();
        assert!(install(&profile, &expected, &correct).is_err());
        assert_eq!(fs::read(&app_js).unwrap(), b"damaged cache");
        drop(active_writer);
        install(&profile, &expected, &correct).unwrap();
        assert_eq!(fs::read(app_js).unwrap(), b"console.log('Lotus Next')");
    }
}
