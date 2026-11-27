//! Plan and record startup of an authenticated component combination.
mod journal;
mod kernel_switch;
mod planned_restart;
mod producer_compatibility;
pub(crate) mod updates;

use crate::bamboo_profile::Profile;
use crate::bamboo_update::{check_component_floor, record_component_launch};
use crate::component_channel::{self, Combination, PairIdentity, VerifiedChannel};
use crate::component_download::{while_selected, DownloadSettings};
use crate::component_kernel::{self, VerifiedKernel};
use crate::frontend::VerifiedFrontend;
use journal::Journal;
use kernel_switch::KernelSwitch;
use planned_restart::PlannedRestart;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager as _, Runtime, WebviewWindow};
use tokio::sync::watch;

pub(crate) fn enabled() -> bool {
    cfg!(feature = "thin-shell")
}

pub(crate) struct Manager {
    profile: Profile,
    settings: watch::Sender<DownloadSettings>,
    auto_check_hours: watch::Sender<u16>,
    updates: updates::Updates,
    kernel_switch: Mutex<Option<Arc<KernelSwitch>>>,
}

struct Prepared {
    kernel: VerifiedKernel,
    frontend: VerifiedFrontend,
    browser: Option<[PathBuf; 3]>,
}

impl Manager {
    pub(crate) fn new(profile: Profile) -> Result<Self, String> {
        let (settings, _) = watch::channel(journal::read_settings(&profile)?);
        let (auto_check_hours, _) = watch::channel(journal::read_check_hours(&profile)?);
        Ok(Self {
            profile,
            settings,
            auto_check_hours,
            updates: updates::Updates::default(),
            kernel_switch: Mutex::new(None),
        })
    }

    async fn load_catalog(&self) -> Result<VerifiedChannel, component_channel::ReleaseCheckError> {
        let mut settings = self.settings.subscribe();
        loop {
            let selected = settings.borrow_and_update().clone();
            let load = component_channel::load_stable(&selected);
            if let Some(result) = while_selected(&mut settings, &selected, load).await {
                return result;
            }
        }
    }

    async fn choose(&self) -> Result<Combination, String> {
        if let Some(pair) = Journal::read(&self.profile)?.next() {
            return Ok(pair.clone());
        }
        self.load_catalog()
            .await?
            .select(None)?
            .map(|candidate| candidate.combination.clone())
            .ok_or_else(|| "The verified catalog has no initial components for this desktop".into())
    }

    async fn prepare(&self, pair: &Combination) -> Result<Prepared, String> {
        check_component_floor(&self.profile, &pair.bamboo.version)?;
        let (kernel, browser) = self.prepare_bamboo(pair).await?;
        let frontend = self.prepare_lotus(pair).await?;
        Ok(Prepared {
            kernel,
            frontend,
            browser,
        })
    }

    async fn prepare_bamboo(
        &self,
        pair: &Combination,
    ) -> Result<(VerifiedKernel, Option<[PathBuf; 3]>), String> {
        let candidate = pair.candidate()?;
        let kernel = component_kernel::prepare_kernel(
            &self.profile.data,
            &candidate,
            self.settings.subscribe(),
            |source, received, total| {
                self.updates
                    .progress(&candidate.artifact.asset_name, source, received, total)
            },
        )
        .await?;
        let browser = if candidate.artifact.browser_runtime.is_some() {
            Some(
                crate::component_browser::prepare_runtime(
                    &self.profile.data,
                    &candidate,
                    self.settings.subscribe(),
                    |source, received, total| {
                        self.updates
                            .progress("Bamboo Browser Runtime", source, received, total)
                    },
                )
                .await?,
            )
        } else {
            None
        };
        Ok((kernel, browser))
    }

