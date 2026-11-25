use super::*;
use std::fs;

#[tokio::test]
async fn force_update_only_queues_after_clean_shutdown_and_released_ownership() {
    let directory = tempfile::tempdir().unwrap();
    let profile = Profile::open(directory.path()).unwrap();
    let manager = Manager::new(profile.clone()).unwrap();
    let original = component_channel::tests::initial_combination().await;
    let channel = component_channel::tests::fixture_channel().await;
    let candidate = channel.select_updates(&original, None).unwrap()[0].clone();
    let update = SelectedUpdate {
        current_sequence: original.sequence,
        current: original.identity(),
        candidate: candidate.clone(),
    };
    Journal {
        active: Some(original.clone()),
        ..Journal::default()
    }
    .save(&profile)
    .unwrap();
    journal::save_downloaded(&profile, &candidate).unwrap();
    let occupied = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = occupied.local_addr().unwrap().port();
    assert!(manager
        .queue_after_force_shutdown(
            &update,
            async {
                Err(crate::sidecar::UpdateShutdownError::Unconfirmed(
                    "shutdown timed out".into(),
                ))
            },
            port,
        )
        .await
        .is_err());
    assert!(manager
        .queue_after_force_shutdown(&update, async { Ok(()) }, port)
        .await
        .is_err());
    assert!(Journal::read(&profile).unwrap().queued.is_none());
    drop(occupied);
    let writer = profile.writer().unwrap();
    assert!(manager
        .queue_after_force_shutdown(&update, async { Ok(()) }, port)
        .await
        .is_err());
    assert_eq!(manager.choose().await.unwrap(), original);
    assert_eq!(
        journal::read_downloaded(&profile).unwrap(),
        Some(candidate.clone())
    );
    drop(writer);
    manager
        .queue_after_force_shutdown(&update, async { Ok(()) }, port)
        .await
        .unwrap();
    assert_eq!(manager.choose().await.unwrap(), candidate);
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bootstrap {
    kind: String,
    catalog_url: String,
    shell_protocol: u32,
}

#[tokio::test]
async fn published_thin_bootstrap_is_bootable_on_native_target() {
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let path = source.join("component-bootstrap.json");
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => panic!("Cannot read the thin bootstrap record: {error}"),
    };
    let bootstrap: Bootstrap = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(bootstrap.kind, "bodhi-component-bootstrap/v3");
    assert_eq!(bootstrap.catalog_url, component_channel::STABLE_CATALOG_URL);
    assert_eq!(bootstrap.shell_protocol, component_channel::SHELL_PROTOCOL);
    let dir = tempfile::tempdir().unwrap();
    let profile_path = dir.path().join("component-profile");
    fs::create_dir(&profile_path).unwrap();
    let profile = Profile::open(&profile_path).unwrap();
    let manager = Manager::new(profile.clone()).unwrap();
    let pair = manager.choose().await.unwrap();
    let identity = pair.identity();
    let prepared = manager.prepare(&pair).await.unwrap();
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut child = std::process::Command::new(prepared.kernel.executable);
    child.env_clear().envs(
        ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "LANG"]
            .into_iter()
            .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
    );
    if let Some([node, host, browser]) = prepared.browser {
        child
            .env("BAMBOO_BROWSER_NODE", node)
            .env("BAMBOO_BROWSER_HOST_SCRIPT", host)
            .env("BAMBOO_BROWSER_EXECUTABLE", browser);
    }
    child
        .current_dir(dir.path())
        .env("RUST_LOG", "info")
        .env("BAMBOO_JIANDU_DATA_DIR", dir.path().join("jiandu"))
        .env("XDG_CONFIG_HOME", dir.path().join("config"))
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
        .arg(prepared.frontend.static_dir.unwrap());
    let runtime = crate::sidecar::SidecarState::default();
    let writer = profile.writer().unwrap();
    let _lease = writer.try_clone().unwrap();
    manager.begin(&pair).unwrap();
    let status = runtime
        .start(child, writer, port, Some(&profile.state_dir))
        .unwrap();
    let readiness = crate::sidecar::wait_for_health(
        port,
        60,
        Some(&status),
        prepared.frontend.index_hash.as_deref(),
    )
    .await;
    let version = if readiness.is_ok() {
        crate::sidecar::owned_version(port, &status).await
    } else {
        Err("Cannot start the published pair".into())
    };
    #[cfg(unix)]
    runtime
        .stop_for_update(Duration::from_secs(90))
        .await
        .unwrap();
    #[cfg(not(unix))]
    runtime.stop().await.unwrap();
    readiness.unwrap();
    assert_eq!(version.unwrap(), pair.bamboo.version);
    drop(_lease);
    assert!(profile.writer().is_ok());
    crate::sidecar::require_available_port(port).unwrap();
    manager.finish(&pair, Ok(())).unwrap();
    assert_eq!(manager.choose().await.unwrap(), pair);
    let evidence = format!(
        "\nBodhi component bootstrap: {} {} {} {} {} {}\n",
        bootstrap.catalog_url,
        bootstrap.shell_protocol,
        pair.sequence,
        identity.bamboo_manifest_sha256,
        identity.lotus_manifest_sha256,
        env!("BODHI_BUILD_TARGET")
    );
    std::io::Write::write_all(&mut std::io::stdout().lock(), evidence.as_bytes()).unwrap();
}

