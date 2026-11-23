use super::*;
use serde_json::{json, Value};
use std::net::TcpListener;

const BASELINE: &str = "2026.11.19";
const BASELINE_MANIFEST_SHA: &str =
    "2cb847499ba187ccc3da0eb76f9779a3c3dce9ac2f46725cf312186c5aca7f21";
const CANDIDATE: &str = "2026.11.22";
const CANDIDATE_SOURCE: &str = "13336567999504a8c7deb89fba94f7907b04c3ee";
const CANDIDATE_MANIFEST_SHA: &str =
    "b50c37033e436a020fcf89f6a21361e0c55892e7bf1b14215a4529c6f88a6a78";
const ARM_CANDIDATE: &str = "2026.11.23";
const ARM_CANDIDATE_SOURCE: &str = "4aee88a853260de306e82d56cd7008a4bc660c9b";
const ARM_CANDIDATE_MANIFEST_SHA: &str =
    "3e6505847466c23429f9e401e5dbb0ee58cf8eb2a1e6f156c0582e86a9b772ab";

struct PublishedTransition {
    baseline: &'static str,
    baseline_manifest_sha: &'static str,
    baseline_schema: u32,
    candidate: &'static str,
    candidate_source: &'static str,
    candidate_manifest_sha: &'static str,
}

fn published_transition() -> PublishedTransition {
    if matches!(
        TARGET,
        "aarch64-unknown-linux-gnu" | "aarch64-pc-windows-msvc"
    ) {
        PublishedTransition {
            baseline: CANDIDATE,
            baseline_manifest_sha: CANDIDATE_MANIFEST_SHA,
            baseline_schema: 3,
            candidate: ARM_CANDIDATE,
            candidate_source: ARM_CANDIDATE_SOURCE,
            candidate_manifest_sha: ARM_CANDIDATE_MANIFEST_SHA,
        }
    } else {
        PublishedTransition {
            baseline: BASELINE,
            baseline_manifest_sha: BASELINE_MANIFEST_SHA,
            baseline_schema: 2,
            candidate: CANDIDATE,
            candidate_source: CANDIDATE_SOURCE,
            candidate_manifest_sha: CANDIDATE_MANIFEST_SHA,
        }
    }
}

struct DesktopRuntime(SidecarState);

impl Drop for DesktopRuntime {
    fn drop(&mut self) {
        self.0.exit();
    }
}

fn bamboo_command(
    profile: &Profile,
    binary: &Path,
    frontend: &Path,
    scratch: &Path,
    port: u16,
) -> Command {
    let mut command = Command::new(binary);
    command.env_clear().envs(
        [
            "PATH",
            "SystemRoot",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
        ]
        .into_iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (key, value))),
    );
    command
        .env("BAMBOO_JIANDU_DATA_DIR", scratch.join("jiandu"))
        .env("CFFIXED_USER_HOME", scratch)
        .env("USERPROFILE", scratch)
        .env("XDG_CONFIG_HOME", scratch.join("config"))
        .env("XDG_DATA_HOME", scratch.join("local-data"))
        .env("RUST_LOG", "warn,bamboo_server::server::entrypoints=info")
        .current_dir(scratch)
        .args([
            "serve",
            "--parent-pid",
            &std::process::id().to_string(),
            "--bind",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--data-dir",
        ])
        .arg(&profile.data)
        .arg("--static-dir")
        .arg(frontend);
    command
}