    async fn prepare_lotus(&self, pair: &Combination) -> Result<VerifiedFrontend, String> {
        let lotus_archive = format!("lotus-next-{}.tgz", pair.lotus.version);
        crate::frontend::prepare_release(
            &self.profile.data,
            &pair.lotus,
            self.settings.subscribe(),
            |source, received, total| {
                self.updates
                    .progress(&lotus_archive, source, received, total)
            },
        )
        .await
    }

    async fn prepare_update(&self, active: &Combination, pair: &Combination) -> Result<(), String> {
        check_component_floor(&self.profile, &pair.bamboo.version)?;
        if pair.bamboo != active.bamboo {
            self.prepare_bamboo(pair).await?;
        }
        if pair.lotus != active.lotus {
            self.prepare_lotus(pair).await?;
        }
        self.prove_prepared_update(pair).await
    }

    async fn prove_prepared_update(&self, pair: &Combination) -> Result<(), String> {
        let prepared = self.reopen_prepared(pair).await?;
        if pair.producer_release {
            producer_compatibility::prove_pair(&prepared.kernel, &prepared.frontend, &pair.lotus)
                .await?;
        }
        Ok(())
    }

    async fn reopen_prepared(&self, pair: &Combination) -> Result<Prepared, String> {
        check_component_floor(&self.profile, &pair.bamboo.version)?;
        let kernel = component_kernel::reopen_kernel(&self.profile, &pair.candidate()?).await?;
        let profile = self.profile.clone();
        let pair = pair.clone();
        tokio::task::spawn_blocking(move || {
            let frontend = crate::frontend::reopen_release(&profile, &pair.lotus)?;
            let browser = crate::component_browser::reopen_runtime(&profile, &pair.candidate()?)?;
            Ok(Prepared {
                kernel,
                frontend,
                browser,
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn reopen_downloaded_update(&self, pair: &Combination) -> Result<Prepared, String> {
        match self.reopen_prepared(pair).await {
            Ok(prepared) => Ok(prepared),
            Err(error) => {
                let _lock = self.profile.update_lock()?;
                journal::clear_downloaded(&self.profile, pair)?;
                Err(format!(
                    "Cannot verify the cached update: {error}. Download this update again."
                ))
            }
        }
    }

    fn begin(&self, pair: &Combination) -> Result<(), String> {
        let _update = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        if journal.next().is_some_and(|expected| expected != pair) {
            return Err("The selected component release changed during startup".into());
        }
        check_component_floor(&self.profile, &pair.bamboo.version)?;
        journal.trial = Some(pair.clone());
        journal.save(&self.profile)?;
        record_component_launch(&self.profile, &pair.bamboo.version)
    }

    fn finish(&self, pair: &Combination, outcome: Result<(), String>) -> Result<(), String> {
        let _update = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        if journal.trial.as_ref() != Some(pair) {
            return Err("The component startup checkpoint changed".into());
        }
        journal.record(pair, outcome.as_ref().err().cloned());
        if outcome.is_ok() {
            journal.activate(pair);
        }
        journal.save(&self.profile)?;
        outcome
    }

    fn recover_lotus_rollback(
        &self,
        pair: &Combination,
        error: &str,
    ) -> Result<Combination, String> {
        let _update = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        if journal.lotus_rollback_target() != Some(pair)
            || journal.queued.as_ref() != Some(pair)
            || journal.next() != Some(pair)
        {
            return Err("The Lotus Next rollback checkpoint changed".into());
        }
        let active = journal.active.clone().ok_or("No active components")?;
        journal.record(pair, Some(error.into()));
        journal.queued = None;
        journal.trial = None;
        journal.save(&self.profile)?;
        Ok(active)
    }

    pub(crate) async fn launch<R: Runtime>(&self, app: &AppHandle<R>) -> Result<bool, String> {
        let Ok(_boot) = self.updates.boot.try_lock() else {
            return Ok(false);
        };
        if self.updates.ready.load(Ordering::Acquire) {
            return Ok(false);
        }
        self.updates.status(updates::Phase::Preparing, None);
        let result = self.launch_once(app).await;
        if let Err(error) = &result {
            self.updates
                .status(updates::Phase::StartupFailed, Some(error.clone()));
        } else {
            self.updates.ready.store(true, Ordering::Release);
        }
        result.map(|()| true)
    }

    async fn launch_once<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let port = crate::web_service_port();
        crate::sidecar::require_available_port(port)?;
        let (handoff, unconfirmed) = {
            let _writer = self.profile.writer()?;
            let handoff = self.arm_authorized_restart()?;
            let mut unconfirmed = false;
            if handoff.is_none() {
                if let Some(abandoned) = PlannedRestart::read(&self.profile)? {
                    unconfirmed = abandoned.has_intent(&self.profile)?;
                    if !unconfirmed {
                        abandoned.clear(&self.profile)?;
                    }
                }
            }
            (handoff, unconfirmed)
        };
        let pair = self.choose().await?;
        let journal = Journal::read(&self.profile)?;
        let rollback = journal.lotus_rollback_target() == Some(&pair)
            && journal.queued.as_ref() == Some(&pair);
        if !rollback
            && journal
                .active
                .as_ref()
                .is_some_and(|active| pair.sequence < active.sequence)
        {
            return Err(
                "The prior component release was not approved as a Lotus Next rollback".into(),
            );
        }
        let mut rollback_error = None;
        if let Err(error) = self.launch_component(app, port, &pair, rollback).await {
            if !rollback {
                return Err(error);
            }
            let active = self.recover_lotus_rollback(&pair, &error)?;
            self.launch_component(app, port, &active, false).await?;
            rollback_error = Some(error);
        }
        self.updates
            .unconfirmed_handoff
            .store(unconfirmed, Ordering::Release);
        if unconfirmed {
            self.updates.status(updates::Phase::RestartFailed, Some(
                "The prior Bamboo did not confirm a safe shutdown. Your current version is running, and the saved sessions are still pending recovery.".into(),
            ));
        } else {
            self.updates.status(updates::Phase::Ready, rollback_error);
        }
        if let Some(handoff) = handoff {
            self.restore_sessions(app, handoff, updates::Phase::Ready, None);
        }
        Ok(())
    }

    fn restore_sessions<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        handoff: PlannedRestart,
        phase: updates::Phase,
        warning: Option<String>,
    ) {
        self.updates.restoring.store(true, Ordering::Release);
        self.updates.status(phase, warning.clone());
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let started = std::time::Instant::now();
            let manager = handle.state::<Self>();
            let runtime = handle.state::<crate::sidecar::SidecarState>();
            loop {
                match manager.resume_planned_restart(&runtime, &handoff).await {
                    Ok(()) => {
                        log::info!(
                            "Bamboo session recovery completed after {:?}",
                            started.elapsed()
                        );
                        manager.updates.restoring.store(false, Ordering::Release);
                        manager.updates.status(updates::Phase::Ready, warning);
                        break;
                    }
                    Err(error) => {
                        manager.updates.status(phase, Some(error));
                        tokio::time::sleep(Duration::from_secs(10)).await;
                    }
                }
            }
        });
    }

    async fn launch_component<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        port: u16,
        pair: &Combination,
        rollback: bool,
    ) -> Result<(), String> {
        let prepared = if rollback {
            self.reopen_prepared(pair).await?
        } else {
            self.prepare(pair).await?
        };
        let window = app
            .get_webview_window("main")
            .ok_or("Bodhi's main window is unavailable")?;
        self.launch_prepared(app, port, pair, &prepared, rollback, Some(&window))
            .await
    }

