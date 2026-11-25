//! Acquire immutable component artifacts using a profile-local partial file.
mod parallel;
mod settings;

pub(crate) use settings::{DownloadSettings, DownloadSource};

use crate::bamboo_profile::{create_directory, open_state_file, Profile};
use crate::component_channel::Asset;
use crate::frontend::valid_sha256;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode, Url};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::Duration;
use tempfile::{NamedTempFile, TempPath};
use tokio::sync::watch;

const MAX_ATTEMPTS: u64 = 3;

pub(crate) struct VerifiedDownload {
    pub file: NamedTempFile,
    // Protect the partial filename until its consumer publishes or drops it.
    _lock: File,
}

struct Partial {
    file: File,
    path: PathBuf,
    lock: File,
}

impl Partial {
    fn open(profile: &Profile, official: &Url, expected: &Asset) -> Result<Self, String> {
        if expected.size_bytes == 0 || !valid_sha256(&expected.sha256) {
            return Err("Invalid component download identity".into());
        }
        let directory = profile.state_dir.join("downloads");
        create_directory(&directory).map_err(|error| error.to_string())?;
        let lock = open_state_file(&directory.join("transfer.lock"), true).map_err(|error| {
            format!("Cannot lock component downloads for this profile: {error}")
        })?;
        let suffix = if official.path().ends_with(".exe") {
            ".part.exe"
        } else {
            ".part"
        };
        let path = directory.join(format!("{}{suffix}", expected.sha256));
        let file = open_state_file(&path, false).map_err(|error| error.to_string())?;
        Ok(Self { file, path, lock })
    }

    fn matches(&mut self, expected: &Asset) -> io::Result<bool> {
        self.file.rewind()?;
        let mut digest = Sha256::new();
        let length = io::copy(&mut self.file, &mut digest)?;
        if length != expected.size_bytes || format!("{:x}", digest.finalize()) != expected.sha256 {
            self.file.set_len(0)?;
            return Ok(false);
        }
        self.file.sync_all()?;
        self.file.rewind()?;
        Ok(true)
    }
}

