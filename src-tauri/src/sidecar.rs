//! Bamboo backend as a managed sidecar process.
//!
//! Instead of linking and running the bamboo HTTP server in-process, the shell
//! spawns the standalone `bamboo serve` binary as a Tauri sidecar and owns its
//! lifecycle. Two guarantees keep the backend from outliving the app:
//!
//! 1. **Owned** — [`SidecarState`] retains the spawned [`SharedChild`] and
//!    can wait for a cooperative exit before the desktop restarts for an update.
//! 2. **Crash-safe** — `bamboo serve --parent-pid <this-pid>` runs an orphan
//!    guard: a dedicated thread that exits the backend when this process goes
//!    away. The primary signal is `getppid()` changing (the kernel reparents
//!    the child to init/launchd the moment its parent terminates), so it fires
//!    even if the app dies *without* cleanup (SIGKILL, force-quit, panic). This
//!    is the half a naive sidecar misses — the reason a backend can outlive a
//!    force-quit.

pub(crate) mod planned_update;

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(unix)]
use shared_child::unix::SharedChildExt;
use shared_child::SharedChild;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::ShellExt;
use tempfile::TempDir;

/// Owns the managed child and distinguishes a kernel switch from app exit.
#[derive(Default)]
pub struct SidecarState {
    child: Mutex<Option<Arc<ManagedChild>>>,
    exiting: AtomicBool,
}

const SHUTDOWN_DIR_ENV: &str = "BAMBOO_MANAGED_SHUTDOWN_DIR";

struct ManagedChild {
    process: Arc<SharedChild>,
    startup: StartupStatus,
    shutdown: Option<TempDir>,
    shutdown_requested: Mutex<bool>,
    update_sequence: tokio::sync::Mutex<u64>,
    committing_update: AtomicBool,
}

impl ManagedChild {
    fn request_shutdown(&self) -> Result<(), String> {
        let mut requested = self
            .shutdown_requested
            .lock()
            .map_err(|error| error.to_string())?;
        if *requested {
            return Ok(());
        }
        if let Some(directory) = &self.shutdown {
            match fs::symlink_metadata(directory.path().join("ready")) {
                Ok(metadata) if metadata.is_file() && metadata.len() == 0 => {
                    File::create_new(directory.path().join("stop")).map_err(|error| {
                        format!("Cannot request managed Bamboo shutdown: {error}")
                    })?;
                    *requested = true;
                    return Ok(());
                }
                Ok(_) => return Err("Invalid managed Bamboo shutdown marker.".into()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.to_string()),
            }
        }
        request_legacy_shutdown(&self.process)?;
        *requested = true;
        Ok(())
    }
}

#[cfg(unix)]
fn request_legacy_shutdown(child: &SharedChild) -> Result<(), String> {
    child
        .send_signal(libc::SIGTERM)
        .map_err(|error| format!("Cannot request managed Bamboo shutdown: {error}"))
}

#[cfg(not(unix))]
fn request_legacy_shutdown(_: &SharedChild) -> Result<(), String> {
    Err("This Bamboo version needs a manual restart. Finish your work, then close and reopen Bodhi to apply the downloaded update.".into())
}

impl SidecarState {
    pub(crate) fn start(
        &self,
        mut command: Command,
        writer: File,
        port: u16,
        shutdown_root: Option<&Path>,
    ) -> Result<StartupStatus, String> {
        let mut recorded = self.child.lock().map_err(|e| e.to_string())?;
        if self.exiting.load(Ordering::SeqCst) {
            return Err("Bodhi is exiting".into());
        }
        if let Some(child) = &*recorded {
            if child
                .process
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_none()
            {
                return Err("The previous managed Bamboo is still running.".into());
            }
        }
        let shutdown = shutdown_root
            .map(|root| {
                tempfile::Builder::new()
                    .prefix("shutdown-")
                    .tempdir_in(root)
            })
            .transpose()
            .map_err(|error| {
                format!("Cannot create the managed Bamboo shutdown directory: {error}")
            })?;
        if let Some(directory) = &shutdown {
            command.env(SHUTDOWN_DIR_ENV, directory.path());
        } else {
            command.env_remove(SHUTDOWN_DIR_ENV);
        }
        let (child, status) =
            spawn_owned(command, writer, port).map_err(|e| format!("spawn bamboo sidecar: {e}"))?;
        log::info!("Managed bamboo pid={} port={port}", child.id());
        *recorded = Some(Arc::new(ManagedChild {
            process: child,
            startup: status.clone(),
            shutdown,
            shutdown_requested: Mutex::new(false),
            update_sequence: tokio::sync::Mutex::new(0),
            committing_update: AtomicBool::new(false),
        }));
        Ok(status)
    }

