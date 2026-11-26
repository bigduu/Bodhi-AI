use super::*;
use std::io::Read;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

const BODY: &[u8] = b"abcdefghij";

fn identity() -> Asset {
    Asset {
        size_bytes: BODY.len() as u64,
        sha256: format!("{:x}", Sha256::digest(BODY)),
    }
}

#[test]
fn imports_only_the_exact_local_payload_into_a_private_copy() {
    let profile_dir = tempfile::tempdir().unwrap();
    let source_dir = tempfile::tempdir().unwrap();
    let profile = Profile::open(profile_dir.path()).unwrap();
    let path = source_dir.path().join("bamboo-test-target.exe");
    let expected = identity();
    fs::write(&path, BODY).unwrap();

    let mut staged = copy_local_asset(&profile, &path, &expected).unwrap();
    assert!(staged.path().starts_with(&profile.state_dir));
    assert_eq!(staged.path().extension().unwrap(), "exe");
    fs::write(&path, b"abcdefghik").unwrap();
    let mut bytes = Vec::new();
    staged.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, BODY);
    let error = copy_local_asset(&profile, &path, &expected).unwrap_err();
    assert!(error.contains("SHA-256"), "{error}");

    fs::write(&path, b"short").unwrap();
    let error = copy_local_asset(&profile, &path, &expected).unwrap_err();
    assert!(error.contains("unexpected file size"), "{error}");
    fs::write(&path, b"abcdefghijk").unwrap();
    let error = copy_local_asset(&profile, &path, &expected).unwrap_err();
    assert!(error.contains("unexpected file size"), "{error}");
}

#[test]
fn local_asset_open_rejects_a_directory() {
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(
        open_local_file(directory.path()).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
}

#[cfg(unix)]
#[test]
fn local_asset_open_rejects_a_symlink_to_an_otherwise_valid_file() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let link = directory.path().join("link");
    fs::write(&source, BODY).unwrap();
    std::os::unix::fs::symlink(source, &link).unwrap();
    assert_eq!(
        open_local_file(&link).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
}

async fn serve(responses: &[&'static str]) -> (Url, JoinHandle<Vec<String>>) {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/asset", server.local_addr().unwrap())).unwrap();
    let responses = responses.to_vec();
    let requests = tokio::spawn(async move {
        let mut requests = Vec::new();
        for response in responses {
            let (stream, _) = server.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if stream.read_line(&mut line).await.unwrap() == 0 || line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
            stream.write_all(response.as_bytes()).await.unwrap();
            if response.ends_with("\r\n\r\nabc") {
                // Let the consumer keep the prefix before closing the socket.
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            stream.shutdown().await.unwrap();
            requests.push(request.to_ascii_lowercase());
        }
        requests
    });
    (url, requests)
}

fn local_client() -> Client {
    Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

#[tokio::test]
async fn interrupted_bytes_survive_reopening_and_resume_from_another_source() {
    let (first, first_requests) =
        serve(&["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"]).await;
    let dir = tempfile::tempdir().unwrap();
    let expected = identity();
    let client = local_client();
    {
        let profile = Profile::open(dir.path()).unwrap();
        let mut partial = Partial::open(&profile, &first, &expected).unwrap();
        assert!(Partial::open(&profile, &first, &expected).is_err());
        let failure = request(&client, &first, &mut partial.file, 10, &mut |_| {}).await;
        assert!(matches!(failure, Err(TransferError::Interrupted(_))));
        assert_eq!(partial.file.metadata().unwrap().len(), 3);
    }
    let initial = &first_requests.await.unwrap()[0];
    assert!(!initial.contains("\r\nrange:"));
    assert!(initial.contains("\r\naccept-encoding: identity"));

    let (second, second_requests) = serve(&[
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 7\r\nContent-Range: bytes 3-9/10\r\n\r\ndefghij",
    ])
    .await;
    let profile = Profile::open(dir.path()).unwrap();
    let mut partial = Partial::open(&profile, &second, &expected).unwrap();
    let mut progress = Vec::new();
    let offset = request(&client, &second, &mut partial.file, 10, &mut |received| {
        progress.push(received);
    })
    .await
    .unwrap();
    assert_eq!(offset, 3);
    assert_eq!(progress.first(), Some(&3));
    assert_eq!(progress.last(), Some(&10));
    assert!(second_requests.await.unwrap()[0].contains("\r\nrange: bytes=3-"));
    assert!(partial.matches(&expected).unwrap());
    let mut bytes = Vec::new();
    partial.file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, BODY);
}

#[tokio::test]
async fn automatic_retry_requests_only_the_missing_bytes() {
    let (url, requests) = serve(&[
        "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc",
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 7\r\nContent-Range: bytes 3-9/10\r\n\r\ndefghij",
    ])
    .await;
    let mut file = tempfile::tempfile().unwrap();
    assert_eq!(
        transfer(&local_client(), &url, &mut file, 10, &mut |_| {})
            .await
            .unwrap(),
        3
    );
    assert!(requests.await.unwrap()[1].contains("\r\nrange: bytes=3-"));
    file.rewind().unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, BODY);
}

#[tokio::test]
async fn a_full_response_replaces_the_partial_instead_of_appending() {
    let (url, requests) = serve(&["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabcdefghij"]).await;
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(b"old").unwrap();
    let mut progress = Vec::new();
    let offset = request(&local_client(), &url, &mut file, 10, &mut |received| {
        progress.push(received);
    })
    .await
    .unwrap();
    assert_eq!(offset, 0);
    assert_eq!(progress[..2], [3, 0]);
    assert!(requests.await.unwrap()[0].contains("\r\nrange: bytes=3-"));
    file.rewind().unwrap();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, BODY);
}

#[tokio::test]
async fn an_invalid_content_range_or_416_gets_a_clean_retry() {
    for invalid in [
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 7\r\nContent-Range: bytes 2-8/10\r\n\r\nunknown",
        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */10\r\nContent-Length: 0\r\n\r\n",
    ] {
        let (url, requests) = serve(&[
            invalid,
            "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabcdefghij",
        ])
        .await;
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"old").unwrap();
        let offset = request(&local_client(), &url, &mut file, 10, &mut |_| {})
            .await
            .unwrap();
        let requests = requests.await.unwrap();
        assert!(requests[0].contains("\r\nrange: bytes=3-"));
        assert!(!requests[1].contains("\r\nrange:"));
        assert_eq!(offset, 0);
        file.rewind().unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, BODY);
    }
}

