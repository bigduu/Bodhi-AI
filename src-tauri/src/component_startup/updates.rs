use super::{
    journal::{History, Journal, Versions},
    Manager, PreparedUpdate,
};
use crate::component_channel::{Changes, Combination};
use crate::component_kernel::DownloadSource;
use chrono::Utc;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager as _, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(crate) const MENU_ID: &str = "component-updates";
const PAGE: &str = "component-updates.html";
const INTERVAL: Duration = Duration::from_secs(30 * 60);

#[derive(Default)]
pub(super) struct Updates {
    display: Mutex<Display>,
    check: tokio::sync::Mutex<()>,
    dialog_open: AtomicBool,
    pub(super) boot: tokio::sync::Mutex<()>,
    pub(super) ready: AtomicBool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Display {
    phase: String,
    error: Option<String>,
    progress: Option<Progress>,
    offer: Option<Offer>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    file: String,
    source: Option<DownloadSource>,
    received: u64,
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
struct Offer {
    versions: Versions,
    changes: Changes,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    bodhi: String,
    active: Option<Versions>,
    running: bool,
    queued: Option<Versions>,
    source: DownloadSource,
    last_check: Option<String>,
    display: Display,
    history: Vec<History>,
}

impl Updates {
    pub(super) fn progress(
        &self,
        file: &str,
        source: Option<DownloadSource>,
        received: u64,
        total: Option<u64>,
    ) {
        if let Ok(mut display) = self.display.lock() {
            display.phase = "正在下载并校验组件".into();
            if let Some(progress) = &mut display.progress {
                if progress.file == file && progress.source == source {
                    progress.received = received;
                    progress.total = total;
                    return;
                }
            }
            display.progress = Some(Progress {
                file: file.into(),
                source,
                received,
                total,
            });
        }
    }

    pub(super) fn status(&self, phase: &str, error: Option<String>) {
        if let Ok(mut display) = self.display.lock() {
            display.phase = phase.into();
            display.error = error;
            display.progress = None;
        }
    }
}

impl Manager {
    fn snapshot(&self, bodhi: String) -> Result<Snapshot, String> {
        let journal = Journal::read(&self.profile)?;
        Ok(Snapshot {
            bodhi,
            active: journal.active.as_ref().map(Versions::from),
            running: self.updates.ready.load(Ordering::Acquire),
            queued: journal.queued.as_ref().map(Versions::from),
            source: journal.source,
            last_check: journal.last_check,
            display: self
                .updates
                .display
                .lock()
                .map_err(|_| "Cannot read the update status")?
                .clone(),
            history: journal.history,
        })
    }

    fn remember_source(&self, source: DownloadSource) -> Result<(), String> {
        let _lock = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        journal.source = source;
        journal.save(&self.profile)?;
        self.sources.send_replace(source);
        Ok(())
    }

    fn record_check(&self) -> Result<(), String> {
        let _lock = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        journal.last_check = Some(Utc::now().to_rfc3339());
        journal.save(&self.profile)
    }

    fn snooze(&self) -> Result<(), String> {
        let _lock = self.profile.update_lock()?;
        let mut journal = Journal::read(&self.profile)?;
        journal.remind_after = Some(Utc::now().timestamp() + INTERVAL.as_secs() as i64);
        journal.save(&self.profile)
    }

    pub(crate) async fn poll<R: Runtime>(&self, app: &AppHandle<R>) {
        let mut interval = check_interval();
        loop {
            interval.tick().await;
            self.check(app).await;
        }
    }

    async fn check<R: Runtime>(&self, app: &AppHandle<R>) {
        let Ok(_in_flight) = self.updates.check.try_lock() else {
            return;
        };
        if self.updates.dialog_open.load(Ordering::Acquire) {
            return;
        }
        if let Err(error) = self.check_and_offer(app).await {
            self.updates.status("组件更新检查失败", Some(error));
        }
    }

    async fn check_and_offer<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let journal = Journal::read(&self.profile)?;
        let Some(current) = journal.active else {
            return Ok(());
        };
        if journal.trial.is_some() || journal.queued.is_some() {
            return Ok(());
        }
        if let Ok(mut display) = self.updates.display.lock() {
            display.offer = None;
        }
        self.updates.status("正在检查组件更新", None);
        let channel = self.channel().await?;
        self.record_check()?;
        let identity = current.identity();
        let Some(candidate) = channel.select(Some((current.sequence, &identity)))? else {
            self.updates.status("组件已是兼容的最新版本", None);
            return Ok(());
        };
        let combination = candidate.combination;
        if let Err(error) = self.prepare(combination).await {
            let _lock = self.profile.update_lock()?;
            let mut journal = Journal::read(&self.profile)?;
            let effective = journal.active.as_ref().map(Versions::from);
            journal.record(combination, Some(error.clone()));
            if let Some(last) = journal.history.last_mut() {
                last.effective = effective;
            }
            journal.save(&self.profile)?;
            return Err(error);
        }
        if let Ok(mut display) = self.updates.display.lock() {
            display.offer = Some(Offer {
                versions: Versions::from(combination),
                changes: combination.changes.clone(),
            });
        }
        self.updates.status("新版组件已校验", None);
        if journal
            .remind_after
            .is_some_and(|deadline| deadline > Utc::now().timestamp())
        {
            return Ok(());
        }
        let message = confirmation(&current, combination);
        let update = PreparedUpdate {
            current_sequence: current.sequence,
            current: identity,
            candidate: combination.clone(),
        };
        self.updates.dialog_open.store(true, Ordering::Release);
        let handle = app.clone();
        app.dialog()
            .message(message)
            .title("Bodhi 组件更新")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "下次启动时升级".into(),
                "稍后提醒".into(),
            ))
            .show(move |approved| {
                tauri::async_runtime::spawn(async move {
                    let manager = handle.state::<Manager>();
                    let result = if approved {
                        manager.reconfirm(&update).await
                    } else {
                        manager.snooze()
                    };
                    manager.updates.dialog_open.store(false, Ordering::Release);
                    match result {
                        Ok(()) if approved => manager.updates.status("已安排下次启动时升级", None),
                        Ok(()) => manager.updates.status("稍后提醒", None),
                        Err(error) => manager.updates.status("无法保存更新选择", Some(error)),
                    }
                });
            });
        Ok(())
    }

    async fn reconfirm(&self, update: &PreparedUpdate) -> Result<(), String> {
        let channel = self.channel().await?;
        let current = Some((update.current_sequence, &update.current));
        if channel
            .select(current)?
            .is_none_or(|candidate| candidate.combination != &update.candidate)
        {
            return Err("兼容目录已更新，请重新检查组件版本".into());
        }
        self.queue(update)
    }
}

