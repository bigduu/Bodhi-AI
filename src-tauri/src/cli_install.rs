//! Install the bundled `bamboo` CLI onto the user's PATH ("Install command-line
//! tools…", VS Code style).
//!
//! Bodhi ships the `bamboo` server binary as a Tauri sidecar; in a bundle it
//! sits next to the shell executable (e.g. `Bodhi.app/Contents/MacOS/bamboo`)
//! where no terminal can find it. This module exposes that binary on PATH:
//!
//! - **macOS** — symlink `/usr/local/bin/bamboo` → bundled binary. If that
//!   needs privileges, escalate ONCE via `osascript … with administrator
//!   privileges`.
//! - **Windows** — the install dir (where `bamboo.exe` sits next to
//!   `bodhi.exe`) is appended to the *user* PATH (`HKCU\Environment`,
//!   `REG_EXPAND_SZ`-safe, deduped) and `WM_SETTINGCHANGE` is broadcast so new
//!   shells pick it up. No admin required.
//! - **Linux** — symlink `~/.local/bin/bamboo`; if that dir is not on `$PATH`
//!   the success dialog includes the `export PATH=…` line to add.
//!
//! Safety rules, enforced BEFORE anything is written:
//! - Never overwrite a real file, and never replace a symlink we do not own.
//!   A link is "ours" only if it points at a bamboo binary inside a Bodhi
//!   install (see [`is_bodhi_bamboo_target`]); anything else aborts with a
//!   dialog naming the conflicting path.
//! - Privilege escalation happens at most once per attempt, and only *after*
//!   the conflict check has passed unprivileged.
//!
//! NATIVE-ONLY: a native menu item + native dialogs. The lotus web frontend
//! stays Tauri-free, so this module exposes no webview commands.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Menu item id matched in `on_menu_event`.
pub const MENU_ID: &str = "install-bamboo-cli";
/// Menu item label (Help menu).
pub const MENU_LABEL: &str = "安装 bamboo 命令行工具…";

const DIALOG_TITLE: &str = "bamboo 命令行工具";

/// File name of the sidecar binary as staged next to the shell executable.
#[cfg(windows)]
const BAMBOO_BIN: &str = "bamboo.exe";
#[cfg(not(windows))]
const BAMBOO_BIN: &str = "bamboo";

/// `build.rs` writes a tiny (<1 KiB) shell-script placeholder so a bare
/// `cargo build` resolves `externalBin`; a real bamboo server binary is tens
/// of megabytes. Anything smaller than this is treated as "not a real
/// sidecar" so we never put a placeholder on the user's PATH.
const MIN_REAL_SIDECAR_BYTES: u64 = 1024 * 1024;

/// Result of one install attempt, ready to be shown in a native dialog.
#[derive(Debug)]
pub struct InstallReport {
    pub success: bool,
    pub message: String,
}

impl InstallReport {
    fn failure(message: impl Into<String>) -> Self {
        Self {
            success: false,
            message: message.into(),
        }
    }
}

/// What one successful install attempt actually did.
#[derive(Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    /// The link/PATH entry already pointed at the current binary. No-op.
    AlreadyInstalled,
    /// Fresh install into a vacant slot.
    Installed,
    /// Replaced a stale link left behind by a previous Bodhi install.
    ReplacedStale,
}

/// Why an install attempt could not proceed.
#[derive(Debug)]
pub enum InstallError {
    /// A foreign file/symlink occupies the slot. NEVER clobbered; the message
    /// names the conflict for the error dialog.
    Conflict(String),
    /// Writing needs privileges we do not have (e.g. `/usr/local/bin` owned
    /// by root). macOS escalates once via osascript on this.
    NeedsPrivilege(String),
    Io(String),
}

// ---------------------------------------------------------------------------
// Locating the bundled binary
// ---------------------------------------------------------------------------

/// Resolve the real bundled `bamboo` binary next to the running executable.
pub fn resolve_bundled_bamboo() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法确定当前可执行文件路径:{e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "无法确定当前可执行文件所在目录".to_string())?;
    resolve_bundled_bamboo_in(dir)
}