#[tokio::test]
async fn published_kernel_update_preserves_profile_on_native_assembly() {
    // The canonical native feature jobs set both variables, stage verified
    // resources, and run this in the usual debug/test compilation. Bare Rust
    // checks deliberately lack those runtime inputs.
    let native_assembly = std::env::var("BAMBOO_SIDECAR_SOURCE").as_deref() == Ok("release")
        && std::env::var("LOTUS_SOURCE").as_deref() == Ok("package");
    if !native_assembly {
        return;
    }
    let transition = published_transition();

    let scratch = tempfile::tempdir().unwrap();
    let profile = scratch.path().join("bamboo-data");
    fs::create_dir(&profile).unwrap();
    fs::write(profile.join("config.json"), b"{}\n").unwrap();
    let profile = Profile::open(&profile).unwrap();
    let executable = std::env::current_exe().unwrap();
    let assembly = executable.parent().unwrap().parent().unwrap();
    let receipt = fs::read(assembly.join("frontend/receipt.json")).unwrap();
    let cached = crate::frontend::resolve_profile(assembly, &receipt, &profile).unwrap();
    let frontend = cached.static_dir.unwrap();
    let index = cached.index_hash.unwrap();
    let lotus = cached.manifest_sha256.unwrap();
    assert!(frontend.starts_with(&profile.state_dir));

    let client = release_client().unwrap();
    let base = format!("{RELEASES}/v{}", transition.baseline);
    let (schema, manifest) = download_manifest(&client, &base, transition.baseline_manifest_sha)
        .await
        .unwrap();
    assert_eq!(schema, transition.baseline_schema);
    let manifest: Manifest = serde_json::from_slice(&manifest).unwrap();
    assert_eq!(manifest.schema_version, schema);
    assert_eq!(manifest.version, transition.baseline);
    let mut artifacts = manifest
        .artifacts
        .into_iter()
        .filter(|asset| asset.target == TARGET);
    let artifact = artifacts.next().expect("native baseline artifact");
    assert!(artifacts.next().is_none());
    check_artifact(&artifact).unwrap();
    let baseline = scratch.path().join(binary_asset());
    install_binary(&client, &base, &baseline, &artifact, transition.baseline)
        .await
        .unwrap();

    let port = TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let runtime = DesktopRuntime(SidecarState::default());
    let writer = profile.writer().unwrap();
    let surviving_writer = writer.try_clone().unwrap();
    let old_status = runtime
        .0
        .start(
            bamboo_command(&profile, &baseline, &frontend, scratch.path(), port),
            writer,
            port,
        )
        .unwrap();
    sidecar::wait_for_health(port, 45, Some(&old_status), Some(&index))
        .await
        .unwrap();
    let old_version = sidecar::owned_version(port, &old_status).await.unwrap();
    assert_eq!(old_version, transition.baseline);
    assert!(
        Profile::open(&profile.data).unwrap().writer().is_err(),
        "a running child must own the profile even with a different port"
    );

    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let response = http
        .post(format!("http://127.0.0.1:{port}/api/v1/sessions"))
        .json(&json!({"title": "Bodhi native kernel test", "workspace_path": scratch.path()}))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let session: Value = response.json().await.unwrap();
    assert_eq!(status, reqwest::StatusCode::CREATED, "{session}");
    let session_id = session["session"]["id"].as_str().unwrap();

    let updates = Updates {
        profile: profile.clone(),
        root: scratch.path().join("kernels/profile"),
        bodhi_version: "0.0.0".into(),
        lotus_manifest_sha256: lotus.clone(),
        bundled_version: old_version.clone(),
        bundled_binary: baseline,
        running_version: Mutex::new(None),
    };
    updates.mark_ready(old_version, old_status);
    let mut upgrade = Upgrade {
        schema_version: 1,
        bodhi_version: "0.0.0".into(),
        lotus_manifest_sha256: lotus.into(),
        from_bamboo_version: transition.baseline.into(),
        bamboo_version: transition.candidate.into(),
        source_revision: transition.candidate_source.into(),
        manifest_sha256: "a".repeat(64),
    };
    assert!(updates
        .stage(upgrade.clone())
        .await
        .unwrap_err()
        .contains("SHA-256"));
    assert!(ProfileState::read(&profile).unwrap().pending.is_none());
    upgrade.manifest_sha256 = transition.candidate_manifest_sha.into();
    updates.stage(upgrade).await.unwrap();
    let staged = ProfileState::read(&profile).unwrap();
    assert!(staged.selection.is_none() && staged.started_version.is_none());
    assert!(
        updates.prepare_launch().await.unwrap().is_none(),
        "staging alone must not activate even on relaunch"
    );
    let candidate = updates.activation_target(&staged).unwrap();
    let mut stale = candidate.clone();
    stale.upgrade.manifest_sha256 = "d".repeat(64);
    assert!(updates
        .activate(
            &stale,
            &runtime.0,
            port,
            Some(&index),
            async |_| panic!("stale approval reached process setup"),
            |_| panic!("stale approval reached page restore"),
        )
        .await
        .is_err());
    let unable_to_park = updates
        .activate(
            candidate,
            &runtime.0,
            port,
            Some(&index),
            async |_| Err("update page did not commit".into()),
            |_| panic!("failed page transition reached page restore"),
        )
        .await
        .unwrap_err();
    assert_eq!(unable_to_park, "update page did not commit");
    assert_eq!(
        sidecar::reported_version(port).await.unwrap(),
        transition.baseline
    );
    assert_eq!(
        updates.verify_running(port, Some(&index)).await.unwrap(),
        transition.baseline
    );

    let command = |kernel: &Kernel| {
        Ok(bamboo_command(
            &profile,
            &kernel.executable,
            &frontend,
            scratch.path(),
            port,
        ))
    };
    // A descendant can outlive the old server while retaining an inherited
    // lease. A separate handle with the same lifetime demonstrates the fence.
    let blocked = updates
        .activate(
            candidate,
            &runtime.0,
            port,
            Some(&index),
            async |kernel| command(kernel),
            |_| panic!("writer conflict reached page restore"),
        )
        .await
        .unwrap_err();
    assert!(
        blocked.contains("Cannot open the Bamboo profile"),
        "{blocked}"
    );
    let retry = ProfileState::read(&profile).unwrap();
    assert!(retry.pending.as_ref() == Some(candidate) && retry.started_version.is_none());
    assert!(updates.verify_running(port, Some(&index)).await.is_err());
    drop(surviving_writer);

    let active = updates
        .activate(
            candidate,
            &runtime.0,
            port,
            Some(&index),
            async |kernel| command(kernel),
            |version| {
                assert_eq!(version, transition.candidate);
                let (observed, owner) = updates.running()?.unwrap();
                assert_eq!(observed, version);
                assert!(owner.is_ready());
                Ok(())
            },
        )
        .await
        .unwrap();
    assert_eq!(active, transition.candidate);
    assert_eq!(sidecar::reported_version(port).await.unwrap(), active);
    let state = ProfileState::read(&profile).unwrap();
    assert!(state.pending.is_none());
    assert_eq!(state.started_version.as_deref(), Some(active.as_str()));
    assert!(
        updates.activation_target(&state).is_err(),
        "successful activation clears the pending update"
    );
    let list = http
        .get(format!("http://127.0.0.1:{port}/api/v1/sessions"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        list.contains(session_id),
        "previous session survives the upgrade"
    );
    runtime.0.stop().await.unwrap();
    assert!(
        profile.writer().is_ok(),
        "the exited child releases its writer lease"
    );
}
