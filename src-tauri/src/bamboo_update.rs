//! Manually staged, release-pinned updates for the managed Bamboo sidecar.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_fs::FsExt;
use tauri_plugin_shell::ShellExt;

use crate::bamboo_profile::{create_directory, persist, Profile};
use crate::sidecar::StartupStatus;

pub const MENU_ID: &str = "install-bamboo-update";
pub const MENU_LABEL: &str = "安装 Bamboo 内核更新…";
const TITLE: &str = "Bamboo 内核更新";
const RELEASES: &str = "https://github.com/bigduu/Bamboo-agent/releases/download";
const BUNDLED_LOCK: &str = include_str!("../../scripts/bamboo-sidecar-lock.json");
const MAX_JSON: u64 = 1024 * 1024;
const MAX_BINARY: u64 = 1024 * 1024 * 1024;
const TARGET: &str = env!("BODHI_BUILD_TARGET");
const MIN_BINARY: u64 = 65536;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Upgrade {
    schema_version: u32,
    bodhi_version: String,
    lotus_manifest_sha256: String,
    from_bamboo_version: String,
    bamboo_version: String,
    source_revision: String,
    manifest_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    version: String,
    source_revision: String,
    artifacts: Vec<Artifact>,
    browser_host: BrowserHost,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    target: String,
    asset_name: String,
    build_mode: String,
    embedded_frontend: bool,
    format: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Deserialize)]
struct BrowserHost {
    files: Vec<HostFile>,
}

#[derive(Deserialize)]
struct HostFile {
    path: String,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
struct Selection {
    upgrade: Upgrade,
    artifact: Artifact,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProfileState {
    selection: Option<Selection>,
    started_version: Option<String>,
}

impl ProfileState {
    fn read(profile: &Profile) -> Result<Self, String> {
        let bytes = match read_json(&profile.state_dir.join("state.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error.to_string()),
        };
        let state: Self = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if let Some(selection) = &state.selection {
            upgrade_version(&selection.upgrade)?;
        }
        if state
            .started_version
            .as_deref()
            .is_some_and(|started| version(started).is_none())
        {
            return Err("The Bamboo profile contains an invalid minimum kernel version.".into());
        }
        Ok(state)
    }

    fn save(&self, profile: &Profile) -> Result<(), String> {
        let mut file = tempfile::NamedTempFile::new_in(&profile.state_dir)
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut file, self).map_err(|error| error.to_string())?;
        file.as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        persist(file.into_temp_path(), &profile.state_dir.join("state.json"))
            .map_err(|error| error.to_string())
    }

