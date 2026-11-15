use super::*;
use crate::sidecar;
use serde_json::{json, Value};
use shared_child::SharedChild;
use std::net::TcpListener;
use std::process::Command;
use std::sync::Arc;

const BASELINE: &str = "2026.11.18";
const BASELINE_MANIFEST_SHA: &str =
    "7c97150255963c8917344f323513beca272e2a9d79a6da20bd0731a8159ae8a1";

struct Child(Arc<SharedChild>);

impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start(
    profile: &Profile,
    writer: File,
    binary: &Path,
    frontend: &Path,
    scratch: &Path,
) -> (Child, StartupStatus, u16) {
    let port = TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
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
    let (child, status) = sidecar::spawn_owned(command, writer, port).unwrap();
    (Child(child), status, port)
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

    let scratch = tempfile::tempdir().unwrap();
    let profile = scratch.path().join("bamboo-data");
    fs::create_dir(&profile).unwrap();
    fs::write(profile.join("config.json"), b"{}\n").unwrap();
    let profile = Profile::open(&profile).unwrap();
    let executable = std::env::current_exe().unwrap();
    let assembly = executable.parent().unwrap().parent().unwrap();
    let frontend = assembly.join("frontend/dist");
    let index = crate::frontend::hash_bytes(&fs::read(frontend.join("index.html")).unwrap());

    let client = release_client().unwrap();
    let base = format!("{RELEASES}/v{BASELINE}");
    let mut manifest = Vec::new();
    download(
        &client,
        &format!("{base}/bamboo-sidecars-v2.json"),
        MAX_JSON,
        &mut manifest,
    )
    .await
    .unwrap();
    assert_eq!(
        crate::frontend::hash_bytes(&manifest),
        BASELINE_MANIFEST_SHA
    );
    let manifest: Manifest = serde_json::from_slice(&manifest).unwrap();
    assert_eq!(manifest.version, BASELINE);
    let mut artifacts = manifest
        .artifacts
        .into_iter()
        .filter(|asset| asset.target == TARGET);
    let artifact = artifacts.next().expect("native baseline artifact");
    assert!(artifacts.next().is_none());
    check_artifact(&artifact).unwrap();
    let baseline = scratch.path().join(binary_asset());
    install_binary(&client, &base, &baseline, &artifact, BASELINE)
        .await
        .unwrap();

    let (old, old_status, old_port) = start(
        &profile,
        profile.writer().unwrap(),
        &baseline,
        &frontend,
        scratch.path(),
    );
    sidecar::wait_for_health(old_port, 45, Some(&old_status), Some(&index))
        .await
        .unwrap();
    let old_version = sidecar::reported_version(old_port).await.unwrap();
    assert_eq!(old_version, BASELINE);
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
        .post(format!("http://127.0.0.1:{old_port}/api/v1/sessions"))
        .json(&json!({"title": "Bodhi native kernel test", "workspace_path": scratch.path()}))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let session: Value = response.json().await.unwrap();
    assert_eq!(status, reqwest::StatusCode::CREATED, "{session}");
    let session_id = session["session"]["id"].as_str().unwrap();

    let lock: Value = serde_json::from_str(BUNDLED_LOCK).unwrap();
    assert_eq!(lock["manifestAssetName"], "bamboo-sidecars-v2.json");
    let receipt: Value =
        serde_json::from_slice(&fs::read(assembly.join("frontend/receipt.json")).unwrap()).unwrap();
    let lotus = receipt["artifactManifestSha256"].as_str().unwrap();
    let updates = Updates {
        profile: profile.clone(),
        root: scratch.path().join("kernels/profile"),
        bodhi_version: "0.0.0".into(),
        lotus_manifest_sha256: lotus.into(),
        bundled_version: old_version.clone(),
        bundled_binary: baseline,
        running_version: OnceLock::new(),
    };
    updates.mark_ready(old_version, old_status);
    let mut upgrade = Upgrade {
        schema_version: 1,
        bodhi_version: "0.0.0".into(),
        lotus_manifest_sha256: lotus.into(),
        from_bamboo_version: BASELINE.into(),
        bamboo_version: lock["version"].as_str().unwrap().into(),
        source_revision: lock["sourceRevision"].as_str().unwrap().into(),
        manifest_sha256: "a".repeat(64),
    };
    assert!(updates
        .stage(upgrade.clone())
        .await
        .unwrap_err()
        .contains("SHA-256"));
    assert!(ProfileState::read(&profile).unwrap().selection.is_none());
    upgrade.manifest_sha256 = lock["manifestSha256"].as_str().unwrap().into();
    updates.stage(upgrade).await.unwrap();
    assert_eq!(sidecar::reported_version(old_port).await.unwrap(), BASELINE);
    drop(old);

    let writer = profile.writer().unwrap();
    let selected = updates.prepare_launch().await.unwrap().unwrap();
    assert_eq!(
        ProfileState::read(&profile)
            .unwrap()
            .started_version
            .as_deref(),
        Some(selected.version.as_str())
    );
    let (_child, status, port) = start(
        &profile,
        writer,
        &selected.executable,
        &frontend,
        scratch.path(),
    );
    sidecar::wait_for_health(port, 45, Some(&status), Some(&index))
        .await
        .unwrap();
    assert_eq!(
        sidecar::reported_version(port).await.unwrap(),
        selected.version
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
}
