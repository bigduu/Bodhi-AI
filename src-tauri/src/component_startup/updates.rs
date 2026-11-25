use super::{
    journal::{self, History, Journal, Versions},
    Manager, SelectedUpdate,
};
use crate::component_channel::{Changes, Combination, PairIdentity, UpdateKind, VerifiedChannel};
use crate::component_download::{DownloadSettings, DownloadSource};
use crate::i18n::{self, Locale};
use crate::sidecar::UpdateShutdownError;
use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};
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
    force_shutdown_started: AtomicBool,
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
    download_sequence: Option<u64>,
    #[serde(skip)]
    selections: Vec<Arc<SelectedUpdate>>,
    #[serde(skip)]
    force: Option<Arc<SelectedUpdate>>,
}

impl Display {
    fn refresh_offers(
        &mut self,
        downloaded: Option<&Combination>,
        skipped: &[PairIdentity],
    ) -> bool {
        let mut available = false;
        let mut verified = false;
        for selection in &self.selections {
            if !skipped.contains(&selection.candidate.identity()) {
                if downloaded == Some(&selection.candidate) {
                    verified = true;
                } else {
                    available = true;
                }
            }
        }
        self.phase = if available {
            Phase::Available
        } else if verified {
            Phase::Verified
        } else if self.selections.is_empty() {
            Phase::Current
        } else {
            Phase::Skipped
        };
        self.error = None;
        self.progress = None;
        self.download_sequence = None;
        available
    }
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
    kind: UpdateKind,
    sequence: u64,
    identity: String,
    versions: Versions,
    changes: Changes,
    downloaded: bool,
    skipped: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ForceOffer {
    sequence: u64,
    identity: String,
    shutdown_started: bool,
}

fn artifact_identity(candidate: &Combination) -> Result<String, String> {
    let descriptor = serde_json::to_vec(candidate).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(descriptor)))
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
    offers: Vec<Offer>,
    force_update: Option<ForceOffer>,
    history: Vec<History>,
}

impl Updates {
    pub(super) fn enable_force_update(&self, update: SelectedUpdate) -> Result<(), String> {
        self.display
            .lock()
            .map_err(|_| "Cannot set the update status")?
            .force = Some(Arc::new(update));
        Ok(())
    }

    fn clear_force_update(&self) {
        if let Ok(mut display) = self.display.lock() {
            display.force = None;
        }
    }

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
        self.status_for_download(phase, error, None);
    }

    fn status_for_download(&self, phase: Phase, error: Option<String>, sequence: Option<u64>) {
        if let Ok(mut display) = self.display.lock() {
            display.phase = phase;
            display.error = error;
            display.progress = None;
            display.download_sequence = sequence;
        }
    }

    fn set_selections(
        &self,
        selections: Vec<Arc<SelectedUpdate>>,
        downloaded: Option<&Combination>,
        skipped: &[PairIdentity],
    ) -> Result<bool, String> {
        let mut display = self
            .display
            .lock()
            .map_err(|_| "Cannot set the update status")?;
        display.selections = selections;
        Ok(display.refresh_offers(downloaded, skipped))
    }

    fn selected(
        &self,
        sequence: u64,
        identity: &str,
        locale: Locale,
    ) -> Result<Arc<SelectedUpdate>, String> {
        let selection = self
            .display
            .lock()
            .map_err(|_| "Cannot read the update status")?
            .selections
            .iter()
            .find(|selection| selection.candidate.sequence == sequence)
            .cloned()
            .ok_or_else(|| locale.text("updates.catalogChanged").to_string())?;
        if artifact_identity(&selection.candidate)? != identity {
            return Err(locale.text("updates.catalogChanged").into());
        }
        Ok(selection)
    }
}

