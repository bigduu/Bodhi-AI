use super::{planned_restart::RestartMode, updates::Phase};
use super::{
    verify_owned_component, workspace_url, Journal, Manager, PlannedRestart, Prepared,
    SelectedUpdate,
};
use crate::bamboo_update_page::UpdatePage;
use crate::sidecar::{require_available_port, SidecarState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager as _, Runtime};

#[derive(Clone, Copy)]
pub(super) enum KernelStop {
    Checkpoint(RestartMode),
    Graceful,
    Force,
}

pub(super) struct KernelSwitch {
    pub(super) update: Arc<SelectedUpdate>,
    stop: KernelStop,
    restored_original_process: AtomicBool,
}

impl KernelSwitch {
    pub(super) fn new(update: Arc<SelectedUpdate>, stop: KernelStop) -> Self {
        Self {
            update,
            stop,
            restored_original_process: AtomicBool::new(false),
        }
    }

    fn original_for_recovery<'a>(
        &self,
        journal: &'a Journal,
    ) -> Result<&'a super::Combination, String> {
        journal
            .active
            .as_ref()
            .filter(|active| {
                active.sequence == self.update.current_sequence
                    && active.identity() == self.update.current
                    && journal.queued.is_none()
                    && journal.trial.as_ref().is_none_or(|trial| trial == *active)
            })
            .ok_or_else(|| "The original Bamboo release is no longer eligible for recovery".into())
    }
}

impl Manager {
    pub(super) fn pending_kernel_switch(&self) -> Result<Option<Arc<KernelSwitch>>, String> {
        Ok(self
            .kernel_switch
            .lock()
            .map_err(|_| "Cannot read the Bamboo switch state")?
            .clone())
    }

    fn save_kernel_switch(&self, value: Option<Arc<KernelSwitch>>) -> Result<(), String> {
        *self
            .kernel_switch
            .lock()
            .map_err(|_| "Cannot write the Bamboo switch state")? = value;
        Ok(())
    }

