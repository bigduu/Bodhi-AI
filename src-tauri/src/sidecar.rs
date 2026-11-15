//! Bamboo backend as a managed sidecar process.
//!
//! Instead of linking and running the bamboo HTTP server in-process, the shell
//! spawns the standalone `bamboo serve` binary as a Tauri sidecar and owns its
//! lifecycle. Two guarantees keep the backend from outliving the app:
//!
//! 1. **Graceful** — the spawned [`SharedChild`] is held in [`SidecarState`]
//!    and killed on `RunEvent::Exit` / `ExitRequested`.
//! 2. **Crash-safe** — `bamboo serve --parent-pid <this-pid>` runs an orphan
//!    guard: a dedicated thread that exits the backend when this process goes
//!    away. The primary signal is `getppid()` changing (the kernel reparents
//!    the child to init/launchd the moment its parent terminates), so it fires
//!    even if the app dies *without* cleanup (SIGKILL, force-quit, panic). This
//!    is the half a naive sidecar misses — the reason a backend can outlive a
//!    force-quit.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use shared_child::SharedChild;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::ShellExt;

/// Holds the running sidecar child so the app-exit handler can kill it.
/// `None` until the child is spawned (or if an external backend was reused).
#[derive(Default)]
pub struct SidecarState {
    child: Mutex<Option<Arc<SharedChild>>>,
    exiting: AtomicBool,
}

/// 0 = starting, 1 = this child bound its HTTP listener, 2 = exited/error.
#[derive(Clone, Default)]
pub struct StartupStatus(Arc<AtomicU8>);

impl StartupStatus {
    pub(crate) fn is_ready(&self) -> bool {
        self.0.load(Ordering::SeqCst) == 1
    }

    #[cfg(test)]
    pub(crate) fn ready_for_test() -> Self {
        Self(Arc::new(AtomicU8::new(1)))
    }
}

pub fn require_available_port(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("BODHI_BACKEND_PORT must be between 1 and 65535".into());
    }
    std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .map(drop)
        .map_err(|_| format!("Port {port} is unavailable. Another local service may be using it. Launch Bodhi with a different BODHI_BACKEND_PORT; the existing service was left untouched."))
}

fn local_log_filter(existing: &str) -> String {
    let baseline = if existing.trim().is_empty() {
        "info"
    } else {
        existing
    };
    format!("{baseline},bamboo_server::server::entrypoints=info")
}

// Bamboo emits this line only after build_bind_listeners succeeds. Requiring
// this owned pipe signal closes the preflight-bind/spawn race: another process's
// HTTP health can never establish readiness for our child. Keep the exact
// producer message covered by the local desktop acceptance when upgrading it.
fn consume_output(buffer: &mut Vec<u8>, bytes: &[u8], port: u16, status: &StartupStatus) {
    buffer.extend_from_slice(bytes);
    while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
        let line = buffer.drain(..=end).collect::<Vec<_>>();
        let line = String::from_utf8_lossy(&line);
        if line
            .split_once(&format!(
                "Unified server running on http://127.0.0.1:{port}"
            ))
            .is_some_and(|(_, tail)| tail.trim().trim_end_matches("\x1b[0m").is_empty())
        {
            let _ = status
                .0
                .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst);
        }
        log::info!("[bamboo] {}", line.trim_end());
    }
    // A malformed, unbounded log line must not consume unbounded shell memory.
    if buffer.len() > 16 * 1024 {
        buffer.clear();
    }
}

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
/// elapses. Local builds additionally require this child's bound signal and the
/// exact verified production index; health from another listener is insufficient.
pub async fn wait_for_health(
    port: u16,
    max_secs: u64,
    owned: Option<&StartupStatus>,
    index_hash: Option<&str>,
) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/api/v1/health");
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let poll = async {
        loop {
            let state = owned
                .map(|status| status.0.load(Ordering::SeqCst))
                .unwrap_or(1);
            if state == 2 {
                return Err("The managed Bamboo process exited before startup completed. Check the engine logs and restart Bodhi.".into());
            }
            if state == 1 {
                if let Ok(resp) = client.get(&url).send().await {
                    if resp.status().is_success() {
                        if let Some(expected) = index_hash {
                            let response = client
                                .get(format!("http://127.0.0.1:{port}/index.html"))
                                .send()
                                .await
                                .map_err(|e| e.to_string())?;
                            if !response.status().is_success()
                                || crate::frontend::hash_bytes(
                                    &response.bytes().await.map_err(|e| e.to_string())?,
                                ) != expected
                            {
                                return Err("The managed backend did not serve this app's verified Lotus Next index. Startup stopped.".into());
                            }
                        }
                        if owned.is_some_and(|status| status.0.load(Ordering::SeqCst) != 1) {
                            continue;
                        }
                        return Ok(());
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(max_secs), poll).await
        .map_err(|_| format!("The local engine did not become ready on port {port} within {max_secs}s. Check its logs and restart Bodhi."))?
}

pub(crate) async fn reported_version(port: u16) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct Ready {
        status: String,
        version: String,
    }

    let ready = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("http://127.0.0.1:{port}/readyz"))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| e.to_string())?
        .json::<Ready>()
        .await
        .map_err(|e| e.to_string())?;
    if ready.status != "ok" {
        return Err("Bamboo did not report a ready runtime.".into());
    }
    Ok(ready.version)
}