/// Testable core of [`resolve_bundled_bamboo`].
///
/// Candidates, in order:
/// 1. `<exe_dir>/bamboo` — a release bundle (Tauri strips the target triple
///    from `externalBin` next to the app binary) and `tauri dev` (the dev
///    cache written by `scripts/build-sidecar.cjs`) both put it here.
/// 2. Dev fallback (`cargo run` without the dev cache): the staged
///    `src-tauri/binaries/bamboo-<triple>` two levels above the exe dir
///    (`<repo>/target/<profile>/bodhi`). Skipped on Windows, where the PATH
///    approach needs the file to literally be named `bamboo.exe`.
///
/// Placeholder binaries (see [`MIN_REAL_SIDECAR_BYTES`]) are rejected.
pub fn resolve_bundled_bamboo_in(exe_dir: &Path) -> Result<PathBuf, String> {
    let mut candidates = vec![exe_dir.join(BAMBOO_BIN)];
    if !cfg!(windows) {
        candidates.extend(staged_dev_sidecars(exe_dir));
    }

    for candidate in &candidates {
        if is_real_sidecar_file(candidate) {
            return Ok(candidate.clone());
        }
    }

    Err(format!(
        "未找到内置的 bamboo 可执行文件(应位于 {})。\n开发模式下请先运行 `npm run build:sidecar:dev`;发布包若出现此错误属于打包问题,请反馈。",
        candidates[0].display()
    ))
}

/// Staged dev sidecars at `<exe_dir>/../../src-tauri/binaries/bamboo-*`,
/// sorted for determinism. Empty when the layout does not match (bundles).
pub fn staged_dev_sidecars(exe_dir: &Path) -> Vec<PathBuf> {
    let Some(repo_root) = exe_dir.parent().and_then(Path::parent) else {
        return Vec::new();
    };
    let staged_dir = repo_root.join("src-tauri").join("binaries");
    let Ok(entries) = std::fs::read_dir(&staged_dir) else {
        return Vec::new();
    };
    let mut staged: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("bamboo-"))
        })
        .collect();
    staged.sort();
    staged
}

/// A candidate counts as a real sidecar only if it is a file large enough to
/// not be the `build.rs` placeholder script.
pub fn is_real_sidecar_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() >= MIN_REAL_SIDECAR_BYTES)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Pure helpers (testable on every platform)
// ---------------------------------------------------------------------------

/// Append `dir` to a Windows `PATH` string unless an equivalent entry exists.
///
/// Returns `None` when `dir` is already present (the idempotent case).
/// Comparison is per-segment, case-insensitive, and ignores surrounding
/// quotes and trailing slashes/backslashes. Existing segments — including
/// unexpanded `%VAR%` ones — are preserved byte-for-byte; we only ever append.
pub fn append_to_path_var(existing: &str, dir: &str) -> Option<String> {
    fn norm(seg: &str) -> String {
        seg.trim()
            .trim_matches('"')
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase()
    }
    let needle = norm(dir);
    if needle.is_empty() {
        return None;
    }
    if existing.split(';').any(|seg| norm(seg) == needle) {
        return None;
    }
    let trimmed = existing.trim_end_matches(';');
    if trimmed.trim().is_empty() {
        Some(dir.to_string())
    } else {
        Some(format!("{trimmed};{dir}"))
    }
}

/// Whether a unix `$PATH` value contains `dir` (exact segment match, trailing
/// slashes ignored).
pub fn path_var_contains(path_var: &str, dir: &Path) -> bool {
    let dir = dir.to_string_lossy();
    let dir = dir.trim_end_matches('/');
    if dir.is_empty() {
        return false;
    }
    path_var
        .split(':')
        .any(|seg| !seg.is_empty() && seg.trim_end_matches('/') == dir)
}

/// POSIX single-quote shell escaping: `'` becomes `'\''`, everything else is
/// literal inside the quotes.
pub fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Escape a string into an AppleScript string literal.
pub fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Build the one-shot admin AppleScript: `mkdir -p <dir> && ln -sfn <target>
/// <link>` under `do shell script … with administrator privileges`.
///
/// SAFETY: only ever run AFTER [`classify_link_site`] approved the slot
/// unprivileged (vacant or a stale link of ours), so the `-f` cannot clobber
/// a foreign file.
pub fn build_admin_install_applescript(target: &Path, link: &Path) -> String {
    let link_dir = link.parent().unwrap_or_else(|| Path::new("/"));
    let cmd = format!(
        "mkdir -p {} && ln -sfn {} {}",
        shell_single_quote(&link_dir.to_string_lossy()),
        shell_single_quote(&target.to_string_lossy()),
        shell_single_quote(&link.to_string_lossy()),
    );
    format!(
        "do shell script {} with administrator privileges",
        applescript_string(&cmd)
    )
}