#[tokio::test]
async fn a_failed_full_fallback_preserves_the_partial() {
    let (url, requests) = serve(&[
        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\n\r\n",
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
    ])
    .await;
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(b"abc").unwrap();
    let result = request(&local_client(), &url, &mut file, 10, &mut |_| {}).await;
    assert!(matches!(result, Err(TransferError::Invalid(_))));
    assert_eq!(file.metadata().unwrap().len(), 3);
    assert!(!requests.await.unwrap()[1].contains("\r\nrange:"));
}

#[test]
fn a_complete_but_corrupt_partial_is_discarded() {
    let dir = tempfile::tempdir().unwrap();
    let profile = Profile::open(dir.path()).unwrap();
    let official = Url::parse("https://github.com/example/asset.exe").unwrap();
    let expected = identity();
    let mut partial = Partial::open(&profile, &official, &expected).unwrap();
    partial.file.write_all(b"zzzdefghij").unwrap();
    assert!(!partial.matches(&expected).unwrap());
    assert_eq!(partial.file.metadata().unwrap().len(), 0);
    assert_eq!(partial.path.extension().unwrap(), "exe");
}

#[tokio::test]
async fn saving_a_new_route_cancels_the_selected_request() {
    let original = DownloadSettings::default();
    let (sender, mut receiver) = watch::channel(original.clone());
    let next = DownloadSettings {
        proxy_url: Some("socks5h://localhost:1080".into()),
        ..DownloadSettings::default()
    };
    let result = while_selected(&mut receiver, &original, async {
        sender.send(next.clone()).unwrap();
        std::future::pending::<()>().await;
    })
    .await;
    assert!(result.is_none());
    assert_eq!(*receiver.borrow_and_update(), next);
}

#[test]
fn settings_preserve_presets_and_map_both_artifact_types_to_the_custom_mirror() {
    let github =
        Url::parse("https://github.com/bigduu/Bamboo-agent/releases/download/v1.0.0/bamboo.exe")
            .unwrap();
    let npm =
        Url::parse("https://registry.npmjs.org/@bigduu/lotus-next/-/lotus-next-1.0.0.tgz").unwrap();
    let mut settings = DownloadSettings::default();
    assert_eq!(
        settings.route(&github).unwrap(),
        (github.clone(), Some(DownloadSource::GitHub))
    );
    for (source, host) in [
        (DownloadSource::GhProxy, "gh-proxy.com"),
        (DownloadSource::GhFast, "ghfast.top"),
    ] {
        settings.source = source;
        assert_eq!(
            settings.route(&github).unwrap().0.as_str(),
            format!("https://{host}/{github}")
        );
        assert_eq!(settings.route(&npm).unwrap(), (npm.clone(), None));
    }
    settings.source = DownloadSource::Custom;
    settings.mirror_url = Some(" https://mirror.example.test/bodhi/ ".into());
    let settings = settings.validated().unwrap();
    for official in [github, npm] {
        let (url, source) = settings.route(&official).unwrap();
        assert_eq!(source, Some(DownloadSource::Custom));
        assert_eq!(
            url.as_str(),
            format!(
                "https://mirror.example.test/bodhi/{}{}",
                official.host_str().unwrap(),
                official.path()
            )
        );
    }
}

#[test]
fn unsupported_or_credential_bearing_endpoints_are_rejected() {
    for proxy in [
        "ftp://localhost:1234",
        "socks5://localhost",
        "http://user:secret@localhost:1234",
        "https://localhost:1234/path",
    ] {
        let settings = DownloadSettings {
            proxy_url: Some(proxy.into()),
            ..DownloadSettings::default()
        };
        assert!(settings.validated().is_err());
    }
    for url in [
        "http://example.test",
        "https://example.test/token?q=1",
        "https://secret@example.test",
    ] {
        let settings = DownloadSettings {
            source: DownloadSource::Custom,
            mirror_url: Some(url.into()),
            ..DownloadSettings::default()
        };
        assert!(settings.validated().is_err());
    }
}

#[tokio::test]
async fn the_configured_forward_proxy_receives_catalog_and_mirror_requests() {
    let (endpoint, requests) = serve(&[
        "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n",
        "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n",
    ])
    .await;
    let settings = DownloadSettings {
        source: DownloadSource::Custom,
        proxy_url: Some(endpoint.origin().ascii_serialization()),
        mirror_url: Some("https://mirror.example.test/bodhi/".into()),
    }
    .validated()
    .unwrap();
    assert!(crate::component_channel::load_stable(&settings)
        .await
        .is_err());
    let official =
        Url::parse("https://registry.npmjs.org/@bigduu/lotus-next/-/lotus-next-1.0.0.tgz").unwrap();
    let selected = settings.route(&official).unwrap().0;
    let client = settings.artifact_client(&official, &selected).unwrap();
    assert!(client.get(selected).send().await.is_err());
    let requests = requests.await.unwrap();
    assert!(requests[0].starts_with("connect raw.githubusercontent.com:443 "));
    assert!(requests[1].starts_with("connect mirror.example.test:443 "));
}
