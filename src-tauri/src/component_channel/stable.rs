//! Independent, Bodhi-managed stable component approvals.
use super::{
    bamboo_version, notes, producer_client, read_bounded_body, read_error, validate_bamboo_release,
    validate_lotus_release, BambooRelease, LotusRelease, ReleaseCheckError, MAX_CHANNEL_BYTES,
};
use crate::component_download::DownloadSettings;
use reqwest::{Client, StatusCode, Url};
use semver::Version;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const BAMBOO_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/bigduu/Bodhi-AI/components-stable/bamboo-v1.json";
const LOTUS_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/bigduu/Bodhi-AI/components-stable/lotus-v1.json";
const MAX_RELEASES: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StableEntry<T> {
    pub(crate) release: T,
    pub(crate) changes: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct StableCatalog<T> {
    pub(crate) revision: u64,
    pub(crate) digest: String,
    recommended_version: Option<Version>,
    releases: BTreeMap<Version, StableEntry<T>>,
    release_digests: BTreeMap<String, String>,
}

impl<T> StableCatalog<T> {
    pub(crate) fn recommended(&self) -> Option<&StableEntry<T>> {
        self.releases.get(self.recommended_version.as_ref()?)
    }

    pub(crate) fn find(&self, version: &str) -> Option<&StableEntry<T>> {
        self.releases.get(&Version::parse(version).ok()?)
    }

    pub(crate) fn release_digests(&self) -> &BTreeMap<String, String> {
        &self.release_digests
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document<T> {
    schema_version: u32,
    revision: u64,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    recommended_version: Option<String>,
    releases: Vec<StableEntry<T>>,
}

pub(crate) async fn load_bamboo(
    settings: &DownloadSettings,
) -> Result<StableCatalog<BambooRelease>, ReleaseCheckError> {
    let bytes = download(settings, BAMBOO_CATALOG_URL, "Bodhi Bamboo stable catalog").await?;
    parse_bamboo(&bytes)
}

pub(crate) async fn load_lotus(
    settings: &DownloadSettings,
) -> Result<StableCatalog<LotusRelease>, ReleaseCheckError> {
    let bytes = download(
        settings,
        LOTUS_CATALOG_URL,
        "Bodhi Lotus Next stable catalog",
    )
    .await?;
    parse_lotus(&bytes)
}

async fn download(
    settings: &DownloadSettings,
    url: &str,
    label: &str,
) -> Result<Vec<u8>, ReleaseCheckError> {
    let client = producer_client(settings, label)?;
    let url = Url::parse(url).map_err(|error| error.to_string())?;
    fetch(&client, url, label).await
}

async fn fetch(client: &Client, url: Url, label: &str) -> Result<Vec<u8>, ReleaseCheckError> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| read_error(error, label))?;
    let status = response.status();
    if status == StatusCode::OK {
        return read_bounded_body(response, MAX_CHANNEL_BYTES, label).await;
    }
    let message = format!("{label} returned HTTP {status}");
    if status.is_server_error()
        || matches!(
            status,
            StatusCode::FORBIDDEN | StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_MANY_REQUESTS
        )
    {
        return Err(ReleaseCheckError::Unavailable(message));
    }
    Err(ReleaseCheckError::Rejected(message))
}

pub(crate) fn parse_bamboo(
    bytes: &[u8],
) -> Result<StableCatalog<BambooRelease>, ReleaseCheckError> {
    parse(bytes, |release| {
        let version = validate_bamboo_release(release)?;
        if bamboo_version(version).is_none() {
            return Err("Invalid stable Bamboo version".into());
        }
        if release
            .artifacts
            .iter()
            .any(|artifact| artifact.browser_runtime.is_none())
        {
            return Err("The stable Bamboo release is missing a native browser runtime".into());
        }
        Ok(version)
    })
}

pub(crate) fn parse_lotus(bytes: &[u8]) -> Result<StableCatalog<LotusRelease>, ReleaseCheckError> {
    parse(bytes, validate_lotus_release)
}

pub(crate) fn release_digest(release: &impl Serialize) -> Result<String, ReleaseCheckError> {
    let identity = serde_json::to_vec(release)
        .map_err(|error| format!("Cannot encode stable component release identity: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(&identity)))
}

fn parse<T: DeserializeOwned + Serialize>(
    bytes: &[u8],
    validate_release: impl Fn(&T) -> Result<&str, String>,
) -> Result<StableCatalog<T>, ReleaseCheckError> {
    if bytes.len() > MAX_CHANNEL_BYTES {
        return Err("The stable component catalog exceeds its size limit".into());
    }
    let document: Document<T> = serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid stable component catalog JSON: {error}"))?;
    if document.schema_version != 1 || document.revision == 0 {
        return Err("Invalid stable component catalog schema or revision".into());
    }
    if document.releases.len() > MAX_RELEASES {
        return Err("The stable component catalog has too many retained releases".into());
    }

    let mut releases = BTreeMap::new();
    let mut release_digests = BTreeMap::new();
    for entry in document.releases {
        let version_text = validate_release(&entry.release)?;
        let version =
            Version::parse(version_text).map_err(|_| "Invalid stable component version")?;
        if releases
            .last_key_value()
            .is_some_and(|(last, _)| last >= &version)
        {
            return Err(
                "Stable component releases must have unique versions in ascending order".into(),
            );
        }
        if !notes(&entry.changes) {
            return Err("Invalid stable component release notes".into());
        }
        release_digests.insert(version_text.to_owned(), release_digest(&entry.release)?);
        releases.insert(version, entry);
    }
    let recommended_version = document
        .recommended_version
        .map(|version| {
            Version::parse(&version)
                .ok()
                .filter(|version| releases.contains_key(version))
                .ok_or("The recommended component release has no admitted identity")
        })
        .transpose()?;

    Ok(StableCatalog {
        revision: document.revision,
        digest: format!("{:x}", Sha256::digest(bytes)),
        recommended_version,
        releases,
        release_digests,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::component_channel::{tests as fixtures, Asset, BrowserRuntimeArtifact};
    use reqwest::redirect::Policy;
    use serde_json::{json, Value};
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn finds_the_recommended_and_retained_exact_release_identities() {
        let [recommended, retained] = fixtures::lotus_fixtures().await;
        let document = json!({
            "schemaVersion": 1,
            "revision": 3,
            "recommendedVersion": recommended.version,
            "releases": [
                { "release": recommended, "changes": ["Reviewed update"] },
                { "release": retained, "changes": [] }
            ]
        });
        let bytes = serde_json::to_vec(&document).unwrap();
        let catalog = parse_lotus(&bytes).unwrap();
        assert_eq!(catalog.revision, 3);
        assert_eq!(catalog.digest, format!("{:x}", Sha256::digest(&bytes)));
        assert_eq!(catalog.recommended().unwrap().release, recommended);
        assert_eq!(catalog.recommended().unwrap().changes, ["Reviewed update"]);
        assert_eq!(catalog.find(&retained.version).unwrap().release, retained);
        assert!(catalog.find("2026.11.26-rc.1").is_none());

        let mut revised = document;
        revised["revision"] = 4.into();
        revised["releases"][0]["changes"] = json!(["Edited release notes"]);
        let edited = parse_lotus(&serde_json::to_vec(&revised).unwrap()).unwrap();
        assert_ne!(catalog.digest, edited.digest);
        assert_eq!(catalog.release_digests(), edited.release_digests());
        revised["releases"][0]["release"]["manifestSha256"] = "f".repeat(64).into();
        let changed = parse_lotus(&serde_json::to_vec(&revised).unwrap()).unwrap();
        assert_ne!(catalog.release_digests(), changed.release_digests());

        let withdrawn = json!({
            "schemaVersion": 1, "revision": 5, "recommendedVersion": null, "releases": []
        });
        let catalog = parse_lotus(&serde_json::to_vec(&withdrawn).unwrap()).unwrap();
        assert!(catalog.recommended().is_none());
        assert!(catalog.find(&recommended.version).is_none());
    }

    #[tokio::test]
    async fn rejects_ambiguous_invalid_or_unbounded_catalog_documents() {
        let [older, newer] = fixtures::lotus_fixtures().await;
        let entry = json!({"release": older, "changes": []});
        let document = json!({
            "schemaVersion": 1, "revision": 1, "recommendedVersion": null,
            "releases": [entry]
        });
        let reject = |value: &Value, message: &str| {
            let error = parse_lotus(&serde_json::to_vec(value).unwrap()).unwrap_err();
            assert!(matches!(&error, ReleaseCheckError::Rejected(text) if text.contains(message)));
        };

        let mut changed = document.clone();
        changed["revision"] = 0.into();
        reject(&changed, "schema or revision");
        changed = document.clone();
        changed
            .as_object_mut()
            .unwrap()
            .remove("recommendedVersion");
        reject(&changed, "missing field `recommendedVersion`");
        changed["recommendedVersion"] = json!(newer.version);
        reject(&changed, "no admitted identity");
        changed = document.clone();
        changed["releases"] = json!([entry, entry]);
        reject(&changed, "unique versions");
        changed["releases"] = json!([{ "release": newer, "changes": [] }, entry]);
        reject(&changed, "ascending order");
        changed["releases"] = json!(vec![entry; MAX_RELEASES + 1]);
        reject(&changed, "too many retained releases");
        changed = document.clone();
        changed["releases"][0]["release"]["manifestSha256"] = json!("wrong digest");
        reject(&changed, "release identity");
        changed = document;
        changed["releases"][0]["changes"] = json!([" "]);
        reject(&changed, "release notes");
        assert!(matches!(
            parse_lotus(&vec![b' '; MAX_CHANNEL_BYTES + 1]),
            Err(ReleaseCheckError::Rejected(message)) if message.contains("size limit")
        ));
    }

    #[tokio::test]
    async fn stable_bamboo_requires_a_verified_runtime_for_every_native_target() {
        let mut release = fixtures::initial_combination().await.bamboo;
        for artifact in &mut release.artifacts {
            artifact.browser_runtime = Some(BrowserRuntimeArtifact {
                asset_name: format!("bamboo-browser-runtime-v1-{}.tar.gz", artifact.target),
                archive: Asset {
                    sha256: "a".repeat(64),
                    size_bytes: 1024,
                },
                receipt_sha256: "b".repeat(64),
            });
        }
        let mut document = json!({
            "schemaVersion": 1, "revision": 1, "recommendedVersion": release.version,
            "releases": [{ "release": release, "changes": [] }]
        });
        let parsed = parse_bamboo(&serde_json::to_vec(&document).unwrap()).unwrap();
        assert_eq!(parsed.recommended().unwrap().release, release);

        document["releases"][0]["release"]["artifacts"][2]["browserRuntime"] = Value::Null;
        assert!(matches!(
            parse_bamboo(&serde_json::to_vec(&document).unwrap()),
            Err(ReleaseCheckError::Rejected(message)) if message.contains("missing a native browser runtime")
        ));
        document["releases"][0]["release"]["artifacts"][2]["target"] = json!("wrong-target");
        assert!(matches!(
            parse_bamboo(&serde_json::to_vec(&document).unwrap()),
            Err(ReleaseCheckError::Rejected(message)) if message.contains("native artifact inventory")
        ));
    }

    #[tokio::test]
    async fn catalog_http_failures_are_classified_without_discarding_the_peer() {
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let available =
            r#"{"schemaVersion":1,"revision":1,"recommendedVersion":null,"releases":[]}"#;
        let bamboo = serve("503 Service Unavailable", "").await;
        let lotus = serve("200 OK", available).await;
        let (bamboo, lotus) = tokio::join!(
            fetch(&client, bamboo, "test Bamboo catalog"),
            fetch(&client, lotus, "test Lotus catalog"),
        );
        assert!(matches!(bamboo, Err(ReleaseCheckError::Unavailable(_))));
        assert_eq!(parse_lotus(&lotus.unwrap()).unwrap().revision, 1);

        let refused = serve("403 Forbidden", "").await;
        assert!(matches!(
            fetch(&client, refused, "test catalog").await,
            Err(ReleaseCheckError::Unavailable(_))
        ));
        let missing = serve("404 Not Found", "").await;
        assert!(matches!(
            fetch(&client, missing, "test catalog").await,
            Err(ReleaseCheckError::Rejected(_))
        ));
    }

    async fn serve(status: &'static str, body: &'static str) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/catalog",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut request = String::new();
            loop {
                let previous = request.len();
                assert_ne!(stream.read_line(&mut request).await.unwrap(), 0);
                if &request[previous..] == "\r\n" {
                    break;
                }
            }
            assert!(request.starts_with("GET /catalog HTTP/1.1\r\n"));
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .get_mut()
                .write_all(response.as_bytes())
                .await
                .unwrap();
        });
        url
    }
}