    fn require_kernel(&self, candidate: &str) -> Result<(), String> {
        if let Some(started) = &self.started_version {
            if version(candidate) < version(started) {
                return Err(format!("This profile has already started Bamboo {started}. Open it with that version or a compatible newer kernel."));
            }
        }
        Ok(())
    }
}

pub(crate) fn check_unmanaged_profile(profile: &Profile) -> Result<(), String> {
    let _lock = profile.update_lock()?;
    let state = ProfileState::read(profile)?;
    if state.started_version.is_some() || state.selection.is_some() {
        return Err("This Bamboo profile has independent kernel updates. Open it from a compatible packaged Bodhi build.".into());
    }
    Ok(())
}

#[derive(Debug)]
pub struct Kernel {
    pub executable: PathBuf,
    pub version: String,
}

pub struct Updates {
    profile: Profile,
    root: PathBuf,
    bodhi_version: String,
    lotus_manifest_sha256: String,
    bundled_version: String,
    bundled_binary: PathBuf,
    running_version: OnceLock<(String, StartupStatus)>,
}

fn version(value: &str) -> Option<[u32; 3]> {
    let mut parts = value.split('.');
    let mut numbers = [0; 3];
    for number in &mut numbers {
        let part = parts.next()?;
        *number = part.parse().ok()?;
        if part != number.to_string() {
            return None;
        }
    }
    (parts.next().is_none() && numbers[0] > 0).then_some(numbers)
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn upgrade_version(upgrade: &Upgrade) -> Result<[u32; 3], String> {
    let from = version(&upgrade.from_bamboo_version);
    let to = version(&upgrade.bamboo_version);
    match (from, to) {
        (Some(from), Some(to)) if to > from => Ok(to),
        _ => Err("The update must name two stable Bamboo versions in ascending order.".into()),
    }
}

fn binary_asset() -> String {
    format!("bamboo-{TARGET}{}", std::env::consts::EXE_SUFFIX)
}

fn check_artifact(artifact: &Artifact) -> Result<(), String> {
    if artifact.target != TARGET
        || artifact.asset_name != binary_asset()
        || artifact.build_mode != "embedded"
        || !artifact.embedded_frontend
        || artifact.format != "raw"
        || !hex(&artifact.sha256, 64)
        || !(MIN_BINARY..=MAX_BINARY).contains(&artifact.size_bytes)
    {
        return Err("The Bamboo release has no matching raw executable for this target.".into());
    }
    Ok(())
}

fn verify_manifest(
    bytes: &[u8],
    upgrade: &Upgrade,
    host_hashes: [&str; 2],
) -> Result<Artifact, String> {
    if crate::frontend::hash_bytes(bytes) != upgrade.manifest_sha256 {
        return Err("The Bamboo manifest failed its SHA-256 check.".into());
    }
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if manifest.schema_version != 2
        || manifest.version != upgrade.bamboo_version
        || manifest.source_revision != upgrade.source_revision
    {
        return Err("The release manifest does not match the approved Bamboo update.".into());
    }
    for (path, expected) in [
        "browser-runtime/host.cjs",
        "browser-runtime/package-lock.json",
    ]
    .into_iter()
    .zip(host_hashes)
    {
        let mut files = manifest
            .browser_host
            .files
            .iter()
            .filter(|file| file.path == path);
        if files.next().is_none_or(|file| file.sha256 != expected) || files.next().is_some() {
            return Err(
                "This kernel requires a different browser host. Update Bodhi first.".into(),
            );
        }
    }
    let mut artifacts = manifest
        .artifacts
        .into_iter()
        .filter(|asset| asset.target == TARGET);
    let artifact = artifacts
        .next()
        .ok_or("The Bamboo release does not support this platform.")?;
    if artifacts.next().is_some() {
        return Err("The Bamboo release has duplicate artifacts for this platform.".into());
    }
    check_artifact(&artifact)?;
    Ok(artifact)
}

fn regular_file(path: &Path) -> io::Result<File> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected a regular file",
        ));
    }
    File::open(path)
}

fn read_json(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    regular_file(path)?
        .take(MAX_JSON + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_JSON {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "oversized update receipt",
        ));
    }
    Ok(bytes)
}

fn directory(path: &Path) -> io::Result<()> {
    if !fs::symlink_metadata(path)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected an owned directory",
        ));
    }
    Ok(())
}

fn matches_binary(path: &Path, artifact: &Artifact) -> io::Result<bool> {
    let file = regular_file(path)?;
    if file.metadata()?.len() != artifact.size_bytes {
        return Ok(false);
    }
    let mut hash = Sha256::new();
    let bytes = io::copy(&mut file.take(artifact.size_bytes + 1), &mut hash)?;
    Ok(bytes == artifact.size_bytes && format!("{:x}", hash.finalize()) == artifact.sha256)
}

