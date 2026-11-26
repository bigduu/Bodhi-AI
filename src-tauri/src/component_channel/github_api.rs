//! The dedicated transport for the explicit GitHub connection test.
use super::github_token::GitHubUpdateCredentials;
use super::{producer_client, read_bounded_body, read_error, ReleaseCheckError};
use crate::component_download::DownloadSettings;
use chrono::{DateTime, TimeDelta, Utc};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use reqwest::{Client, RequestBuilder, Response, StatusCode, Url};
use serde::Deserialize;
use std::time::Duration;

const ORIGIN: &str = "https://api.github.com";
const RELEASE_PATH: &str = "/repos/bigduu/Bamboo-agent/releases/latest";
const ERROR_BODY_LIMIT: usize = 4 * 1024;

fn latest_url() -> Result<Url, GitHubApiFailure> {
    Url::parse(&format!("{ORIGIN}{RELEASE_PATH}"))
        .map_err(|_| ReleaseCheckError::from("Invalid official Bamboo REST endpoint").into())
}

#[derive(Debug)]
pub(super) enum GitHubApiFailure {
    InvalidToken,
    Quota {
        authenticated: bool,
        until: DateTime<Utc>,
    },
    Refused(StatusCode),
    Other(ReleaseCheckError),
}

impl GitHubApiFailure {
    pub(super) fn test_code(&self) -> &'static str {
        match self {
            Self::InvalidToken => "token-rejected",
            Self::Quota { .. } => "token-rate-limited",
            Self::Refused(_) => "github-api-refused",
            Self::Other(_) => "github-api-unavailable",
        }
    }
}

impl From<ReleaseCheckError> for GitHubApiFailure {
    fn from(error: ReleaseCheckError) -> Self {
        Self::Other(error)
    }
}

impl From<GitHubApiFailure> for ReleaseCheckError {
    fn from(error: GitHubApiFailure) -> Self {
        match error {
            GitHubApiFailure::InvalidToken => "GitHub rejected the Bamboo update token (HTTP 401). Replace or remove it and check again.".into(),
            GitHubApiFailure::Quota { authenticated, until } => {
                let kind = if authenticated { "authenticated" } else { "anonymous" };
                Self::Unavailable(format!(
                    "GitHub is rate-limiting {kind} Bamboo update checks. Try again after {}.",
                    until.with_timezone(&chrono::Local)
                ))
            }
            GitHubApiFailure::Refused(status) => format!(
                "GitHub refused the Bamboo update metadata request (HTTP {status}). Check the network or proxy settings."
            ).into(),
            GitHubApiFailure::Other(error) => error,
        }
    }
}

pub(super) struct GitHubApi<'a> {
    credentials: &'a GitHubUpdateCredentials,
    settings: &'a DownloadSettings,
    client: Client,
}

impl<'a> GitHubApi<'a> {
    pub(super) fn new(
        credentials: &'a GitHubUpdateCredentials,
        settings: &'a DownloadSettings,
    ) -> Result<Self, GitHubApiFailure> {
        Ok(Self {
            credentials,
            settings,
            client: producer_client(settings, "Bamboo release metadata")
                .map_err(ReleaseCheckError::from)?,
        })
    }

    pub(super) async fn read(
        &self,
        limit: usize,
        label: &str,
    ) -> Result<Vec<u8>, GitHubApiFailure> {
        let authorization = self.credentials.authorization();
        let authenticated = authorization.is_some();
        let proxy = &self.settings.proxy_url;
        if let Some(until) = self.credentials.retry_at(proxy, Utc::now()) {
            return Err(GitHubApiFailure::Quota {
                authenticated,
                until,
            });
        }
        let response = request(&self.client, latest_url()?, authorization)?
            .send()
            .await
            .map_err(|error| read_error(error, label))?;
        let status = response.status();
        if status == StatusCode::OK {
            return Ok(read_bounded_body(response, limit, label).await?);
        }
        if authenticated && status == StatusCode::UNAUTHORIZED {
            return Err(GitHubApiFailure::InvalidToken);
        }
        if status == StatusCode::FORBIDDEN || status == StatusCode::TOO_MANY_REQUESTS {
            let now = Utc::now();
            if let Some(until) = quota_deadline(response, now).await {
                self.credentials.restrict(proxy.clone(), now, until);
                return Err(GitHubApiFailure::Quota {
                    authenticated,
                    until,
                });
            }
            return Err(GitHubApiFailure::Refused(status));
        }
        Err(ReleaseCheckError::from(format!("{label} returned HTTP {status}")).into())
    }
}

fn request(
    client: &Client,
    url: Url,
    authorization: Option<HeaderValue>,
) -> Result<RequestBuilder, GitHubApiFailure> {
    // The only callers use fixed, typed API paths. Guard the origin again at the
    // header boundary so a future endpoint cannot transmit a token elsewhere.
    if url.origin().ascii_serialization() != ORIGIN
        || url.path() != RELEASE_PATH
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ReleaseCheckError::from("Invalid official Bamboo REST endpoint").into());
    }
    let mut request = client.get(url);
    if let Some(value) = authorization {
        request = request.header(AUTHORIZATION, value);
    }
    Ok(request)
}