#[tokio::test]
async fn ready_history_and_data_floor_survive_a_failed_start() {
    let dir = tempfile::tempdir().unwrap();
    let profile = Profile::open(dir.path()).unwrap();
    let manager = Manager::new(profile.clone()).unwrap();
    let channel = component_channel::tests::fixture_channel().await;
    let next = channel.select(None).unwrap().unwrap().combination.clone();
    // The real compatibility fixture's starting version is the previous pair.
    let original = component_channel::tests::initial_combination().await;
    let writer = profile.writer().unwrap();
    manager.begin(&original).unwrap();
    manager.finish(&original, Ok(())).unwrap();
    manager.begin(&original).unwrap();
    manager.finish(&original, Ok(())).unwrap();
    assert_eq!(Journal::read(&profile).unwrap().history.len(), 1);

    let update = SelectedUpdate {
        current: original.identity(),
        current_sequence: original.sequence,
        candidate: next.clone(),
    };
    assert!(manager.queue(&update).is_err());
    journal::save_downloaded(&profile, &next).unwrap();
    assert_eq!(manager.choose().await.unwrap(), original);
    manager.queue(&update).unwrap();
    assert!(manager.queue(&update).is_err());
    assert_eq!(manager.choose().await.unwrap(), next);
    let unowned = crate::sidecar::SidecarState::default();
    assert!(manager.prepare_restart(&unowned, 9562).await.is_err());
    let still_queued = Journal::read(&profile).unwrap();
    assert_eq!(still_queued.active.as_ref(), Some(&original));
    assert_eq!(still_queued.queued.as_ref(), Some(&next));
    assert!(still_queued.trial.is_none());
    manager.begin(&next).unwrap();
    assert!(manager
        .finish(&next, Err("test startup failure".into()))
        .is_err());
    drop(writer);

    let migrated = Manager::new(profile.clone()).unwrap();
    let _writer = profile.writer().unwrap();
    assert_eq!(migrated.choose().await.unwrap(), next);
    assert!(check_component_floor(&profile, &original.bamboo.version).is_err());
    migrated.begin(&next).unwrap();
    migrated.finish(&next, Ok(())).unwrap();
    let journal = Journal::read(&profile).unwrap();
    assert!(journal.queued.is_none() && journal.trial.is_none());
    assert_eq!(journal.history.len(), 3);
    assert!(journal.history[1].effective.is_none());
    assert_eq!(
        journal.history[2].effective,
        journal.active.as_ref().map(journal::Versions::from)
    );
    assert!(fs::read_to_string(profile.state_dir.join("state.json"))
        .unwrap()
        .contains(&next.bamboo.version));
}
