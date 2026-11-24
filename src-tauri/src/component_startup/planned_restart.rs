//! Durable desktop intent and verification of the old Bamboo process's receipt.

use super::{journal, Combination, Journal, Manager, PairIdentity, SelectedUpdate};
use crate::bamboo_profile::{is_link, Profile};
use crate::component_kernel;
use crate::sidecar::{
    planned_update::{self, Action, Status},
    SidecarState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::Duration;
use uuid::Uuid;

const FILE: &str = "component-planned-restart-v1.json";
const TIMEOUT: Duration = Duration::from_secs(90);
const RESPONSE: Duration = Duration::from_secs(5);
const MAX_INTENT: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PlannedRestart {
    pub(super) request: Uuid,
    pub(super) candidate: Combination,
    current_sequence: u64,
    current: PairIdentity,
    owner: String,
    commit_requested: bool,
    exit_confirmed: bool,
}

impl PlannedRestart {
    pub(super) fn read(profile: &Profile) -> Result<Option<Self>, String> {
        journal::read_json(profile, FILE)
    }

    fn save(&self, profile: &Profile) -> Result<(), String> {
        journal::save_json(profile, FILE, self)
    }

    pub(super) fn clear(&self, profile: &Profile) -> Result<(), String> {
        let _update = profile.update_lock()?;
        if Self::read(profile)?.is_some_and(|plan| plan.request == self.request) {
            fs::remove_file(profile.state_dir.join(FILE)).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn receipt_root(profile: &Profile) -> Result<Option<PathBuf>, String> {
        let root = profile.data.join("managed-update");
        match fs::symlink_metadata(&root) {
            Ok(meta) if meta.is_dir() && !is_link(&meta) => Ok(Some(root)),
            Ok(_) => Err("Invalid Bamboo update receipt directory".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub(super) fn has_intent(&self, profile: &Profile) -> Result<bool, String> {
        let Some(root) = Self::receipt_root(profile)? else {
            return Ok(false);
        };
        Ok(
            planned_update::read_control(&root.join(format!("{}.json", self.request)), MAX_INTENT)?
                .is_some(),
        )
    }

    pub(super) fn authorized(&self, profile: &Profile) -> Result<bool, String> {
        let Some(root) = Self::receipt_root(profile)? else {
            return Ok(false);
        };
        let Some(receipt) =
            planned_update::read_control(&root.join(format!("{}.ready", self.request)), 64)?
        else {
            return Ok(false);
        };
        let intent =
            planned_update::read_control(&root.join(format!("{}.json", self.request)), MAX_INTENT)?
                .ok_or("Missing Bamboo update intent for the readiness receipt")?;
        #[derive(Deserialize)]
        struct Intent {
            schema_version: u8,
            request: Uuid,
        }
        let header: Intent = serde_json::from_slice(&intent).map_err(|error| error.to_string())?;
        if !self.commit_requested
            || header.schema_version != 1
            || header.request != self.request
            || receipt != format!("{:x}", Sha256::digest(&intent)).as_bytes()
        {
            return Err("Bamboo update readiness receipt does not match this restart".into());
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::component_channel::Asset;
    use serde_json::json;
    use std::path::Path;

    #[tokio::test]
    async fn startup_requires_receipt_for_the_exact_committed_intent() {
        let directory = tempfile::tempdir().unwrap();
        let profile = Profile::open(directory.path()).unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let original = crate::component_channel::tests::initial_combination().await;
        let channel = crate::component_channel::tests::fixture_channel().await;
        let target = channel
            .select(Some((original.sequence, &original.identity())))
            .unwrap()
            .unwrap()
            .combination
            .clone();
        manager.begin(&original).unwrap();
        manager.finish(&original, Ok(())).unwrap();
        let mut plan = PlannedRestart {
            request: Uuid::new_v4(),
            candidate: target.clone(),
            current_sequence: original.sequence,
            current: original.identity(),
            owner: "shutdown-fixture".into(),
            commit_requested: false,
            exit_confirmed: false,
        };
        plan.save(&profile).unwrap();
        assert!(manager.arm_authorized_restart().unwrap().is_none());
        assert_eq!(manager.choose().await.unwrap(), original);

        let folder = profile.data.join("managed-update");
        fs::create_dir(&folder).unwrap();
        let intent = folder.join(format!("{}.json", plan.request));
        let ready = folder.join(format!("{}.ready", plan.request));
        let writer = |request| {
            let bytes =
                serde_json::to_vec(&json!({"schema_version": 1, "request": request, "roots": []}))
                    .unwrap();
            fs::write(&intent, &bytes).unwrap();
            format!("{:x}", Sha256::digest(&bytes))
        };
        let digest = writer(plan.request);
        assert!(plan.has_intent(&profile).unwrap());
        assert!(manager.arm_authorized_restart().unwrap().is_none());
        fs::write(&ready, &digest).unwrap();
        assert!(manager.arm_authorized_restart().is_err());

        plan.commit_requested = true;
        plan.save(&profile).unwrap();
        fs::write(&ready, writer(Uuid::new_v4())).unwrap();
        assert!(manager.arm_authorized_restart().is_err());
        writer(plan.request);
        assert!(manager.arm_authorized_restart().is_err());
        fs::write(&ready, &digest).unwrap();
        assert_eq!(
            manager.arm_authorized_restart().unwrap().unwrap().request,
            plan.request
        );
        assert_eq!(manager.choose().await.unwrap(), original);
        assert!(Journal::read(&profile).unwrap().queued.is_none());

        plan.exit_confirmed = true;
        plan.save(&profile).unwrap();
        assert_eq!(
            manager.arm_authorized_restart().unwrap().unwrap().request,
            plan.request
        );
        assert_eq!(manager.choose().await.unwrap(), target);
        manager.begin(&target).unwrap();
        manager.finish(&target, Ok(())).unwrap();

        assert_eq!(
            manager.arm_authorized_restart().unwrap().unwrap().request,
            plan.request
        );
        let mut foreign = plan.clone();
        foreign.request = Uuid::new_v4();
        foreign.clear(&profile).unwrap();
        assert_eq!(
            PlannedRestart::read(&profile).unwrap().unwrap().request,
            plan.request
        );
        plan.clear(&profile).unwrap();
        assert!(manager.arm_authorized_restart().unwrap().is_none());
    }

    #[tokio::test]
    #[ignore = "requires BODHI_PLANNED_UPDATE_BAMBOO set to an independently built native Bamboo"]
    async fn native_bodhi_control_replaces_two_owned_bamboo_processes() {
        let _ = env_logger::builder().is_test(true).try_init();
        let binary = PathBuf::from(std::env::var_os("BODHI_PLANNED_UPDATE_BAMBOO").unwrap());
        assert!(planned_update::executable_supports(&binary).await.unwrap());
        let scratch = tempfile::tempdir().unwrap();
        let profile = Profile::open(scratch.path()).unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let version = std::process::Command::new(&binary)
            .arg("--version")
            .output()
            .unwrap();
        assert!(version.status.success());
        let version = std::str::from_utf8(&version.stdout)
            .unwrap()
            .trim()
            .strip_prefix("bamboo ")
            .unwrap();
        let mut digest = Sha256::new();
        let size_bytes = io::copy(&mut fs::File::open(&binary).unwrap(), &mut digest).unwrap();
        let executable = Asset {
            sha256: format!("{:x}", digest.finalize()),
            size_bytes,
        };
        let cache = profile
            .state_dir
            .join(format!("bamboo-{}", executable.sha256));
        fs::create_dir(&cache).unwrap();
        fs::copy(
            &binary,
            cache.join(format!("bamboo{}", std::env::consts::EXE_SUFFIX)),
        )
        .unwrap();

        let mut original = crate::component_channel::tests::initial_combination().await;
        let channel = crate::component_channel::tests::fixture_channel().await;
        let mut target = channel
            .select(Some((original.sequence, &original.identity())))
            .unwrap()
            .unwrap()
            .combination
            .clone();
        stage_pair(&profile, &mut original, version, &executable);
        stage_pair(&profile, &mut target, version, &executable);
        fs::write(profile.data.join("config.json"), b"{}").unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        #[derive(Default)]
        struct Host(SidecarState);
        impl Drop for Host {
            fn drop(&mut self) {
                self.0.exit();
            }
        }
        let old = Host::default();
        let start = |runtime: &SidecarState, prepared: &super::super::Prepared| {
            let mut command = std::process::Command::new(&prepared.kernel.executable);
            command
                .env_clear()
                .envs(
                    ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "LANG"]
                        .into_iter()
                        .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
                )
                .args([
                    "serve",
                    "--bind",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                    "--parent-pid",
                    &std::process::id().to_string(),
                    "--data-dir",
                ])
                .arg(&profile.data)
                .arg("--static-dir")
                .arg(prepared.frontend.static_dir.as_ref().unwrap())
                .current_dir(&profile.data)
                .env("RUST_LOG", "info")
                .env("XDG_CONFIG_HOME", profile.data.join("config"))
                .env("BAMBOO_JIANDU_DATA_DIR", profile.data.join("jiandu"));
            runtime
                .start(
                    command,
                    profile.writer().unwrap(),
                    port,
                    Some(&profile.state_dir),
                )
                .unwrap()
        };
        manager.begin(&original).unwrap();
        let prepared = manager.reopen_prepared(&original).await.unwrap();
        let owner = start(&old.0, &prepared);
        crate::sidecar::wait_for_health(
            port,
            30,
            Some(&owner),
            prepared.frontend.index_hash.as_deref(),
        )
        .await
        .unwrap();
        assert_eq!(
            crate::sidecar::owned_version(port, &owner).await.unwrap(),
            version
        );
        assert!(manager
            .use_planned_restart(&old.0, &original)
            .await
            .unwrap());
        manager.finish(&original, Ok(())).unwrap();

        journal::save_downloaded(&profile, &target).unwrap();
        let plan = manager
            .plan_restart(
                &old.0,
                &SelectedUpdate {
                    current_sequence: original.sequence,
                    current: original.identity(),
                    candidate: target.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(manager.choose().await.unwrap(), original);
        assert!(profile.writer().is_err());
        manager
            .prepare_planned_restart(&old.0, port, plan.clone())
            .await
            .unwrap();
        assert!(!owner.is_ready());
        assert!(profile.writer().is_ok());

        let restarted = Manager::new(profile.clone()).unwrap();
        let handoff = restarted.arm_authorized_restart().unwrap().unwrap();
        assert_eq!(handoff.request, plan.request);
        restarted.begin(&target).unwrap();
        let prepared = restarted.reopen_prepared(&target).await.unwrap();
        let next = Host::default();
        let successor = start(&next.0, &prepared);
        assert_ne!(next.0.planned_update_owner().unwrap(), plan.owner);
        crate::sidecar::wait_for_health(
            port,
            30,
            Some(&successor),
            prepared.frontend.index_hash.as_deref(),
        )
        .await
        .unwrap();
        assert_eq!(
            crate::sidecar::owned_version(port, &successor)
                .await
                .unwrap(),
            version
        );
        restarted.finish(&target, Ok(())).unwrap();
        restarted
            .resume_planned_restart(&next.0, &handoff)
            .await
            .unwrap();
        assert_eq!(restarted.choose().await.unwrap(), target);
        assert!(PlannedRestart::read(&profile).unwrap().is_none());
        next.0.stop_for_update(TIMEOUT).await.unwrap();
    }

    fn stage_pair(profile: &Profile, pair: &mut Combination, version: &str, executable: &Asset) {
        let native = pair.candidate().unwrap().artifact.target.clone();
        let artifact = pair
            .bamboo
            .artifacts
            .iter_mut()
            .find(|entry| entry.target == native)
            .unwrap();
        artifact.executable = executable.clone();
        artifact.browser_runtime = None;
        pair.bamboo.version = version.into();
        let index = format!(
            "<!doctype html><title>Fixture {}</title>",
            pair.lotus.version
        );
        let hash = crate::frontend::hash_bytes(index.as_bytes());
        let inventory = format!("index.html\0{}\0{hash}\n", index.len());
        pair.lotus.resources_sha256 = crate::frontend::hash_bytes(inventory.as_bytes());
        let manifest = serde_json::to_vec(&json!({
            "schemaVersion": 1, "packageName": "@bigduu/lotus-next", "packageVersion": pair.lotus.version,
            "sourceRevision": pair.lotus.source_revision, "sourceDirty": false, "entrypoint": "index.html",
            "resourcesSha256": pair.lotus.resources_sha256,
            "resources": [{"path":"index.html", "size": index.len(), "sha256": hash}]
        })).unwrap();
        pair.lotus.manifest_sha256 = crate::frontend::hash_bytes(&manifest);
        let dist = profile
            .state_dir
            .join(format!("lotus-npm-{}", pair.lotus.tarball.sha256))
            .join(Path::new("dist"));
        fs::create_dir_all(&dist).unwrap();
        fs::write(dist.join("index.html"), index).unwrap();
        fs::write(dist.join("lotus-next-manifest.json"), manifest).unwrap();
    }
}

impl Manager {
    pub(super) async fn use_planned_restart(
        &self,
        runtime: &SidecarState,
        active: &Combination,
    ) -> Result<bool, String> {
        if runtime.planned_update_available()? {
            return Ok(true);
        }
        let current = component_kernel::reopen_kernel(&self.profile, &active.candidate()?).await?;
        if planned_update::executable_supports(&current.executable).await? {
            return Err(
                "The running Bamboo has not opened its planned-update control channel".into(),
            );
        }
        Ok(false)
    }

    pub(super) async fn plan_restart(
        &self,
        runtime: &SidecarState,
        update: &SelectedUpdate,
    ) -> Result<PlannedRestart, String> {
        let target = match self.reopen_prepared(&update.candidate).await {
            Ok(target) => target,
            Err(error) => {
                let _lock = self.profile.update_lock()?;
                journal::clear_downloaded(&self.profile, &update.candidate)?;
                return Err(format!(
                    "Cannot verify the cached update: {error}. Download this update again."
                ));
            }
        };
        if !planned_update::executable_supports(&target.kernel.executable).await? {
            return Err("The downloaded Bamboo cannot restore a planned update. The current session remains available.".into());
        }
        let _lock = self.profile.update_lock()?;
        update.validate_transition(&Journal::read(&self.profile)?)?;
        if journal::read_downloaded(&self.profile)?.as_ref() != Some(&update.candidate) {
            return Err("Download and verify this component update before applying it".into());
        }
        let plan = PlannedRestart {
            request: Uuid::new_v4(),
            candidate: update.candidate.clone(),
            current_sequence: update.current_sequence,
            current: update.current.clone(),
            owner: runtime.planned_update_owner()?,
            commit_requested: false,
            exit_confirmed: false,
        };
        plan.save(&self.profile)?;
        Ok(plan)
    }

    pub(super) async fn prepare_planned_restart(
        &self,
        runtime: &SidecarState,
        port: u16,
        mut plan: PlannedRestart,
    ) -> Result<(), String> {
        if runtime.planned_update_owner()? != plan.owner {
            return Err("The previous Bamboo process exited before confirming this handoff. Saved sessions are still pending recovery.".into());
        }
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        if !plan.commit_requested {
            let prepared = async {
                loop {
                    let result = runtime.planned_update(plan.request, Action::Prepare, RESPONSE).await?;
                    match result.status {
                        Status::Ready => return Ok(()),
                        Status::Busy if tokio::time::Instant::now() < deadline => {
                            self.updates.status(super::updates::Phase::ShuttingDown, result.message);
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        }
                        _ => return Err(result.message.unwrap_or_else(|| format!("Bamboo could not pause {} session(s). Retry when work can be paused.", result.pending_sessions.len()))),
                    }
                }
            }.await;
            let issued = prepared.and_then(|()| {
                let _lock = self.profile.update_lock()?;
                plan.commit_requested = true;
                plan.save(&self.profile)
            });
            if let Err(error) = issued {
                let _ = runtime
                    .planned_update(plan.request, Action::Abort, RESPONSE)
                    .await;
                plan.clear(&self.profile)?;
                return Err(error);
            }
        }

        runtime.set_committing_update(true)?;
        while !plan.authorized(&self.profile)? {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let result = runtime
                .planned_update(plan.request, Action::Commit, remaining.max(RESPONSE))
                .await;
            if plan.authorized(&self.profile)? {
                break;
            }
            let result = result?;
            match result.status {
                Status::Revoked | Status::Aborted | Status::Error => {
                    if plan.has_intent(&self.profile)? {
                        return Err(result.message.unwrap_or_else(|| "A Bamboo update was committed and is waiting for its original process to confirm shutdown.".into()));
                    }
                    let _ = runtime.planned_update(plan.request, Action::Abort, RESPONSE).await;
                    runtime.set_committing_update(false)?;
                    plan.clear(&self.profile)?;
                    return Err(result.message.unwrap_or_else(|| "The Bamboo preparation expired. Apply the downloaded update again.".into()));
                }
                Status::Committing | Status::Busy if tokio::time::Instant::now() < deadline => {
                    self.updates.status(super::updates::Phase::ShuttingDown, result.message);
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                _ => return Err(result.message.unwrap_or_else(|| "Bamboo has not finished the planned shutdown. Retry applying the update to continue waiting.".into())),
            }
        }
        runtime.wait_for_update_exit(TIMEOUT, false).await?;
        let _writer = self.profile.writer()?;
        crate::sidecar::require_available_port(port)?;
        let _lock = self.profile.update_lock()?;
        plan.exit_confirmed = true;
        plan.save(&self.profile)
    }

    pub(super) fn arm_authorized_restart(&self) -> Result<Option<PlannedRestart>, String> {
        let Some(plan) = PlannedRestart::read(&self.profile)? else {
            return Ok(None);
        };
        if !plan.authorized(&self.profile)? {
            return Ok(None);
        }
        let _lock = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        let original = |active: &Combination| {
            active.sequence == plan.current_sequence && active.identity() == plan.current
        };
        if !plan.exit_confirmed {
            // Bamboo's receipt authorizes session recovery. Activation also
            // requires the desktop's durable observation of a clean exit.
            if journal.next().is_some_and(original) {
                return Ok(Some(plan));
            }
            return Err(
                "The approved Bamboo recovery no longer matches the original component release"
                    .into(),
            );
        }
        if journal
            .active
            .as_ref()
            .is_none_or(|active| active != &plan.candidate && !original(active))
        {
            return Err(
                "The approved Bamboo handoff no longer matches the active component release".into(),
            );
        }
        if let Some(next) = journal.next() {
            if next == &plan.candidate {
                return Ok(Some(plan));
            }
            if next.sequence >= plan.candidate.sequence
                || journal.trial.is_some()
                || journal.queued.is_some()
            {
                return Err(
                    "The approved Bamboo handoff no longer matches the component journal".into(),
                );
            }
        }
        journal.queued = Some(plan.candidate.clone());
        journal.save(&self.profile)?;
        Ok(Some(plan))
    }

    pub(super) async fn resume_planned_restart(
        &self,
        runtime: &SidecarState,
        plan: &PlannedRestart,
    ) -> Result<(), String> {
        let result = runtime
            .planned_update(plan.request, Action::Resume, RESPONSE)
            .await?;
        if result.status == Status::Resumed
            && result
                .report
                .as_ref()
                .is_some_and(|report| report.pending_sessions.is_empty())
        {
            return plan.clear(&self.profile);
        }
        Err(result.message.unwrap_or_else(|| {
            "Bamboo is running and some saved sessions are still waiting to resume".into()
        }))
    }
}
