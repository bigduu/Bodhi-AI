use super::{
    journal::{self, History, Journal, Versions},
    Manager, SelectedUpdate,
};
use crate::component_channel::github_token::{GitHubUpdateCredentials, GitHubUpdateTokenState};
use crate::component_channel::producer::{self, Discovery};
use crate::component_channel::stable::{self, StableCatalog};
use crate::component_channel::{
    load_manual_bamboo_release, read_local_bamboo_manifest, BambooRelease, Changes, Combination,
    LotusRelease, PairIdentity, ReleaseCheckError, UpdateKind, VerifiedChannel,
};
use crate::component_download::{while_selected, DownloadSettings, DownloadSource};
use crate::i18n::{self, Locale};
use crate::sidecar::UpdateShutdownError;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager as _, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(crate) const MENU_ID: &str = "component-updates";
const PAGE: &str = "component-updates.html";
const REMINDER_DELAY: Duration = Duration::from_secs(30 * 60);
const IMMEDIATE_RELEASE_CHECK: Duration = Duration::from_secs(3);

#[cfg(test)]
mod stable_tests;

type StableCatalogs = (
    Result<StableCatalog<BambooRelease>, ReleaseCheckError>,
    Result<StableCatalog<LotusRelease>, ReleaseCheckError>,
);