    fn owned_child(&self) -> Result<Arc<ManagedChild>, String> {
        if self.exiting.load(Ordering::SeqCst) {
            return Err("Bodhi is exiting".into());
        }
        self.child
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .ok_or("Bodhi does not own a Bamboo process.".into())
    }

    /// Stop this exact child through the server's normal cleanup path.
    pub(crate) async fn stop_for_update(&self, timeout: Duration) -> Result<(), String> {
        self.wait_for_update_exit(timeout, true).await
    }

    pub(crate) fn set_committing_update(&self, committing: bool) -> Result<(), String> {
        self.owned_child()?
            .committing_update
            .store(committing, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) fn update_requires_process(&self) -> bool {
        self.owned_child().is_ok_and(|child| {
            child.committing_update.load(Ordering::SeqCst)
                && !child
                    .process
                    .try_wait()
                    .is_ok_and(|status| status.is_some())
        })
    }

    pub(crate) async fn wait_for_update_exit(
        &self,
        timeout: Duration,
        request_shutdown: bool,
    ) -> Result<(), String> {
        let child = self.owned_child()?;
        let exited = match child
            .process
            .try_wait()
            .map_err(|error| error.to_string())?
        {
            Some(exited) => exited,
            None => {
                if request_shutdown {
                    // Closing Bodhi must not kill the child while its normal
                    // shutdown is draining, even if this wait times out.
                    let was_committing = child.committing_update.swap(true, Ordering::SeqCst);
                    if let Err(error) = child.request_shutdown() {
                        child
                            .committing_update
                            .store(was_committing, Ordering::SeqCst);
                        return Err(error);
                    }
                }
                let process = child.process.clone();
                tokio::task::spawn_blocking(move || process.wait_timeout(timeout))
                    .await
                    .map_err(|error| error.to_string())?
                    .map_err(|error| format!("Cannot wait for managed Bamboo shutdown: {error}"))?
                    .ok_or("Bamboo is still shutting down. Retry the update after it exits.")?
            }
        };
        if !exited.success() {
            return Err(format!("Bamboo exited with {exited} during shutdown."));
        }
        child.startup.0.store(2, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) async fn stop(&self) -> Result<(), String> {
        let child = self.owned_child()?;
        let process = child.process.clone();
        process
            .kill()
            .map_err(|e| format!("stop managed Bamboo: {e}"))?;
        let exited =
            tokio::task::spawn_blocking(move || process.wait_timeout(Duration::from_secs(10)))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("reap managed Bamboo: {e}"))?;
        if exited.is_none() {
            return Err("The managed Bamboo process did not exit. Try applying the update again after it stops.".into());
        }
        child.startup.0.store(2, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) fn exit(&self) {
        self.exiting.store(true, Ordering::SeqCst);
        if let Ok(mut recorded) = self.child.lock() {
            if let Some(child) = recorded.take() {
                if !child.process.try_wait().is_ok_and(|exit| exit.is_some()) {
                    log::info!("Killing bamboo sidecar on app exit");
                    let _ = child.process.kill();
                }
            }
        }
    }
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
        .map_err(|_| format!("Port {port} is unavailable. Another local service may be using it."))
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
                return Err("The managed Bamboo process exited before startup completed.".into());
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
    tokio::time::timeout(Duration::from_secs(max_secs), poll)
        .await
        .map_err(|_| {
            format!("The local engine did not become ready on port {port} within {max_secs}s.")
        })?
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

pub(crate) async fn owned_version(port: u16, owner: &StartupStatus) -> Result<String, String> {
    let version = reported_version(port).await?;
    if !owner.is_ready() {
        return Err("The managed Bamboo exited while checking its version.".into());
    }
    Ok(version)
}

/// Prepare the same owned Bamboo command for initial startup and kernel switches.
pub(crate) fn command<R: Runtime>(
    app: &AppHandle<R>,
    port: u16,
    data_dir: &Path,
    static_dir: Option<&Path>,
    kernel: Option<&Path>,
    browser_runtime: Option<[PathBuf; 3]>,
) -> Result<Command, String> {
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

    let browser_paths = match browser_runtime {
        Some(paths) => Some(paths),
        None if cfg!(feature = "thin-shell") => None,
        None => {
            let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
            Some(crate::browser_runtime::resolve(&resources)?)
        }
    };
    if let Some([node, host, browser]) = browser_paths {
        log::info!("Managed browser runtime: {}", host.display());
        command
            .env("BAMBOO_BROWSER_NODE", node)
            .env("BAMBOO_BROWSER_HOST_SCRIPT", host)
            .env("BAMBOO_BROWSER_EXECUTABLE", browser);
    } else {
        command
            .env_remove("BAMBOO_BROWSER_NODE")
            .env_remove("BAMBOO_BROWSER_HOST_SCRIPT")
            .env_remove("BAMBOO_BROWSER_EXECUTABLE");
    }

    Ok(command)
}

fn spawn_owned(
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
        state.exit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_SHUTDOWN_WORK: &str = "BODHI_SHUTDOWN_FIXTURE_WORK";
    const TEST_SHUTDOWN_PORT: &str = "BODHI_SHUTDOWN_FIXTURE_PORT";

    #[test]
    #[ignore = "spawned as an owned native process by the graceful stop test"]
    fn shutdown_fixture_entry() {
        let work = PathBuf::from(std::env::var_os(TEST_SHUTDOWN_WORK).unwrap());
        let control = PathBuf::from(std::env::var_os(SHUTDOWN_DIR_ENV).unwrap());
        let port: u16 = std::env::var(TEST_SHUTDOWN_PORT).unwrap().parse().unwrap();
        let _listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        println!("Unified server running on http://127.0.0.1:{port}");
        File::create_new(control.join("ready")).unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        for path in [control.join("stop"), work.join("finish")] {
            while !path.is_file() {
                assert!(std::time::Instant::now() < deadline, "missing {path:?}");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        File::create_new(work.join("clean-exit")).unwrap();
    }

    #[tokio::test]
    async fn update_shutdown_waits_without_killing_the_child_and_can_retry() {
        let work = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(work.path()).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut fixture = Command::new(std::env::current_exe().unwrap());
        fixture
            .args([
                "--ignored",
                "--exact",
                "sidecar::tests::shutdown_fixture_entry",
                "--nocapture",
            ])
            .env(TEST_SHUTDOWN_WORK, work.path())
            .env(TEST_SHUTDOWN_PORT, port.to_string());

        let runtime = SidecarState::default();
        let status = runtime
            .start(
                fixture,
                profile.writer().unwrap(),
                port,
                Some(&profile.state_dir),
            )
            .unwrap();
        let child = runtime.owned_child().unwrap();
        let control = child.shutdown.as_ref().unwrap().path();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !control.join("ready").is_file() || !status.is_ready() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(profile.writer().is_err());
        assert!(!runtime.update_requires_process());

        std::fs::write(control.join("ready"), b"invalid").unwrap();
        for was_committing in [false, true] {
            runtime.set_committing_update(was_committing).unwrap();
            assert_eq!(
                runtime.stop_for_update(Duration::ZERO).await.unwrap_err(),
                "Invalid managed Bamboo shutdown marker."
            );
            assert_eq!(runtime.update_requires_process(), was_committing);
            assert!(!control.join("stop").exists());
        }
        runtime.set_committing_update(false).unwrap();
        std::fs::write(control.join("ready"), b"").unwrap();

        assert!(runtime
            .stop_for_update(Duration::from_millis(100))
            .await
            .unwrap_err()
            .contains("still shutting down"));
        assert!(control.join("stop").is_file());
        assert!(child.process.try_wait().unwrap().is_none());
        assert!(runtime.update_requires_process());
        assert!(require_available_port(port).is_err());
        assert!(profile.writer().is_err());

        File::create_new(work.path().join("finish")).unwrap();
        runtime
            .stop_for_update(Duration::from_secs(5))
            .await
            .unwrap();
        assert!(work.path().join("clean-exit").is_file());
        assert!(!runtime.update_requires_process());
        assert!(require_available_port(port).is_ok());
        assert!(profile.writer().is_ok());
        runtime.stop_for_update(Duration::ZERO).await.unwrap();
    }

    #[test]
    fn foreign_listener_is_rejected_without_touching_it() {
        let foreign = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = foreign.local_addr().unwrap().port();
        assert!(require_available_port(port)
            .unwrap_err()
            .contains(&format!("Port {port} is unavailable")));
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