/// Whether a symlink target is a bamboo binary that belongs to a Bodhi
/// install (current or previous) — the only links we are allowed to replace.
///
/// Heuristic: the file name is `bamboo` (or a `bamboo-<triple>` staging name)
/// AND some path component mentions "bodhi" (case-insensitive), which covers
/// `/Applications/Bodhi AI.app/Contents/MacOS/bamboo` as well as dev trees
/// like `…/bodhi/target/debug/bamboo`. A Homebrew/user `bamboo` fails the
/// second test and is treated as foreign.
pub fn is_bodhi_bamboo_target(target: &Path) -> bool {
    let name_is_bamboo = target
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "bamboo" || n == "bamboo.exe" || n.starts_with("bamboo-"));
    if !name_is_bamboo {
        return false;
    }
    target.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| s.to_ascii_lowercase().contains("bodhi"))
    })
}

// ---------------------------------------------------------------------------
// Unix symlink installation (macOS + Linux share this)
// ---------------------------------------------------------------------------

/// State of the would-be link path, decided before any write.
#[cfg(unix)]
#[derive(Debug)]
pub enum LinkSite {
    /// Nothing there — free to create.
    Vacant,
    /// Symlink already points at `desired_target`.
    AlreadyInstalled,
    /// Symlink of ours pointing at an old/moved Bodhi binary — replaceable.
    StaleOurs { current_target: PathBuf },
    /// Symlink owned by something else — NEVER touched.
    ForeignSymlink { current_target: PathBuf },
    /// A real file or directory — NEVER touched.
    Occupied,
}

/// Classify what currently occupies `link`. Read-only; needs no privileges.
#[cfg(unix)]
pub fn classify_link_site(link: &Path, desired_target: &Path) -> std::io::Result<LinkSite> {
    match std::fs::symlink_metadata(link) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LinkSite::Vacant),
        Err(e) => Err(e),
        Ok(meta) if meta.file_type().is_symlink() => {
            let current_target = std::fs::read_link(link)?;
            if current_target == desired_target {
                Ok(LinkSite::AlreadyInstalled)
            } else if is_bodhi_bamboo_target(&current_target) {
                Ok(LinkSite::StaleOurs { current_target })
            } else {
                Ok(LinkSite::ForeignSymlink { current_target })
            }
        }
        Ok(_) => Ok(LinkSite::Occupied),
    }
}

/// Create (or refresh) `link` → `desired_target`, honoring the never-clobber
/// rules. Pure filesystem logic — paths are injected, so tests run against
/// tempdirs and the real `/usr/local/bin` is never touched.
#[cfg(unix)]
pub fn install_symlink(link: &Path, desired_target: &Path) -> Result<InstallOutcome, InstallError> {
    let site = classify_link_site(link, desired_target).map_err(|e| {
        if is_permission_error(&e) {
            InstallError::NeedsPrivilege(e.to_string())
        } else {
            InstallError::Io(format!("检查 {} 失败:{e}", link.display()))
        }
    })?;

    let replacing_stale = match site {
        LinkSite::AlreadyInstalled => return Ok(InstallOutcome::AlreadyInstalled),
        LinkSite::ForeignSymlink { current_target } => {
            return Err(InstallError::Conflict(format!(
                "{} 已指向 {},不是 Bodhi 创建的链接。为安全起见未做任何修改;请手动处理后重试。",
                link.display(),
                current_target.display()
            )));
        }
        LinkSite::Occupied => {
            return Err(InstallError::Conflict(format!(
                "{} 已存在且是普通文件/目录。为安全起见未做任何修改;请手动处理后重试。",
                link.display()
            )));
        }
        LinkSite::Vacant => false,
        LinkSite::StaleOurs { .. } => true,
    };

    place_symlink(link, desired_target).map_err(|e| {
        if is_permission_error(&e) {
            InstallError::NeedsPrivilege(e.to_string())
        } else {
            InstallError::Io(format!("创建 {} 失败:{e}", link.display()))
        }
    })?;

    Ok(if replacing_stale {
        InstallOutcome::ReplacedStale
    } else {
        InstallOutcome::Installed
    })
}

/// `mkdir -p` the parent, drop a pre-approved stale link, create the symlink.
#[cfg(unix)]
fn place_symlink(link: &Path, target: &Path) -> std::io::Result<()> {
    if let Some(dir) = link.parent() {
        std::fs::create_dir_all(dir)?;
    }
    match std::fs::remove_file(link) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    std::os::unix::fs::symlink(target, link)
}

