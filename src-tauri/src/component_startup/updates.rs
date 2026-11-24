use super::{
    journal::{History, Journal, Versions},
    Manager, PreparedUpdate,
};
use crate::component_channel::{self, Changes, Combination};
use crate::component_kernel::DownloadSource;
use crate::i18n::{self, Locale};
use chrono::Utc;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager as _, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(crate) const MENU_ID: &str = "component-updates";
const PAGE: &str = "component-updates.html";
const INTERVAL: Duration = Duration::from_secs(30 * 60);

#[derive(Default)]
pub(super) struct Updates {
    display: Mutex<Display>,
    check: tokio::sync::Mutex<()>,
    dialog_open: AtomicBool,
    pub(super) boot: tokio::sync::Mutex<()>,
    pub(super) ready: AtomicBool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Display {
    phase: Phase,
    error: Option<String>,
    progress: Option<Progress>,
    offer: Option<Offer>,
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Phase {
    #[default]
    Preparing,
    Downloading,
    Starting,
    StartupFailed,
    Ready,
    CheckFailed,
    Checking,
    Current,
    Verified,
    Queued,
    Deferred,
    SaveFailed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    file: String,
    source: Option<DownloadSource>,
    received: u64,
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
struct Offer {
    versions: Versions,
    changes: Changes,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    locale: Locale,
    bodhi: String,
    active: Option<Versions>,
    running: bool,
    queued: Option<Versions>,
    source: DownloadSource,
    last_check: Option<String>,
    display: Display,
    history: Vec<History>,
}

impl Updates {
    pub(super) fn progress(
        &self,
        file: &str,
        source: Option<DownloadSource>,
        received: u64,
        total: Option<u64>,
    ) {
        if let Ok(mut display) = self.display.lock() {
            display.phase = Phase::Downloading;
            if let Some(progress) = &mut display.progress {
                if progress.file == file && progress.source == source {
                    progress.received = received;
                    progress.total = total;
                    return;
                }
            }
            display.progress = Some(Progress {
                file: file.into(),
                source,
                received,
                total,
            });
        }
    }

    pub(super) fn status(&self, phase: Phase, error: Option<String>) {
        if let Ok(mut display) = self.display.lock() {
            display.phase = phase;
            display.error = error;
            display.progress = None;
        }
    }
}

impl Manager {
    fn snapshot(&self, bodhi: String, locale: Locale) -> Result<Snapshot, String> {
        let journal = Journal::read(&self.profile)?;
        Ok(Snapshot {
            locale,
            bodhi,
            active: journal.active.as_ref().map(Versions::from),
            running: self.updates.ready.load(Ordering::Acquire),
            queued: journal.queued.as_ref().map(Versions::from),
            source: journal.source,
            last_check: journal.last_check,
            display: self
                .updates
                .display
                .lock()
                .map_err(|_| "Cannot read the update status")?
                .clone(),
            history: journal.history,
        })
    }

    fn remember_source(&self, source: DownloadSource) -> Result<(), String> {
        let _lock = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        journal.source = source;
        journal.save(&self.profile)?;
        self.sources.send_replace(source);
        Ok(())
    }

    fn record_check(&self) -> Result<(), String> {
        let _lock = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        journal.last_check = Some(Utc::now().to_rfc3339());
        journal.save(&self.profile)
    }

    fn snooze(&self) -> Result<(), String> {
        let _lock = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        journal.remind_after = Some(Utc::now().timestamp() + INTERVAL.as_secs() as i64);
        journal.save(&self.profile)
    }

    pub(crate) async fn poll<R: Runtime>(&self, app: &AppHandle<R>) {
        let mut interval = check_interval();
        loop {
            interval.tick().await;
            self.check(app).await;
        }
    }

    async fn check<R: Runtime>(&self, app: &AppHandle<R>) {
        let Ok(_in_flight) = self.updates.check.try_lock() else {
            return;
        };
        if self.updates.dialog_open.load(Ordering::Acquire) {
            return;
        }
        if let Err(error) = self.check_and_offer(app).await {
            self.updates.status(Phase::CheckFailed, Some(error));
        }
    }

    async fn check_and_offer<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let journal = Journal::read(&self.profile)?;
        let Some(current) = journal.active else {
            return Ok(());
        };
        if journal.trial.is_some() || journal.queued.is_some() {
            return Ok(());
        }
        if let Ok(mut display) = self.updates.display.lock() {
            display.offer = None;
        }
        self.updates.status(Phase::Checking, None);
        let channel = component_channel::load_stable().await?;
        self.record_check()?;
        let identity = current.identity();
        let Some(candidate) = channel.select(Some((current.sequence, &identity)))? else {
            self.updates.status(Phase::Current, None);
            return Ok(());
        };
        let combination = candidate.combination;
        if let Err(error) = self.prepare(combination).await {
            let _lock = self.profile.update_lock()?;
            let mut journal = Journal::read(&self.profile)?;
            let effective = journal.active.as_ref().map(Versions::from);
            journal.record(combination, Some(error.clone()));
            if let Some(last) = journal.history.last_mut() {
                last.effective = effective;
            }
            journal.save(&self.profile)?;
            return Err(error);
        }
        if let Ok(mut display) = self.updates.display.lock() {
            display.offer = Some(Offer {
                versions: Versions::from(combination),
                changes: combination.changes.clone(),
            });
        }
        self.updates.status(Phase::Verified, None);
        if journal
            .remind_after
            .is_some_and(|deadline| deadline > Utc::now().timestamp())
        {
            return Ok(());
        }
        let locale = i18n::active(app);
        let message = confirmation(locale, &current, combination);
        let update = PreparedUpdate {
            current_sequence: current.sequence,
            current: identity,
            candidate: combination.clone(),
        };
        self.updates.dialog_open.store(true, Ordering::Release);
        let handle = app.clone();
        app.dialog()
            .message(message)
            .title(locale.text("updates.confirmTitle"))
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                locale.text("updates.confirmApply").into(),
                locale.text("updates.remindLater").into(),
            ))
            .show(move |approved| {
                tauri::async_runtime::spawn(async move {
                    let manager = handle.state::<Manager>();
                    let result = if approved {
                        manager.reconfirm(&update, i18n::active(&handle)).await
                    } else {
                        manager.snooze()
                    };
                    manager.updates.dialog_open.store(false, Ordering::Release);
                    match result {
                        Ok(()) if approved => manager.updates.status(Phase::Queued, None),
                        Ok(()) => manager.updates.status(Phase::Deferred, None),
                        Err(error) => manager.updates.status(Phase::SaveFailed, Some(error)),
                    }
                });
            });
        Ok(())
    }