/// Spawn `bamboo serve`, record its child handle, and return its startup state.
///
/// IMPORTANT: [`SharedChild`] is held in [`SidecarState`] for app-exit cleanup.
/// The `--parent-pid` orphan guard
/// (wired below) is the crash-safe backstop for unclean exits where that kill
/// never runs.
pub fn spawn<R: Runtime>(
    app: &AppHandle<R>,
    port: u16,
    data_dir: &Path,
    static_dir: Option<&Path>,
    kernel: Option<&Path>,
    writer: File,
) -> Result<StartupStatus, String> {
    let state = app
        .try_state::<SidecarState>()
        .ok_or("missing sidecar state")?;
    let mut recorded = state.child.lock().map_err(|e| e.to_string())?;
    if state.exiting.load(Ordering::SeqCst) {
        return Err("Bodhi is exiting".into());
    }
    let command = match kernel {
        Some(path) => app.shell().command(path),
        None => app
            .shell()
            .sidecar("bamboo")
            .map_err(|e| format!("resolve bamboo sidecar: {e}"))?,
    };
    let mut command: Command = command.into();
    command
        .args([
            "serve",
            "--parent-pid",
            &std::process::id().to_string(),
            "--port",
            &port.to_string(),
            "--bind",
            "127.0.0.1",
            "--data-dir",
        ])
        .arg(data_dir);
    if let Some(dir) = static_dir {
        command.arg("--static-dir").arg(dir);
    }
    if static_dir.is_some() {
        command.env(
            "RUST_LOG",
            local_log_filter(&std::env::var("RUST_LOG").unwrap_or_default()),
        );
    }

    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let [node, host, browser] = crate::browser_runtime::resolve(&resources)?;
    log::info!("Managed browser runtime: {}", host.display());
    command
        .env("BAMBOO_BROWSER_NODE", node)
        .env("BAMBOO_BROWSER_HOST_SCRIPT", host)
        .env("BAMBOO_BROWSER_EXECUTABLE", browser);

    let (child, status) =
        spawn_owned(command, writer, port).map_err(|e| format!("spawn bamboo sidecar: {e}"))?;
    log::info!("Managed bamboo pid={} port={port}", child.id());
    *recorded = Some(child);
    Ok(status)
}