/// EACCES/EPERM map to `PermissionDenied`; 30 is EROFS (read-only fs) on both
/// macOS and Linux, which `ErrorKind` does not yet cover on stable.
#[cfg(unix)]
fn is_permission_error(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(30)
}

/// Canonical link location per OS.
#[cfg(target_os = "macos")]
pub fn default_link_path() -> Result<PathBuf, String> {
    Ok(PathBuf::from("/usr/local/bin/bamboo"))
}

#[cfg(target_os = "linux")]
pub fn default_link_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".local").join("bin").join("bamboo"))
        .ok_or_else(|| "无法确定用户主目录".to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn report_from_outcome(outcome: InstallOutcome, link: &Path) -> InstallReport {
    let message = match outcome {
        InstallOutcome::AlreadyInstalled => format!(
            "已安装,指向当前版本。\n可在终端运行 `bamboo --help` / `bamboo tui`。\n({})",
            link.display()
        ),
        InstallOutcome::Installed => format!(
            "已安装:{} → 内置的 bamboo。\n在终端运行 `bamboo --help` / `bamboo tui`。",
            link.display()
        ),
        InstallOutcome::ReplacedStale => format!(
            "已将旧版链接更新为当前版本:{}。\n在终端运行 `bamboo --help` / `bamboo tui`。",
            link.display()
        ),
    };
    InstallReport {
        success: true,
        message,
    }
}

// ---------------------------------------------------------------------------
// Per-OS entry points
// ---------------------------------------------------------------------------

/// macOS: `/usr/local/bin/bamboo` symlink, single osascript escalation.
#[cfg(target_os = "macos")]
pub fn perform_install() -> InstallReport {
    let target = match resolve_bundled_bamboo() {
        Ok(t) => t,
        Err(e) => return InstallReport::failure(e),
    };
    let link = match default_link_path() {
        Ok(l) => l,
        Err(e) => return InstallReport::failure(e),
    };
    match install_symlink(&link, &target) {
        Ok(outcome) => report_from_outcome(outcome, &link),
        Err(InstallError::NeedsPrivilege(_)) => {
            // Single escalation. The conflict check above already passed
            // unprivileged, so the admin `ln -sfn` can only fill a vacant
            // slot or refresh our own stale link.
            match escalate_install_macos(&link, &target) {
                Ok(()) => report_from_outcome(InstallOutcome::Installed, &link),
                Err(e) => InstallReport::failure(e),
            }
        }
        Err(InstallError::Conflict(msg)) | Err(InstallError::Io(msg)) => {
            InstallReport::failure(msg)
        }
    }
}

#[cfg(target_os = "macos")]
fn escalate_install_macos(link: &Path, target: &Path) -> Result<(), String> {
    let script = build_admin_install_applescript(target, link);
    let output = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("无法运行 osascript:{e}"))?;

    if output.status.success() {
        // Verify the admin command actually produced the link we asked for.
        match classify_link_site(link, target) {
            Ok(LinkSite::AlreadyInstalled) => Ok(()),
            Ok(other) => Err(format!(
                "授权命令已执行,但 {} 的状态异常({other:?})。",
                link.display()
            )),
            Err(e) => Err(format!("授权后校验 {} 失败:{e}", link.display())),
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // osascript reports a dismissed auth dialog as error -128.
        if stderr.contains("-128") || stderr.to_ascii_lowercase().contains("cancel") {
            Err("已取消授权,未安装。".to_string())
        } else {
            Err(format!("管理员安装失败:{}", stderr.trim()))
        }
    }
}

/// Linux: `~/.local/bin/bamboo` symlink + PATH hint when needed.
#[cfg(target_os = "linux")]
pub fn perform_install() -> InstallReport {
    let target = match resolve_bundled_bamboo() {
        Ok(t) => t,
        Err(e) => return InstallReport::failure(e),
    };
    let link = match default_link_path() {
        Ok(l) => l,
        Err(e) => return InstallReport::failure(e),
    };
    match install_symlink(&link, &target) {
        Ok(outcome) => {
            let mut report = report_from_outcome(outcome, &link);
            let path_var = std::env::var("PATH").unwrap_or_default();
            if let Some(dir) = link.parent() {
                if !path_var_contains(&path_var, dir) {
                    report.message.push_str(
                        "\n\n注意:~/.local/bin 当前不在 $PATH。请在 shell 配置(如 ~/.bashrc)中加入:\nexport PATH=\"$HOME/.local/bin:$PATH\"",
                    );
                }
            }
            report
        }
        Err(InstallError::NeedsPrivilege(msg)) => {
            InstallReport::failure(format!("没有权限写入 {}:{msg}", link.display()))
        }
        Err(InstallError::Conflict(msg)) | Err(InstallError::Io(msg)) => {
            InstallReport::failure(msg)
        }
    }
}

/// Windows: append the install dir to the user PATH (HKCU) and broadcast the
/// change. `bamboo.exe` already sits next to `bodhi.exe`, so no files move.
#[cfg(windows)]
pub fn perform_install() -> InstallReport {
    let target = match resolve_bundled_bamboo() {
        Ok(t) => t,
        Err(e) => return InstallReport::failure(e),
    };
    let Some(dir) = target.parent() else {
        return InstallReport::failure("无法确定 bamboo.exe 所在目录".to_string());
    };
    let dir_str = dir.to_string_lossy().into_owned();

    let (current, vtype) = match read_user_path() {
        Ok(v) => v,
        Err(e) => return InstallReport::failure(e),
    };
    match append_to_path_var(&current, &dir_str) {
        None => InstallReport {
            success: true,
            message: format!(
                "已安装,指向当前版本。\n安装目录已在用户 PATH 中({dir_str})。\n可在终端运行 `bamboo --help` / `bamboo tui`。"
            ),
        },
        Some(new_value) => {
            if let Err(e) = write_user_path(&new_value, vtype) {
                return InstallReport::failure(e);
            }
            broadcast_environment_change();
            InstallReport {
                success: true,
                message: format!(
                    "已将 {dir_str} 加入用户 PATH。\n请打开新的终端窗口,运行 `bamboo --help` / `bamboo tui`。"
                ),
            }
        }
    }
}

/// Read the user `Path` value and its registry type. `REG_EXPAND_SZ` entries
/// (e.g. `%USERPROFILE%\bin`) must be written back with the same type or
/// their expansion breaks — that is why the type travels with the value.
#[cfg(windows)]
fn read_user_path() -> Result<(String, winreg::enums::RegType), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::types::FromRegValue;
    use winreg::RegKey;

    let env = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", KEY_READ)
        .map_err(|e| format!("读取 HKCU\\Environment 失败:{e}"))?;
    match env.get_raw_value("Path") {
        Ok(raw) => {
            let vtype = raw.vtype;
            let value =
                String::from_reg_value(&raw).map_err(|e| format!("解析用户 PATH 失败:{e}"))?;
            Ok((value, vtype))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok((String::new(), winreg::enums::RegType::REG_EXPAND_SZ))
        }
        Err(e) => Err(format!("读取用户 PATH 失败:{e}")),
    }
}