    async fn reconfirm(&self, update: &PreparedUpdate, locale: Locale) -> Result<(), String> {
        let channel = component_channel::load_stable().await?;
        let current = Some((update.current_sequence, &update.current));
        if channel
            .select(current)?
            .is_none_or(|candidate| candidate.combination != &update.candidate)
        {
            return Err(locale.text("updates.catalogChanged").into());
        }
        self.queue(update)
    }
}

fn check_interval() -> tokio::time::Interval {
    let mut interval = tokio::time::interval(INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval
}

fn confirmation(locale: Locale, current: &Combination, next: &Combination) -> String {
    let mut sections = Vec::new();
    for (name, old, new, changes) in [
        (
            "Bamboo",
            &current.bamboo.version,
            &next.bamboo.version,
            &next.changes.bamboo,
        ),
        (
            "Lotus Next",
            &current.lotus.version,
            &next.lotus.version,
            &next.changes.lotus,
        ),
    ] {
        if old == new {
            continue;
        }
        let heading = format!("{name} {old} → {new}");
        let mut lines = Vec::from([heading]);
        if changes.is_empty() {
            lines.push(locale.text("updates.noNotes").into());
        }
        for change in changes.iter().take(4) {
            lines.push(format!(
                "• {}",
                change.chars().take(230).collect::<String>()
            ));
        }
        sections.push(lines.join("\n"));
    }
    sections.push(locale.text("updates.confirmBody").into());
    sections.join("\n\n")
}

pub(crate) fn open<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MENU_ID) {
        window.show().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    WebviewWindowBuilder::new(app, MENU_ID, WebviewUrl::App(PAGE.into()))
        .title(i18n::active(app).text("updates.title"))
        .inner_size(690.0, 680.0)
        .min_inner_size(460.0, 420.0)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(crate) fn authorize<R: Runtime>(
    window: &WebviewWindow<R>,
    allow_splash: bool,
) -> Result<(), String> {
    let url = window.url().map_err(|error| error.to_string())?;
    let dev = if tauri::is_dev() {
        window.config().build.dev_url.as_ref()
    } else {
        None
    };
    if can_access(window.label(), &url, dev, allow_splash) {
        return Ok(());
    }
    Err("This window cannot access the component updater".into())
}

fn can_access(label: &str, url: &tauri::Url, dev: Option<&tauri::Url>, allow_splash: bool) -> bool {
    let bundled = url.port().is_none()
        && matches!(
            (url.scheme(), url.host_str()),
            ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
        );
    let owned_dev = dev.filter(|expected| {
        expected.scheme() == "http"
            && expected.host_str() == Some("127.0.0.1")
            && expected.origin() == url.origin()
    });
    let updates = label == MENU_ID && url.path() == "/component-updates.html";
    let splash = allow_splash && label == "main";
    (updates && (bundled || owned_dev.is_some()))
        || (splash && bundled && matches!(url.path(), "" | "/" | "/index.html"))
        || (splash && url.path() == "/__bodhi_startup" && owned_dev == Some(url))
}

#[tauri::command]
pub(crate) fn shell_translations<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<ShellTranslations, String> {
    authorize(&window, true)?;
    let locale = i18n::active(&app);
    Ok(ShellTranslations {
        locale,
        messages: locale.messages(),
    })
}

#[derive(Serialize)]
pub(crate) struct ShellTranslations {
    locale: Locale,
    messages: &'static BTreeMap<String, String>,
}

#[tauri::command]
pub(crate) fn component_snapshot<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Snapshot, String> {
    authorize(&window, true)?;
    app.try_state::<Manager>()
        .ok_or("The component updater is unavailable")?
        .snapshot(app.package_info().version.to_string(), i18n::active(&app))
}

#[tauri::command]
pub(crate) fn check_components<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    authorize(&window, false)?;
    if app.try_state::<Manager>().is_none() {
        return Err("The component updater is unavailable".into());
    }
    tauri::async_runtime::spawn(async move {
        let manager = app.state::<Manager>();
        if manager.updates.ready.load(Ordering::Acquire) {
            manager.check(&app).await;
        } else if matches!(manager.launch(&app).await, Ok(true)) {
            manager.poll(&app).await;
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn set_component_source<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    source: DownloadSource,
) -> Result<(), String> {
    authorize(&window, false)?;
    app.try_state::<Manager>()
        .ok_or("The component updater is unavailable")?
        .remember_source(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn checks_immediately_and_at_thirty_minutes() {
        let start = tokio::time::Instant::now();
        let mut interval = check_interval();
        assert_eq!(interval.tick().await, start);
        assert!(
            tokio::time::timeout(Duration::from_secs(1799), interval.tick())
                .await
                .is_err()
        );
        assert_eq!(interval.tick().await, start + Duration::from_secs(1800));
    }

    #[test]
    fn update_commands_only_accept_the_bundled_or_owned_development_page() {
        let parse = |url| tauri::Url::parse(url).unwrap();
        let dev = parse("http://127.0.0.1:1420/__bodhi_startup?run=owned");
        let update = parse("http://127.0.0.1:1420/component-updates.html");
        let bundled = parse("tauri://localhost/component-updates.html");
        assert!(can_access(MENU_ID, &bundled, None, false));
        let splash = parse("tauri://localhost");
        assert!(can_access("main", &splash, None, true));
        assert!(!can_access("main", &splash, None, false));
        assert!(!can_access("main", &parse("tauri://foreign"), None, true));
        assert!(!can_access(MENU_ID, &update, None, false));
        assert!(can_access(MENU_ID, &update, Some(&dev), false));
        assert!(!can_access("main", &update, Some(&dev), true));
        let other = parse("http://127.0.0.1:8000/component-updates.html");
        assert!(!can_access(MENU_ID, &other, Some(&dev), false));
        assert!(can_access("main", &dev, Some(&dev), true));
        assert!(!can_access("main", &dev, Some(&dev), false));
        let stale = parse("http://127.0.0.1:1420/__bodhi_startup?run=old");
        assert!(!can_access("main", &stale, Some(&dev), true));
    }

    #[test]
    fn selected_source_is_persisted_before_observers_restart_the_download() {
        let state = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(state.path()).unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let receiver = manager.sources.subscribe();
        manager.remember_source(DownloadSource::GhFast).unwrap();
        assert_eq!(*receiver.borrow(), DownloadSource::GhFast);
        let reopened = Manager::new(profile).unwrap();
        assert_eq!(
            reopened
                .snapshot("0.0.0".into(), Locale::English)
                .unwrap()
                .source,
            DownloadSource::GhFast
        );
    }
}