impl Updates {
    pub fn for_app<R: Runtime>(
        app: &AppHandle<R>,
        profile: Profile,
        lotus_manifest_sha256: String,
    ) -> Result<Self, String> {
        let bundled_lock: serde_json::Value =
            serde_json::from_str(BUNDLED_LOCK).map_err(|e| e.to_string())?;
        let bundled_version = bundled_lock["version"]
            .as_str()
            .ok_or("Missing bundled Bamboo version.")?;
        let local_data = dirs::data_local_dir()
            .filter(|path| path.is_absolute())
            .ok_or("Cannot locate the local Bamboo update directory.")?;
        // The managed executables and selection are outside the WebView's app
        // data directory and are explicitly forbidden even after a file dialog.
        let store = local_data.join(format!("{}-kernels", app.config().identifier));
        app.fs_scope()
            .forbid_directory(&store, true)
            .map_err(|e| e.to_string())?;
        let key = crate::frontend::hash_bytes(profile.data.as_os_str().as_encoded_bytes());
        let bundled: std::process::Command = app
            .shell()
            .sidecar("bamboo")
            .map_err(|error| error.to_string())?
            .into();
        Ok(Self {
            profile,
            root: store.join(key),
            bodhi_version: app.package_info().version.to_string(),
            lotus_manifest_sha256,
            bundled_version: bundled_version.into(),
            bundled_binary: PathBuf::from(bundled.get_program()),
            running_version: OnceLock::new(),
        })
    }

    pub fn mark_ready(&self, version: String, process: StartupStatus) {
        let _ = self.running_version.set((version, process));
    }