#[derive(Default)]
pub(super) struct Updates {
    display: Mutex<Display>,
    action: tokio::sync::Mutex<()>,
    github_credentials: GitHubUpdateCredentials,
    restart_requested: AtomicBool,
    force_shutdown_started: AtomicBool,
    lotus_rollback_started: AtomicBool,
    dialog_open: AtomicBool,
    pub(super) boot: tokio::sync::Mutex<()>,
    pub(super) ready: AtomicBool,
    pub(super) restoring: AtomicBool,
    pub(super) unconfirmed_handoff: AtomicBool,
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
    Reconnecting,
    RestoringSessions,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LotusRollbackOffer {
    identity: String,
    versions: Versions,
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
    bamboo_restart_pending: bool,
    bamboo_recovery_pending: bool,
    settings: DownloadSettings,
    github_update_token_state: GitHubUpdateTokenState,
    auto_check_hours: u16,
    last_check: Option<String>,
    display: Display,
    offers: Vec<Offer>,
    force_update: Option<ForceOffer>,
    lotus_rollback: Option<LotusRollbackOffer>,
    lotus_update_suppressed: bool,
    history: Vec<History>,
}

impl Updates {
    pub(super) fn reset_kernel_shutdown(&self) {
        self.force_shutdown_started.store(false, Ordering::Release);
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
        warning: Option<String>,
    ) -> Result<bool, String> {
        let mut display = self
            .display
            .lock()
            .map_err(|_| "Cannot set the update status")?;
        display.selections = selections;
        let available = display.refresh_offers(downloaded, skipped);
        display.error = warning;
        Ok(available)
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
        let kernel_switch = self.pending_kernel_switch()?;
        let unconfirmed = self.updates.unconfirmed_handoff.load(Ordering::Acquire);
        let lotus_rollback = if planned.is_none()
            && journal.queued.is_none()
            && journal.trial.is_none()
            && !self.restart_in_progress()
            && kernel_switch.is_none()
        {
            journal
                .lotus_rollback_target()
                .map(|pair| {
                    Ok::<_, String>(LotusRollbackOffer {
                        identity: artifact_identity(pair)?,
                        versions: Versions::from(pair),
                        shutdown_started: self
                            .updates
                            .lotus_rollback_started
                            .load(Ordering::Acquire),
                    })
                })
                .transpose()?
        } else {
            None
        };
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
                if unconfirmed && kind == UpdateKind::Bamboo {
                    continue;
                }
                if planned.is_none()
                    && kernel_switch.is_none()
                    && !self.updates.restoring.load(Ordering::Acquire)
                    && !self.updates.restart_requested.load(Ordering::Acquire)
                    && !self.updates.lotus_rollback_started.load(Ordering::Acquire)
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
            queued: kernel_switch
                .as_ref()
                .map(|pending| pending.update.candidate.sequence)
                .or_else(|| journal.queued.as_ref().map(|candidate| candidate.sequence))
                .or(planned
                    .filter(|plan| {
                        !unconfirmed
                            && journal.active.as_ref() != Some(&plan.candidate)
                            && !self.updates.restoring.load(Ordering::Acquire)
                    })
                    .map(|plan| plan.candidate.sequence)),
            bamboo_restart_pending: kernel_switch.is_some(),
            bamboo_recovery_pending: unconfirmed,
            settings: self.settings.borrow().clone(),
            github_update_token_state: self.updates.github_credentials.status(),
            auto_check_hours: *self.auto_check_hours.borrow(),
            last_check: journal.last_check,
            display,
            offers,
            force_update,
            lotus_rollback,
            lotus_update_suppressed: journal.suppressed_lotus.is_some()
                && !self.restart_in_progress()
                && !self.updates.lotus_rollback_started.load(Ordering::Acquire),
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

    fn remember_check_hours(&self, hours: u16) -> Result<(), String> {
        let _lock = self.profile.update_lock()?;
        journal::save_check_hours(&self.profile, hours)?;
        self.auto_check_hours.send_if_modified(|current| {
            if *current == hours {
                return false;
            }
            *current = hours;
            true
        });
        Ok(())
    }

    fn snooze(&self) -> Result<(), String> {
        let _lock = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        journal.remind_after = Some(Utc::now().timestamp() + REMINDER_DELAY.as_secs() as i64);
        journal.save(&self.profile)
    }

    pub(crate) async fn poll<R: Runtime>(&self, app: &AppHandle<R>) {
        self.updates.github_credentials.initialize().await;
        let mut schedule = self.auto_check_hours.subscribe();
        loop {
            let delay = {
                let _action = self.updates.action.lock().await;
                let hours = *schedule.borrow_and_update();
                let interval = check_interval(hours);
                match self.prepare_automatic_check(interval, Utc::now()) {
                    Ok(Some(remaining)) if remaining.is_zero() => {
                        if self.check().await {
                            self.remind(app);
                        }
                        interval
                    }
                    Ok(remaining) => remaining,
                    Err(error) => {
                        self.updates.status(Phase::CheckFailed, Some(error));
                        interval
                    }
                }
            };
            tokio::select! {
                _ = wait_for_check(delay) => {}
                result = schedule.changed() => {
                    if result.is_err() {
                        break;
                    }
                }
            }
        }
    }

    fn prepare_automatic_check(
        &self,
        interval: Option<Duration>,
        now: DateTime<Utc>,
    ) -> Result<Option<Duration>, String> {
        let journal = Journal::read(&self.profile)?;
        let remaining = interval
            .map(|interval| remaining_check_delay(interval, journal.last_check.as_deref(), now));
        if remaining != Some(Duration::ZERO) && self.check_allowed(&journal)? {
            self.restore_downloaded_offer(&journal)?;
        }
        Ok(remaining)
    }

    fn restore_downloaded_offer(&self, journal: &Journal) -> Result<(), String> {
        let Some(current) = &journal.active else {
            return Ok(());
        };
        let mut display = self
            .updates
            .display
            .lock()
            .map_err(|_| "Cannot read the update status")?;
        if !display.selections.is_empty() || !matches!(display.phase, Phase::Ready) {
            return Ok(());
        }
        let downloaded = journal::read_downloaded(&self.profile)?;
        if let Some(pair) = downloaded.filter(|pair| {
            producer::retain_download(current, pair, journal.suppressed_lotus.as_deref())
        }) {
            let skipped = journal::read_skipped(&self.profile)?;
            display.selections.push(Arc::new(SelectedUpdate {
                current_sequence: current.sequence,
                current: current.identity(),
                candidate: pair.clone(),
            }));
            let warning = display.error.take();
            display.refresh_offers(Some(&pair), &skipped);
            display.error = warning;
        }
        Ok(())
    }

    fn check_allowed(&self, journal: &Journal) -> Result<bool, String> {
        Ok(journal.active.is_some()
            && self.pending_kernel_switch()?.is_none()
            && !self.updates.restoring.load(Ordering::Acquire)
            && journal.trial.is_none()
            && journal.queued.is_none()
            && !self.local_shutdown_started()
            && super::PlannedRestart::read(&self.profile)?.is_none())
    }

    async fn check(&self) -> bool {
        self.check_with_catalogs(|settings| async move {
            tokio::join!(
                stable::load_bamboo(&settings),
                stable::load_lotus(&settings)
            )
        })
        .await
    }

    async fn check_with_catalogs<F: Future<Output = StableCatalogs> + Send>(
        &self,
        load: impl Fn(DownloadSettings) -> F + Sync,
    ) -> bool {
        let detected = self
            .detect_updates(async |current, journal, downloaded| {
                let downloaded_local = match downloaded {
                    Some(pair) if pair.update_kind(current) == Some(UpdateKind::Bamboo) => {
                        journal::matches_local_bamboo_download(
                            &self.profile,
                            pair,
                            &artifact_identity(pair)?,
                        )?
                    }
                    _ => false,
                };
                let mut settings = self.settings.subscribe();
                let (bamboo, lotus) = loop {
                    let selected = settings.borrow_and_update().clone();
                    if let Some(result) =
                        while_selected(&mut settings, &selected, load(selected.clone())).await
                    {
                        break result;
                    }
                };
                let catalog_download =
                    downloaded.filter(|pair| pair.producer_release && !downloaded_local);
                let bamboo_download = catalog_download
                    .filter(|pair| pair.update_kind(current) == Some(UpdateKind::Bamboo));
                let lotus_download = catalog_download
                    .filter(|pair| pair.update_kind(current) == Some(UpdateKind::Lotus));
                let bamboo = bamboo.and_then(|catalog| {
                    self.record_catalog(UpdateKind::Bamboo, catalog, current, bamboo_download)
                });
                let lotus = lotus.and_then(|catalog| {
                    self.record_catalog(UpdateKind::Lotus, catalog, current, lotus_download)
                });
                let saved = journal::read_downloaded(&self.profile)?;
                let downloaded = downloaded.filter(|pair| {
                    Some(*pair) == saved.as_ref()
                        || match pair.update_kind(current) {
                            Some(UpdateKind::Bamboo) => bamboo.is_ok(),
                            Some(UpdateKind::Lotus) => lotus.is_ok(),
                            _ => false,
                        }
                });
                Ok(producer::discover(
                    bamboo,
                    lotus,
                    current,
                    downloaded,
                    downloaded_local,
                    journal.suppressed_lotus.as_deref(),
                    journal.rolled_back_lotus.as_ref(),
                ))
            })
            .await;
        match detected {
            Ok(available) => available,
            Err(error) => {
                self.updates.status(Phase::CheckFailed, Some(error));
                false
            }
        }
    }

    fn record_catalog<T>(
        &self,
        kind: UpdateKind,
        catalog: StableCatalog<T>,
        active: &Combination,
        downloaded: Option<&Combination>,
    ) -> Result<StableCatalog<T>, ReleaseCheckError> {
        let active = match kind {
            UpdateKind::Bamboo
                if active
                    .bamboo
                    .artifacts
                    .iter()
                    .all(|asset| asset.browser_runtime.is_some()) =>
            {
                Some((
                    active.bamboo.version.as_str(),
                    stable::release_digest(&active.bamboo)?,
                ))
            }
            UpdateKind::Lotus => Some((
                active.lotus.version.as_str(),
                stable::release_digest(&active.lotus)?,
            )),
            _ => None,
        };
        let staged = match (kind, downloaded) {
            (UpdateKind::Bamboo, Some(pair)) => Some(journal::CatalogDownload {
                pair,
                version: &pair.bamboo.version,
                digest: stable::release_digest(&pair.bamboo)?,
                local_identity: Some(artifact_identity(pair)?),
            }),
            (UpdateKind::Lotus, Some(pair)) => Some(journal::CatalogDownload {
                pair,
                version: &pair.lotus.version,
                digest: stable::release_digest(&pair.lotus)?,
                local_identity: None,
            }),
            _ => None,
        };
        journal::record_catalog(&self.profile, kind, &catalog, staged, active)?;
        Ok(catalog)
    }

    #[cfg(test)]
    async fn detect(
        &self,
        load_catalog: impl Future<Output = Result<VerifiedChannel, String>>,
    ) -> Result<bool, String> {
        self.detect_updates(async move |current, journal, _| {
            let catalog = load_catalog.await?;
            Ok(Discovery {
                offers: catalog
                    .select_updates(current, journal.suppressed_lotus.as_deref())?
                    .into_iter()
                    .cloned()
                    .collect(),
                failures: Vec::new(),
                download_changed: false,
            })
        })
        .await
    }

    async fn detect_updates(
        &self,
        discovery: impl AsyncFnOnce(
            &Combination,
            &Journal,
            Option<&Combination>,
        ) -> Result<Discovery, String>,
    ) -> Result<bool, String> {
        let (journal, downloaded) = {
            let _lock = self.profile.update_lock()?;
            let mut journal = Journal::read(&self.profile)?;
            if !self.check_allowed(&journal)? {
                return Ok(false);
            }
            let downloaded = journal::read_downloaded(&self.profile)?;
            journal.last_check = Some(Utc::now().to_rfc3339());
            journal.save(&self.profile)?;
            (journal, downloaded)
        };
        let current = journal
            .active
            .as_ref()
            .expect("check requires active components");
        self.updates.status(Phase::Checking, None);
        let Discovery {
            offers,
            failures,
            download_changed,
        } = discovery(current, &journal, downloaded.as_ref()).await?;
        let downloaded = if download_changed {
            if let Some(candidate) = &downloaded {
                let _lock = self.profile.update_lock()?;
                journal::clear_downloaded(&self.profile, candidate)?;
            }
            None
        } else {
            downloaded
        };
        if failures.len() >= 2 && offers.is_empty() {
            return Err(failures.join("\n"));
        }
        let identity = current.identity();
        let selections = offers
            .into_iter()
            .map(|candidate| {
                Arc::new(SelectedUpdate {
                    current_sequence: current.sequence,
                    current: identity.clone(),
                    candidate,
                })
            })
            .collect();
        let skipped = journal::read_skipped(&self.profile)?;
        let warning = (!failures.is_empty()).then(|| failures.join("\n"));
        let available =
            self.updates
                .set_selections(selections, downloaded.as_ref(), &skipped, warning)?;
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

    async fn import_local_bamboo(&self, manifest: PathBuf, locale: Locale) -> Result<(), String> {
        let _action = self.updates.action.lock().await;
        let journal = Journal::read(&self.profile)?;
        if !self.check_allowed(&journal)? {
            return Err(locale.text("updates.restartPending").into());
        }
        let active = journal
            .active
            .as_ref()
            .ok_or("Bodhi components are not ready")?;
        self.updates.status(Phase::Checking, None);
        match self.stage_local_bamboo(manifest, active).await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.updates.status(Phase::DownloadFailed, None);
                Err(error)
            }
        }
    }

