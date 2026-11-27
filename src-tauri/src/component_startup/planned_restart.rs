//! Durable desktop intent and verification of the old Bamboo process's receipt.

#[cfg(test)]
use super::SelectedUpdate;
use super::{journal, Combination, Journal, Manager, PairIdentity};
use crate::bamboo_profile::{is_link, sync_directory, Profile};
#[cfg(test)]
use crate::component_kernel;
use crate::sidecar::{
    planned_update::{self, Action, Status},
    SidecarState, UpdateShutdownError,
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

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum RestartMode {
    #[default]
    Planned,
    Immediate,
}

impl RestartMode {
    fn is_planned(&self) -> bool {
        matches!(self, Self::Planned)
    }

    fn prepare_action(self) -> Action {
        match self {
            Self::Planned => Action::Prepare,
            Self::Immediate => Action::PrepareImmediate,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PlannedRestart {
    pub(super) request: Uuid,
    pub(super) candidate: Combination,
    current_sequence: u64,
    current: PairIdentity,
    owner: String,
    #[serde(default, skip_serializing_if = "RestartMode::is_planned")]
    pub(super) mode: RestartMode,
    pub(super) commit_requested: bool,
    pub(super) exit_confirmed: bool,
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
        if matches!(self.mode, RestartMode::Immediate) {
            // The receipt can be visible while Bamboo is still syncing its directory.
            sync_directory(&root).map_err(|error| {
                format!("Cannot make the Bamboo update readiness receipt durable: {error}")
            })?;
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
            mode: RestartMode::default(),
            commit_requested: false,
            exit_confirmed: false,
        };
        plan.save(&profile).unwrap();
        let saved = fs::read(profile.state_dir.join(FILE)).unwrap();
        let legacy: serde_json::Value = serde_json::from_slice(&saved).unwrap();
        assert!(legacy.get("mode").is_none());
        assert!(PlannedRestart::read(&profile)
            .unwrap()
            .unwrap()
            .mode
            .is_planned());
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
        let locale = crate::i18n::Locale::English;
        assert_eq!(
            manager
                .set_skipped(target.sequence, String::new(), true, locale)
                .await
                .unwrap_err(),
            locale.text("updates.restartPending")
        );
        assert!(journal::read_skipped(&profile).unwrap().is_empty());
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
    async fn lotus_update_does_not_acquire_a_missing_bamboo_peer() {
        use crate::component_channel::tests::{
            fixture_channel_with_independent_updates, initial_combination,
        };
        use crate::component_channel::UpdateKind;
        let directory = tempfile::tempdir().unwrap();
        let profile = Profile::open(directory.path()).unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let original = initial_combination().await;
        let channel = fixture_channel_with_independent_updates();
        let mut candidate = channel
            .select_updates(&original, None)
            .unwrap()
            .into_iter()
            .find(|candidate| candidate.update_kind(&original) == Some(UpdateKind::Lotus))
            .unwrap()
            .clone();
        let peer = original.candidate().unwrap().artifact.executable.clone();
        stage_pair(&profile, &mut candidate, &original.bamboo.version, &peer);
        candidate.bamboo = original.bamboo.clone();
        assert!(crate::frontend::reopen_release(&profile, &candidate.lotus).is_ok());
        let missing_peer =
            crate::component_kernel::reopen_kernel(&profile, &candidate.candidate().unwrap())
                .await
                .unwrap_err();

        let proxy = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        manager
            .settings
            .send_replace(crate::component_download::DownloadSettings {
                proxy_url: Some(format!("http://{}", proxy.local_addr().unwrap())),
                ..Default::default()
            });
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            manager.prepare_update(&original, &candidate),
        )
        .await
        .expect("reopening a missing peer should not contact a release source");
        assert_eq!(outcome.unwrap_err(), missing_peer);
        assert!(!profile
            .state_dir
            .join(format!("bamboo-{}", peer.sha256))
            .exists());
        journal::save_downloaded(&profile, &candidate).unwrap();
        assert!(manager.reopen_downloaded_update(&candidate).await.is_err());
        assert!(journal::read_downloaded(&profile).unwrap().is_none());
    }

    #[tokio::test]
    #[ignore = "requires BODHI_PLANNED_UPDATE_BAMBOO set to an independently built native Bamboo"]
    async fn native_bodhi_control_replaces_two_owned_bamboo_processes() {
        native_bodhi_restart(Some(RestartMode::Planned), None).await;
    }

    #[tokio::test]
    #[ignore = "requires BODHI_PLANNED_UPDATE_BAMBOO with immediate-update-v1 support"]
    async fn native_bodhi_control_applies_an_immediate_checkpointed_update() {
        native_bodhi_restart(Some(RestartMode::Immediate), None).await;
    }

    #[tokio::test]
    #[ignore = "requires two official native Bamboo executables via BODHI_PLANNED_UPDATE_BAMBOO and BODHI_NEXT_UPDATE_BAMBOO"]
    async fn native_owned_bamboo_switch_reuses_the_host_and_profile() {
        let replacement = PathBuf::from(std::env::var_os("BODHI_NEXT_UPDATE_BAMBOO").unwrap());
        native_bodhi_restart(Some(RestartMode::Planned), Some(&replacement)).await;
    }

    #[tokio::test]
    #[ignore = "requires official Bamboo 2026.11.50 and 2026.11.51 via the native fixture environment"]
    async fn native_force_switch_replaces_bamboo_with_hooks_enabled_and_keeps_history() {
        let replacement = PathBuf::from(std::env::var_os("BODHI_NEXT_UPDATE_BAMBOO").unwrap());
        native_bodhi_restart(None, Some(&replacement)).await;
    }

    fn stage_native_binary(
        profile: &Profile,
        binary: &std::path::Path,
    ) -> (String, Asset, PathBuf) {
        let output = std::process::Command::new(binary)
            .arg("--version")
            .output()
            .unwrap();
        assert!(output.status.success());
        let version = std::str::from_utf8(&output.stdout)
            .unwrap()
            .trim()
            .strip_prefix("bamboo ")
            .unwrap()
            .to_owned();
        let mut digest = Sha256::new();
        let size_bytes = io::copy(&mut fs::File::open(binary).unwrap(), &mut digest).unwrap();
        let asset = Asset {
            sha256: format!("{:x}", digest.finalize()),
            size_bytes,
        };
        let cache = profile.state_dir.join(format!("bamboo-{}", asset.sha256));
        fs::create_dir(&cache).unwrap();
        let path = cache.join(format!("bamboo{}", std::env::consts::EXE_SUFFIX));
        fs::copy(binary, &path).unwrap();
        (version, asset, path)
    }

    async fn native_bodhi_restart(
        mode: Option<RestartMode>,
        replacement: Option<&std::path::Path>,
    ) {
        let _ = env_logger::builder().is_test(true).try_init();
        let binary = PathBuf::from(std::env::var_os("BODHI_PLANNED_UPDATE_BAMBOO").unwrap());
        assert!(planned_update::executable_supports(&binary).await.unwrap());
        let scratch = tempfile::tempdir().unwrap();
        let profile = Profile::open(scratch.path()).unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let (version, executable, path) = stage_native_binary(&profile, &binary);

        let mut original = crate::component_channel::tests::initial_combination().await;
        let channel = crate::component_channel::tests::fixture_channel().await;
        let mut target = channel
            .select(Some((original.sequence, &original.identity())))
            .unwrap()
            .unwrap()
            .combination
            .clone();
        // The component journal requires release versions. For a source-built
        // binary use its real digest and retain the test catalog's version.
        // Both launched processes still have to report the binary's version.
        let catalog_version = if version == "0.0.0" {
            original.bamboo.version.clone()
        } else {
            version.clone()
        };
        stage_pair(&profile, &mut original, &catalog_version, &executable);
        let (target_version, target_path) = if let Some(replacement) = replacement {
            let (next, next_asset, next_path) = stage_native_binary(&profile, replacement);
            assert!(
                semver::Version::parse(&next).unwrap() > semver::Version::parse(&version).unwrap()
            );
            stage_pair(&profile, &mut target, &next, &next_asset);
            target.lotus = original.lotus.clone();
            assert_eq!(
                target.update_kind(&original),
                Some(crate::component_channel::UpdateKind::Bamboo)
            );
            (next, next_path)
        } else {
            stage_pair(&profile, &mut target, &catalog_version, &executable);
            target.bamboo = original.bamboo.clone();
            assert_ne!(target.lotus.manifest_sha256, original.lotus.manifest_sha256);
            (version.clone(), path)
        };
        let config = if mode.is_some() {
            json!({})
        } else {
            assert_eq!((&*version, &*target_version), ("2026.11.50", "2026.11.51"));
            json!({
                "setup": {
                    "completed": true, "completed_at": "1970-01-01T00:00:00Z", "version": 1
                },
                "features": {"provider_model_ref": true},
                "provider_instances": {"update-fixture": {
                    "provider_type": "openai", "label": "Isolated update",
                    "api_key": "synthetic-loopback", "base_url": "http://127.0.0.1:1/v1",
                    "model": "gpt-4o-mini", "enabled": true
                }},
                "default_provider_instance": "update-fixture",
                "defaults": {"chat": {"provider": "update-fixture", "model": "gpt-4o-mini"}},
                "lifecycle_hooks": {"enabled": true},
                "memory": {"auto_dream_enabled": false}
            })
        };
        fs::write(
            profile.data.join("config.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
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
        let selected_mode = manager.checkpoint_mode(&old.0, &original).await.unwrap();
        assert_eq!(
            selected_mode,
            Some(if old.0.immediate_update_available().unwrap() {
                RestartMode::Immediate
            } else {
                RestartMode::Planned
            })
        );
        if matches!(mode, Some(RestartMode::Immediate)) {
            assert_eq!(selected_mode, Some(RestartMode::Immediate));
        }
        manager.finish(&original, Ok(())).unwrap();

        manager.prepare_update(&original, &target).await.unwrap();
        journal::save_downloaded(&profile, &target).unwrap();
        let update = std::sync::Arc::new(SelectedUpdate {
            current_sequence: original.sequence,
            current: original.identity(),
            candidate: target.clone(),
        });
        assert_eq!(manager.choose().await.unwrap(), original);
        assert!(profile.writer().is_err());

        let original_owner = old.0.planned_update_owner().unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let base = format!("http://127.0.0.1:{port}/api/v1");
        let saved = if mode.is_none() {
            let refused = old
                .0
                .planned_update(Uuid::new_v4(), Action::PrepareImmediate, RESPONSE)
                .await
                .unwrap();
            assert_eq!(refused.status, Status::Error);
            assert_eq!(
                refused.message.as_deref(),
                Some("Configured lifecycle hooks prevent a planned update")
            );
            assert!(!profile.data.join("managed-update").exists());
            let model = json!({"provider": "update-fixture", "model": "gpt-4o-mini"});
            let created = client
                .post(format!("{base}/sessions"))
                .json(&json!({
                    "provider": model["provider"], "model": model["model"], "model_ref": model,
                    "title": "Existing session before direct update", "title_generated": true,
                    "workspace_path": profile.data
                }))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap();
            let id = created["session"]["id"].as_str().unwrap().to_owned();
            let accepted = client
                .post(format!("{base}/chat"))
                .json(&json!({
                    "provider": model["provider"], "model": model["model"], "model_ref": model,
                    "session_id": id, "message": "Preserve this committed user message."
                }))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap();
            assert_eq!(accepted["session_id"], id);
            client
                .post(format!("{base}/execute/{id}"))
                .json(&json!({
                    "provider": model["provider"], "model": model["model"], "model_ref": model
                }))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let history = tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    let history = native_history(&client, &base, &id).await;
                    if history.as_array().unwrap().iter().any(|message| {
                        message["role"] == "user"
                            && message["content"] == "Preserve this committed user message."
                    }) {
                        break history;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .expect("the old Bamboo committed the submitted user message");
            Some((id, history))
        } else {
            None
        };

        let new_host = replacement.is_none().then(Host::default);
        let new_manager = replacement
            .is_none()
            .then(|| Manager::new(profile.clone()).unwrap());
        let running_manager = new_manager.as_ref().unwrap_or(&manager);
        let running_host = new_host.as_ref().unwrap_or(&old);
        let handoff = if let Some(mode) = mode {
            let plan = manager.plan_restart(&old.0, &update, mode).await.unwrap();
            let persisted = PlannedRestart::read(&profile).unwrap().unwrap();
            assert_eq!(persisted.request, plan.request);
            assert_eq!(persisted.mode, mode);
            manager
                .prepare_planned_restart(&old.0, port, persisted)
                .await
                .unwrap();
            let handoff = running_manager.arm_authorized_restart().unwrap().unwrap();
            assert!(handoff.authorized(&profile).unwrap());
            assert_eq!(handoff.request, plan.request);
            Some(handoff)
        } else {
            manager.reopen_downloaded_update(&target).await.unwrap();
            manager
                .stop_owned_for_switch(&old.0, port, &update, &Journal::read(&profile).unwrap())
                .await
                .unwrap();
            assert!(old.0.owned_has_exited().unwrap());
            assert!(!profile.data.join("managed-update").exists());
            None
        };
        assert!(!owner.is_ready());
        assert!(profile.writer().is_ok());
        let foreign_listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        assert!(crate::sidecar::require_available_port(port).is_err());
        drop(foreign_listener);

        running_manager.begin(&target).unwrap();
        let prepared = running_manager.reopen_prepared(&target).await.unwrap();
        assert_eq!(prepared.kernel.executable, target_path);
        let successor = start(&running_host.0, &prepared);
        assert_ne!(
            running_host.0.planned_update_owner().unwrap(),
            original_owner
        );
        crate::sidecar::wait_for_health(
            port,
            30,
            Some(&successor),
            prepared.frontend.index_hash.as_deref(),
        )
        .await
        .unwrap();
        assert!(profile.writer().is_err());
        assert_eq!(
            crate::sidecar::owned_version(port, &successor)
                .await
                .unwrap(),
            target_version
        );
        running_manager.finish(&target, Ok(())).unwrap();
        if let Some(handoff) = handoff {
            running_manager
                .resume_planned_restart(&running_host.0, &handoff)
                .await
                .unwrap();
        }
        if let Some((id, history)) = saved {
            let detail = client
                .get(format!("{base}/sessions/{id}"))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap();
            assert_eq!(detail["session"]["id"], id);
            assert_eq!(native_history(&client, &base, &id).await, history);
            let config: serde_json::Value =
                serde_json::from_slice(&fs::read(profile.data.join("hooks.json")).unwrap())
                    .unwrap();
            assert_eq!(config["data"]["lifecycle_hooks"]["enabled"], true);
        }
        assert_eq!(running_manager.choose().await.unwrap(), target);
        assert!(PlannedRestart::read(&profile).unwrap().is_none());
        running_host.0.stop_for_update(TIMEOUT).await.unwrap();
    }

    async fn native_history(client: &reqwest::Client, base: &str, id: &str) -> serde_json::Value {
        let history = client
            .get(format!("{base}/sessions/{id}/history"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        if history.is_array() {
            history
        } else {
            history["messages"].clone()
        }
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
    #[cfg(test)]
    pub(super) async fn checkpoint_mode(
        &self,
        runtime: &SidecarState,
        active: &Combination,
    ) -> Result<Option<RestartMode>, String> {
        if runtime.immediate_update_available()? {
            return Ok(Some(RestartMode::Immediate));
        }
        if runtime.planned_update_available()? {
            return Ok(Some(RestartMode::Planned));
        }
        let current = component_kernel::reopen_kernel(&self.profile, &active.candidate()?).await?;
        if planned_update::executable_supports(&current.executable).await? {
            return Err("The running Bamboo has not opened its update control channel".into());
        }
        Ok(None)
    }

    #[cfg(test)]
    pub(super) async fn plan_restart(
        &self,
        runtime: &SidecarState,
        update: &SelectedUpdate,
        mode: RestartMode,
    ) -> Result<PlannedRestart, String> {
        let target = self.reopen_downloaded_update(&update.candidate).await?;
        self.plan_verified_restart(runtime, update, mode, &target)
            .await
    }

    #[cfg(test)]
    pub(super) async fn plan_verified_restart(
        &self,
        runtime: &SidecarState,
        update: &SelectedUpdate,
        mode: RestartMode,
        target: &super::Prepared,
    ) -> Result<PlannedRestart, String> {
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
            mode,
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
                    let result = runtime
                        .planned_update(plan.request, plan.mode.prepare_action(), RESPONSE)
                        .await?;
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
        match plan.mode {
            RestartMode::Planned => runtime.wait_for_update_exit(TIMEOUT, false).await?,
            RestartMode::Immediate => runtime
                .force_stop_after_checkpoint(&plan.owner, Duration::from_secs(10))
                .await
                .map_err(|error| match error {
                    UpdateShutdownError::RequestRejected(message)
                    | UpdateShutdownError::Unconfirmed(message) => message,
                })?,
        }
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