    async fn launch_prepared<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        port: u16,
        pair: &Combination,
        prepared: &Prepared,
        rollback: bool,
        workspace: Option<&WebviewWindow<R>>,
    ) -> Result<(), String> {
        self.updates.status(updates::Phase::Starting, None);
        let writer = self.profile.writer()?;
        let command = crate::sidecar::command(
            app,
            port,
            &self.profile.data,
            prepared.frontend.static_dir.as_deref(),
            Some(&prepared.kernel.executable),
            prepared.browser.clone(),
        )?;
        let runtime = app.state::<crate::sidecar::SidecarState>();
        self.begin(pair)?;
        let outcome = async {
            let status = runtime.start(command, writer, port, Some(&self.profile.state_dir))?;
            verify_owned_component(port, &status, pair, prepared, 60).await?;
            if let Some(window) = workspace {
                let url = workspace_url(port, prepared)?;
                window.navigate(url).map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        .await;
        let result = if rollback && outcome.is_err() {
            outcome
        } else {
            self.finish(pair, outcome)
        };
        if result.is_err() {
            if let Err(error) = runtime.stop().await {
                log::warn!("Cannot stop Bamboo after a failed component launch: {error}");
            }
        }
        result
    }

    async fn prepare_restart(
        &self,
        runtime: &crate::sidecar::SidecarState,
        port: u16,
    ) -> Result<(), String> {
        let _update = self.profile.update_lock()?;
        let journal = Journal::read(&self.profile)?;
        if journal.queued.is_none() || journal.active.is_none() || journal.trial.is_some() {
            return Err("There is no approved component update to restart into.".into());
        }

        self.updates.status(updates::Phase::ShuttingDown, None);
        runtime
            .force_stop_for_update(Duration::from_secs(10))
            .await
            .map_err(|error| match error {
                crate::sidecar::UpdateShutdownError::RequestRejected(message)
                | crate::sidecar::UpdateShutdownError::Unconfirmed(message) => message,
            })?;
        // Take the writer lease again to prove the old runtime and anything
        // inheriting its handle have released the profile.
        let _writer = self.profile.writer()?;
        crate::sidecar::require_available_port(port)
    }

    fn queue(&self, update: &SelectedUpdate) -> Result<(), String> {
        let _update = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        update.validate_transition(&journal)?;
        if journal::read_downloaded(&self.profile)?.as_ref() != Some(&update.candidate) {
            return Err("Download and verify this component update before applying it".into());
        }
        check_component_floor(&self.profile, &update.candidate.bamboo.version)?;
        journal.queued = Some(update.candidate.clone());
        journal.save(&self.profile)
    }
}

fn workspace_url(port: u16, prepared: &Prepared) -> Result<tauri::Url, String> {
    crate::ready_frontend_url(true, port, None, prepared.frontend.index_hash.as_deref())
}

async fn verify_owned_component(
    port: u16,
    owner: &crate::sidecar::StartupStatus,
    pair: &Combination,
    prepared: &Prepared,
    timeout_secs: u64,
) -> Result<(), String> {
    crate::sidecar::wait_for_health(
        port,
        timeout_secs,
        Some(owner),
        prepared.frontend.index_hash.as_deref(),
    )
    .await?;
    if crate::sidecar::owned_version(port, owner).await? != prepared.kernel.version {
        return Err("The running Bamboo differs from the approved component release".into());
    }
    if pair.producer_release {
        producer_compatibility::prove_live_pair(
            port,
            owner,
            &prepared.kernel.version,
            &prepared.frontend,
            &pair.lotus,
        )
        .await?;
    }
    Ok(())
}

#[derive(PartialEq, Eq)]
struct SelectedUpdate {
    current_sequence: u64,
    current: PairIdentity,
    candidate: Combination,
}

impl SelectedUpdate {
    fn validate_transition<'a>(&self, journal: &'a Journal) -> Result<&'a Combination, String> {
        journal
            .active
            .as_ref()
            .filter(|active| {
                journal.trial.is_none()
                    && journal.queued.is_none()
                    && active.sequence == self.current_sequence
                    && active.identity() == self.current
                    && self.candidate.sequence > active.sequence
            })
            .ok_or_else(|| "This component update is no longer applicable".into())
    }
}

#[cfg(test)]
mod tests;
