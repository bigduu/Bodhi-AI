use super::{MAX_CHANNEL_BYTES, REPOSITORY};
use futures_util::stream;
use reqwest::{Client, StatusCode, Url};
use std::io;
use std::time::Duration;
use tough::{async_trait, Bytes, Transport, TransportError, TransportErrorKind, TransportStream};

#[derive(Debug, Clone)]
pub(super) struct Https(Client);

impl Https {
    pub(super) fn new() -> Result<Self, String> {
        Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map(Self)
            .map_err(|e| e.to_string())
    }
}

#[async_trait]
impl Transport for Https {
    async fn fetch(&self, url: Url) -> Result<TransportStream, TransportError> {
        if !url.as_str().starts_with(REPOSITORY)
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(TransportError::new(
                TransportErrorKind::UnsupportedUrlScheme,
                url,
            ));
        }
        let mut response = self.0.get(url.clone()).send().await.map_err(|error| {
            TransportError::new_with_cause(TransportErrorKind::Other, &url, error.without_url())
        })?;
        match response.status() {
            StatusCode::OK => {
                let mut data = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|error| {
                    TransportError::new_with_cause(
                        TransportErrorKind::Other,
                        &url,
                        error.without_url(),
                    )
                })? {
                    if chunk.len() > MAX_CHANNEL_BYTES - data.len() {
                        return Err(TransportError::new_with_cause(
                            TransportErrorKind::Other,
                            url,
                            io::Error::other("component metadata exceeds its size limit"),
                        ));
                    }
                    data.extend_from_slice(&chunk);
                }
                Ok(Box::pin(stream::iter([Ok(Bytes::from(data))])))
            }
            StatusCode::NOT_FOUND => {
                Err(TransportError::new(TransportErrorKind::FileNotFound, url))
            }
            status => Err(TransportError::new_with_cause(
                TransportErrorKind::Other,
                url,
                io::Error::other(format!("unexpected HTTP status {status}")),
            )),
        }
    }
}
