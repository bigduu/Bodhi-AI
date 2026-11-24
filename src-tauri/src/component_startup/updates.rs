use super::{
    journal::{self, History, Journal, Versions},
    Manager, SelectedUpdate,
};
use crate::component_channel::{Changes, PairIdentity, VerifiedChannel};
use crate::component_download::{DownloadSettings, DownloadSource};
use crate::i18n::{self, Locale};
use chrono::Utc;
use serde::Serialize;
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager as _, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(crate) const MENU_ID: &str = "component-updates";
const PAGE: &str = "component-updates.html";
const INTERVAL: Duration = Duration::from_secs(30 * 60);

#[derive(Default)]
pub(super) struct Updates {
    display: Mutex<Display>,
    action: tokio::sync::Mutex<()>,
    restart_requested: AtomicBool,
    dialog_open: AtomicBool,
    pub(super) boot: tokio::sync::Mutex<()>,
    pub(super) ready: AtomicBool,
    pub(super) restoring: AtomicBool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Display {
    phase: Phase,
    error: Option<String>,
    progress: Option<Progress>,
    #[serde(skip)]
    selection: Option<Arc<SelectedUpdate>>,
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
    Available,
    Skipped,
    DownloadFailed,
    Verified,
    Saving,
    ShuttingDown,
    Restarting,
    RestartFailed,
    SaveFailed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    file: String,
    source: Option<DownloadSource>,
    received: u64,
    total: u64,
}

#[derive(Serialize)]
struct Offer {
    sequence: u64,
    identity: PairIdentity,
    versions: Versions,
    changes: Changes,
    downloaded: bool,
    skipped: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    locale: Locale,
    bodhi: String,
    active: Option<Versions>,
    running: bool,
    queued: Option<u64>,
    settings: DownloadSettings,
    last_check: Option<String>,
    display: Display,
    offer: Option<Offer>,
    history: Vec<History>,
}

impl Updates {
    pub(super) fn progress(
        &self,
        file: &str,
        source: Option<DownloadSource>,
        received: u64,
        total: u64,
    ) {
        if let Ok(mut display) = self.display.lock() {
            display.phase = Phase::Downloading;
            display.error = None;
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

    fn set_selection(
        &self,
        selection: Option<Arc<SelectedUpdate>>,
        downloaded: bool,
        skipped: bool,
    ) -> Result<(), String> {
        let mut display = self
            .display
            .lock()
            .map_err(|_| "Cannot set the update status")?;
        display.phase = match (&selection, downloaded, skipped) {
            (None, _, _) => Phase::Current,
            (Some(_), _, true) => Phase::Skipped,
            (Some(_), false, false) => Phase::Available,
            (Some(_), true, false) => Phase::Verified,
        };
        display.selection = selection;
        display.error = None;
        display.progress = None;
        Ok(())
    }

    fn selected(&self, sequence: u64, locale: Locale) -> Result<Arc<SelectedUpdate>, String> {
        self.display
            .lock()
            .map_err(|_| "Cannot read the update status")?
            .selection
            .as_ref()
            .filter(|selection| selection.candidate.sequence == sequence)
            .cloned()
            .ok_or_else(|| locale.text("updates.catalogChanged").into())
    }
}

impl Manager {
    fn snapshot(&self, bodhi: String, locale: Locale) -> Result<Snapshot, String> {
        let journal = Journal::read(&self.profile)?;
        let display = self
            .updates
            .display
            .lock()
            .map_err(|_| "Cannot read the update status")?
            .clone();
        let offer = match display.selection.as_ref() {
            None => None,
            Some(update) => {
                let identity = update.candidate.identity();
                let skipped = journal::read_skipped(&self.profile)?.contains(&identity);
                Some(Offer {
                    sequence: update.candidate.sequence,
                    identity,
                    versions: Versions::from(&update.candidate),
                    changes: update.candidate.changes.clone(),
                    downloaded: journal::read_downloaded(&self.profile)?.as_ref()
                        == Some(&update.candidate),
                    skipped,
                })
            }
        };
        Ok(Snapshot {
            locale,
            bodhi,
            active: journal.active.as_ref().map(Versions::from),
            running: self.updates.ready.load(Ordering::Acquire),
            queued: journal
                .queued
                .as_ref()
                .map(|candidate| candidate.sequence)
                .or(super::PlannedRestart::read(&self.profile)?
                    .filter(|plan| {
                        journal.active.as_ref() != Some(&plan.candidate)
                            && !self.updates.restoring.load(Ordering::Acquire)
                    })
                    .map(|plan| plan.candidate.sequence)),
            settings: self.settings.borrow().clone(),
            last_check: journal.last_check,
            display,
            offer,
            history: journal.history,
        })
    }

    fn remember_settings(&self, settings: DownloadSettings) -> Result<(), String> {
        let settings = settings.validated()?;
        let _lock = self.profile.update_lock()?;
        journal::save_settings(&self.profile, &settings)?;
        self.settings.send_replace(settings);
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
            let Ok(_action) = self.updates.action.try_lock() else {
                continue;
            };
            if self.check().await {
                self.remind(app);
            }
        }
    }

    async fn check(&self) -> bool {
        match self.detect(self.load_catalog()).await {
            Ok(available) => available,
            Err(error) => {
                self.updates.status(Phase::CheckFailed, Some(error));
                false
            }
        }
    }

    async fn detect(
        &self,
        load_catalog: impl Future<Output = Result<VerifiedChannel, String>>,
    ) -> Result<bool, String> {
        let journal = Journal::read(&self.profile)?;
        let Some(current) = journal.active else {
            return Ok(false);
        };
        if journal.trial.is_some()
            || journal.queued.is_some()
            || super::PlannedRestart::read(&self.profile)?.is_some()
        {
            return Ok(false);
        }
        self.updates.status(Phase::Checking, None);
        let channel = load_catalog.await?;
        self.record_check()?;
        let identity = current.identity();
        let selection = channel
            .select(Some((current.sequence, &identity)))?
            .map(|candidate| {
                Arc::new(SelectedUpdate {
                    current_sequence: current.sequence,
                    current: identity,
                    candidate: candidate.combination.clone(),
                })
            });
        let downloaded = journal::read_downloaded(&self.profile)?;
        let verified = selection
            .as_ref()
            .is_some_and(|update| downloaded.as_ref() == Some(&update.candidate));
        let skipped_pairs = journal::read_skipped(&self.profile)?;
        let skipped = selection
            .as_ref()
            .is_some_and(|update| skipped_pairs.contains(&update.candidate.identity()));
        let notify = selection.is_some()
            && !verified
            && !skipped
            && journal
                .remind_after
                .is_none_or(|deadline| deadline <= Utc::now().timestamp());
        self.updates.set_selection(selection, verified, skipped)?;
        Ok(notify)
    }

    fn remind<R: Runtime>(&self, app: &AppHandle<R>) {
        if app.get_webview_window(MENU_ID).is_some()
            || self.updates.dialog_open.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let locale = i18n::active(app);
        let handle = app.clone();
        app.dialog()
            .message(locale.text("updates.availableBody"))
            .title(locale.text("updates.availableTitle"))
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                locale.text("updates.view").into(),
                locale.text("updates.remindLater").into(),
            ))
            .show(move |view| {
                tauri::async_runtime::spawn(async move {
                    let manager = handle.state::<Manager>();
                    let result = if view {
                        open(&handle)
                    } else {
                        manager.snooze()
                    };
                    if let Err(error) = result {
                        log::warn!("Cannot handle the component update reminder: {error}");
                    }
                    manager.updates.dialog_open.store(false, Ordering::Release);
                });
            });
    }