    pub(super) async fn begin_kernel_switch<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        update: Arc<SelectedUpdate>,
        stop: KernelStop,
    ) {
        let result = self.reopen_downloaded_update(&update.candidate).await;
        match result {
            Ok(prepared) => {
                let pending = Arc::new(KernelSwitch::new(update, stop));
                if let Err(error) = self.save_kernel_switch(Some(pending.clone())) {
                    self.updates.status(Phase::RestartFailed, Some(error));
                    return;
                }
                self.continue_kernel_switch(app, pending, Some(prepared))
                    .await;
            }
            Err(error) => self.updates.status(Phase::SaveFailed, Some(error)),
        }
    }

    pub(super) async fn continue_kernel_switch<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        pending: Arc<KernelSwitch>,
        prepared: Option<Prepared>,
    ) {
        let recovery_started = pending.restored_original_process.load(Ordering::Acquire);
        let result = if recovery_started {
            self.recover_original_after_exit(app, &pending).await
        } else {
            self.switch_kernel(app, &pending, prepared).await
        };
        let Err(error) = result else { return };
        // A refused stop can restore the exact still-running owner. If the
        // owner exited without confirming the switch, recover the original
        // release unless the candidate has already entered its trial.
        if !recovery_started {
            if self
                .restore_unstopped_workspace(app, &pending)
                .await
                .is_ok()
            {
                self.updates.status(Phase::RestartFailed, Some(error));
                return;
            }
            if self
                .recover_original_after_exit(app, &pending)
                .await
                .is_ok()
            {
                return;
            }
        }
        if let Some(window) = app.get_webview_window("main") {
            if let Err(page_error) = app
                .state::<UpdatePage>()
                .show_restart_failure(&window)
                .await
            {
                log::warn!("Cannot show Bamboo switch recovery page: {page_error}");
            }
        }
        self.updates.status(Phase::RestartFailed, Some(error));
    }

    async fn switch_kernel<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        pending: &KernelSwitch,
        prepared: Option<Prepared>,
    ) -> Result<(), String> {
        let pair = &pending.update.candidate;
        let prepared = match prepared {
            Some(prepared) => prepared,
            None => self.reopen_prepared(pair).await?,
        };
        let port = crate::web_service_port();
        let window = app
            .get_webview_window("main")
            .ok_or("Bodhi's main window is unavailable")?;
        let page = app.state::<UpdatePage>();
        let runtime = app.state::<SidecarState>();
        let url = workspace_url(port, &prepared)?;
        let journal = Journal::read(&self.profile)?;
        let active = journal
            .active
            .as_ref()
            .ok_or("No active Bamboo components")?;
        let activated = active == pair && journal.trial.is_none();
        let handoff = if activated {
            // The replacement was verified but its workspace navigation failed.
            // Retry attaching to that exact process without rerunning shutdown.
            match runtime.owned_startup_status() {
                Ok(owner) => verify_owned_component(port, &owner, pair, &prepared, 3).await?,
                Err(_) if runtime.owned_has_exited()? => {
                    page.park_for_restart(&window, &url).await?;
                    require_available_port(port)?;
                    self.launch_prepared(app, port, pair, &prepared, false, None)
                        .await?;
                }
                Err(error) => return Err(error),
            }
            self.arm_authorized_restart()?
                .filter(|plan| plan.exit_confirmed && plan.candidate == *pair)
        } else {
            if active.sequence != pending.update.current_sequence
                || active.identity() != pending.update.current
                || journal.trial.as_ref().is_some_and(|trial| trial != pair)
                || journal.queued.as_ref().is_some_and(|queued| queued != pair)
            {
                return Err(
                    "The approved Bamboo switch no longer matches the active components".into(),
                );
            }
            self.updates.status(Phase::ShuttingDown, None);
            let parking = Instant::now();
            page.park_for_restart(&window, &url).await?;
            log::info!("Bodhi workspace parked after {:?}", parking.elapsed());
            let draining = Instant::now();
            let handoff = self
                .stop_owned_for_switch(&runtime, port, pending, &prepared, &journal)
                .await?;
            let stopped = Instant::now();
            log::info!(
                "Bamboo switch confirmed old process exit after {:?}",
                draining.elapsed()
            );
            require_available_port(port)?;
            self.launch_prepared(app, port, pair, &prepared, false, None)
                .await?;
            log::info!("Bamboo replacement ready after {:?}", stopped.elapsed());
            handoff
        };

        let reconnecting = Instant::now();
        self.updates.status(Phase::Reconnecting, None);
        page.resume_verified(&window, &url).await?;
        log::info!(
            "Bodhi workspace reattached after {:?}",
            reconnecting.elapsed()
        );
        self.save_kernel_switch(None)?;
        self.updates.reset_kernel_shutdown();
        if let Some(handoff) = handoff {
            self.restore_sessions(app, handoff, Phase::RestoringSessions, None);
        } else {
            self.updates.status(Phase::Ready, None);
        }
        Ok(())
    }

    pub(super) async fn stop_owned_for_switch(
        &self,
        runtime: &SidecarState,
        port: u16,
        pending: &KernelSwitch,
        prepared: &Prepared,
        journal: &Journal,
    ) -> Result<Option<PlannedRestart>, String> {
        let update = &pending.update;
        match pending.stop {
            KernelStop::Checkpoint(mode) => {
                let plan = match PlannedRestart::read(&self.profile)? {
                    Some(plan) if plan.candidate == update.candidate && plan.mode == mode => plan,
                    Some(_) => return Err("The Bamboo handoff changed before the switch".into()),
                    None => {
                        self.plan_verified_restart(runtime, update, mode, prepared)
                            .await?
                    }
                };
                if !plan.exit_confirmed {
                    self.prepare_planned_restart(runtime, port, plan).await?;
                }
                let _writer = self.profile.writer()?;
                require_available_port(port)?;
                let handoff = self
                    .arm_authorized_restart()?
                    .filter(|handoff| {
                        handoff.exit_confirmed && handoff.candidate == update.candidate
                    })
                    .ok_or("The previous Bamboo did not confirm the planned shutdown")?;
                Ok(Some(handoff))
            }
            KernelStop::Graceful => {
                if journal.queued.is_none() {
                    runtime
                        .stop_for_rollback(Duration::from_secs(90))
                        .await
                        .map_err(shutdown_message)?;
                    let _writer = self.profile.writer()?;
                    require_available_port(port)?;
                    self.queue(update)?;
                }
                Ok(None)
            }
            KernelStop::Force => {
                if journal.queued.is_none() {
                    self.queue_after_force_shutdown(
                        update,
                        runtime.force_stop_for_update(Duration::from_secs(10)),
                        port,
                    )
                    .await?;
                }
                Ok(None)
            }
        }
    }

    async fn recover_original_after_exit<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        pending: &KernelSwitch,
    ) -> Result<(), String> {
        let journal = Journal::read(&self.profile)?;
        let original = pending.original_for_recovery(&journal)?;
        let plan = PlannedRestart::read(&self.profile)?;
        if plan
            .as_ref()
            .is_some_and(|plan| plan.exit_confirmed || plan.candidate != pending.update.candidate)
        {
            return Err("The original Bamboo restart no longer matches the handoff".into());
        }
        let runtime = app.state::<SidecarState>();
        let restarted = pending.restored_original_process.load(Ordering::Acquire);
        if !restarted && !runtime.owned_has_exited()? {
            return Err("The previous Bamboo process is still running".into());
        }
        let prepared = self.reopen_prepared(original).await?;
        let port = crate::web_service_port();
        let window = app
            .get_webview_window("main")
            .ok_or("Bodhi's main window is unavailable")?;
        let page = app.state::<UpdatePage>();
        let url = workspace_url(port, &prepared)?;

        if restarted && !runtime.owned_has_exited()? {
            let owner = runtime.owned_startup_status()?;
            verify_owned_component(port, &owner, original, &prepared, 3).await?;
        } else {
            page.park_for_restart(&window, &url).await?;
            require_available_port(port)?;
            self.launch_prepared(app, port, original, &prepared, false, None)
                .await?;
            pending
                .restored_original_process
                .store(true, Ordering::Release);
        }
        if page.needs_restore() {
            self.updates.status(Phase::Reconnecting, None);
            page.resume_verified(&window, &url).await?;
        }

        let mut unconfirmed = false;
        let handoff = if let Some(plan) = plan {
            if plan.authorized(&self.profile)? {
                Some(plan)
            } else {
                unconfirmed = plan.has_intent(&self.profile)?;
                if !unconfirmed {
                    plan.clear(&self.profile)?;
                }
                None
            }
        } else {
            None
        };
        self.updates
            .unconfirmed_handoff
            .store(unconfirmed, Ordering::Release);
        let warning = Some(if unconfirmed {
            "Bodhi restored the previous Bamboo release. Saved sessions are still pending recovery."
        } else {
            "Bamboo exited before confirming the switch. Bodhi restored the previous release."
        }.into());
        self.save_kernel_switch(None)?;
        self.updates.reset_kernel_shutdown();
        if let Some(handoff) = handoff {
            self.restore_sessions(app, handoff, Phase::RestoringSessions, warning);
        } else {
            self.updates.status(Phase::RestartFailed, warning);
        }
        Ok(())
    }

    async fn restore_unstopped_workspace<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        pending: &KernelSwitch,
    ) -> Result<(), String> {
        let journal = Journal::read(&self.profile)?;
        let active = journal
            .active
            .as_ref()
            .ok_or("No active Bamboo components")?;
        if active.sequence != pending.update.current_sequence
            || active.identity() != pending.update.current
            || app.state::<SidecarState>().update_requires_process()
            || journal.queued.is_some()
            || journal.trial.is_some()
            || self.local_shutdown_started()
        {
            return Err("The original workspace cannot be restored during a Bamboo handoff".into());
        }
        if let Some(plan) = PlannedRestart::read(&self.profile)? {
            if plan.commit_requested || plan.has_intent(&self.profile)? {
                return Err("The previous Bamboo shutdown is in progress".into());
            }
        }
        let owner = app.state::<SidecarState>().owned_startup_status()?;
        let page = app.state::<UpdatePage>();
        if page.needs_restore() {
            let window = app
                .get_webview_window("main")
                .ok_or("Bodhi's main window is unavailable")?;
            let port = crate::web_service_port();
            let original = self.reopen_prepared(active).await?;
            verify_owned_component(port, &owner, active, &original, 3).await?;
            page.resume_verified(&window, &workspace_url(port, &original)?)
                .await?;
        }
        self.save_kernel_switch(None)
    }
}