    async fn stage_local_bamboo(
        &self,
        manifest: PathBuf,
        active: &Combination,
    ) -> Result<(), String> {
        let directory = manifest
            .parent()
            .ok_or("Cannot locate the Bamboo release folder")?
            .to_path_buf();
        let (version, manifest_identity) =
            tokio::task::spawn_blocking(move || read_local_bamboo_manifest(&manifest))
                .await
                .map_err(|error| error.to_string())??;
        let release = {
            let mut settings = self.settings.subscribe();
            loop {
                let route = settings.borrow_and_update().clone();
                let work = load_manual_bamboo_release(&route, &version);
                if let Some(result) = while_selected(&mut settings, &route, work).await {
                    break result?;
                }
            }
        };
        let pair = producer::bamboo_offer(active, release, Vec::new())?
            .ok_or("Choose a Bamboo release newer than the installed version")?;
        let update = self.select_local_bamboo_offer(active, pair)?;
        self.verify_local_bamboo_offer(&update)?;
        let pair = &update.candidate;
        if pair.bamboo.manifest != manifest_identity {
            return Err("The selected Bamboo manifest differs from the official release".into());
        }
        crate::bamboo_update::check_component_floor(&self.profile, &pair.bamboo.version)?;
        let candidate = pair.candidate()?;
        self.updates.status(Phase::Downloading, None);
        crate::component_kernel::prepare_local_kernel(&self.profile.data, &candidate, &directory)
            .await?;
        crate::component_browser::prepare_local_runtime(&self.profile.data, &candidate, &directory)
            .await?;
        self.prove_prepared_update(pair).await?;
        {
            let _lock = self.profile.update_lock()?;
            update.validate_transition(&Journal::read(&self.profile)?)?;
            journal::save_local_bamboo_download(&self.profile, pair, &artifact_identity(pair)?)?;
        }

        let skipped = journal::read_skipped(&self.profile)?;
        let mut display = self
            .updates
            .display
            .lock()
            .map_err(|_| "Cannot set the update status")?;
        display
            .selections
            .retain(|selection| selection.candidate.update_kind(active) == Some(UpdateKind::Lotus));
        display.selections.push(update.clone());
        display.refresh_offers(Some(pair), &skipped);
        Ok(())
    }

    fn select_local_bamboo_offer(
        &self,
        active: &Combination,
        mut candidate: Combination,
    ) -> Result<Arc<SelectedUpdate>, String> {
        let display = self
            .updates
            .display
            .lock()
            .map_err(|_| "Cannot read the update status")?;
        // Older catalog offers may use the same sequence as a producer offer.
        while display.selections.iter().any(|selection| {
            selection.candidate.sequence == candidate.sequence
                && selection.candidate.update_kind(active) == Some(UpdateKind::Lotus)
        }) {
            candidate.sequence = candidate
                .sequence
                .checked_add(2)
                .ok_or("Bamboo update sequence overflow")?;
        }
        Ok(Arc::new(SelectedUpdate {
            current_sequence: active.sequence,
            current: active.identity(),
            candidate,
        }))
    }