fn check_interval() -> tokio::time::Interval {
    let mut interval = tokio::time::interval(INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval
}

fn confirmation(current: &Combination, next: &Combination) -> String {
    let mut sections = Vec::new();
    for (name, old, new, changes) in [
        (
            "Bamboo",
            &current.bamboo.version,
            &next.bamboo.version,
            &next.changes.bamboo,
        ),
        (
            "Lotus Next",
            &current.lotus.version,
            &next.lotus.version,
            &next.changes.lotus,
        ),
    ] {
        if old == new {
            continue;
        }
        let heading = format!("{name} {old} → {new}");
        let mut lines = Vec::from([heading]);
        if changes.is_empty() {
            lines.push("发布说明暂不可用".into());
        }
        for change in changes.iter().take(4) {
            lines.push(format!(
                "• {}",
                change.chars().take(230).collect::<String>()
            ));
        }
        sections.push(lines.join("\n"));
    }
    sections.push("下载与校验已完成。升级将在下次启动 Bodhi 时生效。".into());
    sections.join("\n\n")
}

pub(crate) fn open<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MENU_ID) {
        window.show().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    WebviewWindowBuilder::new(app, MENU_ID, WebviewUrl::App(PAGE.into()))
        .title("Bodhi 版本与更新")
        .inner_size(690.0, 680.0)
        .min_inner_size(460.0, 420.0)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn authorize<R: Runtime>(window: &WebviewWindow<R>, allow_splash: bool) -> Result<(), String> {
    let url = window.url().map_err(|error| error.to_string())?;
    let local = matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    );
    let updates = window.label() == MENU_ID && url.path() == "/component-updates.html";
    let splash =
        allow_splash && window.label() == "main" && matches!(url.path(), "/" | "/index.html");
    if local && (updates || splash) {
        return Ok(());
    }
    Err("This window cannot access the component updater".into())
}

#[tauri::command]
pub(crate) fn component_snapshot<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Snapshot, String> {
    authorize(&window, true)?;
    app.try_state::<Manager>()
        .ok_or("The component updater is unavailable")?
        .snapshot(app.package_info().version.to_string())
}

#[tauri::command]
pub(crate) fn check_components<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    authorize(&window, false)?;
    if app.try_state::<Manager>().is_none() {
        return Err("The component updater is unavailable".into());
    }
    tauri::async_runtime::spawn(async move {
        let manager = app.state::<Manager>();
        if manager.updates.ready.load(Ordering::Acquire) {
            manager.check(&app).await;
        } else if matches!(manager.launch(&app).await, Ok(true)) {
            manager.poll(&app).await;
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn set_component_source<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    source: DownloadSource,
) -> Result<(), String> {
    authorize(&window, false)?;
    app.try_state::<Manager>()
        .ok_or("The component updater is unavailable")?
        .remember_source(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn checks_immediately_and_at_thirty_minutes() {
        let start = tokio::time::Instant::now();
        let mut interval = check_interval();
        assert_eq!(interval.tick().await, start);
        assert!(
            tokio::time::timeout(Duration::from_secs(1799), interval.tick())
                .await
                .is_err()
        );
        assert_eq!(interval.tick().await, start + Duration::from_secs(1800));
    }

    #[test]
    fn selected_source_is_persisted_before_observers_restart_the_download() {
        let state = tempfile::tempdir().unwrap();
        let profile = crate::bamboo_profile::Profile::open(state.path()).unwrap();
        let manager = Manager::new(profile.clone()).unwrap();
        let receiver = manager.sources.subscribe();
        manager.remember_source(DownloadSource::GhFast).unwrap();
        assert_eq!(*receiver.borrow(), DownloadSource::GhFast);
        let reopened = Manager::new(profile).unwrap();
        assert_eq!(
            reopened.snapshot("0.0.0".into()).unwrap().source,
            DownloadSource::GhFast
        );
    }
}