fn shutdown_message(error: crate::sidecar::UpdateShutdownError) -> String {
    match error {
        crate::sidecar::UpdateShutdownError::RequestRejected(message)
        | crate::sidecar::UpdateShutdownError::Unconfirmed(message) => message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn interrupted_exit_recovers_only_the_original_release_before_a_new_trial() {
        let original = crate::component_channel::tests::initial_combination().await;
        let mut candidate = original.clone();
        candidate.sequence += 1;
        candidate.bamboo.version = "2026.11.99".into();
        candidate.bamboo.manifest.sha256 = "1".repeat(64);
        let pending = KernelSwitch::new(
            Arc::new(SelectedUpdate {
                current_sequence: original.sequence,
                current: original.identity(),
                candidate: candidate.clone(),
            }),
            KernelStop::Checkpoint(RestartMode::Planned),
        );
        let mut journal = Journal {
            active: Some(original.clone()),
            ..Journal::default()
        };
        assert_eq!(pending.original_for_recovery(&journal).unwrap(), &original);
        journal.trial = Some(original.clone());
        assert_eq!(pending.original_for_recovery(&journal).unwrap(), &original);
        journal.trial = Some(candidate.clone());
        assert!(pending.original_for_recovery(&journal).is_err());
        journal.trial = None;
        journal.queued = Some(candidate.clone());
        assert!(pending.original_for_recovery(&journal).is_err());
        journal.queued = None;
        journal.active = Some(candidate);
        assert!(pending.original_for_recovery(&journal).is_err());
    }
}
