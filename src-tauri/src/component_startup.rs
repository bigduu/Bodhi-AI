//! Plan and record startup of an authenticated component combination.
mod journal;
pub(crate) mod updates;

use crate::bamboo_profile::{create_directory, Profile};
use crate::bamboo_update::{check_component_floor, record_component_launch};
use crate::component_channel::{self, Combination, PairIdentity, VerifiedChannel};
use crate::component_kernel::{self, DownloadSource, VerifiedKernel};
use crate::frontend::VerifiedFrontend;
use journal::Journal;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager as _, Runtime};
use tokio::sync::watch;

const TRUSTED_ROOT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/component-update-root.json"));

pub(crate) fn enabled() -> bool {
    cfg!(feature = "thin-shell") && !TRUSTED_ROOT.is_empty()
}

pub(crate) struct Manager {
    profile: Profile,
    sources: watch::Sender<DownloadSource>,
    updates: updates::Updates,
}

struct Prepared {
    kernel: VerifiedKernel,
    frontend: VerifiedFrontend,
    browser: [PathBuf; 3],
}

impl Manager {
    pub(crate) fn new(profile: Profile) -> Result<Self, String> {
        let (sources, _) = watch::channel(Journal::read(&profile)?.source);
        Ok(Self {
            profile,
            sources,
            updates: updates::Updates::default(),
        })
    }

    async fn channel(&self) -> Result<VerifiedChannel, String> {
        let _update = self.profile.update_lock()?;
        let metadata = self.profile.state_dir.join("component-metadata-v1");
        create_directory(&metadata).map_err(|e| e.to_string())?;
        tokio::time::timeout(
            Duration::from_secs(90),
            component_channel::load_stable(TRUSTED_ROOT, &metadata),
        )
        .await
        .map_err(|_| "The component catalog check timed out".to_owned())?
    }

    async fn choose(&self) -> Result<Combination, String> {
        if let Some(pair) = Journal::read(&self.profile)?.next() {
            return Ok(pair.clone());
        }
        self.channel()
            .await?
            .select(None)?
            .map(|candidate| candidate.combination.clone())
            .ok_or_else(|| "The verified catalog has no initial components for this desktop".into())
    }

    async fn prepare(&self, pair: &Combination) -> Result<Prepared, String> {
        check_component_floor(&self.profile, &pair.bamboo.version)?;
        let candidate = pair.candidate()?;
        let kernel = component_kernel::prepare_kernel(
            &self.profile.data,
            &candidate,
            self.sources.subscribe(),
            |source, received, total| {
                self.updates.progress(
                    &candidate.artifact.asset_name,
                    Some(source),
                    received,
                    Some(total),
                )
            },
        )
        .await?;
        let lotus_archive = format!("lotus-next-{}.tgz", pair.lotus.version);
        let frontend =
            crate::frontend::prepare_release(&self.profile.data, &pair.lotus, |received, total| {
                self.updates.progress(&lotus_archive, None, received, total)
            })
            .await?;
        let browser = crate::component_browser::prepare_runtime(
            &self.profile.data,
            &candidate,
            self.sources.subscribe(),
            |source, received, total| {
                self.updates.progress(
                    "Bamboo Browser Runtime",
                    Some(source),
                    received,
                    Some(total),
                )
            },
        )
        .await?;
        Ok(Prepared {
            kernel,
            frontend,
            browser,
        })
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
            journal.active = Some(pair.clone());
            journal.trial = None;
            journal.queued = None;
        }
        journal.save(&self.profile)?;
        outcome
    }

    pub(crate) async fn launch<R: Runtime>(&self, app: &AppHandle<R>) -> Result<bool, String> {
        let Ok(_boot) = self.updates.boot.try_lock() else {
            return Ok(false);
        };
        if self.updates.ready.load(Ordering::Acquire) {
            return Ok(false);
        }
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
        let pair = self.choose().await?;
        let prepared = self.prepare(&pair).await?;
        self.updates.status(updates::Phase::Starting, None);
        let writer = self.profile.writer()?;
        let command = crate::sidecar::command(
            app,
            port,
            &self.profile.data,
            prepared.frontend.static_dir.as_deref(),
            Some(&prepared.kernel.executable),
            Some(prepared.browser),
        )?;
        let runtime = app.state::<crate::sidecar::SidecarState>();
        let window = app
            .get_webview_window("main")
            .ok_or("Bodhi's main window is unavailable")?;
        self.begin(&pair)?;
        let outcome = async {
            let status = runtime.start(command, writer, port)?;
            crate::sidecar::wait_for_health(
                port,
                60,
                Some(&status),
                prepared.frontend.index_hash.as_deref(),
            )
            .await?;
            let actual = crate::sidecar::owned_version(port, &status).await?;
            if actual != prepared.kernel.version {
                return Err(
                    "The running Bamboo differs from the approved component release".into(),
                );
            }
            let url = crate::ready_frontend_url(
                true,
                port,
                None,
                prepared.frontend.index_hash.as_deref(),
            )?;
            window.navigate(url).map_err(|error| error.to_string())
        }
        .await;
        let result = self.finish(&pair, outcome);
        if result.is_err() {
            if let Err(error) = runtime.stop().await {
                log::warn!("Cannot stop Bamboo after a failed component launch: {error}");
            }
        } else {
            self.updates.status(updates::Phase::Ready, None);
        }
        result
    }

    fn queue(&self, update: &PreparedUpdate) -> Result<(), String> {
        let _update = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        let active = journal
            .active
            .as_ref()
            .ok_or("The current component pair is unavailable")?;
        if journal.trial.is_some()
            || journal.queued.is_some()
            || active.sequence != update.current_sequence
            || active.identity() != update.current
            || update.candidate.sequence <= active.sequence
        {
            return Err("This component update is no longer applicable".into());
        }
        check_component_floor(&self.profile, &update.candidate.bamboo.version)?;
        journal.queued = Some(update.candidate.clone());
        journal.save(&self.profile)
    }
}

struct PreparedUpdate {
    current_sequence: u64,
    current: PairIdentity,
    candidate: Combination,
}

#[cfg(test)]
mod tests;
