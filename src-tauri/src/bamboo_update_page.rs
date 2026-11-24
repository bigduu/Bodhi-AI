use crate::i18n::{self, Locale};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, Runtime, Url, WebviewWindow};
use tokio::sync::oneshot;

pub(crate) const SCHEME: &str = "bodhi-update";

pub(crate) fn response(locale: Locale) -> tauri::http::Response<Vec<u8>> {
    let escape = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let page = include_str!("../../bodhi-splash/bamboo-update.html")
        .replace("{{locale}}", locale.tag())
        .replace("{{title}}", &escape(locale.text("kernel.title")))
        .replace(
            "{{heading}}",
            &escape(locale.text("kernel.transitionHeading")),
        )
        .replace("{{hint}}", &escape(locale.text("kernel.transitionHint")));
    tauri::http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        .body(page.into_bytes())
        .expect("valid bundled update page response")
}

pub(crate) struct UpdatePage {
    base: Url,
    parked: Mutex<Option<Parked>>,
}

struct Parked {
    url: Url,
    resume: Url,
    committed: Option<oneshot::Sender<()>>,
}

impl UpdatePage {
    pub(crate) fn new(use_https_scheme: bool) -> Self {
        let base = if cfg!(any(windows, target_os = "android")) {
            let scheme = if use_https_scheme { "https" } else { "http" };
            format!("{scheme}://{SCHEME}.localhost/")
        } else {
            format!("{SCHEME}://localhost/")
        };
        Self {
            base: Url::parse(&base).expect("valid bundled update page URL"),
            parked: Mutex::new(None),
        }
    }

    pub(crate) fn allows_navigation(&self, url: &Url) -> bool {
        let Ok(parked) = self.parked.lock() else {
            return false;
        };
        match parked.as_ref() {
            Some(page) => &page.url == url,
            // Once a restore begins, a delayed transition navigation must
            // not take the window back to the local update page.
            None => url.scheme() != self.base.scheme() || url.host() != self.base.host(),
        }
    }

    pub(crate) fn needs_restore(&self) -> bool {
        self.parked.lock().is_ok_and(|parked| parked.is_some())
    }

    pub(crate) fn committed(&self, url: &Url) {
        if let Ok(mut parked) = self.parked.lock() {
            if let Some(page) = parked.as_mut().filter(|page| &page.url == url) {
                if let Some(sender) = page.committed.take() {
                    let _ = sender.send(());
                }
            }
        }
    }

    fn begin(&self, resume: Url) -> Result<(Url, oneshot::Receiver<()>), String> {
        let mut parked = self.parked.lock().map_err(|error| error.to_string())?;
        let mut url = self.base.clone();
        // A late event from a previous attempt cannot authorize this switch.
        url.query_pairs_mut()
            .append_pair("attempt", &uuid::Uuid::new_v4().to_string());
        let (sender, receiver) = oneshot::channel();
        *parked = Some(Parked {
            url: url.clone(),
            resume: parked.as_ref().map_or(resume, |page| page.resume.clone()),
            committed: Some(sender),
        });
        Ok((url, receiver))
    }

    pub(crate) async fn park<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        frontend: &Url,
    ) -> Result<(), String> {
        let resume = window
            .url()
            .ok()
            .filter(|url| url.origin() == frontend.origin())
            .unwrap_or_else(|| frontend.clone());
        let (url, committed) = self.begin(resume)?;
        window
            .navigate(url.clone())
            .map_err(|error| error.to_string())?;
        let committed = tokio::time::timeout(Duration::from_secs(10), committed).await;
        if !matches!(committed, Ok(Ok(()))) || !window.url().is_ok_and(|current| current == url) {
            return Err(i18n::active(window.app_handle())
                .text("kernel.transitionFailed")
                .into());
        }
        log::info!("Bodhi update page committed before Bamboo handoff");
        Ok(())
    }

    fn release(&self) -> Result<Parked, String> {
        let mut parked = self.parked.lock().map_err(|error| error.to_string())?;
        parked
            .take()
            .ok_or_else(|| "Missing Bamboo update page".into())
    }

    pub(crate) fn resume<R: Runtime>(&self, window: &WebviewWindow<R>) -> Result<(), String> {
        let page = self.release()?;
        if let Err(error) = window.navigate(page.resume.clone()) {
            *self.parked.lock().map_err(|error| error.to_string())? = Some(page);
            return Err(error.to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_transition_has_translated_text_and_no_script_access() {
        let response = response(Locale::TraditionalChinese);
        let html = std::str::from_utf8(response.body()).unwrap();
        assert!(html.contains("lang=\"zh-TW\""));
        assert!(html.contains("正在切換 Bamboo 核心"));
        assert!(!html.contains("{{"));
        assert!(response.headers()["Content-Security-Policy"]
            .to_str()
            .unwrap()
            .starts_with("default-src 'none'"));
    }

    #[test]
    fn only_the_current_local_page_can_load_until_the_frontend_is_restored() {
        let page = UpdatePage::new(false);
        let origin = Url::parse("http://127.0.0.1:19562/").unwrap();
        let session = origin.join("chat/session").unwrap();
        assert!(page.allows_navigation(&session));

        let (first, _) = page.begin(session.clone()).unwrap();
        let (retry, mut committed) = page.begin(origin.clone()).unwrap();
        assert!(page.needs_restore());
        assert!(page.allows_navigation(&retry));
        assert!(!page.allows_navigation(&session));
        assert!(!page.allows_navigation(&first));
        page.committed(&session);
        page.committed(&first);
        assert_eq!(
            committed.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        page.committed(&retry);
        assert_eq!(committed.try_recv(), Ok(()));
        assert!(!page.allows_navigation(&origin));

        assert_eq!(page.release().unwrap().resume, session);
        assert!(!page.needs_restore());
        assert!(page.allows_navigation(&session));
        assert!(!page.allows_navigation(&retry));
    }
}
