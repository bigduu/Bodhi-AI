use std::sync::Mutex;
use std::time::Duration;
use tauri::{Runtime, Url, WebviewWindow};
use tokio::sync::oneshot;

pub(crate) const SCHEME: &str = "bodhi-update";

pub(crate) fn response() -> tauri::http::Response<&'static [u8]> {
    tauri::http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        .body(include_bytes!("../../bodhi-splash/bamboo-update.html").as_slice())
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
        self.parked
            .lock()
            .is_ok_and(|parked| parked.as_ref().is_none_or(|page| &page.url == url))
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
            return Err("Bodhi 未能切换到本地过渡页。请从帮助菜单重试应用。".into());
        }
        log::info!("Bodhi update page committed before Bamboo handoff");
        Ok(())
    }

    fn release(&self) -> Result<Url, String> {
        let mut parked = self.parked.lock().map_err(|error| error.to_string())?;
        Ok(parked.take().ok_or("Missing Bamboo update page")?.resume)
    }

    pub(crate) fn resume<R: Runtime>(&self, window: &WebviewWindow<R>) -> Result<(), String> {
        window
            .navigate(self.release()?)
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_current_local_page_can_load_until_the_frontend_is_restored() {
        let page = UpdatePage::new(false);
        let origin = Url::parse("http://127.0.0.1:19562/").unwrap();
        let session = origin.join("chat/session").unwrap();
        assert!(page.allows_navigation(&session));

        let (first, _) = page.begin(session.clone()).unwrap();
        let (retry, mut committed) = page.begin(origin.clone()).unwrap();
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

        assert_eq!(page.release().unwrap(), session);
        assert!(page.allows_navigation(&session));
    }
}
