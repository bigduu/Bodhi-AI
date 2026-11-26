use crate::i18n::{self, Locale};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{http, Manager, Runtime, Url, WebviewWindow};
use tokio::sync::oneshot;

pub(crate) const SCHEME: &str = "bodhi-update";
const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(10);
const RESUME_ATTEMPT: &str = "bodhi-restart";

#[derive(Clone, Copy)]
enum PageKind {
    LegacyUpdate,
    Restarting,
    RestartFailed,
}

fn response(locale: Locale, kind: PageKind) -> http::Response<Vec<u8>> {
    let escape = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let (heading, hint) = match kind {
        PageKind::LegacyUpdate => ("kernel.transitionHeading", "kernel.transitionHint"),
        PageKind::Restarting => (
            "kernel.restartTransitionHeading",
            "kernel.restartRetryFromUpdates",
        ),
        PageKind::RestartFailed => (
            "kernel.restartFailedHeading",
            "kernel.restartRetryFromUpdates",
        ),
    };
    let title = match kind {
        PageKind::LegacyUpdate => "kernel.title",
        _ => heading,
    };
    let page = include_str!("../../bodhi-splash/bamboo-update.html")
        .replace("{{locale}}", locale.tag())
        .replace("{{title}}", &escape(locale.text(title)))
        .replace("{{heading}}", &escape(locale.text(heading)))
        .replace("{{hint}}", &escape(locale.text(hint)));
    http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        .body(page.into_bytes())
        .expect("valid bundled update page response")
}

pub(crate) fn respond<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    uri: &http::Uri,
) -> http::Response<Vec<u8>> {
    if label == "main" {
        if let Some(kind) = app
            .try_state::<UpdatePage>()
            .and_then(|page| page.request_kind(uri))
        {
            return response(i18n::active(app), kind);
        }
    }
    http::Response::builder()
        .status(http::StatusCode::NOT_FOUND)
        .header("Cache-Control", "no-store")
        .body(Vec::new())
        .expect("valid update page not found response")
}

pub(crate) struct UpdatePage {
    base: Url,
    parked: Mutex<Option<Parked>>,
}

struct Navigation {
    url: Url,
    committed: Option<oneshot::Sender<()>>,
}

impl Navigation {
    fn new(url: Url) -> (Self, oneshot::Receiver<()>) {
        let (sender, receiver) = oneshot::channel();
        (
            Self {
                url,
                committed: Some(sender),
            },
            receiver,
        )
    }
}

struct Parked {
    local: Navigation,
    resume: Url,
    kind: PageKind,
    restoring: Option<Navigation>,
}

impl Parked {
    fn permitted(&mut self) -> &mut Navigation {
        self.restoring.as_mut().unwrap_or(&mut self.local)
    }