pub(crate) async fn acquire_asset(
    profile: &Profile,
    official: &str,
    expected: &Asset,
    mut settings: watch::Receiver<DownloadSettings>,
    mut progress: impl FnMut(Option<DownloadSource>, u64, u64) + Send,
) -> Result<VerifiedDownload, String> {
    let official = Url::parse(official).map_err(|_| "Invalid official artifact URL")?;
    let mut partial = Partial::open(profile, &official, expected)?;
    let mut tried_clean = false;
    loop {
        let selected = settings.borrow_and_update().clone();
        let (url, source) = selected.route(&official)?;
        let client = selected.artifact_client(&official, &url)?;
        let mut report = |received| progress(source, received, expected.size_bytes);
        let work = transfer_asset(
            &client,
            &url,
            &mut partial.file,
            expected.size_bytes,
            &mut report,
            !tried_clean,
        );
        let Some(result) = while_selected(&mut settings, &selected, work).await else {
            continue;
        };
        let can_retry_clean = result?;
        let expected = expected.clone();
        let (checked, valid) = tokio::task::spawn_blocking(move || {
            let valid = partial.matches(&expected)?;
            Ok::<_, io::Error>((partial, valid))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
        partial = checked;
        if valid {
            let path = TempPath::from_path(partial.path);
            return Ok(VerifiedDownload {
                file: NamedTempFile::from_parts(partial.file, path),
                _lock: partial.lock,
            });
        }
        if !can_retry_clean || tried_clean {
            return Err("The downloaded bytes failed the component catalog SHA-256 check.".into());
        }
        tried_clean = true;
    }
}

pub(crate) async fn while_selected<T>(
    settings: &mut watch::Receiver<DownloadSettings>,
    selected: &DownloadSettings,
    work: impl std::future::Future<Output = T> + Send,
) -> Option<T> {
    tokio::pin!(work);
    tokio::select! {
        biased;
        changed = async { settings.wait_for(|settings| settings != selected).await.is_ok() } => {
            if changed { None } else { Some(work.await) }
        }
        output = &mut work => Some(output),
    }
}

async fn transfer_asset(
    client: &Client,
    url: &Url,
    file: &mut File,
    total: u64,
    progress: &mut (impl FnMut(u64) + Send),
    allow_parallel: bool,
) -> Result<bool, String> {
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    if allow_parallel
        && total.saturating_sub(size) >= parallel::MIN_REMAINING
        && parallel::transfer(client, url, file, total, progress, parallel::CHUNK_SIZE).await?
    {
        // If an origin serves inconsistent range bodies, retry from zero serially.
        return Ok(true);
    }
    transfer(client, url, file, total, progress)
        .await
        .map(|offset| offset != 0)
}

async fn transfer(
    client: &Client,
    url: &Url,
    file: &mut File,
    total: u64,
    progress: &mut (impl FnMut(u64) + Send),
) -> Result<u64, String> {
    for attempt in 1..MAX_ATTEMPTS {
        match request(client, url, file, total, progress).await {
            Err(TransferError::Interrupted(_)) => {
                tokio::time::sleep(Duration::from_secs(attempt)).await;
            }
            result => return result.map_err(TransferError::message),
        }
    }
    request(client, url, file, total, progress)
        .await
        .map_err(TransferError::message)
}

#[derive(Debug)]
enum TransferError {
    Interrupted(String),
    Invalid(String),
}

impl TransferError {
    fn network(error: reqwest::Error) -> Self {
        let retryable = !error.is_redirect() && !error.is_builder();
        let message = error.without_url().to_string();
        if retryable {
            Self::Interrupted(message)
        } else {
            Self::Invalid(message)
        }
    }

    fn message(self) -> String {
        match self {
            Self::Interrupted(message) => format!("Component download interrupted: {message}"),
            Self::Invalid(message) => message,
        }
    }
}

impl From<io::Error> for TransferError {
    fn from(error: io::Error) -> Self {
        Self::Invalid(error.to_string())
    }
}

async fn request(
    client: &Client,
    url: &Url,
    file: &mut File,
    total: u64,
    progress: &mut impl FnMut(u64),
) -> Result<u64, TransferError> {
    let mut offset = file.metadata()?.len();
    if offset > total {
        file.set_len(0)?;
        offset = 0;
    }
    progress(offset);
    if offset == total {
        return Ok(offset);
    }
    let mut range_start = offset;
    loop {
        let mut request = client.get(url.clone()).header(ACCEPT_ENCODING, "identity");
        if range_start > 0 {
            request = request.header(RANGE, format!("bytes={range_start}-"));
        }
        let mut response = request.send().await.map_err(TransferError::network)?;
        let resumed = match response.status() {
            StatusCode::OK => false,
            StatusCode::PARTIAL_CONTENT
                if range_start > 0 && valid_range(&response, range_start, total, total) =>
            {
                true
            }
            StatusCode::PARTIAL_CONTENT | StatusCode::RANGE_NOT_SATISFIABLE if range_start > 0 => {
                range_start = 0;
                continue;
            }
            status => {
                return Err(TransferError::Invalid(format!(
                    "The component download source returned HTTP {status}."
                )));
            }
        };
        let start = if resumed { range_start } else { 0 };
        if !identity_encoding(&response)
            || response
                .content_length()
                .is_some_and(|length| length != total - start)
        {
            return Err(TransferError::Invalid(
                "The component response encoding or size differs from the catalog.".into(),
            ));
        }
        if start != offset {
            file.set_len(0)?;
            progress(0);
        }
        file.seek(SeekFrom::Start(start))?;
        let mut received = start;
        while let Some(chunk) = response.chunk().await.map_err(TransferError::network)? {
            if chunk.len() as u64 > total - received {
                file.set_len(0)?;
                return Err(TransferError::Invalid(
                    "The component download exceeds its catalog size.".into(),
                ));
            }
            file.write_all(&chunk)?;
            received += chunk.len() as u64;
            progress(received);
        }
        if received != total {
            return Err(TransferError::Interrupted(
                "the response ended before the catalog size was reached".into(),
            ));
        }
        return Ok(start);
    }
}

fn identity_encoding(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get_all(CONTENT_ENCODING)
        .iter()
        .all(|value| value.as_bytes().eq_ignore_ascii_case(b"identity"))
}

fn valid_range(response: &reqwest::Response, start: u64, end: u64, total: u64) -> bool {
    let expected = format!("bytes {start}-{}/{total}", end - 1);
    let mut ranges = response.headers().get_all(CONTENT_RANGE).iter();
    ranges
        .next()
        .is_some_and(|range| range == expected.as_str())
        && ranges.next().is_none()
}

#[cfg(test)]
mod tests;