    async fn download(&self, sequence: u64, locale: Locale) -> Result<(), String> {
        let _action = self.updates.action.lock().await;
        let update = self.updates.selected(sequence, locale)?;
        let journal = Journal::read(&self.profile)?;
        update.validate_transition(&journal)?;
        self.require_unskipped(&update, locale)?;
        if journal::read_downloaded(&self.profile)?.as_ref() == Some(&update.candidate) {
            return Ok(());
        }
        self.updates.status(Phase::Downloading, None);
        let result = self.prepare(&update.candidate).await.map(|_| ());
        let phase = if result.is_ok() {
            Phase::Verified
        } else {
            Phase::DownloadFailed
        };
        let error = result.as_ref().err().cloned();
        if let Err(error) = self.record_download(&update, result) {
            self.updates.status(Phase::SaveFailed, Some(error));
        } else {
            self.updates.status(phase, error);
        }
        Ok(())
    }

    pub(super) async fn set_skipped(
        &self,
        sequence: u64,
        identity: PairIdentity,
        skip: bool,
        locale: Locale,
    ) -> Result<(), String> {
        let _action = self.updates.action.lock().await;
        let _profile = self.profile.update_lock()?;
        let journal = Journal::read(&self.profile)?;
        if self.updates.restart_requested.load(Ordering::Acquire)
            || self.updates.restoring.load(Ordering::Acquire)
            || journal.trial.is_some()
            || journal.queued.is_some()
            || super::PlannedRestart::read(&self.profile)?.is_some()
        {
            return Err(locale.text("updates.restartPending").into());
        }
        let update = self.updates.selected(sequence, locale)?;
        if identity != update.candidate.identity() {
            return Err(locale.text("updates.catalogChanged").into());
        }
        update.validate_transition(&journal)?;
        let downloaded =
            journal::read_downloaded(&self.profile)?.as_ref() == Some(&update.candidate);
        let mut skipped = journal::read_skipped(&self.profile)?;
        if skip && !skipped.contains(&identity) {
            skipped.push(identity);
            journal::save_skipped(&self.profile, &skipped)?;
        } else if !skip && skipped.contains(&identity) {
            skipped.retain(|pair| pair != &identity);
            journal::save_skipped(&self.profile, &skipped)?;
        }
        self.updates.set_selection(Some(update), downloaded, skip)
    }