    fn verify_local_bamboo_offer(&self, update: &SelectedUpdate) -> Result<(), String> {
        let release = &update.candidate.bamboo;
        let changed =
            |pair: &Combination| pair.bamboo.version == release.version && pair.bamboo != *release;
        let mut downloaded_changed = false;
        {
            let _lock = self.profile.update_lock()?;
            if let Some(staged) = journal::read_downloaded(&self.profile)?.filter(changed) {
                journal::clear_downloaded(&self.profile, &staged)?;
                downloaded_changed = true;
            }
        }
        let mut display = self
            .updates
            .display
            .lock()
            .map_err(|_| "Cannot read the update status")?;
        let prior_count = display.selections.len();
        display.selections.retain(|item| !changed(&item.candidate));
        if downloaded_changed || display.selections.len() != prior_count {
            return Err(
                "The local Bamboo release differs from an already verified release of the same version".into(),
            );
        }
        Ok(())
    }

    async fn download(&self, sequence: u64, identity: &str, locale: Locale) -> Result<(), String> {
        let _action = self.updates.action.lock().await;
        if self.local_shutdown_started()
            || self.pending_kernel_switch()?.is_some()
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
            || self.local_shutdown_started()
            || self.pending_kernel_switch()?.is_some()
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
        if let Some(pending) = self.pending_kernel_switch()? {
            if pending.update.candidate.sequence != sequence
                || match identity.as_deref() {
                    Some(expected) => artifact_identity(&pending.update.candidate)? != expected,
                    None => false,
                }
            {
                return Err(locale.text("updates.catalogChanged").into());
            }
            self.continue_kernel_switch(app, pending, None).await;
            return Ok(());
        }
        if self.updates.lotus_rollback_started.load(Ordering::Acquire) {
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
            let (update, active) = self.downloaded_update(sequence, identity, &journal, locale)?;
            self.updates.status(Phase::Saving, None);
            if !self.updates.force_shutdown_started.load(Ordering::Acquire) {
                let check = self.reconfirm_selected(active, &update, locale);
                if let Err(error) = allow_cached_immediate_update(check).await {
                    self.updates.status(Phase::SaveFailed, Some(error));
                    return Ok(());
                }
            }
            if update.candidate.update_kind(active) == Some(UpdateKind::Bamboo) {
                self.begin_kernel_switch(app, update).await;
                return Ok(());
            }
            match self.reopen_downloaded_update(&update.candidate).await {
                Ok(_) => {
                    self.queue_after_force_shutdown(
                        &update,
                        runtime.force_stop_for_update(Duration::from_secs(10)),
                        port,
                    )
                    .await
                }
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

    fn restart_in_progress(&self) -> bool {
        self.updates.restart_requested.load(Ordering::Acquire)
            || self.updates.restoring.load(Ordering::Acquire)
            || self.updates.force_shutdown_started.load(Ordering::Acquire)
    }

    pub(super) fn local_shutdown_started(&self) -> bool {
        self.updates.force_shutdown_started.load(Ordering::Acquire)
            || self.updates.lotus_rollback_started.load(Ordering::Acquire)
    }

    fn require_idle_journal(&self, journal: &Journal, locale: Locale) -> Result<(), String> {
        if self.restart_in_progress()
            || self.pending_kernel_switch()?.is_some()
            || journal.queued.is_some()
            || journal.trial.is_some()
            || super::PlannedRestart::read(&self.profile)?.is_some()
        {
            return Err(locale.text("updates.restartPending").into());
        }
        Ok(())
    }

    async fn rollback_lotus<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        identity: &str,
    ) -> Result<(), String> {
        let _action = self.updates.action.lock().await;
        let locale = i18n::active(app);
        let journal = Journal::read(&self.profile)?;
        self.require_idle_journal(&journal, locale)?;
        let pair = journal
            .lotus_rollback_target()
            .ok_or_else(|| locale.text("updates.catalogChanged").to_string())?;
        if artifact_identity(pair)? != identity {
            return Err(locale.text("updates.catalogChanged").into());
        }
        self.updates.status(Phase::Saving, None);
        let result = async {
            if !self.updates.lotus_rollback_started.load(Ordering::Acquire) {
                self.reopen_prepared(pair).await?;
            }
            self.updates.status(Phase::ShuttingDown, None);
            let runtime = app.state::<crate::sidecar::SidecarState>();
            self.queue_lotus_rollback(
                pair,
                runtime.stop_for_rollback(Duration::from_secs(90)),
                crate::web_service_port(),
                locale,
            )
            .await
        }
        .await;
        if let Err(error) = result {
            self.updates.status(Phase::RestartFailed, Some(error));
        } else {
            self.request_restart(app);
        }
        Ok(())
    }

    async fn queue_lotus_rollback(
        &self,
        pair: &Combination,
        shutdown: impl Future<Output = Result<(), UpdateShutdownError>>,
        port: u16,
        locale: Locale,
    ) -> Result<(), String> {
        wait_for_owned_exit(&self.updates.lotus_rollback_started, shutdown).await?;
        let _writer = self.profile.writer()?;
        crate::sidecar::require_available_port(port)?;
        let _update = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        self.require_idle_journal(&journal, locale)?;
        if journal.lotus_rollback_target() != Some(pair) {
            return Err(locale.text("updates.catalogChanged").into());
        }
        journal.queued = Some(pair.clone());
        journal.save(&self.profile)
    }

    async fn resume_lotus_updates(&self, locale: Locale) -> Result<(), String> {
        let _action = self.updates.action.lock().await;
        {
            if self.updates.lotus_rollback_started.load(Ordering::Acquire) {
                return Err(locale.text("updates.restartPending").into());
            }
            let _update = self.profile.update_lock()?;
            let mut journal = Journal::read(&self.profile)?;
            self.require_idle_journal(&journal, locale)?;
            if journal.suppressed_lotus.take().is_none() {
                return Ok(());
            }
            journal.save(&self.profile)?;
        }
        self.check().await;
        Ok(())
    }

    fn downloaded_update<'a>(
        &self,
        sequence: u64,
        identity: &str,
        journal: &'a Journal,
        locale: Locale,
    ) -> Result<(Arc<SelectedUpdate>, &'a Combination), String> {
        let update = self.updates.selected(sequence, identity, locale)?;
        let active = update.validate_transition(journal)?;
        self.require_unskipped(&update, locale)?;
        if journal::read_downloaded(&self.profile)?.as_ref() != Some(&update.candidate) {
            return Err(locale.text("updates.downloadRequired").into());
        }
        Ok((update, active))
    }

    pub(super) async fn queue_after_force_shutdown(
        &self,
        update: &SelectedUpdate,
        shutdown: impl Future<Output = Result<(), UpdateShutdownError>>,
        port: u16,
    ) -> Result<(), String> {
        self.updates.status(Phase::ShuttingDown, None);
        wait_for_owned_exit(&self.updates.force_shutdown_started, shutdown).await?;
        let _writer = self.profile.writer()?;
        crate::sidecar::require_available_port(port)?;
        if super::PlannedRestart::read(&self.profile)?.is_some() {
            return Err("A planned Bamboo restart still needs to complete".into());
        }
        self.queue(update)
    }

    fn request_restart<R: Runtime>(&self, app: &AppHandle<R>) {
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
        load_catalog: impl Future<Output = Result<VerifiedChannel, ReleaseCheckError>>,
    ) -> Result<(), ReleaseCheckError> {
        let channel = load_catalog.await?;
        let journal = Journal::read(&self.profile)?;
        if !channel
            .select_updates(active, journal.suppressed_lotus.as_deref())?
            .contains(&&update.candidate)
        {
            return Err(locale.text("updates.catalogChanged").into());
        }
        Ok(())
    }

    async fn reconfirm_selected(
        &self,
        active: &Combination,
        update: &SelectedUpdate,
        locale: Locale,
    ) -> Result<(), ReleaseCheckError> {
        // Manual imports were authenticated at staging. The normal restart paths
        // reopen and verify the exact cached files before taking the writer offline.
        if update.candidate.update_kind(active) == Some(UpdateKind::Bamboo)
            && journal::matches_local_bamboo_download(
                &self.profile,
                &update.candidate,
                &artifact_identity(&update.candidate)?,
            )?
        {
            return Ok(());
        }
        if !update.candidate.producer_release {
            return self
                .reconfirm(active, update, locale, self.load_catalog())
                .await;
        }
        self.reconfirm_stable(
            update,
            active,
            locale,
            |settings| async move { stable::load_bamboo(&settings).await },
            |settings| async move { stable::load_lotus(&settings).await },
        )
        .await
    }

    async fn reconfirm_stable<B, L>(
        &self,
        update: &SelectedUpdate,
        active: &Combination,
        locale: Locale,
        load_bamboo: impl Fn(DownloadSettings) -> B + Sync,
        load_lotus: impl Fn(DownloadSettings) -> L + Sync,
    ) -> Result<(), ReleaseCheckError>
    where
        B: Future<Output = Result<StableCatalog<BambooRelease>, ReleaseCheckError>> + Send,
        L: Future<Output = Result<StableCatalog<LotusRelease>, ReleaseCheckError>> + Send,
    {
        let mut settings = self.settings.subscribe();
        loop {
            let selected = settings.borrow_and_update().clone();
            let candidate = &update.candidate;
            let kind = candidate
                .update_kind(active)
                .ok_or_else(|| locale.text("updates.catalogChanged").to_string())?;
            let work = async {
                let confirm = match kind {
                    UpdateKind::Bamboo => {
                        let catalog = self.record_catalog(
                            kind,
                            load_bamboo(selected.clone()).await?,
                            active,
                            Some(candidate),
                        )?;
                        producer::reconfirm(&catalog, &candidate.bamboo.version, &candidate.bamboo)
                    }
                    UpdateKind::Lotus => {
                        let catalog = self.record_catalog(
                            kind,
                            load_lotus(selected.clone()).await?,
                            active,
                            Some(candidate),
                        )?;
                        producer::reconfirm(&catalog, &candidate.lotus.version, &candidate.lotus)
                    }
                    UpdateKind::Pair => return Err(locale.text("updates.catalogChanged").into()),
                };
                confirm
            };
            if let Some(result) = while_selected(&mut settings, &selected, work).await {
                return result;
            }
        }
    }
}

async fn allow_cached_immediate_update(
    reconfirm: impl Future<Output = Result<(), ReleaseCheckError>>,
) -> Result<(), String> {
    match tokio::time::timeout(IMMEDIATE_RELEASE_CHECK, reconfirm).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(ReleaseCheckError::Rejected(error))) => Err(error),
        Ok(Err(ReleaseCheckError::Unavailable(error))) => {
            log::info!("Applying the locally verified component update: {error}");
            Ok(())
        }
        Err(_) => {
            log::info!(
                "Applying the locally verified component update after the release check timed out"
            );
            Ok(())
        }
    }
}

