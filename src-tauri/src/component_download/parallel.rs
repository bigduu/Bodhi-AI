//! Download disjoint ranges while keeping the existing partial file contiguous.
use super::{identity_encoding, valid_range};
use futures_util::{stream, StreamExt};
use reqwest::header::{ACCEPT_ENCODING, RANGE};
use reqwest::{Client, Response, StatusCode, Url};
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};

const CONCURRENT_RANGES: usize = 4;
pub(super) const CHUNK_SIZE: u64 = 8 * 1024 * 1024;
pub(super) const MIN_REMAINING: u64 = CONCURRENT_RANGES as u64 * CHUNK_SIZE;

/// Return false to let the serial downloader continue from the committed prefix.
pub(super) async fn transfer(
    client: &Client,
    url: &Url,
    file: &mut File,
    total: u64,
    progress: &mut (impl FnMut(u64) + Send),
    chunk_size: u64,
) -> Result<bool, String> {
    let start = file.metadata().map_err(|error| error.to_string())?.len();
    if start >= total {
        return Ok(false);
    }
    progress(start);
    // A server or mirror may ignore Range. Confirm a bounded range before
    // opening more requests, and reuse the approved redirect for this attempt.
    let Some(probe) = range(client, url, start, start + 1, total).await else {
        return Ok(false);
    };
    let url = probe.url().clone();
    drop(probe);
    let mut chunks = stream::iter((start..total).step_by(chunk_size as usize))
        .map(|start| {
            read_chunk(
                client,
                &url,
                start,
                start.saturating_add(chunk_size).min(total),
                total,
            )
        })
        .buffered(CONCURRENT_RANGES);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut received = start;
    while let Some(chunk) = chunks.next().await {
        let Some(chunk) = chunk else {
            return Ok(false);
        };
        file.write_all(&chunk).map_err(|error| error.to_string())?;
        received += chunk.len() as u64;
        progress(received);
    }
    Ok(true)
}

async fn range(client: &Client, url: &Url, start: u64, end: u64, total: u64) -> Option<Response> {
    let response = client
        .get(url.clone())
        .header(ACCEPT_ENCODING, "identity")
        .header(RANGE, format!("bytes={start}-{}", end - 1))
        .send()
        .await
        .ok()?;
    (response.status() == StatusCode::PARTIAL_CONTENT
        && valid_range(&response, start, end, total)
        && identity_encoding(&response)
        && response
            .content_length()
            .is_none_or(|length| length == end - start))
    .then_some(response)
}

async fn read_chunk(
    client: &Client,
    url: &Url,
    start: u64,
    end: u64,
    total: u64,
) -> Option<Vec<u8>> {
    let mut response = range(client, url, start, end, total).await?;
    let size = (end - start) as usize;
    let mut bytes = Vec::with_capacity(size);
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > size - bytes.len() {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    (bytes.len() == size).then_some(bytes)
}

#[cfg(test)]
mod tests;