    fn require_unskipped(&self, update: &SelectedUpdate, locale: Locale) -> Result<(), String> {
        if journal::read_skipped(&self.profile)?.contains(&update.candidate.identity()) {
            return Err(locale.text("updates.undoSkipRequired").into());
        }
        Ok(())
    }

    fn record_download(
        &self,
        update: &SelectedUpdate,
        outcome: Result<(), String>,
    ) -> Result<(), String> {
        let _lock = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        update.validate_transition(&journal)?;
        if let Err(error) = outcome {
            let effective = journal.active.as_ref().map(Versions::from);
            journal.record(&update.candidate, Some(error));
            if let Some(last) = journal.history.last_mut() {
                last.effective = effective;
            }
            journal.save(&self.profile)
        } else {
            journal::save_downloaded(&self.profile, &update.candidate)
        }
    }

    async fn apply<R: Runtime>(&self, app: &AppHandle<R>, sequence: u64) -> Result<(), String> {
        let _action = self.updates.action.lock().await;
        if self.updates.restart_requested.load(Ordering::Acquire) {
            return Ok(());
        }
        if self.updates.restoring.load(Ordering::Acquire) {
            return Err("Wait for Bamboo to restore the previous sessions".into());
        }
        let locale = i18n::active(app);
        let journal = Journal::read(&self.profile)?;
        let runtime = app.state::<crate::sidecar::SidecarState>();
        let port = crate::web_service_port();
        let plan = super::PlannedRestart::read(&self.profile)?;
        let restart = if let Some(plan) = plan {
            if plan.candidate.sequence != sequence
                || journal.active.as_ref() == Some(&plan.candidate)
            {
                return Err(locale.text("updates.catalogChanged").into());
            }
            self.updates.status(Phase::ShuttingDown, None);
            self.prepare_planned_restart(&runtime, port, plan).await
        } else if let Some(queued) = &journal.queued {
            if queued.sequence != sequence {
                return Err(locale.text("updates.catalogChanged").into());
            }
            self.prepare_restart(&runtime, port).await
        } else {
            let update = self.updates.selected(sequence, locale)?;
            update.validate_transition(&journal)?;
            self.require_unskipped(&update, locale)?;
            if journal::read_downloaded(&self.profile)?.as_ref() != Some(&update.candidate) {
                return Err(locale.text("updates.downloadRequired").into());
            }
            self.updates.status(Phase::Saving, None);
            if let Err(error) = self.reconfirm(&update, locale).await {
                self.updates.status(Phase::SaveFailed, Some(error));
                return Ok(());
            }
            let active = journal
                .active
                .as_ref()
                .ok_or("Bamboo has no active component release")?;
            match self.use_planned_restart(&runtime, active).await {
                Ok(true) => match self.plan_restart(&runtime, &update).await {
                    Ok(plan) => {
                        self.updates.status(Phase::ShuttingDown, None);
                        self.prepare_planned_restart(&runtime, port, plan).await
                    }
                    Err(error) => Err(error),
                },
                Ok(false) => match self.queue(&update) {
                    Ok(()) => self.prepare_restart(&runtime, port).await,
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            }
        };
        if let Err(error) = restart {
            self.updates.status(Phase::RestartFailed, Some(error));
            return Ok(());
        }
        self.updates
            .restart_requested
            .store(true, Ordering::Release);
        self.updates.status(Phase::Restarting, None);
        app.request_restart();
        Ok(())
    }

    async fn reconfirm(&self, update: &SelectedUpdate, locale: Locale) -> Result<(), String> {
        let channel = self.load_catalog().await?;
        let current = Some((update.current_sequence, &update.current));
        if channel
            .select(current)?
            .is_none_or(|candidate| candidate.combination != &update.candidate)
        {
            return Err(locale.text("updates.catalogChanged").into());
        }
        Ok(())
    }
}

fn check_interval() -> tokio::time::Interval {
    let mut interval = tokio::time::interval(INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval
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
pub(crate) async fn check_components<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    authorize(&window, false)?;
    let manager = running_manager(&app)?;
    let _action = manager.updates.action.lock().await;
    manager.check().await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn download_component_update<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    sequence: u64,
) -> Result<(), String> {
    authorize(&window, false)?;
    running_manager(&app)?
        .download(sequence, i18n::active(&app))
        .await
}

#[tauri::command]
pub(crate) async fn set_component_version_skipped<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    sequence: u64,
    identity: PairIdentity,
    skipped: bool,
) -> Result<(), String> {
    authorize(&window, false)?;
    running_manager(&app)?
        .set_skipped(sequence, identity, skipped, i18n::active(&app))
        .await
}

#[tauri::command]
pub(crate) async fn apply_component_update<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    sequence: u64,
) -> Result<(), String> {
    authorize(&window, false)?;
    running_manager(&app)?.apply(&app, sequence).await
}