impl Manager {
    fn snapshot(&self, bodhi: String, locale: Locale) -> Result<Snapshot, String> {
        let journal = Journal::read(&self.profile)?;
        let planned = super::PlannedRestart::read(&self.profile)?;
        let display = self
            .updates
            .display
            .lock()
            .map_err(|_| "Cannot read the update status")?
            .clone();
        let mut offers = Vec::new();
        let mut force_update = None;
        if !display.selections.is_empty() {
            let skipped = journal::read_skipped(&self.profile)?;
            let downloaded = journal::read_downloaded(&self.profile)?;
            for update in &display.selections {
                let Ok(active) = update.validate_transition(&journal) else {
                    continue;
                };
                let Some(kind) = update.candidate.update_kind(active) else {
                    continue;
                };
                let identity = artifact_identity(&update.candidate)?;
                let skipped_offer = skipped.contains(&update.candidate.identity());
                let downloaded_offer = downloaded.as_ref() == Some(&update.candidate);
                if planned.is_none()
                    && !self.updates.restoring.load(Ordering::Acquire)
                    && !self.updates.restart_requested.load(Ordering::Acquire)
                    && display.force.as_deref() == Some(update.as_ref())
                    && downloaded_offer
                    && !skipped_offer
                {
                    force_update = Some(ForceOffer {
                        sequence: update.candidate.sequence,
                        identity: identity.clone(),
                        shutdown_started: self
                            .updates
                            .force_shutdown_started
                            .load(Ordering::Acquire),
                    });
                }
                offers.push(Offer {
                    kind,
                    sequence: update.candidate.sequence,
                    skipped: skipped_offer,
                    identity,
                    versions: Versions::from(&update.candidate),
                    changes: update.candidate.changes.clone(),
                    downloaded: downloaded_offer,
                });
            }
        }
        Ok(Snapshot {
            locale,
            bodhi,
            active: journal.active.as_ref().map(Versions::from),
            running: self.updates.ready.load(Ordering::Acquire),
            queued: journal
                .queued
                .as_ref()
                .map(|candidate| candidate.sequence)
                .or(planned
                    .filter(|plan| {
                        journal.active.as_ref() != Some(&plan.candidate)
                            && !self.updates.restoring.load(Ordering::Acquire)
                    })
                    .map(|plan| plan.candidate.sequence)),
            settings: self.settings.borrow().clone(),
            last_check: journal.last_check,
            display,
            offers,
            force_update,
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
            || self.updates.force_shutdown_started.load(Ordering::Acquire)
            || super::PlannedRestart::read(&self.profile)?.is_some()
        {
            return Ok(false);
        }
        self.updates.status(Phase::Checking, None);
        let channel = load_catalog.await?;
        self.record_check()?;
        let identity = current.identity();
        let selections = channel
            .select_updates(&current)?
            .into_iter()
            .map(|candidate| {
                Arc::new(SelectedUpdate {
                    current_sequence: current.sequence,
                    current: identity.clone(),
                    candidate: candidate.clone(),
                })
            })
            .collect();
        let downloaded = journal::read_downloaded(&self.profile)?;
        let skipped = journal::read_skipped(&self.profile)?;
        let available = self
            .updates
            .set_selections(selections, downloaded.as_ref(), &skipped)?;
        Ok(available
            && journal
                .remind_after
                .is_none_or(|deadline| deadline <= Utc::now().timestamp()))
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

    async fn download(&self, sequence: u64, identity: &str, locale: Locale) -> Result<(), String> {
        let _action = self.updates.action.lock().await;
        if self.updates.force_shutdown_started.load(Ordering::Acquire)
            || super::PlannedRestart::read(&self.profile)?.is_some()
        {
            return Err(locale.text("updates.restartPending").into());
        }
        let update = self.updates.selected(sequence, identity, locale)?;
        let journal = Journal::read(&self.profile)?;
        let active = update.validate_transition(&journal)?;
        self.require_unskipped(&update, locale)?;
        if journal::read_downloaded(&self.profile)?.as_ref() == Some(&update.candidate) {
            return Ok(());
        }
        self.updates
            .status_for_download(Phase::Downloading, None, Some(sequence));
        let result = self.prepare_update(active, &update.candidate).await;
        let phase = if result.is_ok() {
            Phase::Verified
        } else {
            Phase::DownloadFailed
        };
        let error = result.as_ref().err().cloned();
        let (phase, error) = match self.record_download(&update, result) {
            Ok(()) => (phase, error),
            Err(error) => (Phase::SaveFailed, Some(error)),
        };
        self.updates
            .status_for_download(phase, error, Some(sequence));
        Ok(())
    }

    pub(super) async fn set_skipped(
        &self,
        sequence: u64,
        identity: String,
        skip: bool,
        locale: Locale,
    ) -> Result<(), String> {
        let _action = self.updates.action.lock().await;
        let _profile = self.profile.update_lock()?;
        let journal = Journal::read(&self.profile)?;
        if self.updates.restart_requested.load(Ordering::Acquire)
            || self.updates.restoring.load(Ordering::Acquire)
            || self.updates.force_shutdown_started.load(Ordering::Acquire)
            || journal.trial.is_some()
            || journal.queued.is_some()
            || super::PlannedRestart::read(&self.profile)?.is_some()
        {
            return Err(locale.text("updates.restartPending").into());
        }
        let update = self.updates.selected(sequence, &identity, locale)?;
        update.validate_transition(&journal)?;
        let identity = update.candidate.identity();
        let downloaded = journal::read_downloaded(&self.profile)?;
        let mut skipped = journal::read_skipped(&self.profile)?;
        if skip && !skipped.contains(&identity) {
            skipped.push(identity);
            journal::save_skipped(&self.profile, &skipped)?;
        } else if !skip && skipped.contains(&identity) {
            skipped.retain(|pair| pair != &identity);
            journal::save_skipped(&self.profile, &skipped)?;
        }
        self.updates
            .display
            .lock()
            .map_err(|_| "Cannot set the update status")?
            .refresh_offers(downloaded.as_ref(), &skipped);
        Ok(())
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

    async fn apply<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        sequence: u64,
        identity: Option<String>,
    ) -> Result<(), String> {
        let _action = self.updates.action.lock().await;
        if self.updates.restart_requested.load(Ordering::Acquire) {
            return Ok(());
        }
        if self.updates.restoring.load(Ordering::Acquire) {
            return Err("Wait for Bamboo to restore the previous sessions".into());
        }
        let locale = i18n::active(app);
        if self.updates.force_shutdown_started.load(Ordering::Acquire) {
            return Err(locale.text("updates.restartPending").into());
        }
        let journal = Journal::read(&self.profile)?;
        let runtime = app.state::<crate::sidecar::SidecarState>();
        let port = crate::web_service_port();
        let plan = super::PlannedRestart::read(&self.profile)?;
        let matches_approval = |candidate: &Combination| -> Result<bool, String> {
            Ok(candidate.sequence == sequence
                && match &identity {
                    Some(id) => artifact_identity(candidate)? == *id,
                    None => true,
                })
        };
        let restart = if let Some(plan) = plan {
            if !matches_approval(&plan.candidate)?
                || journal.active.as_ref() == Some(&plan.candidate)
            {
                return Err(locale.text("updates.catalogChanged").into());
            }
            self.updates.status(Phase::ShuttingDown, None);
            self.prepare_planned_restart(&runtime, port, plan).await
        } else if let Some(queued) = &journal.queued {
            if !matches_approval(queued)? {
                return Err(locale.text("updates.catalogChanged").into());
            }
            self.prepare_restart(&runtime, port).await
        } else {
            let identity = identity
                .as_ref()
                .ok_or_else(|| locale.text("updates.catalogChanged").to_string())?;
            let update = self.updates.selected(sequence, identity, locale)?;
            let active = update.validate_transition(&journal)?;
            self.require_unskipped(&update, locale)?;
            if journal::read_downloaded(&self.profile)?.as_ref() != Some(&update.candidate) {
                return Err(locale.text("updates.downloadRequired").into());
            }
            self.updates.clear_force_update();
            self.updates.status(Phase::Saving, None);
            if let Err(error) = self
                .reconfirm(active, &update, locale, self.load_catalog())
                .await
            {
                self.updates.status(Phase::SaveFailed, Some(error));
                return Ok(());
            }
            match self.use_planned_restart(&runtime, active).await {
                Ok(true) => match self.plan_restart(&runtime, &update).await {
                    Ok(plan) => {
                        self.updates.status(Phase::ShuttingDown, None);
                        self.prepare_planned_restart(&runtime, port, plan).await
                    }
                    Err(error) => Err(error),
                },
                Ok(false) => match self
                    .reopen_downloaded_update(&update.candidate)
                    .await
                    .and_then(|_| self.queue(&update))
                {
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
        self.request_restart(app);
        Ok(())
    }

    fn force_target(
        &self,
        sequence: u64,
        identity: &str,
        locale: Locale,
    ) -> Result<(Arc<SelectedUpdate>, Journal), String> {
        if self.updates.restoring.load(Ordering::Acquire)
            || self.updates.restart_requested.load(Ordering::Acquire)
            || super::PlannedRestart::read(&self.profile)?.is_some()
        {
            return Err(locale.text("updates.restartPending").into());
        }
        let update = self.updates.selected(sequence, identity, locale)?;
        let display = self
            .updates
            .display
            .lock()
            .map_err(|_| "Cannot read the update status")?;
        if display.force.as_deref() != Some(update.as_ref()) {
            return Err(locale.text("updates.catalogChanged").into());
        }
        drop(display);
        let journal = Journal::read(&self.profile)?;
        update.validate_transition(&journal)?;
        self.require_unskipped(&update, locale)?;
        if journal::read_downloaded(&self.profile)?.as_ref() != Some(&update.candidate) {
            return Err(locale.text("updates.downloadRequired").into());
        }
        Ok((update, journal))
    }

    async fn force_apply<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        sequence: u64,
        identity: &str,
    ) -> Result<(), String> {
        let _action = self.updates.action.lock().await;
        let locale = i18n::active(app);
        let (update, _) = self.force_target(sequence, identity, locale)?;
        let prompt = locale
            .text("updates.forceBody")
            .replace("{bamboo}", &update.candidate.bamboo.version)
            .replace("{lotus}", &update.candidate.lotus.version);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.dialog()
            .message(prompt)
            .title(locale.text("updates.forceTitle"))
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                locale.text("updates.forceUpdate").into(),
                locale.text("dialog.cancel").into(),
            ))
            .show(move |confirmed| {
                let _ = sender.send(confirmed);
            });
        if !receiver.await.unwrap_or(false) {
            return Ok(());
        }
        let (update, journal) = self.force_target(sequence, identity, locale)?;
        let active = update.validate_transition(&journal)?;
        self.updates.status(Phase::Saving, None);
        let runtime = app.state::<crate::sidecar::SidecarState>();
        let result = async {
            self.reconfirm(active, &update, locale, self.load_catalog())
                .await?;
            self.reopen_downloaded_update(&update.candidate).await?;
            self.queue_after_force_shutdown(
                &update,
                runtime.stop_for_update(Duration::from_secs(90)),
                crate::web_service_port(),
            )
            .await
        }
        .await;
        if let Err(error) = result {
            self.updates.status(Phase::RestartFailed, Some(error));
            return Ok(());
        }
        self.request_restart(app);
        Ok(())
    }

    pub(super) async fn queue_after_force_shutdown(
        &self,
        update: &SelectedUpdate,
        shutdown: impl Future<Output = Result<(), UpdateShutdownError>>,
        port: u16,
    ) -> Result<(), String> {
        let shutdown_already_started = self
            .updates
            .force_shutdown_started
            .swap(true, Ordering::AcqRel);
        self.updates.status(Phase::ShuttingDown, None);
        match shutdown.await {
            Ok(()) => {}
            Err(UpdateShutdownError::RequestRejected(error)) => {
                self.updates
                    .force_shutdown_started
                    .store(shutdown_already_started, Ordering::Release);
                return Err(error);
            }
            Err(UpdateShutdownError::Unconfirmed(error)) => return Err(error),
        }
        let _writer = self.profile.writer()?;
        crate::sidecar::require_available_port(port)?;
        if super::PlannedRestart::read(&self.profile)?.is_some() {
            return Err("A planned Bamboo restart still needs to complete".into());
        }
        self.queue(update)
    }

    fn request_restart<R: Runtime>(&self, app: &AppHandle<R>) {
        self.updates.clear_force_update();
        self.updates
            .restart_requested
            .store(true, Ordering::Release);
        self.updates.status(Phase::Restarting, None);
        app.request_restart();
    }

    async fn reconfirm(
        &self,
        active: &Combination,
        update: &SelectedUpdate,
        locale: Locale,
        load_catalog: impl Future<Output = Result<VerifiedChannel, String>>,
    ) -> Result<(), String> {
        let channel = load_catalog.await?;
        if !channel.select_updates(active)?.contains(&&update.candidate) {
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
    identity: String,
) -> Result<(), String> {
    authorize(&window, false)?;
    running_manager(&app)?
        .download(sequence, &identity, i18n::active(&app))
        .await
}

#[tauri::command]
pub(crate) async fn set_component_version_skipped<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    sequence: u64,
    identity: String,
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
    identity: Option<String>,
) -> Result<(), String> {
    authorize(&window, false)?;
    running_manager(&app)?.apply(&app, sequence, identity).await
}

#[tauri::command]
pub(crate) async fn force_component_update<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    sequence: u64,
    identity: String,
) -> Result<(), String> {
    authorize(&window, false)?;
    running_manager(&app)?
        .force_apply(&app, sequence, &identity)
        .await
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
        let offer = snapshot.offers.into_iter().next().unwrap();
        assert!(!offer.downloaded);
        let update = manager
            .updates
            .selected(offer.sequence, &offer.identity, Locale::English)
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
        assert!(verified.offers.into_iter().next().unwrap().downloaded);
        assert!(verified.queued.is_none());
    }

    #[tokio::test]
    async fn either_offer_can_be_staged_and_queued_without_switching_its_peer() {
        use crate::component_channel::tests::{
            fixture_channel_with_independent_updates, initial_combination,
        };

        for kind in [UpdateKind::Bamboo, UpdateKind::Lotus] {
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
                .detect(async { Ok(fixture_channel_with_independent_updates()) })
                .await
                .unwrap());
            let offers = manager.snapshot("0.0.0".into(), locale).unwrap().offers;
            assert_eq!(offers.len(), 2);
            let chosen = offers.iter().find(|offer| offer.kind == kind).unwrap();
            let peer = offers.iter().find(|offer| offer.kind != kind).unwrap();
            assert!(manager
                .download(chosen.sequence, &peer.identity, locale)
                .await
                .is_err());
            manager
                .set_skipped(peer.sequence, peer.identity.clone(), true, locale)
                .await
                .unwrap();
            let update = manager
                .updates
                .selected(chosen.sequence, &chosen.identity, locale)
                .unwrap();
            let mut altered = update.candidate.clone();
            altered.lotus.tarball.size_bytes += 1;
            assert_eq!(altered.identity(), update.candidate.identity());
            assert!(manager
                .updates
                .selected(
                    chosen.sequence,
                    &artifact_identity(&altered).unwrap(),
                    locale
                )
                .is_err());
            match kind {
                UpdateKind::Bamboo => assert_eq!(update.candidate.lotus, original.lotus),
                UpdateKind::Lotus => assert_eq!(update.candidate.bamboo, original.bamboo),
                UpdateKind::Pair => unreachable!(),
            }
            manager.record_download(&update, Ok(())).unwrap();
            let staged = manager.snapshot("0.0.0".into(), locale).unwrap().offers;
            assert!(staged
                .iter()
                .any(|offer| offer.kind == kind && offer.downloaded && !offer.skipped));
            assert!(staged
                .iter()
                .any(|offer| offer.kind != kind && !offer.downloaded && offer.skipped));
            manager.queue(&update).unwrap();
            let _writer = profile.writer().unwrap();
            manager.begin(&update.candidate).unwrap();
            manager.finish(&update.candidate, Ok(())).unwrap();
            assert!(update
                .validate_transition(&Journal::read(&profile).unwrap())
                .is_err());
            manager
                .detect(async { Ok(fixture_channel_with_independent_updates()) })
                .await
                .unwrap();
            let remaining = manager.snapshot("0.0.0".into(), locale).unwrap().offers;
            assert_eq!(remaining.len(), 1);
            assert!(remaining[0].kind != kind && remaining[0].kind != UpdateKind::Pair);
        }
    }

    #[tokio::test]
    async fn a_selected_bamboo_version_stays_staged_when_a_newer_version_appears() {
        use crate::component_channel::tests::{
            fixture_channel, fixture_channel_with_independent_bamboo_versions,
            fixture_channel_with_independent_updates, initial_combination,
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
        let manager = Manager::new(profile.clone()).unwrap();
        let locale = Locale::English;
        manager
            .detect(async { Ok(fixture_channel_with_independent_updates()) })
            .await
            .unwrap();
        let offered = manager.snapshot("0.0.0".into(), locale).unwrap().offers;
        let chosen = offered
            .iter()
            .find(|offer| offer.kind == UpdateKind::Bamboo)
            .unwrap();
        let selected = manager
            .updates
            .selected(chosen.sequence, &chosen.identity, locale)
            .unwrap();
        manager.record_download(&selected, Ok(())).unwrap();

        manager
            .detect(async { Ok(fixture_channel_with_independent_bamboo_versions()) })
            .await
            .unwrap();
        let refreshed = manager.snapshot("0.0.0".into(), locale).unwrap().offers;
        let bamboo: Vec<_> = refreshed
            .iter()
            .filter(|offer| offer.kind == UpdateKind::Bamboo)
            .collect();
        assert_eq!(bamboo[0].versions.bamboo, "2026.11.40");
        assert!(!bamboo[0].downloaded);
        assert_eq!(bamboo[1].identity, chosen.identity);
        assert!(bamboo[1].downloaded);
        assert_eq!(bamboo.len(), 2);
        manager
            .reconfirm(&original, &selected, locale, async {
                Ok(fixture_channel_with_independent_bamboo_versions())
            })
            .await
            .unwrap();
        assert!(manager
            .reconfirm(&original, &selected, locale, async {
                Ok(fixture_channel().await)
            })
            .await
            .is_err());

        manager.queue(&selected).unwrap();
        let queued = Journal::read(&profile).unwrap().queued.unwrap();
        assert_eq!(queued.bamboo.version, "2026.11.39");
        assert_eq!(queued.lotus, original.lotus);
    }

    #[tokio::test]
    async fn force_update_is_specific_to_the_download_and_tracks_shutdown_retries() {
        use crate::component_channel::tests::{
            fixture_channel_with_independent_updates, initial_combination,
        };
        let directory = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(directory.path()).unwrap();
        let original = initial_combination().await;
        Journal {
            active: Some(original),
            ..Journal::default()
        }
        .save(&profile)
        .unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let locale = Locale::English;
        manager
            .detect(async { Ok(fixture_channel_with_independent_updates()) })
            .await
            .unwrap();
        let offers = manager.snapshot("0.0.0".into(), locale).unwrap().offers;
        let chosen = &offers[0];
        let other = &offers[1];
        let update = manager
            .updates
            .selected(chosen.sequence, &chosen.identity, locale)
            .unwrap();
        manager.record_download(&update, Ok(())).unwrap();
        assert!(manager
            .force_target(chosen.sequence, &chosen.identity, locale)
            .is_err());
        manager
            .updates
            .enable_force_update(SelectedUpdate {
                current_sequence: update.current_sequence,
                current: update.current.clone(),
                candidate: update.candidate.clone(),
            })
            .unwrap();
        let granted = manager
            .snapshot("0.0.0".into(), locale)
            .unwrap()
            .force_update
            .unwrap();
        assert_eq!(granted.identity, chosen.identity);
        assert!(!granted.shutdown_started);
        assert!(manager
            .force_target(chosen.sequence, &chosen.identity, locale)
            .is_ok());
        assert!(manager
            .force_target(other.sequence, &other.identity, locale)
            .is_err());
        let rejected = || async {
            Err(UpdateShutdownError::RequestRejected(
                "shutdown request was rejected".into(),
            ))
        };
        assert_eq!(
            manager
                .queue_after_force_shutdown(&update, rejected(), 0)
                .await
                .unwrap_err(),
            "shutdown request was rejected"
        );
        assert!(manager
            .download(chosen.sequence, &chosen.identity, locale)
            .await
            .is_ok());
        assert!(
            !manager
                .snapshot("0.0.0".into(), locale)
                .unwrap()
                .force_update
                .unwrap()
                .shutdown_started
        );

        assert!(manager
            .queue_after_force_shutdown(
                &update,
                async {
                    Err(UpdateShutdownError::Unconfirmed(
                        "shutdown timed out".into(),
                    ))
                },
                0,
            )
            .await
            .is_err());
        assert!(manager
            .queue_after_force_shutdown(&update, rejected(), 0)
            .await
            .is_err());
        assert!(
            manager
                .snapshot("0.0.0".into(), locale)
                .unwrap()
                .force_update
                .unwrap()
                .shutdown_started
        );
        assert!(manager
            .download(other.sequence, &other.identity, locale)
            .await
            .is_err());
        assert!(manager
            .force_target(chosen.sequence, &chosen.identity, locale)
            .is_ok());
        assert!(Journal::read(&profile).unwrap().queued.is_none());
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
            .offers
            .into_iter()
            .next()
            .unwrap();

        assert!(manager
            .set_skipped(
                offer.sequence,
                artifact_identity(&original).unwrap(),
                true,
                locale
            )
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
            [manager
                .updates
                .selected(offer.sequence, &offer.identity, locale)
                .unwrap()
                .candidate
                .identity()]
        );
        let reopened = Manager::new(profile.clone()).unwrap();
        assert_eq!(reopened.choose().await.unwrap(), original);
        assert!(!reopened
            .detect(async { Ok(fixture_channel().await) })
            .await
            .unwrap());
        let skipped = reopened.snapshot("0.0.0".into(), locale).unwrap();
        assert!(matches!(skipped.display.phase, Phase::Skipped));
        assert!(skipped.offers.into_iter().next().unwrap().skipped);
        assert_eq!(
            reopened
                .download(offer.sequence, &offer.identity, locale)
                .await
                .unwrap_err(),
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
            .offers
            .into_iter()
            .next()
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
            .offers
            .into_iter()
            .next()
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
            .offers
            .into_iter()
            .next()
            .unwrap();
        let update = manager
            .updates
            .selected(offer.sequence, &offer.identity, locale)
            .unwrap();
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
            .offers
            .into_iter()
            .next()
            .unwrap();
        assert!(skipped.downloaded && skipped.skipped);
        manager
            .set_skipped(offer.sequence, offer.identity.clone(), false, locale)
            .await
            .unwrap();
        let resumed = manager.snapshot("0.0.0".into(), locale).unwrap();
        assert!(matches!(resumed.display.phase, Phase::Verified));
        assert!(resumed.offers.into_iter().next().unwrap().downloaded);
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