    fn selection<'a>(&self, state: &'a ProfileState) -> Option<&'a Selection> {
        state.selection.as_ref().filter(|selection| {
            version(&selection.upgrade.bamboo_version) > version(&self.bundled_version)
        })
    }

    fn check_pair(&self, upgrade: &Upgrade) -> Result<(), String> {
        if upgrade.schema_version != 1
            || !hex(&upgrade.manifest_sha256, 64)
            || !hex(&upgrade.source_revision, 40)
            || upgrade.bodhi_version != self.bodhi_version
            || upgrade.lotus_manifest_sha256 != self.lotus_manifest_sha256
        {
            return Err(
                "The Bamboo update receipt does not match this Bodhi and Lotus version.".into(),
            );
        }
        Ok(())
    }

    fn check_transition(&self, upgrade: &Upgrade) -> Result<(), String> {
        let state = ProfileState::read(&self.profile)?;
        self.check_transition_from(&state, upgrade)
    }

    fn check_transition_from(&self, state: &ProfileState, upgrade: &Upgrade) -> Result<(), String> {
        self.check_pair(upgrade)?;
        upgrade_version(upgrade)?;
        state.require_kernel(&upgrade.bamboo_version)?;
        let selected = self.selection(state);
        if selected.is_some_and(|selection| {
            let installed = &selection.upgrade;
            installed.from_bamboo_version == upgrade.from_bamboo_version
                && installed.bamboo_version == upgrade.bamboo_version
                && installed.source_revision == upgrade.source_revision
                && installed.manifest_sha256 == upgrade.manifest_sha256
        }) {
            // A renewed approval can preserve the exact installed kernel when
            // the Bodhi assembly changes. The same rule permits repair.
            return Ok(());
        }
        let current = selected.map_or(self.bundled_version.as_str(), |selection| {
            selection.upgrade.bamboo_version.as_str()
        });
        if current != upgrade.from_bamboo_version {
            return Err(format!(
                "This update requires Bamboo {}, but {} is selected for startup.",
                upgrade.from_bamboo_version, current
            ));
        }
        if !self
            .running_version
            .get()
            .is_some_and(|(version, process)| {
                version == &upgrade.from_bamboo_version && process.is_ready()
            })
        {
            return Err(
                "Start Bodhi with the required Bamboo version before installing this update."
                    .into(),
            );
        }
        Ok(())
    }

    fn artifact_path(&self, upgrade: &Upgrade, artifact: &Artifact) -> PathBuf {
        self.root.join(format!(
            "bamboo-{}-{}{}",
            upgrade.bamboo_version,
            artifact.sha256,
            std::env::consts::EXE_SUFFIX
        ))
    }

    fn selected_kernel(&self, state: &ProfileState) -> Result<Option<Kernel>, String> {
        let Some(selection) = self.selection(state) else {
            return Ok(None);
        };
        self.check_pair(&selection.upgrade)?;
        check_artifact(&selection.artifact)?;
        directory(self.root.parent().expect("kernel store parent")).map_err(|e| e.to_string())?;
        directory(&self.root).map_err(|e| e.to_string())?;
        let executable = self.artifact_path(&selection.upgrade, &selection.artifact);
        if !matches!(matches_binary(&executable, &selection.artifact), Ok(true)) {
            return Err(format!("Selected Bamboo {} is missing or damaged. Repair the selected kernel before opening this data directory.", selection.upgrade.bamboo_version));
        }
        Ok(Some(Kernel {
            executable,
            version: selection.upgrade.bamboo_version.clone(),
        }))
    }

    pub async fn prepare_launch(&self) -> Result<Option<Kernel>, String> {
        let _lock = self.profile.update_lock()?;
        let mut state = ProfileState::read(&self.profile)?;
        let selected = self.selected_kernel(&state)?;
        let chosen = selected
            .as_ref()
            .map_or(self.bundled_version.as_str(), |kernel| {
                kernel.version.as_str()
            });
        state.require_kernel(chosen)?;
        if state.selection.is_some() || state.started_version.is_some() {
            if selected.is_none() {
                check_executable_version(&self.bundled_binary, chosen).await?;
            }
            if state.started_version.as_deref() != Some(chosen) {
                // Commit before the process can open or migrate the profile.
                state.started_version = Some(chosen.into());
                state.save(&self.profile)?;
            }
        }
        Ok(selected)
    }

    async fn stage(&self, upgrade: Upgrade) -> Result<(), String> {
        let _lock = self.profile.update_lock()?;
        let mut state = ProfileState::read(&self.profile)?;
        self.check_transition_from(&state, &upgrade)?;
        let store = self.root.parent().expect("kernel store parent");
        fs::create_dir_all(store.parent().expect("local data directory"))
            .map_err(|e| e.to_string())?;
        create_directory(store).map_err(|e| e.to_string())?;
        create_directory(&self.root).map_err(|e| e.to_string())?;

        let client = release_client()?;
        let base = format!("{RELEASES}/v{}", upgrade.bamboo_version);
        let mut manifest = Vec::new();
        download(
            &client,
            &format!("{base}/bamboo-sidecars-v2.json"),
            MAX_JSON,
            &mut manifest,
        )
        .await?;
        let host = crate::browser_runtime::host_hashes()?;
        let artifact = verify_manifest(&manifest, &upgrade, [&host[0], &host[1]])?;
        let destination = self.artifact_path(&upgrade, &artifact);
        if !matches!(matches_binary(&destination, &artifact), Ok(true)) {
            install_binary(
                &client,
                &base,
                &destination,
                &artifact,
                &upgrade.bamboo_version,
            )
            .await?;
        }

        state.selection = Some(Selection { upgrade, artifact });
        state.save(&self.profile)
    }
}

fn release_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 5
                && matches!(
                    attempt.url().host_str(),
                    Some(
                        "github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                )
            {
                attempt.follow()
            } else {
                attempt.error("unexpected Bamboo release redirect")
            }
        }))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())
}