pub(crate) fn spawn_owned(
    mut command: Command,
    writer: File,
    port: u16,
) -> io::Result<(Arc<SharedChild>, StartupStatus)> {
    // Bamboo serve holds the profile lease via stdin until its process exits,
    // including if the shell is force-quit while the child is still alive.
    command
        .stdin(Stdio::from(writer))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = Arc::new(SharedChild::spawn(&mut command)?);
    let status = StartupStatus::default();
    drain(
        child.take_stdout().expect("piped Bamboo stdout"),
        port,
        status.clone(),
    );
    drain(
        child.take_stderr().expect("piped Bamboo stderr"),
        port,
        status.clone(),
    );
    let (process, exited) = (child.clone(), status.clone());
    std::thread::spawn(move || {
        let result = process.wait();
        exited.0.store(2, Ordering::SeqCst);
        log::info!("[bamboo] managed process exited: {result:?}");
    });
    Ok((child, status))
}

fn drain(mut pipe: impl Read + Send + 'static, port: u16, status: StartupStatus) {
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let mut bytes = [0; 4096];
        loop {
            match pipe.read(&mut bytes) {
                Ok(0) => break,
                Ok(length) => consume_output(&mut buffer, &bytes[..length], port, &status),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    log::warn!("[bamboo] cannot read process output: {error}");
                    break;
                }
            }
        }
    });
}

/// Kill the recorded sidecar, if any. Idempotent; safe to call on app exit.
pub fn kill<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<SidecarState>() {
        state.exiting.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = state.child.lock() {
            if let Some(child) = guard.take() {
                log::info!("Killing bamboo sidecar on app exit");
                let _ = child.kill();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreign_listener_is_rejected_without_touching_it() {
        let foreign = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = foreign.local_addr().unwrap().port();
        assert!(require_available_port(port)
            .unwrap_err()
            .contains("BODHI_BACKEND_PORT"));
        assert!(std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).is_ok());
        drop(foreign);
        assert!(require_available_port(port).is_ok());
    }

    #[test]
    fn only_complete_owned_bound_message_establishes_readiness() {
        let status = StartupStatus::default();
        let mut output = Vec::new();
        consume_output(
            &mut output,
            b"Starting unified server on 127.0.0.1:9562...\n",
            9562,
            &status,
        );
        consume_output(
            &mut output,
            b"Unified server running on http://127.0.0.1:9999\n",
            9562,
            &status,
        );
        consume_output(
            &mut output,
            b"Unified server running on http://127.0.0.1:95620\n",
            9562,
            &status,
        );
        assert_eq!(status.0.load(Ordering::SeqCst), 0);
        consume_output(
            &mut output,
            b"INFO Unified server running on http://127.",
            9562,
            &status,
        );
        consume_output(&mut output, b"0.0.1:9562", 9562, &status);
        assert_eq!(status.0.load(Ordering::SeqCst), 0);
        consume_output(&mut output, b"\n", 9562, &status);
        assert_eq!(status.0.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn termination_before_or_after_bound_signal_never_passes_health() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        for ready_first in [false, true] {
            let status = StartupStatus::default();
            if ready_first {
                status.0.store(1, Ordering::SeqCst);
            }
            status.0.store(2, Ordering::SeqCst);
            consume_output(
                &mut Vec::new(),
                b"Unified server running on http://127.0.0.1:9562\n",
                9562,
                &status,
            );
            assert!(wait_for_health(port, 1, Some(&status), None)
                .await
                .unwrap_err()
                .contains("exited"));
        }
    }

    #[tokio::test]
    async fn unowned_http_health_is_never_probed_before_the_child_binds() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let status = StartupStatus::default();
        assert!(wait_for_health(port, 1, Some(&status), None).await.is_err());
        listener.set_nonblocking(true).unwrap();
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn local_logging_preserves_preferences_and_enables_the_owned_bind_signal() {
        assert_eq!(
            local_log_filter("warn"),
            "warn,bamboo_server::server::entrypoints=info"
        );
        assert_eq!(
            local_log_filter(""),
            "info,bamboo_server::server::entrypoints=info"
        );
    }
}