/// Write the user `Path` back with the ORIGINAL registry type preserved.
#[cfg(windows)]
fn write_user_path(value: &str, vtype: winreg::enums::RegType) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::{RegKey, RegValue};

    let env = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", KEY_SET_VALUE)
        .map_err(|e| format!("打开 HKCU\\Environment 失败:{e}"))?;
    let mut bytes: Vec<u8> = Vec::with_capacity((value.len() + 1) * 2);
    for unit in value.encode_utf16().chain(std::iter::once(0u16)) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    env.set_raw_value("Path", &RegValue { bytes, vtype })
        .map_err(|e| format!("写入用户 PATH 失败:{e}"))
}

/// Tell running apps (Explorer, new consoles) the environment changed so new
/// terminals see the updated PATH without a re-login.
#[cfg(windows)]
fn broadcast_environment_change() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };

    let param: Vec<u16> = "Environment\0".encode_utf16().collect();
    let mut result: usize = 0;
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            param.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            &mut result,
        );
    }
}

/// Fallback for platforms Bodhi does not ship on.
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn perform_install() -> InstallReport {
    InstallReport::failure("此平台暂不支持安装命令行工具。".to_string())
}

// ---------------------------------------------------------------------------
// Installed-state probe (used by the one-time startup offer)
// ---------------------------------------------------------------------------

