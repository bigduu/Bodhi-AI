use crate::command::copy::copy_to_clipboard;
use crate::embedded::EmbeddedWebService;
use bamboo_agent::infrastructure::{Config, ProxyAuth};
use chrono::{SecondsFormat, Utc};
use log::{info, LevelFilter};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tauri::{App, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_log::{Target, TargetKind};
use tokio::time::sleep;

pub mod app_settings;
pub mod command;
pub mod embedded;

// Embedded web service state wrapper for Tauri state management
pub struct WebServiceState(pub Arc<EmbeddedWebService>);

fn should_exit_on_main_window_close(label: &str, is_close_requested: bool) -> bool {
    label == "main" && is_close_requested
}

fn parse_truthy_flag(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn is_webview_diag_enabled() -> bool {
    std::env::var("BODHI_WEBVIEW_DIAG")
        .map(|value| parse_truthy_flag(&value))
        .unwrap_or(false)
}

fn should_open_devtools() -> bool {
    std::env::var("BODHI_OPEN_DEVTOOLS")
        .map(|value| parse_truthy_flag(&value))
        .unwrap_or(false)
}

fn maybe_open_devtools<R: Runtime>(app: &App<R>) {
    if !should_open_devtools() {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
        log::info!("[webview-diag] Opened devtools for main window");
    } else {
        log::warn!("[webview-diag] main window not found for devtools");
    }
}

fn schedule_webview_diag<R: Runtime>(app: &App<R>) {
    if !is_webview_diag_enabled() {
        return;
    }

    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        sleep(Duration::from_secs(3)).await;

        let Some(window) = app_handle.get_webview_window("main") else {
            log::warn!("[webview-diag] main window not found");
            return;
        };

        // Best-effort diagnostic overlay when the frontend did not mount.
        let js = r#"
          (function () {
            const root = document.getElementById("root");
            const rootHasContent = !!(
              root &&
              (root.childElementCount > 0 || (root.textContent || "").trim().length > 0)
            );

            const lines = [];
            lines.push("Bodhi WebView Diagnostics");
            lines.push("href=" + location.href);
            lines.push("origin=" + location.origin);
            lines.push("readyState=" + document.readyState);
            lines.push("root_present=" + Boolean(root));
            lines.push("root_has_content=" + rootHasContent);
            lines.push("script_count=" + document.scripts.length);

            const moduleScript = Array.from(document.scripts).find((s) => s.type === "module");
            if (moduleScript && moduleScript.src) {
              lines.push("module_src=" + moduleScript.src);
            }

            if (!rootHasContent) {
              document.body.innerHTML =
                "<pre style='margin:0;padding:16px;white-space:pre-wrap;font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f6f6f6;color:#111;'>" +
                lines.join("\n") +
                "</pre>";
            } else {
              console.info("[webview-diag] frontend root has content; no overlay injected");
              console.info("[webview-diag] " + lines.join(" | "));
            }
          })();
        "#;

        if let Err(error) = window.eval(js) {
            log::warn!("[webview-diag] failed to inject diagnostics: {}", error);
        }
    });
}

fn is_internal_build_mode() -> bool {
    if let Some(compiled_flag) = option_env!("BODHI_INTERNAL_BUILD") {
        return parse_truthy_flag(compiled_flag);
    }

    std::env::var("BODHI_INTERNAL_BUILD")
        .map(|value| parse_truthy_flag(&value))
        .unwrap_or(false)
}

fn show_internal_startup_confirmation<R: Runtime>(app: &App<R>) {
    if !is_internal_build_mode() {
        return;
    }

    if let Some(main_window) = app.get_webview_window("main") {
        if let Err(error) = main_window.hide() {
            log::warn!(
                "Failed to hide main window before startup confirmation: {}",
                error
            );
        }
    }

    let app_handle = app.handle().clone();
    app.dialog()
        .message(
            "This is an internal development build of Bodhi.\n\nAccept to continue, or decline to exit.",
        )
        .title("Welcome to Bodhi")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Accept and Continue".to_string(),
            "Decline and Exit".to_string(),
        ))
        .show(move |accepted| {
            if accepted {
                if let Some(window) = app_handle.get_webview_window("main") {
                    if let Err(error) = window.show() {
                        log::warn!("Failed to show main window after confirmation: {}", error);
                    }
                    if let Err(error) = window.set_focus() {
                        log::warn!("Failed to focus main window after confirmation: {}", error);
                    }
                }
                return;
            }

            log::info!("Startup confirmation declined; exiting application");
            app_handle.exit(0);
        });
}

fn setup<R: Runtime>(app: &mut App<R>) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = app_settings::bamboo_dir();
    std::fs::create_dir_all(&app_data_dir)?;
    info!("App data dir: {:?}", app_data_dir);

    // Start embedded web service
    let web_service = Arc::new(EmbeddedWebService::new(9562, app_data_dir.clone()));

    let web_service_clone = Arc::clone(&web_service);
    tauri::async_runtime::spawn(async move {
        // If an external backend is already running on the port,
        // don't try to start the embedded server (avoids noisy bind/health failures).
        if web_service_clone.is_running().await {
            log::info!(
                "Backend already running on port {}; skipping embedded web service start",
                9562
            );
            return;
        }

        if let Err(e) = web_service_clone.start().await {
            log::error!("Failed to start embedded web service: {}", e);
        }
    });

    // Manage web service state for later access
    app.manage(WebServiceState(web_service));

    show_internal_startup_confirmation(app);
    maybe_open_devtools(app);
    schedule_webview_diag(app);

    Ok(())
}