async fn install_binary(
    client: &reqwest::Client,
    base: &str,
    destination: &Path,
    artifact: &Artifact,
    version: &str,
) -> Result<(), String> {
    let root = destination.parent().expect("kernel directory");
    let mut file = tempfile::Builder::new()
        .suffix(std::env::consts::EXE_SUFFIX)
        .tempfile_in(root)
        .map_err(|e| e.to_string())?;
    let (length, hash) = download(
        client,
        &format!("{base}/{}", artifact.asset_name),
        artifact.size_bytes,
        &mut file,
    )
    .await?;
    if length != artifact.size_bytes || hash != artifact.sha256 {
        return Err("The downloaded Bamboo executable failed its size or SHA-256 check.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    // Close the writable handle before executing (Linux rejects an open
    // writable executable). The temp path is removed on unsuccessful probes.
    let file = file.into_temp_path();
    check_executable_version(&file, version).await?;
    persist(file, destination).map_err(|e| e.to_string())
}

async fn check_executable_version(path: &Path, expected: &str) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("--version").stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .map_err(|_| "The Bamboo version check timed out.")?
        .map_err(|e| format!("Cannot execute the Bamboo update: {e}"))?;
    if !output.status.success()
        || String::from_utf8_lossy(&output.stdout).trim() != format!("bamboo {expected}")
    {
        return Err("The downloaded Bamboo executable reports an unexpected version.".into());
    }
    Ok(())
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    limit: u64,
    output: &mut (impl Write + Send),
) -> Result<(u64, String), String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| {
            format!(
                "Cannot download the published Bamboo release: {}",
                e.without_url()
            )
        })?;
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err("The Bamboo download exceeds its expected size.".into());
    }
    let mut length = 0;
    let mut hash = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| e.without_url().to_string())?
    {
        length += chunk.len() as u64;
        if length > limit {
            return Err("The Bamboo download exceeds its expected size.".into());
        }
        output.write_all(&chunk).map_err(|e| e.to_string())?;
        hash.update(chunk);
    }
    Ok((length, format!("{:x}", hash.finalize())))
}

pub fn run_from_menu<R: Runtime>(app: &AppHandle<R>) {
    if app.try_state::<Updates>().is_none() {
        report(app, Err("此 Bodhi 构建没有独立内核更新入口。".into()));
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("选择维护方提供的 Bamboo 兼容性凭据")
        .add_filter("Bamboo 更新凭据", &["json"])
        .pick_file(move |file| {
            let Some(file) = file else {
                return;
            };
            let upgrade = (|| {
                let path = file.into_path().map_err(|e| e.to_string())?;
                let bytes = read_json(&path).map_err(|e| e.to_string())?;
                let upgrade = serde_json::from_slice(&bytes).map_err(|error| {
                    format!(
                        "更新凭据格式有误（第 {} 行，第 {} 列）。",
                        error.line(),
                        error.column()
                    )
                })?;
                handle.state::<Updates>().check_transition(&upgrade)?;
                Ok::<_, String>(upgrade)
            })();
            match upgrade {
                Ok(upgrade) => confirm(&handle, upgrade),
                Err(e) => report(&handle, Err(e)),
            }
        });
}

fn confirm<R: Runtime>(app: &AppHandle<R>, upgrade: Upgrade) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "从 Bamboo 官方发布下载 {}？\n\nBodhi 会根据你选择的维护方凭据校验发布文件。下载完成后，退出并重新打开 Bodhi 即可使用新内核。",
            upgrade.bamboo_version
        ))
        .title(TITLE)
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "下载更新".into(),
            "取消".into(),
        ))
        .show(move |accepted| {
            if accepted {
                tauri::async_runtime::spawn(async move {
                    let updates = handle.state::<Updates>();
                    log::info!("Staging Bamboo kernel {}", upgrade.bamboo_version);
                    let result = updates.stage(upgrade).await;
                    report(&handle, result);
                });
            }
        });
}

