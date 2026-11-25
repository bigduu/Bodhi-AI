use super::super::{transfer as transfer_serial, Partial};
use super::transfer;
use crate::bamboo_profile::Profile;
use crate::component_channel::Asset;
use reqwest::{Client, Url};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::time::timeout;

const DEADLINE: Duration = Duration::from_secs(10);

async fn listen() -> (TcpListener, Url) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!(
        "http://{}/component",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    (listener, url)
}

fn client() -> Client {
    Client::builder()
        .no_proxy()
        .no_gzip()
        .timeout(DEADLINE)
        .build()
        .unwrap()
}

async fn accept_range(listener: &TcpListener) -> (String, BufReader<TcpStream>) {
    let (stream, _) = listener.accept().await.unwrap();
    let mut stream = BufReader::new(stream);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        assert_ne!(stream.read_line(&mut line).await.unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        headers.push_str(&line.to_ascii_lowercase());
    }
    assert!(headers.contains("\r\naccept-encoding: identity\r\n"));
    let range = headers
        .lines()
        .find_map(|line| line.strip_prefix("range: "))
        .expect("expected one range request")
        .to_owned();
    (range, stream)
}

async fn reply(
    mut stream: BufReader<TcpStream>,
    status: &str,
    range: Option<&str>,
    length: usize,
    body: &[u8],
) -> std::io::Result<()> {
    let mut headers =
        format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {length}\r\n");
    if let Some(range) = range {
        headers.push_str(&format!("Content-Range: {range}\r\n"));
    }
    headers.push_str("\r\n");
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await
}

async fn probe(listener: &TcpListener, body: &[u8], offset: usize) {
    let (range, stream) = accept_range(listener).await;
    assert_eq!(range, format!("bytes={offset}-{offset}"));
    let content_range = format!("bytes {offset}-{offset}/{}", body.len());
    reply(
        stream,
        "206 Partial Content",
        Some(&content_range),
        1,
        &body[offset..=offset],
    )
    .await
    .unwrap();
}

fn partial(prefix: &[u8]) -> File {
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(prefix).unwrap();
    file.rewind().unwrap();
    file
}

fn contents(file: &mut File) -> Vec<u8> {
    file.rewind().unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    bytes
}

#[tokio::test]
async fn four_requests_overlap_and_append_to_a_legacy_prefix_in_order() {
    const BODY: &[u8] = b"abcdefghijklmn";
    let (listener, url) = listen().await;
    let server = tokio::spawn(async move {
        probe(&listener, BODY, 2).await;
        let mut requests = Vec::new();
        // Reply only after all four chunk requests have arrived. A serial
        // downloader cannot reach the reply loop under this test's deadline.
        for _ in 0..4 {
            requests.push(accept_range(&listener).await);
        }
        for (start, end) in [(11, 13), (8, 10), (5, 7), (2, 4)] {
            let requested = format!("bytes={start}-{end}");
            let index = requests
                .iter()
                .position(|(range, _)| range == &requested)
                .unwrap();
            let (_, stream) = requests.swap_remove(index);
            let range = format!("bytes {start}-{end}/{}", BODY.len());
            reply(
                stream,
                "206 Partial Content",
                Some(&range),
                end - start + 1,
                &BODY[start..=end],
            )
            .await
            .unwrap();
        }
    });
    let mut file = partial(&BODY[..2]);
    let mut progress = Vec::new();
    let completed = timeout(
        DEADLINE,
        transfer(
            &client(),
            &url,
            &mut file,
            BODY.len() as u64,
            &mut |size| progress.push(size),
            3,
        ),
    )
    .await
    .expect("expected concurrent requests")
    .unwrap();
    assert!(completed);
    timeout(DEADLINE, server).await.unwrap().unwrap();
    assert_eq!(contents(&mut file), BODY);
    assert_eq!(progress.first(), Some(&2));
    assert_eq!(progress.last(), Some(&(BODY.len() as u64)));
    assert!(progress.windows(2).all(|sizes| sizes[0] <= sizes[1]));
}