#[tauri::command]
async fn get_proxy_config() -> Result<serde_json::Value, String> {
    let data_dir = app_settings::bamboo_dir();
    let config = Config::from_data_dir(Some(data_dir));

    let (username, password, remember) = if let Some(auth) = config.proxy_auth {
        (Some(auth.username), Some(auth.password), true)
    } else if let (Ok(env_username), Ok(env_password)) = (
        std::env::var("PROXY_USERNAME"),
        std::env::var("PROXY_PASSWORD"),
    ) {
        (Some(env_username), Some(env_password), false)
    } else {
        (None, None, false)
    };

    Ok(serde_json::json!({
        "http_proxy": config.http_proxy,
        "https_proxy": config.https_proxy,
        "username": username,
        "password": password,
        "remember": remember,
    }))
}

#[tauri::command]
async fn mark_setup_incomplete() -> Result<(), String> {
    let data_dir = app_settings::bamboo_dir();
    let mut config = Config::from_data_dir(Some(data_dir.clone()));

    config.extra.insert(
        "setup".to_string(),
        serde_json::json!({
            "completed": false,
            "reset_at": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        }),
    );

    config
        .save_to_dir(data_dir)
        .map_err(|e| format!("Failed to save config: {e}"))
}

#[tauri::command]
async fn set_proxy_config(
    http_proxy: String,
    https_proxy: String,
    username: Option<String>,
    password: Option<String>,
    remember: bool,
) -> Result<(), String> {
    let http_proxy = http_proxy.trim().to_string();
    let https_proxy = https_proxy.trim().to_string();

    let username = username.unwrap_or_default().trim().to_string();
    let password = password.unwrap_or_default();
    let has_auth = !username.is_empty();

    let mut config = Config::from_data_dir(Some(app_settings::bamboo_dir()));

    config.http_proxy = http_proxy.clone();
    config.https_proxy = https_proxy.clone();

    if remember && has_auth && (!http_proxy.is_empty() || !https_proxy.is_empty()) {
        config.proxy_auth = Some(ProxyAuth { username, password });
    } else {
        config.proxy_auth = None;
    }

    config
        .save_to_dir(app_settings::bamboo_dir())
        .map_err(|e| format!("Failed to save config: {e}"))?;

    // Note: Runtime proxy auth is handled by frontend via HTTP API (POST /bamboo/proxy-auth)
    // The bamboo-agent will read proxy auth from config.json when needed

    Ok(())
}

#[tauri::command]
fn set_window_theme(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    let normalized = theme.trim().to_ascii_lowercase();
    let target_theme = match normalized.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        "system" | "" => None,
        _ => return Err(format!("Unsupported theme '{}'", theme)),
    };

    window
        .set_theme(target_theme)
        .map_err(|error| format!("Failed to set window theme: {}", error))
}

/// Toggle main window visibility - show if hidden, hide if visible
fn toggle_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(true) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_plugin = tauri_plugin_log::Builder::new()
        .level(LevelFilter::Debug)
        .clear_targets()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::Folder {
                path: app_settings::bamboo_dir().join("logs"),
                file_name: None,
            }),
        ])
        .build();
    let dialog_plugin = tauri_plugin_dialog::init();
    let fs_plugin = tauri_plugin_fs::init();

    tauri::Builder::default()
        .plugin(fs_plugin)
        .plugin(log_plugin)
        .plugin(dialog_plugin)
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Register global shortcut: Cmd+Shift+Space (or Ctrl+Shift+Space on Windows/Linux)
            #[cfg(target_os = "macos")]
            let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);
            #[cfg(not(target_os = "macos"))]
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);

            if let Err(e) = app
                .global_shortcut()
                .on_shortcut(shortcut, move |app, _, _| {
                    toggle_main_window(app);
                })
            {
                log::warn!("Failed to register global shortcut: {}", e);
            } else {
                log::info!("Global shortcut registered: Cmd/Ctrl+Shift+Space");
            }

            setup(app)
        })
        .invoke_handler(tauri::generate_handler![
            copy_to_clipboard,
            get_proxy_config,
            mark_setup_incomplete,
            set_proxy_config,
            set_window_theme,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: window_event,
                ..
            } = event
            {
                let is_close_requested =
                    matches!(window_event, tauri::WindowEvent::CloseRequested { .. });
                if should_exit_on_main_window_close(&label, is_close_requested) {
                    log::info!("Main window close requested, exiting application...");
                    app_handle.exit(0);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn should_exit_when_main_window_requests_close() {
        assert!(super::should_exit_on_main_window_close("main", true));
    }

    #[test]
    fn should_not_exit_when_non_main_window_requests_close() {
        assert!(!super::should_exit_on_main_window_close("settings", true));
    }

    #[test]
    fn should_not_exit_when_main_window_event_is_not_close_requested() {
        assert!(!super::should_exit_on_main_window_close("main", false));
    }
}