    fn permits(&self, url: &Url) -> bool {
        self.restoring.as_ref().unwrap_or(&self.local).url == *url
    }
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
            Some(page) => page.permits(url),
            // Once a restore begins, a delayed transition navigation must
            // not take the window back to the local update page.
            None => url.scheme() != self.base.scheme() || url.host() != self.base.host(),
        }
    }

    pub(crate) fn needs_restore(&self) -> bool {
        self.parked.lock().is_ok_and(|parked| parked.is_some())
    }

    fn request_kind(&self, uri: &http::Uri) -> Option<PageKind> {
        let parked = self.parked.lock().ok()?;
        let page = parked.as_ref().filter(|page| page.restoring.is_none())?;
        let url = &page.local.url;
        // Some engines translate the custom scheme to a local HTTP(S)
        // request. Check the exact attempt using fields common to both.
        (uri.path() == url.path() && uri.query() == url.query()).then_some(page.kind)
    }

    pub(crate) fn committed(&self, url: &Url) {
        if let Ok(mut parked) = self.parked.lock() {
            if let Some(page) = parked.as_mut().filter(|page| page.permits(url)) {
                if let Some(sender) = page.permitted().committed.take() {
                    let _ = sender.send(());
                }
            }
        }
    }

    fn begin(&self, resume: Url, kind: PageKind) -> Result<(Url, oneshot::Receiver<()>), String> {
        let mut parked = self.parked.lock().map_err(|error| error.to_string())?;
        let mut url = self.base.clone();
        // A late event from a previous attempt cannot authorize this switch.
        url.query_pairs_mut()
            .append_pair("attempt", &uuid::Uuid::new_v4().to_string());
        let (local, receiver) = Navigation::new(url.clone());
        *parked = Some(Parked {
            local,
            resume: parked.as_ref().map_or(resume, |page| page.resume.clone()),
            kind,
            restoring: None,
        });
        Ok((url, receiver))
    }

    async fn park_with_kind<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        frontend: &Url,
        kind: PageKind,
    ) -> Result<(), String> {
        let resume = window
            .url()
            .ok()
            .filter(|url| safe_route(url, frontend))
            .unwrap_or_else(|| frontend.clone());
        let (url, committed) = self.begin(resume, kind)?;
        self.navigate_local(window, &url, committed).await?;
        log::info!("Bodhi update page committed before Bamboo handoff");
        Ok(())
    }

    async fn navigate_local<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        url: &Url,
        committed: oneshot::Receiver<()>,
    ) -> Result<(), String> {
        window
            .navigate(url.clone())
            .map_err(|error| error.to_string())?;
        if !navigation_committed(committed).await
            || !window.url().is_ok_and(|current| current == *url)
        {
            return Err(i18n::active(window.app_handle())
                .text("kernel.transitionFailed")
                .into());
        }
        Ok(())
    }

    pub(crate) async fn park<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        frontend: &Url,
    ) -> Result<(), String> {
        self.park_with_kind(window, frontend, PageKind::LegacyUpdate)
            .await
    }

    pub(crate) async fn park_for_restart<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        frontend: &Url,
    ) -> Result<(), String> {
        self.park_with_kind(window, frontend, PageKind::Restarting)
            .await
    }

    pub(crate) async fn show_restart_failure<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
    ) -> Result<(), String> {
        let resume = self
            .parked
            .lock()
            .map_err(|error| error.to_string())?
            .as_ref()
            .ok_or("Missing Bamboo update page")?
            .resume
            .clone();
        let (url, committed) = self.begin(resume, PageKind::RestartFailed)?;
        self.navigate_local(window, &url, committed).await
    }

    fn begin_restore(&self, frontend: &Url) -> Result<(Url, oneshot::Receiver<()>), String> {
        let mut parked = self.parked.lock().map_err(|error| error.to_string())?;
        let page = parked.as_mut().ok_or("Missing Bamboo update page")?;
        let url = verified_resume_url(&page.resume, frontend);
        let (navigation, receiver) = Navigation::new(url.clone());
        page.restoring = Some(navigation);
        Ok((url, receiver))
    }

    fn complete_restore(&self, url: &Url) -> Result<(), String> {
        let mut parked = self.parked.lock().map_err(|error| error.to_string())?;
        let Some(navigation) = parked.as_ref().and_then(|page| page.restoring.as_ref()) else {
            return Err("Missing Bodhi workspace navigation".into());
        };
        if &navigation.url != url || navigation.committed.is_some() {
            return Err("Bodhi workspace navigation changed before committing".into());
        }
        *parked = None;
        Ok(())
    }

    /// Use only after the caller verifies the exact managed listener and frontend.
    pub(crate) async fn resume_verified<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        frontend: &Url,
    ) -> Result<(), String> {
        let (url, committed) = self.begin_restore(frontend)?;
        window
            .navigate(url.clone())
            .map_err(|error| error.to_string())?;
        // A same-origin app may replace its current route after commit.
        if !navigation_committed(committed).await
            || !window.url().is_ok_and(|current| safe_route(&current, &url))
        {
            return Err(i18n::active(window.app_handle())
                .text("kernel.restartRetryFromUpdates")
                .into());
        }
        self.complete_restore(&url)
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

async fn navigation_committed(committed: oneshot::Receiver<()>) -> bool {
    matches!(
        tokio::time::timeout(NAVIGATION_TIMEOUT, committed).await,
        Ok(Ok(()))
    )
}

fn safe_route(route: &Url, frontend: &Url) -> bool {
    route.origin() == frontend.origin() && route.username().is_empty() && route.password().is_none()
}

fn verified_resume_url(saved: &Url, frontend: &Url) -> Url {
    let mut restored = if safe_route(saved, frontend) {
        saved.clone()
    } else {
        frontend.clone()
    };
    let mut keys = restored.query_pairs();
    let query = restored
        .query()
        .unwrap_or_default()
        .split('&')
        .filter(|part| {
            !part.is_empty()
                && keys
                    .next()
                    .is_some_and(|(key, _)| key != "frontend" && key != RESUME_ATTEMPT)
        })
        .collect::<Vec<_>>()
        .join("&");
    restored.set_query(None);
    if !query.is_empty() {
        // Preserve existing route query values without decoding and re-encoding them.
        restored.set_query(Some(&query));
    }
    let mut parameters = restored.query_pairs_mut();
    if let Some((_, hash)) = frontend.query_pairs().find(|(key, _)| key == "frontend") {
        parameters.append_pair("frontend", &hash);
    }
    // A delayed WebView commit from a previous restore cannot release the fence.
    parameters.append_pair(RESUME_ATTEMPT, &uuid::Uuid::new_v4().to_string());
    drop(parameters);
    restored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_transition_has_translated_text_and_no_script_access() {
        let response = response(Locale::TraditionalChinese, PageKind::LegacyUpdate);
        let html = std::str::from_utf8(response.body()).unwrap();
        assert!(html.contains("lang=\"zh-TW\""));
        assert!(html.contains("正在切換 Bamboo 核心"));
        assert!(!html.contains("{{"));
        assert!(response.headers()["Content-Security-Policy"]
            .to_str()
            .unwrap()
            .starts_with("default-src 'none'"));
        assert_eq!(response.headers()["Cache-Control"], "no-store");
    }

    #[test]
    fn only_the_current_local_page_can_load_until_the_frontend_is_restored() {
        let page = UpdatePage::new(false);
        let origin = Url::parse("http://127.0.0.1:19562/").unwrap();
        let session = origin.join("chat/session").unwrap();
        assert!(page.allows_navigation(&session));

        let (first, _) = page.begin(session.clone(), PageKind::LegacyUpdate).unwrap();
        let (retry, mut committed) = page.begin(origin.clone(), PageKind::RestartFailed).unwrap();
        assert!(page.needs_restore());
        assert!(page.allows_navigation(&retry));
        assert!(!page.allows_navigation(&session));
        assert!(!page.allows_navigation(&first));
        assert!(page
            .request_kind(&first.as_str().parse().unwrap())
            .is_none());
        assert!(matches!(
            page.request_kind(&retry.as_str().parse().unwrap()),
            Some(PageKind::RestartFailed)
        ));
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

    #[test]
    fn verified_restore_keeps_the_route_and_ignores_stale_commits() {
        let page = UpdatePage::new(false);
        let saved =
            Url::parse("http://127.0.0.1:19562/chat/session?tag=a%2bb&fron%74end=old#panel")
                .unwrap();
        let frontend = Url::parse("http://127.0.0.1:19562/?frontend=new").unwrap();
        let (parked, _) = page.begin(saved.clone(), PageKind::Restarting).unwrap();

        let (first, _) = page.begin_restore(&frontend).unwrap();
        let (second, mut committed) = page.begin_restore(&frontend).unwrap();
        assert_eq!(second.path(), saved.path());
        assert_eq!(second.fragment(), saved.fragment());
        assert!(second
            .query()
            .unwrap()
            .starts_with("tag=a%2bb&frontend=new&"));
        assert!(!page.allows_navigation(&parked));
        assert!(!page.allows_navigation(&saved));
        assert!(!page.allows_navigation(&first));
        assert!(page.allows_navigation(&second));
        assert!(page.complete_restore(&second).is_err());
        page.committed(&first);
        assert_eq!(
            committed.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        page.committed(&second);
        assert_eq!(committed.try_recv(), Ok(()));
        page.complete_restore(&second).unwrap();
        assert!(!page.needs_restore());
        assert!(page.allows_navigation(&saved));
        assert!(!page.allows_navigation(&parked));
    }

    #[test]
    fn restore_discards_routes_outside_the_verified_frontend() {
        let frontend = Url::parse("http://127.0.0.1:19562/?frontend=new").unwrap();
        for saved in [
            "http://127.0.0.1:19563/old?private=value#old",
            "http://user:password@127.0.0.1:19562/old?private=value#old",
        ] {
            let restored = verified_resume_url(&Url::parse(saved).unwrap(), &frontend);
            assert_eq!(restored.path(), "/");
            assert_eq!(restored.fragment(), None);
            assert!(restored.username().is_empty());
            assert!(!restored.query().unwrap().contains("private"));
        }
    }
}