/// Best-effort: is the CLI already wired up to the CURRENT bundled binary?
pub fn is_installed() -> bool {
    match resolve_bundled_bamboo() {
        Ok(target) => installed_state(&target),
        Err(_) => false,
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn installed_state(target: &Path) -> bool {
    let Ok(link) = default_link_path() else {
        return false;
    };
    matches!(
        classify_link_site(&link, target),
        Ok(LinkSite::AlreadyInstalled)
    )
}

#[cfg(windows)]
fn installed_state(target: &Path) -> bool {
    let Some(dir) = target.parent() else {
        return false;
    };
    match read_user_path() {
        Ok((current, _)) => append_to_path_var(&current, &dir.to_string_lossy()).is_none(),
        Err(_) => false,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn installed_state(_target: &Path) -> bool {
    false
}

// ---------------------------------------------------------------------------
// UI glue: menu handler + one-time startup offer
// ---------------------------------------------------------------------------

/// Menu entry point. Runs the install on a dedicated thread (the osascript
/// admin prompt can block for as long as the user stares at it) and reports
/// the result via a native dialog.
pub fn run_from_menu<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let report = perform_install();
        show_report(&app, &report);
    });
}

fn show_report<R: Runtime>(app: &AppHandle<R>, report: &InstallReport) {
    if report.success {
        log::info!("cli-install: {}", report.message);
    } else {
        log::warn!("cli-install failed: {}", report.message);
    }
    app.dialog()
        .message(&report.message)
        .title(DIALOG_TITLE)
        .kind(if report.success {
            MessageDialogKind::Info
        } else {
            MessageDialogKind::Error
        })
        .show(|_| {});
}

/// Marker recording that the one-time offer was shown (and how it was
/// answered), stored in the bamboo data dir next to `config.json`.
fn offer_marker_path() -> PathBuf {
    crate::app_settings::bamboo_dir().join("bodhi_cli_install_offer.json")
}

fn record_offer(marker: &Path, answer: &str) {
    if let Some(dir) = marker.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::json!({
        "offered_at": chrono::Utc::now().to_rfc3339(),
        "answer": answer,
    });
    if let Err(e) = std::fs::write(marker, body.to_string()) {
        log::warn!("cli-install: failed to record offer marker: {e}");
    }
}

/// One-time, first-launch offer to install the CLI. Never re-prompts: the
/// answer is recorded in [`offer_marker_path`]. Release bundles only — a dev
/// run would offer to link a debug binary.
pub fn maybe_offer_on_startup<R: Runtime>(app: &AppHandle<R>) {
    if cfg!(debug_assertions) {
        return;
    }
    let marker = offer_marker_path();
    if marker.exists() {
        return;
    }
    if is_installed() {
        record_offer(&marker, "already-installed");
        return;
    }
    // No usable bundled binary → nothing to offer (and nothing to nag about).
    if resolve_bundled_bamboo().is_err() {
        return;
    }

    let app = app.clone();
    app.clone()
        .dialog()
        .message(
            "是否将 bamboo 命令行工具安装到 PATH?\n\n安装后可在任意终端运行 `bamboo --help` / `bamboo tui`。\n之后也可以随时通过菜单「Help → 安装 bamboo 命令行工具…」安装。",
        )
        .title(DIALOG_TITLE)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "安装".to_string(),
            "以后再说".to_string(),
        ))
        .show(move |install| {
            record_offer(&marker, if install { "accepted" } else { "declined" });
            if install {
                std::thread::spawn(move || {
                    let report = perform_install();
                    show_report(&app, &report);
                });
            }
        });
}