fn report<R: Runtime>(app: &AppHandle<R>, result: Result<(), String>) {
    let (message, kind) = match result {
        Ok(()) => (
            "Bamboo 内核已下载并校验。退出并重新打开 Bodhi 后生效。".into(),
            MessageDialogKind::Info,
        ),
        Err(error) => {
            log::warn!("Bamboo kernel update failed");
            (error, MessageDialogKind::Error)
        }
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    app.dialog()
        .message(message)
        .title(TITLE)
        .parent(&window)
        .kind(kind)
        .show(|_| {});
}

#[cfg(test)]
#[path = "bamboo_update_native.rs"]
mod native;

#[cfg(test)]
mod tests {
    use super::*;

    fn updates(root: &Path) -> Updates {
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        let profile = Profile::open(&data).unwrap();
        let root = root.join("kernels/profile");
        fs::create_dir_all(&root).unwrap();
        Updates {
            profile,
            root,
            bodhi_version: "2026.11.16".into(),
            lotus_manifest_sha256: "a".repeat(64),
            bundled_version: "2026.11.18".into(),
            bundled_binary: PathBuf::new(),
            running_version: OnceLock::new(),
        }
    }

    fn receipt(from: &str, to: &str) -> Upgrade {
        Upgrade {
            schema_version: 1,
            bodhi_version: "2026.11.16".into(),
            lotus_manifest_sha256: "a".repeat(64),
            from_bamboo_version: from.into(),
            bamboo_version: to.into(),
            source_revision: "b".repeat(40),
            manifest_sha256: "c".repeat(64),
        }
    }

    fn artifact(binary: &[u8]) -> Artifact {
        Artifact {
            target: TARGET.into(),
            asset_name: binary_asset(),
            build_mode: "embedded".into(),
            embedded_frontend: true,
            format: "raw".into(),
            sha256: crate::frontend::hash_bytes(binary),
            size_bytes: binary.len() as u64,
        }
    }

    fn write_selection(updates: &Updates, upgrade: Upgrade, binary: &[u8]) -> PathBuf {
        let artifact = artifact(binary);
        let path = updates.artifact_path(&upgrade, &artifact);
        fs::write(&path, binary).unwrap();
        let mut state = ProfileState::read(&updates.profile).unwrap();
        state.selection = Some(Selection { upgrade, artifact });
        state.save(&updates.profile).unwrap();
        path
    }

    fn selected(updates: &Updates) -> Result<Option<Kernel>, String> {
        updates.selected_kernel(&ProfileState::read(&updates.profile).unwrap())
    }

    #[test]
    fn requires_the_matching_shell_frontend_and_running_kernel() {
        let temp = tempfile::tempdir().unwrap();
        let updates = updates(temp.path());
        let mut upgrade = receipt("2026.11.18", "2026.11.19");
        assert!(updates.check_transition(&upgrade).is_err());
        updates.mark_ready("2026.11.18".into(), StartupStatus::ready_for_test());
        assert!(updates.check_transition(&upgrade).is_ok());
        upgrade.lotus_manifest_sha256 = "d".repeat(64);
        assert!(updates.check_transition(&upgrade).is_err());
        assert!(upgrade_version(&receipt("2026.11.18", "2026.11.9")).is_err());
        assert!(upgrade_version(&receipt("2026.11.18", "2026.11.20-alpha.1")).is_err());
    }

    #[test]
    fn a_staged_upgrade_cannot_be_skipped_by_a_second_install() {
        let temp = tempfile::tempdir().unwrap();
        let baseline = updates(temp.path());
        baseline.mark_ready("2026.11.18".into(), StartupStatus::ready_for_test());
        assert!(selected(&baseline).unwrap().is_none());
        let binary = vec![0; MIN_BINARY as usize];
        write_selection(&baseline, receipt("2026.11.18", "2026.11.19"), &binary);
        let next = receipt("2026.11.19", "2026.11.20");
        assert!(baseline.check_transition(&next).is_err());

        let restarted = updates(temp.path());
        let selected = selected(&restarted).unwrap().unwrap();
        assert_eq!(selected.version, "2026.11.19");
        restarted.mark_ready(selected.version, StartupStatus::ready_for_test());
        assert!(restarted.check_transition(&next).is_ok());
    }

    #[test]
    fn damaged_selected_kernel_is_repairable_without_silently_booting_an_older_one() {
        let temp = tempfile::tempdir().unwrap();
        let mut updates = updates(temp.path());
        let binary = vec![0; MIN_BINARY as usize];
        let path = write_selection(&updates, receipt("2026.11.18", "2026.11.19"), &binary);
        fs::write(&path, vec![1; binary.len()]).unwrap();
        assert!(selected(&updates).is_err());
        assert!(updates
            .check_transition(&receipt("2026.11.18", "2026.11.19"))
            .is_ok());
        updates.bundled_version = "2026.11.20".into();
        assert!(selected(&updates).unwrap().is_none());
    }

    #[test]
    fn an_existing_kernel_requires_renewed_approval_for_a_different_shell() {
        let temp = tempfile::tempdir().unwrap();
        let mut updates = updates(temp.path());
        let binary = vec![0; MIN_BINARY as usize];
        write_selection(&updates, receipt("2026.11.18", "2026.11.19"), &binary);
        updates.bodhi_version = "2026.11.17".into();
        assert!(selected(&updates).is_err());
        let mut renewed = receipt("2026.11.18", "2026.11.19");
        renewed.bodhi_version = updates.bodhi_version.clone();
        assert!(updates.check_transition(&renewed).is_ok());
        renewed.manifest_sha256 = "d".repeat(64);
        assert!(updates.check_transition(&renewed).is_err());
    }

    #[tokio::test]
    async fn the_version_floor_moves_with_the_profile_and_blocks_older_launches() {
        let temp = tempfile::tempdir().unwrap();
        let mut updates = updates(temp.path());
        let binary = vec![0; MIN_BINARY as usize];
        write_selection(&updates, receipt("2026.11.18", "2026.11.19"), &binary);
        let kernel = updates.prepare_launch().await.unwrap().unwrap();
        assert_eq!(kernel.version, "2026.11.19");

        let moved = temp.path().join("moved");
        fs::rename(&updates.profile.data, &moved).unwrap();
        updates.profile = Profile::open(&moved).unwrap();
        let mut state = ProfileState::read(&updates.profile).unwrap();
        assert_eq!(state.started_version.as_deref(), Some("2026.11.19"));
        state.started_version = Some("2026.11.20".into());
        state.save(&updates.profile).unwrap();
        assert!(updates
            .prepare_launch()
            .await
            .unwrap_err()
            .contains("2026.11.20"));
        assert!(updates
            .check_transition(&receipt("2026.11.18", "2026.11.19"))
            .is_err());
        assert!(check_unmanaged_profile(&updates.profile).is_err());
    }

    #[test]
    fn only_the_pinned_manifest_target_and_browser_host_are_admitted() {
        let mut upgrade = receipt("2026.11.18", "2026.11.19");
        let binary = vec![0; MIN_BINARY as usize];
        let mut manifest = serde_json::json!({
            "schemaVersion": 2,
            "version": upgrade.bamboo_version,
            "sourceRevision": upgrade.source_revision,
            "artifacts": [artifact(&binary)],
            "browserHost": { "files": [
                { "path": "browser-runtime/host.cjs", "sha256": "host" },
                { "path": "browser-runtime/package-lock.json", "sha256": "lock" }
            ] },
        });
        let bytes = serde_json::to_vec(&manifest).unwrap();
        assert!(verify_manifest(&bytes, &upgrade, ["host", "lock"]).is_err());
        upgrade.manifest_sha256 = crate::frontend::hash_bytes(&bytes);
        assert!(verify_manifest(&bytes, &upgrade, ["host", "lock"]).is_ok());
        assert!(verify_manifest(&bytes, &upgrade, ["other", "lock"]).is_err());
        manifest["artifacts"][0]["assetName"] = "different-executable".into();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        upgrade.manifest_sha256 = crate::frontend::hash_bytes(&bytes);
        assert!(verify_manifest(&bytes, &upgrade, ["host", "lock"]).is_err());
    }
}
