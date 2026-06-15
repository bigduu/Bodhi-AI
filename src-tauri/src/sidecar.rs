//! Bamboo backend as a managed sidecar process.
//!
//! Instead of linking and running the bamboo HTTP server in-process, the shell
//! spawns the standalone `bamboo serve` binary as a Tauri sidecar and owns its
//! lifecycle. Two guarantees keep the backend from outliving the app:
//!
//! 1. **Graceful** — the spawned [`CommandChild`] is held in [`SidecarState`]
//!    and killed on `RunEvent::Exit` / `ExitRequested`.
//! 2. **Crash-safe** — `bamboo serve --parent-pid <this-pid>` runs an orphan
//!    guard: a dedicated thread that exits the backend when this process goes
//!    away. The primary signal is `getppid()` changing (the kernel reparents
//!    the child to init/launchd the moment its parent terminates), so it fires
//!    even if the app dies *without* cleanup (SIGKILL, force-quit, panic). This
//!    is the half a naive sidecar misses — the reason a backend can outlive a
//!    force-quit.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the running sidecar child so the app-exit handler can kill it.
/// `None` until the child is spawned (or if an external backend was reused).
pub struct SidecarState(pub Mutex<Option<CommandChild>>);

/// Probe whether a backend is already serving on `port` (e.g. a dev `bamboo
/// serve` the developer started by hand). If so, we don't spawn our own.
pub async fn backend_already_running(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/api/v1/health");
    let client = reqwest::Client::new();
    matches!(
        client.get(&url).timeout(Duration::from_secs(1)).send().await,
        Ok(resp) if resp.status().is_success()
    )
}

/// Poll the backend health endpoint until it returns success or `max_secs`
/// elapses. Returns whether it became healthy.
pub async fn wait_for_health(port: u16, max_secs: u64) -> bool {
    let url = format!("http://127.0.0.1:{port}/api/v1/health");
    let client = reqwest::Client::new();
    for _ in 0..(max_secs * 2) {
        if let Ok(resp) = client.get(&url).timeout(Duration::from_secs(2)).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

/// Spawn `bamboo serve` as a sidecar and return its child handle.
///
/// IMPORTANT: the returned [`CommandChild`] is the *graceful* handle — keep it
/// in [`SidecarState`] and kill it on app exit. The `--parent-pid` orphan guard
/// (wired below) is the crash-safe backstop for unclean exits where that kill
/// never runs.
pub fn spawn<R: Runtime>(
    app: &AppHandle<R>,
    port: u16,
    data_dir: &std::path::Path,
) -> Result<CommandChild, String> {
    let command = app
        .shell()
        .sidecar("bamboo")
        .map_err(|e| format!("resolve bamboo sidecar: {e}"))?
        .args([
            "serve".to_string(),
            // Crash-safe orphan guard: the backend exits if this shell process
            // disappears (incl. SIGKILL / force-quit, which run no cleanup).
            "--parent-pid".to_string(),
            std::process::id().to_string(),
            "--port".to_string(),
            port.to_string(),
            "--bind".to_string(),
            "127.0.0.1".to_string(),
            // Pin the sidecar to the same data dir the shell resolved, so both
            // read/write the same config.json without the shell linking bamboo.
            "--data-dir".to_string(),
            data_dir.to_string_lossy().into_owned(),
        ]);

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("spawn bamboo sidecar: {e}"))?;

    // Drain the event stream so the child's stdout/stderr pipe never fills and
    // blocks the backend, and surface its logs under our logger.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim_end();
                    if !line.is_empty() {
                        log::info!("[bamboo] {line}");
                    }
                }
                CommandEvent::Error(err) => log::warn!("[bamboo] sidecar error: {err}"),
                CommandEvent::Terminated(payload) => {
                    log::warn!("[bamboo] sidecar terminated: {payload:?}");
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

/// Kill the recorded sidecar, if any. Idempotent; safe to call on app exit.
pub fn kill<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                log::info!("Killing bamboo sidecar on app exit");
                let _ = child.kill();
            }
        }
    }
}