// ---------------------------------------------------------------------------
// Tests — tempdirs and injected roots only; the real /usr/local/bin, registry
// and PATH are NEVER touched here.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Windows PATH append/dedupe (pure string logic, runs everywhere) ----

    #[test]
    fn path_append_to_empty() {
        assert_eq!(
            append_to_path_var("", r"C:\Apps\Bodhi").as_deref(),
            Some(r"C:\Apps\Bodhi")
        );
    }

    #[test]
    fn path_append_to_existing() {
        assert_eq!(
            append_to_path_var(r"C:\Windows;C:\Windows\System32", r"C:\Apps\Bodhi").as_deref(),
            Some(r"C:\Windows;C:\Windows\System32;C:\Apps\Bodhi")
        );
    }

    #[test]
    fn path_append_dedupes_exact_match() {
        assert_eq!(
            append_to_path_var(r"C:\Apps\Bodhi;C:\Windows", r"C:\Apps\Bodhi"),
            None
        );
    }

    #[test]
    fn path_append_dedupes_case_insensitive_and_trailing_slash() {
        assert_eq!(
            append_to_path_var(r"c:\apps\bodhi\;C:\Windows", r"C:\Apps\Bodhi"),
            None
        );
    }

    #[test]
    fn path_append_dedupes_quoted_segment() {
        assert_eq!(
            append_to_path_var(r#""C:\Apps\Bodhi";C:\Windows"#, r"C:\Apps\Bodhi"),
            None
        );
    }

    #[test]
    fn path_append_ignores_trailing_semicolons() {
        assert_eq!(
            append_to_path_var(r"C:\Windows;;", r"C:\Apps\Bodhi").as_deref(),
            Some(r"C:\Windows;C:\Apps\Bodhi")
        );
    }

    #[test]
    fn path_append_preserves_unexpanded_entries() {
        let existing = r"%USERPROFILE%\bin;C:\Windows";
        assert_eq!(
            append_to_path_var(existing, r"C:\Apps\Bodhi").as_deref(),
            Some(r"%USERPROFILE%\bin;C:\Windows;C:\Apps\Bodhi")
        );
    }

    #[test]
    fn path_append_empty_dir_is_noop() {
        assert_eq!(append_to_path_var(r"C:\Windows", ""), None);
    }

    // ---- unix $PATH probe ----

    #[test]
    fn unix_path_contains_exact_segment() {
        assert!(path_var_contains(
            "/usr/bin:/home/u/.local/bin:/bin",
            Path::new("/home/u/.local/bin")
        ));
        assert!(path_var_contains(
            "/usr/bin:/home/u/.local/bin/",
            Path::new("/home/u/.local/bin")
        ));
        assert!(!path_var_contains(
            "/usr/bin:/home/u/.local/binx",
            Path::new("/home/u/.local/bin")
        ));
        assert!(!path_var_contains("", Path::new("/home/u/.local/bin")));
    }

    // ---- shell / AppleScript quoting ----

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_single_quote("no quotes"), "'no quotes'");
        assert_eq!(shell_single_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn applescript_string_escapes_backslashes_and_quotes() {
        assert_eq!(applescript_string(r#"a "b" \c"#), r#""a \"b\" \\c""#);
    }

    #[test]
    fn admin_script_quotes_awkward_paths() {
        let target = Path::new("/Applications/Bodhi AI.app/Contents/MacOS/bamboo");
        let link = Path::new("/usr/local/bin/bamboo");
        let script = build_admin_install_applescript(target, link);
        assert!(script.starts_with("do shell script \""));
        assert!(script.ends_with("\" with administrator privileges"));
        assert!(script.contains("mkdir -p '/usr/local/bin'"));
        assert!(script.contains(
            "ln -sfn '/Applications/Bodhi AI.app/Contents/MacOS/bamboo' '/usr/local/bin/bamboo'"
        ));
    }

    // ---- ours-vs-foreign link classification ----

    #[test]
    fn bodhi_targets_are_ours() {
        assert!(is_bodhi_bamboo_target(Path::new(
            "/Applications/Bodhi AI.app/Contents/MacOS/bamboo"
        )));
        assert!(is_bodhi_bamboo_target(Path::new(
            "/Users/u/ws/bodhi/target/debug/bamboo"
        )));
        assert!(is_bodhi_bamboo_target(Path::new(
            "/Users/u/ws/bodhi/src-tauri/binaries/bamboo-aarch64-apple-darwin"
        )));
    }

    #[test]
    fn foreign_targets_are_not_ours() {
        // Right name, no Bodhi component → foreign (e.g. Homebrew).
        assert!(!is_bodhi_bamboo_target(Path::new(
            "/opt/homebrew/bin/bamboo"
        )));
        // Bodhi component, different binary → foreign.
        assert!(!is_bodhi_bamboo_target(Path::new(
            "/Applications/Bodhi AI.app/Contents/MacOS/bodhi"
        )));
    }

    // ---- bundled-binary resolution (tempdir roots only) ----

    fn write_file(path: &Path, len: usize) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, vec![0u8; len]).unwrap();
    }

    #[test]
    fn resolve_finds_real_binary_next_to_exe() {
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path().join("target").join("release");
        let bin = exe_dir.join(BAMBOO_BIN);
        write_file(&bin, 2 * 1024 * 1024);
        assert_eq!(resolve_bundled_bamboo_in(&exe_dir).unwrap(), bin);
    }

    #[test]
    fn resolve_rejects_placeholder_sized_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path().join("target").join("release");
        write_file(&exe_dir.join(BAMBOO_BIN), 100); // build.rs placeholder size
        assert!(resolve_bundled_bamboo_in(&exe_dir).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_falls_back_to_staged_dev_sidecar() {
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path().join("target").join("debug");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let staged = tmp
            .path()
            .join("src-tauri")
            .join("binaries")
            .join("bamboo-aarch64-apple-darwin");
        write_file(&staged, 2 * 1024 * 1024);
        assert_eq!(resolve_bundled_bamboo_in(&exe_dir).unwrap(), staged);
    }

    #[test]
    fn resolve_errors_when_nothing_found() {
        let tmp = tempfile::tempdir().unwrap();
        let exe_dir = tmp.path().join("target").join("debug");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let err = resolve_bundled_bamboo_in(&exe_dir).unwrap_err();
        assert!(err.contains("bamboo"));
    }

    // ---- symlink install semantics (unix, tempdirs only) ----

    #[cfg(unix)]
    mod symlink_install {
        use super::super::*;

        struct Site {
            _tmp: tempfile::TempDir,
            link: PathBuf,
            target: PathBuf,
        }

        fn site() -> Site {
            let tmp = tempfile::tempdir().unwrap();
            // A plausible "bundled binary" target inside a Bodhi-ish path.
            let target = tmp
                .path()
                .join("Bodhi.app")
                .join("Contents")
                .join("MacOS")
                .join("bamboo");
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, b"binary").unwrap();
            let link = tmp.path().join("usr-local-bin").join("bamboo");
            Site {
                _tmp: tmp,
                link,
                target,
            }
        }

        #[test]
        fn installs_into_vacant_slot_creating_dir() {
            let s = site();
            let outcome = install_symlink(&s.link, &s.target).unwrap();
            assert_eq!(outcome, InstallOutcome::Installed);
            assert_eq!(std::fs::read_link(&s.link).unwrap(), s.target);
        }

        #[test]
        fn second_run_is_idempotent() {
            let s = site();
            install_symlink(&s.link, &s.target).unwrap();
            let outcome = install_symlink(&s.link, &s.target).unwrap();
            assert_eq!(outcome, InstallOutcome::AlreadyInstalled);
        }

        #[test]
        fn replaces_stale_link_into_previous_bodhi_install() {
            let s = site();
            std::fs::create_dir_all(s.link.parent().unwrap()).unwrap();
            // Simulates a link left behind by an old install location.
            std::os::unix::fs::symlink(
                "/Applications/Old Bodhi.app/Contents/MacOS/bamboo",
                &s.link,
            )
            .unwrap();
            let outcome = install_symlink(&s.link, &s.target).unwrap();
            assert_eq!(outcome, InstallOutcome::ReplacedStale);
            assert_eq!(std::fs::read_link(&s.link).unwrap(), s.target);
        }

        #[test]
        fn never_replaces_foreign_symlink() {
            let s = site();
            std::fs::create_dir_all(s.link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink("/opt/homebrew/bin/bamboo", &s.link).unwrap();
            let err = install_symlink(&s.link, &s.target).unwrap_err();
            assert!(matches!(err, InstallError::Conflict(_)));
            // Untouched.
            assert_eq!(
                std::fs::read_link(&s.link).unwrap(),
                Path::new("/opt/homebrew/bin/bamboo")
            );
        }

        #[test]
        fn never_clobbers_real_file() {
            let s = site();
            std::fs::create_dir_all(s.link.parent().unwrap()).unwrap();
            std::fs::write(&s.link, b"someone's script").unwrap();
            let err = install_symlink(&s.link, &s.target).unwrap_err();
            assert!(matches!(err, InstallError::Conflict(_)));
            assert_eq!(
                std::fs::read(&s.link).unwrap(),
                b"someone's script".to_vec()
            );
        }

        #[test]
        fn permission_denied_maps_to_needs_privilege() {
            use std::os::unix::fs::PermissionsExt;
            let s = site();
            let dir = s.link.parent().unwrap();
            std::fs::create_dir_all(dir).unwrap();
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o555)).unwrap();
            let result = install_symlink(&s.link, &s.target);
            // Restore so the tempdir can be cleaned up before asserting.
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            match result {
                // Running as root (some CI containers): the write succeeds.
                Ok(outcome) => assert_eq!(outcome, InstallOutcome::Installed),
                Err(e) => assert!(matches!(e, InstallError::NeedsPrivilege(_)), "{e:?}"),
            }
        }
    }
}