async fn quota_deadline(response: Response, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let (exhausted, retry_after, reset) = quota_headers(response.headers(), now);
    let deadline = [retry_after, reset]
        .into_iter()
        .flatten()
        .filter(|time| *time > now)
        .max();
    if exhausted || retry_after.is_some() || response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Some(deadline.unwrap_or(now + TimeDelta::minutes(1)));
    }
    // GitHub may omit quota headers for a secondary limit. Only a recognized
    // bounded JSON response makes such a 403 eligible for the rate fallback.
    let body = tokio::time::timeout(
        Duration::from_millis(250),
        read_bounded_body(response, ERROR_BODY_LIMIT, "GitHub REST error"),
    )
    .await
    .ok()?
    .ok()?;
    let body: GitHubErrorBody = serde_json::from_slice(&body).ok()?;
    (body
        .message
        .starts_with("You have exceeded a secondary rate limit."))
    .then_some(now + TimeDelta::minutes(1))
}

#[derive(Deserialize)]
struct GitHubErrorBody {
    message: String,
}

fn quota_headers(
    headers: &HeaderMap,
    now: DateTime<Utc>,
) -> (bool, Option<DateTime<Utc>>, Option<DateTime<Utc>>) {
    let header = |name| headers.get(name).and_then(|value| value.to_str().ok());
    let exhausted = header("x-ratelimit-remaining") == Some("0");
    let retry_after = header("retry-after").and_then(|value| {
        value
            .parse::<i64>()
            .ok()
            .filter(|seconds| *seconds >= 0)
            .and_then(TimeDelta::try_seconds)
            .and_then(|delta| now.checked_add_signed(delta))
            .or_else(|| {
                DateTime::parse_from_rfc2822(value)
                    .ok()
                    .map(|time| time.to_utc())
            })
    });
    let reset = if exhausted {
        header("x-ratelimit-reset")
            .and_then(|value| value.parse().ok())
            .and_then(|epoch| DateTime::from_timestamp(epoch, 0))
    } else {
        None
    };
    (exhausted, retry_after, reset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_header_is_only_added_to_the_fixed_https_api_origin() {
        let client = Client::new();
        let mut auth = HeaderValue::from_static("Bearer github_pat_fixture_123");
        auth.set_sensitive(true);
        let authenticated = request(&client, latest_url().unwrap(), Some(auth.clone()))
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(authenticated.url().host_str(), Some("api.github.com"));
        assert!(authenticated.headers()[AUTHORIZATION].is_sensitive());
        assert!(!format!("{authenticated:?}").contains("github_pat_fixture_123"));
        let anonymous = request(&client, latest_url().unwrap(), None)
            .unwrap()
            .build()
            .unwrap();
        assert!(!anonymous.headers().contains_key(AUTHORIZATION));
        for address in [
            "http://api.github.com/repos/bigduu/Bamboo-agent/releases/latest",
            "https://api.github.com:8443/repos/bigduu/Bamboo-agent/releases/latest",
            "https://api.github.com@registry.npmjs.org/",
            "https://github.com/bigduu/Bamboo-agent/releases/latest",
            "https://release-assets.githubusercontent.com/download",
            "https://gh-proxy.com/",
            "https://api.github.com/user",
            "https://api.github.com/repos/bigduu/Bamboo-agent/contents",
            "https://api.github.com/repos/bigduu/Bamboo-agent/releases/tags/v2026.11.48",
            "https://api.github.com/repos/bigduu/Bamboo-agent/releases/latest?mirror=true",
        ] {
            assert!(request(&client, Url::parse(address).unwrap(), Some(auth.clone())).is_err());
        }
    }

    #[test]
    fn quota_headers_distinguish_empty_quota_from_ordinary_forbidden() {
        let now = DateTime::from_timestamp(1_800_000_000, 0).unwrap();
        let mut headers = HeaderMap::new();
        assert_eq!(quota_headers(&headers, now), (false, None, None));
        headers.insert("x-ratelimit-remaining", HeaderValue::from_static("0"));
        headers.insert("x-ratelimit-reset", HeaderValue::from_static("1800000060"));
        headers.insert("retry-after", HeaderValue::from_static("10"));
        assert_eq!(
            quota_headers(&headers, now),
            (
                true,
                Some(now + TimeDelta::seconds(10)),
                Some(now + TimeDelta::minutes(1))
            )
        );
    }

    #[tokio::test]
    async fn transport_keeps_credentials_out_of_other_requests_and_classifies_secondary_quota() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let client = Client::builder().no_proxy().build().unwrap();
        let mut auth = HeaderValue::from_static("Bearer github_pat_fixture_123");
        auth.set_sensitive(true);
        // Building an authenticated API request must not add default headers to
        // the underlying client, even if it is used for an unrelated request.
        let _ = request(&client, latest_url().unwrap(), Some(auth.clone()))
            .unwrap()
            .build()
            .unwrap();
        let now = DateTime::from_timestamp(1_800_000_000, 0).unwrap();
        for (body, deadline) in [
            (
                r#"{"message":"You have exceeded a secondary rate limit. Please wait."}"#,
                Some(now + TimeDelta::minutes(1)),
            ),
            (r#"{"message":"Forbidden by office network policy."}"#, None),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
            assert!(request(&client, url.clone(), Some(auth.clone())).is_err());
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request_bytes = Vec::new();
                let mut byte = [0];
                while !request_bytes.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).await.unwrap();
                    request_bytes.extend(byte);
                    assert!(request_bytes.len() < 8192);
                }
                let request_text = String::from_utf8(request_bytes)
                    .unwrap()
                    .to_ascii_lowercase();
                assert!(!request_text.contains("authorization"));
                let response = format!("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let response = client.get(url).send().await.unwrap();
            assert_eq!(quota_deadline(response, now).await, deadline);
            server.await.unwrap();
        }
    }
}