async fn wait_for_owned_exit(
    shutdown_started: &AtomicBool,
    shutdown: impl Future<Output = Result<(), UpdateShutdownError>>,
) -> Result<(), String> {
    let already_started = shutdown_started.swap(true, Ordering::AcqRel);
    match shutdown.await {
        Ok(()) => Ok(()),
        Err(UpdateShutdownError::RequestRejected(error)) => {
            shutdown_started.store(already_started, Ordering::Release);
            Err(error)
        }
        Err(UpdateShutdownError::Unconfirmed(error)) => Err(error),
    }
}

fn check_interval(hours: u16) -> Option<Duration> {
    (hours != 0).then(|| Duration::from_secs(u64::from(hours) * 60 * 60))
}

async fn wait_for_check(delay: Option<Duration>) {
    if let Some(delay) = delay {
        tokio::time::sleep(delay).await;
    } else {
        std::future::pending().await
    }
}

fn remaining_check_delay(
    interval: Duration,
    last_check: Option<&str>,
    now: DateTime<Utc>,
) -> Duration {
    let Some(last_check) = last_check.and_then(|time| DateTime::parse_from_rfc3339(time).ok())
    else {
        return Duration::ZERO;
    };
    let elapsed = now
        .signed_duration_since(last_check.with_timezone(&Utc))
        .to_std()
        .unwrap_or_default();
    interval.saturating_sub(elapsed)
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
pub(crate) async fn import_local_bamboo_update<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<bool, String> {
    authorize(&window, false)?;
    let manager = running_manager(&app)?;
    let locale = i18n::active(&app);
    let (chosen, selection) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title(locale.text("updates.importLocalBamboo"))
        .add_filter(locale.text("kernel.receiptFilter"), &["json"])
        .pick_file(move |path| {
            let _ = chosen.send(path);
        });
    let Some(path) = selection.await.map_err(|error| error.to_string())? else {
        return Ok(false);
    };
    manager
        .import_local_bamboo(path.into_path().map_err(|error| error.to_string())?, locale)
        .await?;
    Ok(true)
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
pub(crate) async fn rollback_lotus_component<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    identity: String,
) -> Result<(), String> {
    authorize(&window, false)?;
    running_manager(&app)?.rollback_lotus(&app, &identity).await
}

#[tauri::command]
pub(crate) async fn resume_lotus_updates<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    authorize(&window, false)?;
    running_manager(&app)?
        .resume_lotus_updates(i18n::active(&app))
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

#[tauri::command]
pub(crate) fn set_component_check_interval<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    hours: u16,
) -> Result<(), String> {
    authorize(&window, false)?;
    app.try_state::<Manager>()
        .ok_or_else(|| "The component updater is unavailable".to_string())?
        .remember_check_hours(hours)
}

