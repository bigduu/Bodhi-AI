use reqwest::{redirect::Policy, Client, ClientBuilder, Proxy, Url};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Default, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DownloadSource {
    #[default]
    #[serde(rename = "github")]
    GitHub,
    GhProxy,
    GhFast,
    Custom,
}

#[derive(Debug, Default, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadSettings {
    pub source: DownloadSource,
    pub proxy_url: Option<String>,
    pub mirror_url: Option<String>,
}

impl DownloadSettings {
    pub fn validated(mut self) -> Result<Self, String> {
        self.proxy_url = optional_url(self.proxy_url);
        self.mirror_url = optional_url(self.mirror_url);
        if let Some(url) = &self.proxy_url {
            let parsed = endpoint(url).map_err(|_| invalid_proxy())?;
            if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h")
                || !matches!(parsed.path(), "" | "/")
                || parsed.port_or_known_default().is_none()
            {
                return Err(invalid_proxy());
            }
            Proxy::all(parsed).map_err(|_| invalid_proxy())?;
        }
        if let Some(url) = &self.mirror_url {
            mirror(url)?;
        }
        if self.source == DownloadSource::Custom && self.mirror_url.is_none() {
            return Err("Enter a custom HTTPS mirror URL.".into());
        }
        Ok(self)
    }

    pub fn client(&self) -> Result<ClientBuilder, String> {
        let builder = Client::builder().https_only(true);
        if let Some(url) = &self.proxy_url {
            Ok(builder.proxy(Proxy::all(url).map_err(|_| invalid_proxy())?))
        } else {
            Ok(builder)
        }
    }

    pub fn route(&self, official: &Url) -> Result<(Url, Option<DownloadSource>), String> {
        use DownloadSource::*;
        let github = official.host_str() == Some("github.com");
        match (self.source, github) {
            (Custom, _) => {
                let mut url = mirror(self.mirror_url.as_deref().unwrap_or_default())?;
                url.set_path(&format!(
                    "{}/{}{}",
                    url.path().trim_end_matches('/'),
                    official.host_str().ok_or("Missing artifact host")?,
                    official.path()
                ));
                Ok((url, Some(Custom)))
            }
            (GhProxy | GhFast, true) => {
                let host = if self.source == GhProxy {
                    "gh-proxy.com"
                } else {
                    "ghfast.top"
                };
                let url = Url::parse(&format!("https://{host}/{official}"))
                    .map_err(|_| "Invalid release mirror URL")?;
                Ok((url, Some(self.source)))
            }
            (_, true) => Ok((official.clone(), Some(GitHub))),
            (_, false) => Ok((official.clone(), None)),
        }
    }

    pub fn artifact_client(&self, official: &Url, selected: &Url) -> Result<Client, String> {
        let github = official.host_str() == Some("github.com");
        let original = official.origin();
        let selected = selected.origin();
        let redirects = if !github && original == selected {
            Policy::none()
        } else {
            Policy::custom(move |attempt| {
                let url = attempt.url();
                let from_github = github
                    && url.port_or_known_default() == Some(443)
                    && matches!(
                        url.host_str(),
                        Some(
                            "release-assets.githubusercontent.com"
                                | "objects.githubusercontent.com"
                        )
                    );
                if attempt.previous().len() < 5
                    && url.scheme() == "https"
                    && has_no_credentials(url)
                    && (url.origin() == selected || url.origin() == original || from_github)
                {
                    attempt.follow()
                } else {
                    attempt.error("unexpected component download redirect")
                }
            })
        };
        self.client()?
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .referer(false)
            .redirect(redirects)
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .timeout(Duration::from_secs(20 * 60))
            .build()
            .map_err(|error| error.without_url().to_string())
    }
}

fn optional_url(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn endpoint(url: &str) -> Result<Url, ()> {
    let parsed = Url::parse(url).map_err(|_| ())?;
    if url.len() > 2048
        || parsed.host_str().is_none()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(());
    }
    Ok(parsed)
}

fn has_no_credentials(url: &Url) -> bool {
    url.username().is_empty() && url.password().is_none()
}

fn mirror(url: &str) -> Result<Url, String> {
    endpoint(url)
        .ok()
        .filter(|url| url.scheme() == "https" && has_no_credentials(url))
        .ok_or_else(|| {
            "Enter an HTTPS mirror base URL without credentials, a query or a fragment.".into()
        })
}

fn invalid_proxy() -> String {
    "Enter an HTTP, HTTPS, SOCKS5 or SOCKS5H proxy URL with a host and port.".into()
}