fn running_manager<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, Manager>, String> {
    app.try_state::<Manager>()
        .filter(|manager| manager.updates.ready.load(Ordering::Acquire))
        .ok_or_else(|| "The component updater is unavailable until startup completes".into())
}

#[tauri::command]
pub(crate) fn retry_component_startup<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    authorize(&window, true)?;
    if app.try_state::<Manager>().is_none() {
        return Err("The component updater is unavailable".into());
    }
    tauri::async_runtime::spawn(async move {
        let manager = app.state::<Manager>();
        if matches!(manager.launch(&app).await, Ok(true)) {
            manager.poll(&app).await;
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_component_updates<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    authorize(&window, true)?;
    if app.try_state::<Manager>().is_none() {
        return Err("The component updater is unavailable".into());
    }
    open(&app)
}

#[tauri::command]
pub(crate) fn set_component_download_settings<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    settings: DownloadSettings,
) -> Result<(), String> {
    authorize(&window, false)?;
    app.try_state::<Manager>()
        .ok_or("The component updater is unavailable")?
        .remember_settings(settings)
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

    #[tokio::test]
    async fn detection_and_verified_download_leave_the_active_pair_selected() {
        use crate::component_channel::tests::{fixture_channel, initial_combination};

        let state = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(state.path()).unwrap();
        let original = initial_combination().await;
        Journal {
            active: Some(original.clone()),
            ..Journal::default()
        }
        .save(&profile)
        .unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        assert!(manager
            .detect(async { Ok(fixture_channel().await) })
            .await
            .unwrap());
        let snapshot = manager.snapshot("0.0.0".into(), Locale::English).unwrap();
        assert!(snapshot.last_check.is_some());
        assert!(matches!(snapshot.display.phase, Phase::Available));
        assert!(snapshot.display.progress.is_none() && snapshot.queued.is_none());
        let offer = snapshot.offer.unwrap();
        assert!(!offer.downloaded);
        let update = manager
            .updates
            .selected(offer.sequence, Locale::English)
            .unwrap();
        assert!(manager.queue(&update).is_err());

        manager
            .record_download(&update, Err("interrupted transfer".into()))
            .unwrap();
        assert!(journal::read_downloaded(&profile).unwrap().is_none());
        manager.record_download(&update, Ok(())).unwrap();
        let reopened = Manager::new(profile.clone()).unwrap();
        assert_eq!(reopened.choose().await.unwrap(), original);
        assert!(!reopened
            .detect(async { Ok(fixture_channel().await) })
            .await
            .unwrap());
        let verified = reopened.snapshot("0.0.0".into(), Locale::English).unwrap();
        assert!(matches!(verified.display.phase, Phase::Verified));
        assert!(verified.offer.unwrap().downloaded);
        assert!(verified.queued.is_none());
    }

    #[tokio::test]
    async fn skipped_pair_survives_startup_and_leaves_a_later_lotus_update_available() {
        use crate::component_channel::tests::{
            fixture_channel, fixture_channel_with_lotus_only_update, initial_combination,
        };

        let state = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(state.path()).unwrap();
        let original = initial_combination().await;
        Journal {
            active: Some(original.clone()),
            ..Journal::default()
        }
        .save(&profile)
        .unwrap();
        let locale = Locale::English;
        let manager = Manager::new(profile.clone()).unwrap();
        assert!(manager
            .detect(async { Ok(fixture_channel().await) })
            .await
            .unwrap());
        let offer = manager
            .snapshot("0.0.0".into(), locale)
            .unwrap()
            .offer
            .unwrap();

        assert!(manager
            .set_skipped(offer.sequence, original.identity(), true, locale)
            .await
            .is_err());
        assert!(journal::read_skipped(&profile).unwrap().is_empty());
        for _ in 0..2 {
            manager
                .set_skipped(offer.sequence, offer.identity.clone(), true, locale)
                .await
                .unwrap();
        }
        assert_eq!(
            journal::read_skipped(&profile).unwrap(),
            [offer.identity.clone()]
        );
        let reopened = Manager::new(profile.clone()).unwrap();
        assert_eq!(reopened.choose().await.unwrap(), original);
        assert!(!reopened
            .detect(async { Ok(fixture_channel().await) })
            .await
            .unwrap());
        let skipped = reopened.snapshot("0.0.0".into(), locale).unwrap();
        assert!(matches!(skipped.display.phase, Phase::Skipped));
        assert!(skipped.offer.unwrap().skipped);
        assert_eq!(
            reopened.download(offer.sequence, locale).await.unwrap_err(),
            locale.text("updates.undoSkipRequired")
        );
        assert!(journal::read_downloaded(&profile).unwrap().is_none());

        assert!(reopened
            .detect(async { Ok(fixture_channel_with_lotus_only_update()) })
            .await
            .unwrap());
        let later = reopened
            .snapshot("0.0.0".into(), locale)
            .unwrap()
            .offer
            .unwrap();
        assert!(!later.skipped);
        assert!(later.sequence > offer.sequence);
        assert_eq!(later.versions.bamboo, original.bamboo.version);
        assert_ne!(later.versions.lotus, original.lotus.version);
        assert!(reopened
            .set_skipped(offer.sequence, offer.identity.clone(), false, locale)
            .await
            .is_err());
        reopened
            .set_skipped(later.sequence, later.identity.clone(), true, locale)
            .await
            .unwrap();
        assert!(!reopened
            .detect(async { Ok(fixture_channel_with_lotus_only_update()) })
            .await
            .unwrap());
        let still_latest = reopened
            .snapshot("0.0.0".into(), locale)
            .unwrap()
            .offer
            .unwrap();
        assert!(still_latest.skipped);
        assert_eq!(still_latest.sequence, later.sequence);
        reopened
            .set_skipped(later.sequence, later.identity, false, locale)
            .await
            .unwrap();

        assert!(!reopened
            .detect(async { Ok(fixture_channel().await) })
            .await
            .unwrap());
        reopened
            .set_skipped(offer.sequence, offer.identity, false, locale)
            .await
            .unwrap();
        assert!(reopened
            .detect(async { Ok(fixture_channel().await) })
            .await
            .unwrap());
        assert!(journal::read_skipped(&profile).unwrap().is_empty());
    }

    #[tokio::test]
    async fn skipping_preserves_a_verified_download_and_refuses_to_change_a_queued_restart() {
        use crate::component_channel::tests::{fixture_channel, initial_combination};

        let state = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(state.path()).unwrap();
        let locale = Locale::English;
        let manager = Manager::new(profile.clone()).unwrap();
        let original = initial_combination().await;
        Journal {
            active: Some(original.clone()),
            ..Journal::default()
        }
        .save(&profile)
        .unwrap();
        manager
            .detect(async { Ok(fixture_channel().await) })
            .await
            .unwrap();
        let offer = manager
            .snapshot("0.0.0".into(), locale)
            .unwrap()
            .offer
            .unwrap();
        let update = manager.updates.selected(offer.sequence, locale).unwrap();
        manager.record_download(&update, Ok(())).unwrap();
        let journal_file = profile.state_dir.join("components-v1.json");
        let before = std::fs::read(&journal_file).unwrap();

        manager
            .set_skipped(offer.sequence, offer.identity.clone(), true, locale)
            .await
            .unwrap();
        manager.require_unskipped(&update, locale).unwrap_err();
        let skipped = manager
            .snapshot("0.0.0".into(), locale)
            .unwrap()
            .offer
            .unwrap();
        assert!(skipped.downloaded && skipped.skipped);
        manager
            .set_skipped(offer.sequence, offer.identity.clone(), false, locale)
            .await
            .unwrap();
        let resumed = manager.snapshot("0.0.0".into(), locale).unwrap();
        assert!(matches!(resumed.display.phase, Phase::Verified));
        assert!(resumed.offer.unwrap().downloaded);
        assert_eq!(std::fs::read(journal_file).unwrap(), before);
        assert_eq!(
            journal::read_downloaded(&profile).unwrap().unwrap(),
            update.candidate
        );

        manager.queue(&update).unwrap();
        assert_eq!(
            manager
                .set_skipped(offer.sequence, offer.identity, true, locale)
                .await
                .unwrap_err(),
            locale.text("updates.restartPending")
        );
        assert!(journal::read_skipped(&profile).unwrap().is_empty());
        assert_eq!(
            Journal::read(&profile).unwrap().queued.unwrap(),
            update.candidate
        );
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
    fn download_settings_inherit_the_legacy_source_and_persist_before_switching() {
        let state = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(state.path()).unwrap();
        let legacy = Journal {
            source: DownloadSource::GhFast,
            ..Journal::default()
        };
        legacy.save(&profile).unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let receiver = manager.settings.subscribe();
        assert_eq!(receiver.borrow().source, DownloadSource::GhFast);
        let selected = DownloadSettings {
            source: DownloadSource::Custom,
            mirror_url: Some("https://mirror.example.com/bodhi".into()),
            proxy_url: Some("http://localhost:8888".into()),
        };
        manager.remember_settings(selected.clone()).unwrap();
        assert_eq!(journal::read_settings(&profile).unwrap(), selected);
        assert_eq!(*receiver.borrow(), selected);
        assert!(manager
            .remember_settings(DownloadSettings {
                source: DownloadSource::Custom,
                ..DownloadSettings::default()
            })
            .is_err());
        let reopened = Manager::new(profile.clone()).unwrap();
        assert_eq!(
            reopened
                .snapshot("0.0.0".into(), Locale::English)
                .unwrap()
                .settings,
            selected
        );
        assert_eq!(
            Journal::read(&profile).unwrap().source,
            DownloadSource::GhFast
        );
    }
}