#[tauri::command]
pub(crate) async fn save_github_update_token<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    token: String,
) -> Result<(), String> {
    authorize(&window, false)?;
    let manager = running_manager(&app)?;
    let _action = manager.updates.action.lock().await;
    manager.updates.github_credentials.save(token).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn test_github_update_token<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    authorize(&window, false)?;
    let manager = running_manager(&app)?;
    let _action = manager.updates.action.lock().await;
    let credentials = &manager.updates.github_credentials;
    credentials.initialize().await;
    let mut settings = manager.settings.subscribe();
    loop {
        let selected = settings.borrow_and_update().clone();
        let work = crate::component_channel::test_github_update_token(credentials, &selected);
        if let Some(result) = while_selected(&mut settings, &selected, work).await {
            return result.map_err(str::to_owned);
        }
    }
}

#[tauri::command]
pub(crate) async fn remove_github_update_token<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    authorize(&window, false)?;
    let manager = running_manager(&app)?;
    let _action = manager.updates.action.lock().await;
    manager.updates.github_credentials.remove().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_check_becomes_due_at_the_configured_boundary() {
        let start = Utc::now();
        let saved = start.to_rfc3339();
        let interval = check_interval(3).unwrap();
        assert_eq!(remaining_check_delay(interval, None, start), Duration::ZERO);
        assert_eq!(
            remaining_check_delay(interval, Some(&saved), start + chrono::TimeDelta::hours(2)),
            Duration::from_secs(3600)
        );
        assert_eq!(
            remaining_check_delay(interval, Some(&saved), start + chrono::TimeDelta::hours(3)),
            Duration::ZERO
        );
        assert_eq!(check_interval(0), None);
    }

    #[tokio::test]
    async fn reopened_manager_respects_failed_check_and_retains_verified_download() {
        use crate::component_channel::tests::{fixture_channel, initial_combination};

        let directory = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(directory.path()).unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let original = initial_combination().await;
        let channel = fixture_channel().await;
        let target = channel
            .select(Some((original.sequence, &original.identity())))
            .unwrap()
            .unwrap()
            .combination
            .clone();
        manager.begin(&original).unwrap();
        manager.finish(&original, Ok(())).unwrap();
        journal::save_downloaded(&profile, &target).unwrap();
        assert_eq!(
            manager
                .detect(async { Err("network unavailable".into()) })
                .await,
            Err("network unavailable".into())
        );
        let saved = Journal::read(&profile).unwrap().last_check.unwrap();
        let last_check = DateTime::parse_from_rfc3339(&saved)
            .unwrap()
            .with_timezone(&Utc);

        let reopened = Manager::new(profile.clone()).unwrap();
        reopened.updates.status(Phase::Ready, None);
        let interval = check_interval(*reopened.auto_check_hours.borrow());
        assert_eq!(interval, Some(Duration::from_secs(3 * 60 * 60)));
        assert_eq!(
            reopened
                .prepare_automatic_check(interval, last_check)
                .unwrap(),
            interval
        );
        let snapshot = reopened.snapshot("0.0.0".into(), Locale::English).unwrap();
        assert!(snapshot
            .offers
            .iter()
            .any(|offer| offer.downloaded && offer.sequence == target.sequence));

        let mut schedule = reopened.auto_check_hours.subscribe();
        reopened.remember_check_hours(0).unwrap();
        schedule.changed().await.unwrap();
        let manual = Manager::new(profile.clone()).unwrap();
        assert_eq!(*manual.auto_check_hours.borrow(), 0);
        assert_eq!(
            manual.prepare_automatic_check(None, last_check).unwrap(),
            None
        );
        assert!(manual.detect(async { Ok(channel) }).await.is_ok());
        assert!(Journal::read(&profile).unwrap().last_check.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn immediate_release_check_allows_transport_failure_and_bounds_unresponsive_sources() {
        let unavailable = ReleaseCheckError::Unavailable("cannot reach producer".into());
        allow_cached_immediate_update(async { Err(unavailable) })
            .await
            .unwrap();
        let start = tokio::time::Instant::now();
        allow_cached_immediate_update(std::future::pending())
            .await
            .unwrap();
        assert_eq!(start.elapsed(), IMMEDIATE_RELEASE_CHECK);
        let rejected = ReleaseCheckError::Rejected("the selected release was withdrawn".into());
        assert_eq!(
            allow_cached_immediate_update(async { Err(rejected) }).await,
            Err("the selected release was withdrawn".into())
        );
    }

    #[tokio::test]
    async fn lotus_rollback_preserves_bamboo_and_recovers_a_failed_start() {
        use crate::component_channel::tests::{
            fixture_channel_with_lotus_only_update, initial_combination,
        };

        let directory = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(directory.path()).unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let locale = Locale::English;
        let previous = initial_combination().await;
        let channel = fixture_channel_with_lotus_only_update();
        let current = channel.select_updates(&previous, None).unwrap()[0].clone();
        Journal {
            active: Some(previous.clone()),
            queued: Some(current.clone()),
            ..Journal::default()
        }
        .save(&profile)
        .unwrap();
        assert!(Journal::read(&profile)
            .unwrap()
            .lotus_rollback_target()
            .is_none());
        manager.begin(&current).unwrap();
        manager.finish(&current, Ok(())).unwrap();
        let offer = manager
            .snapshot("0.0.0".into(), locale)
            .unwrap()
            .lotus_rollback
            .unwrap();
        assert_eq!(offer.identity, artifact_identity(&previous).unwrap());
        assert_eq!(offer.versions, Versions::from(&previous));
        assert_eq!(previous.bamboo, current.bamboo);
        assert_ne!(previous.lotus, current.lotus);

        assert!(manager.reopen_prepared(&previous).await.is_err());
        let occupied = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        let rejected = || async {
            Err(UpdateShutdownError::RequestRejected(
                "shutdown rejected".into(),
            ))
        };
        assert!(manager
            .queue_lotus_rollback(&previous, rejected(), port, locale)
            .await
            .is_err());
        assert!(
            !manager
                .snapshot("0.0.0".into(), locale)
                .unwrap()
                .lotus_rollback
                .unwrap()
                .shutdown_started
        );
        assert!(manager
            .queue_lotus_rollback(
                &previous,
                async {
                    Err(UpdateShutdownError::Unconfirmed(
                        "shutdown timed out".into(),
                    ))
                },
                port,
                locale
            )
            .await
            .is_err());
        assert!(manager
            .queue_lotus_rollback(&previous, rejected(), port, locale)
            .await
            .is_err());
        assert!(
            manager
                .snapshot("0.0.0".into(), locale)
                .unwrap()
                .lotus_rollback
                .unwrap()
                .shutdown_started
        );
        assert!(!manager
            .detect(async { panic!("lookup while rollback shutdown still pending") })
            .await
            .unwrap());
        assert!(manager
            .queue_lotus_rollback(&previous, async { Ok(()) }, port, locale)
            .await
            .is_err());
        drop(occupied);
        assert_eq!(manager.choose().await.unwrap(), current);

        manager
            .queue_lotus_rollback(&previous, async { Ok(()) }, port, locale)
            .await
            .unwrap();
        assert_eq!(manager.choose().await.unwrap(), previous);
        manager.begin(&previous).unwrap();
        // Recover the old active selection even after a persisted trial checkpoint.
        let restarted = Manager::new(profile.clone()).unwrap();
        assert_eq!(
            restarted
                .recover_lotus_rollback(&previous, "replacement failed")
                .unwrap(),
            current
        );
        assert_eq!(restarted.choose().await.unwrap(), current);
        assert!(Journal::read(&profile).unwrap().suppressed_lotus.is_none());
        restarted
            .queue_lotus_rollback(&previous, async { Ok(()) }, port, locale)
            .await
            .unwrap();
        restarted.begin(&previous).unwrap();
        restarted.finish(&previous, Ok(())).unwrap();

        let reopened = Manager::new(profile.clone()).unwrap();
        let journal = Journal::read(&profile).unwrap();
        assert_eq!(reopened.choose().await.unwrap(), previous);
        assert_eq!(
            journal.suppressed_lotus.as_deref(),
            Some(current.lotus.manifest_sha256.as_str())
        );
        assert_eq!(journal.rolled_back_lotus.as_ref(), Some(&current.lotus));
        assert!(journal.lotus_rollback_target().is_none());
        assert!(reopened.detect(async { Ok(channel) }).await.unwrap());
        let snapshot = reopened.snapshot("0.0.0".into(), locale).unwrap();
        assert!(snapshot.lotus_update_suppressed);
        assert_eq!(snapshot.offers.len(), 1);
        assert_ne!(snapshot.offers[0].versions.lotus, current.lotus.version);
        assert!(snapshot
            .history
            .iter()
            .any(|event| event.error.as_deref() == Some("replacement failed")));
    }

    #[tokio::test]
    async fn local_bamboo_selection_avoids_a_legacy_lotus_sequence_collision() {
        use crate::component_channel::tests::{
            fixture_channel_with_independent_updates, initial_combination,
        };

        let scratch = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(scratch.path()).unwrap();
        let manager = Manager::new(profile).unwrap();
        let current = initial_combination().await;
        let channel = fixture_channel_with_independent_updates();
        let mut lotus = channel
            .select_updates(&current, None)
            .unwrap()
            .into_iter()
            .find(|offer| offer.update_kind(&current) == Some(UpdateKind::Lotus))
            .unwrap()
            .clone();
        lotus.sequence = current.sequence + 1;
        manager.updates.display.lock().unwrap().selections = vec![Arc::new(SelectedUpdate {
            current_sequence: current.sequence,
            current: current.identity(),
            candidate: lotus.clone(),
        })];
        let mut release = current.bamboo.clone();
        release.version = "2026.11.99".into();
        release.manifest.sha256 = "f".repeat(64);
        let bamboo = producer::bamboo_offer(&current, release, Vec::new())
            .unwrap()
            .unwrap();
        assert_eq!(bamboo.sequence, lotus.sequence);
        let selected = manager.select_local_bamboo_offer(&current, bamboo).unwrap();
        assert_eq!(selected.candidate.sequence, lotus.sequence + 2);
        manager
            .updates
            .display
            .lock()
            .unwrap()
            .selections
            .push(selected.clone());
        let identity = artifact_identity(&selected.candidate).unwrap();
        assert!(manager
            .updates
            .selected(selected.candidate.sequence, &identity, Locale::English)
            .is_ok());
        let lotus_identity = artifact_identity(&lotus).unwrap();
        assert!(manager
            .updates
            .selected(lotus.sequence, &lotus_identity, Locale::English)
            .is_ok());
    }

    #[tokio::test]
    async fn local_import_receipt_authorizes_only_the_exact_staged_bamboo() {
        use crate::component_channel::tests::initial_combination;

        let scratch = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(scratch.path()).unwrap();
        let current = initial_combination().await;
        let mut latest = current.bamboo.clone();
        latest.version = "2026.11.99".into();
        latest.manifest.sha256 = "f".repeat(64);
        let candidate = producer::bamboo_offer(&current, latest, Vec::new())
            .unwrap()
            .unwrap();
        let identity = artifact_identity(&candidate).unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let update = SelectedUpdate {
            current_sequence: current.sequence,
            current: current.identity(),
            candidate: candidate.clone(),
        };
        journal::save_local_bamboo_download(&profile, &candidate, &identity).unwrap();
        assert!(manager
            .reconfirm_selected(&current, &update, Locale::English)
            .await
            .is_ok());
        assert!(!journal::matches_local_bamboo_download(&profile, &candidate, "wrong").unwrap());

        Journal {
            active: Some(current.clone()),
            ..Journal::default()
        }
        .save(&profile)
        .unwrap();
        manager
            .detect_updates(async |_, _, _| {
                Ok(Discovery {
                    offers: Vec::new(),
                    failures: vec!["Bamboo changed the identity of a downloaded release".into()],
                    download_changed: true,
                })
            })
            .await
            .unwrap();
        assert!(journal::read_downloaded(&profile).unwrap().is_none());
        assert!(!journal::matches_local_bamboo_download(&profile, &candidate, &identity).unwrap());

        let mut replacement = candidate.clone();
        replacement.bamboo.manifest.sha256 = "e".repeat(64);
        journal::save_downloaded(&profile, &replacement).unwrap();
        assert!(!journal::matches_local_bamboo_download(&profile, &candidate, &identity).unwrap());
        assert!(!journal::matches_local_bamboo_download(
            &profile,
            &replacement,
            &artifact_identity(&replacement).unwrap(),
        )
        .unwrap());
    }

    #[tokio::test]
    #[ignore = "requires original public Bamboo files and a REST-blocking forward proxy"]
    async fn stages_published_local_bamboo_without_the_github_rest_api() {
        let scratch = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(scratch.path()).unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let current = manager.choose().await.unwrap();
        manager.prepare_lotus(&current).await.unwrap();
        Journal {
            active: Some(current.clone()),
            ..Journal::default()
        }
        .save(&profile)
        .unwrap();
        let manifest = PathBuf::from(std::env::var_os("BODHI_LOCAL_IMPORT_DIR").unwrap())
            .join("bamboo-sidecars-v3.json");
        let proxy_url = std::env::var("BODHI_LOCAL_IMPORT_PROXY").unwrap();
        manager.settings.send_replace(DownloadSettings {
            proxy_url: Some(proxy_url),
            ..DownloadSettings::default()
        });

        manager
            .import_local_bamboo(manifest, Locale::English)
            .await
            .unwrap();
        let staged = journal::read_downloaded(&profile).unwrap().unwrap();
        assert_eq!(staged.lotus, current.lotus);
        assert_eq!(staged.update_kind(&current), Some(UpdateKind::Bamboo));
        assert_eq!(manager.choose().await.unwrap(), current);
        assert!(Journal::read(&profile).unwrap().queued.is_none());
        let reopened = Manager::new(profile).unwrap();
        reopened.settings.send_replace(DownloadSettings {
            proxy_url: Some("http://127.0.0.1:9".into()),
            ..DownloadSettings::default()
        });
        let update = SelectedUpdate {
            current_sequence: current.sequence,
            current: current.identity(),
            candidate: staged.clone(),
        };
        reopened
            .reconfirm_selected(&current, &update, Locale::English)
            .await
            .unwrap();
        reopened.reopen_downloaded_update(&staged).await.unwrap();
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
        assert!(allow_cached_immediate_update(manager.reconfirm(
            &original,
            &selected,
            locale,
            async { Ok(fixture_channel().await) }
        ))
        .await
        .is_err());

        let proxy = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        manager.settings.send_replace(DownloadSettings {
            proxy_url: Some(format!("http://{}", proxy.local_addr().unwrap())),
            ..DownloadSettings::default()
        });
        let disconnect = tokio::spawn(async move { drop(proxy.accept().await.unwrap()) });
        let unavailable = async {
            let result = manager
                .reconfirm(&original, &selected, locale, manager.load_catalog())
                .await;
            assert!(matches!(&result, Err(ReleaseCheckError::Unavailable(_))));
            result
        };
        allow_cached_immediate_update(unavailable).await.unwrap();
        disconnect.await.unwrap();

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
        let journal = Journal::read(&profile).unwrap();
        let chosen = &offers[0];
        let other = &offers[1];
        let update = manager
            .updates
            .selected(chosen.sequence, &chosen.identity, locale)
            .unwrap();
        assert!(manager
            .downloaded_update(chosen.sequence, &chosen.identity, &journal, locale,)
            .is_err());
        manager.record_download(&update, Ok(())).unwrap();
        let granted = manager
            .snapshot("0.0.0".into(), locale)
            .unwrap()
            .force_update
            .unwrap();
        assert_eq!(granted.identity, chosen.identity);
        assert!(!granted.shutdown_started);
        assert!(manager
            .downloaded_update(chosen.sequence, &chosen.identity, &journal, locale,)
            .is_ok());
        assert!(manager
            .downloaded_update(other.sequence, &other.identity, &journal, locale,)
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
            .downloaded_update(chosen.sequence, &chosen.identity, &journal, locale,)
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
            proxy_url: Some("http://tester:test%40password@localhost:8888".into()),
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