#[tokio::test]
async fn an_ignored_or_rejected_probe_preserves_the_existing_prefix() {
    const BODY: &[u8] = b"abcdefgh";
    for (status, content_range, payload) in [
        ("200 OK", None, BODY),
        (
            "416 Range Not Satisfiable",
            Some("bytes */8"),
            b"".as_slice(),
        ),
        ("206 Partial Content", Some("bytes 3-3/8"), b"d".as_slice()),
    ] {
        let (listener, url) = listen().await;
        let server = tokio::spawn(async move {
            let (request, stream) = accept_range(&listener).await;
            assert_eq!(request, "bytes=2-2");
            // The client may drop the response as soon as it sees the headers.
            let _ = reply(stream, status, content_range, payload.len(), payload).await;
        });
        let mut file = partial(&BODY[..2]);
        let completed = timeout(
            DEADLINE,
            transfer(
                &client(),
                &url,
                &mut file,
                BODY.len() as u64,
                &mut |_| {},
                3,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            !completed,
            "{status} should fall back to the serial downloader"
        );
        timeout(DEADLINE, server).await.unwrap().unwrap();
        assert_eq!(contents(&mut file), &BODY[..2]);
    }
}

#[tokio::test]
async fn a_malformed_or_disconnected_chunk_resumes_from_the_committed_prefix() {
    const BODY: &[u8] = b"abcdefgh";
    for (content_range, payload) in [
        ("bytes 5-7/9", b"fgh".as_slice()),
        ("bytes 5-7/8", b"fg".as_slice()),
    ] {
        let (listener, url) = listen().await;
        let committed = Arc::new(Notify::new());
        let server_committed = committed.clone();
        let server = tokio::spawn(async move {
            probe(&listener, BODY, 2).await;
            let first = accept_range(&listener).await;
            let second = accept_range(&listener).await;
            let (first, second) = if first.0 == "bytes=2-4" {
                (first, second)
            } else {
                (second, first)
            };
            assert_eq!(first.0, "bytes=2-4");
            assert_eq!(second.0, "bytes=5-7");
            reply(
                first.1,
                "206 Partial Content",
                Some("bytes 2-4/8"),
                3,
                b"cde",
            )
            .await
            .unwrap();
            // Guarantee the valid first chunk was committed before rejecting
            // the second, so the last three bytes must remain resumable.
            server_committed.notified().await;
            let _ = reply(
                second.1,
                "206 Partial Content",
                Some(content_range),
                3,
                payload,
            )
            .await;
        });
        let directory = tempfile::tempdir().unwrap();
        let profile = Profile::open(directory.path()).unwrap();
        let expected = Asset {
            size_bytes: BODY.len() as u64,
            sha256: format!("{:x}", Sha256::digest(BODY)),
        };
        let mut pending = Partial::open(&profile, &url, &expected).unwrap();
        pending.file.write_all(&BODY[..2]).unwrap();
        let completed = timeout(
            DEADLINE,
            transfer(
                &client(),
                &url,
                &mut pending.file,
                expected.size_bytes,
                &mut |size| {
                    if size == 5 {
                        committed.notify_one();
                    }
                },
                3,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!completed);
        timeout(DEADLINE, server).await.unwrap().unwrap();
        assert_eq!(contents(&mut pending.file), &BODY[..5]);
        let path = pending.path.clone();
        drop(pending);

        let (listener, recovery_url) = listen().await;
        let recovery = tokio::spawn(async move {
            let (request, stream) = accept_range(&listener).await;
            assert_eq!(request, "bytes=5-");
            reply(
                stream,
                "206 Partial Content",
                Some("bytes 5-7/8"),
                3,
                b"fgh",
            )
            .await
            .unwrap();
        });
        let mut pending = Partial::open(&profile, &recovery_url, &expected).unwrap();
        assert_eq!(pending.path, path);
        let offset = timeout(
            DEADLINE,
            transfer_serial(
                &client(),
                &recovery_url,
                &mut pending.file,
                expected.size_bytes,
                &mut |_| {},
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(offset, 5);
        timeout(DEADLINE, recovery).await.unwrap().unwrap();
        assert!(pending.matches(&expected).unwrap());
        assert_eq!(contents(&mut pending.file), BODY);
    }
}
