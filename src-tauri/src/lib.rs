use crate::command::copy::copy_to_clipboard;
use crate::embedded::EmbeddedWebService;
use chrono::{SecondsFormat, Utc};
use log::{info, LevelFilter};
use serde_json::Value;
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

fn read_config_json() -> Result<Value, String> {
    let config_path = app_settings::config_json_path();
    app_settings::load_config_json(&config_path)
}

fn write_config_json(config: &Value) -> Result<(), String> {
    let config_path = app_settings::config_json_path();
    app_settings::write_config_json(&config_path, config)
}

fn read_proxy_auth_from_plain(config: &Value, key: &str) -> Option<bamboo_agent::core::ProxyAuth> {
    config
        .get(key)
        .cloned()
        .and_then(|value| serde_json::from_value::<bamboo_agent::core::ProxyAuth>(value).ok())
}

fn read_proxy_auth_from_encrypted(
    config: &Value,
    key: &str,
) -> Option<bamboo_agent::core::ProxyAuth> {
    let encrypted = config.get(key).and_then(|value| value.as_str())?;

    match bamboo_agent::core::encryption::decrypt(encrypted) {
        Ok(decrypted) => match serde_json::from_str::<bamboo_agent::core::ProxyAuth>(&decrypted) {
            Ok(auth) => Some(auth),
            Err(error) => {
                log::warn!(
                    "Failed to parse decrypted proxy auth from {}: {}",
                    key,
                    error
                );
                None
            }
        },
        Err(error) => {
            log::warn!("Failed to decrypt proxy auth from {}: {}", key, error);
            None
        }
    }
}

fn read_proxy_auth_from_config(
    config: &Value,
    proxy_type: &str,
) -> Option<bamboo_agent::core::ProxyAuth> {
    let encrypted_key = format!("{}_proxy_auth_encrypted", proxy_type);
    if let Some(auth) = read_proxy_auth_from_encrypted(config, &encrypted_key) {
        return Some(auth);
    }

    let plain_key = format!("{}_proxy_auth", proxy_type);
    read_proxy_auth_from_plain(config, &plain_key)
}

fn read_proxy_auth_unified(config: &Value) -> Option<bamboo_agent::core::ProxyAuth> {
    // Canonical Bamboo key (preferred).
    if let Some(auth) = read_proxy_auth_from_encrypted(config, "proxy_auth_encrypted") {
        return Some(auth);
    }

    // Legacy per-scheme keys (back-compat).
    read_proxy_auth_from_config(config, "http")
        .or_else(|| read_proxy_auth_from_config(config, "https"))
}

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
    let config = read_config_json()?;

    let http_proxy = config
        .get("http_proxy")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let https_proxy = config
        .get("https_proxy")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();

    let stored_auth = read_proxy_auth_unified(&config);

    let (username, password, remember) = if let Some(auth) = stored_auth {
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
        "http_proxy": http_proxy,
        "https_proxy": https_proxy,
        "username": username,
        "password": password,
        "remember": remember,
    }))
}

#[tauri::command]
async fn mark_setup_incomplete() -> Result<(), String> {
    let mut config = read_config_json()?;

    // If setup field exists and is an object, set completed to false
    if let Some(config_obj) = config.as_object_mut() {
        if let Some(setup_entry) = config_obj.get_mut("setup") {
            if let Some(setup_obj) = setup_entry.as_object_mut() {
                setup_obj.insert("completed".to_string(), Value::Bool(false));
                setup_obj.insert(
                    "reset_at".to_string(),
                    Value::String(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)),
                );
                return write_config_json(&config);
            }
        }
    }

    // If config doesn't have setup object, we still need to create one with completed=false
    // to force the setup flow on next launch
    let setup_obj = serde_json::json!({
        "completed": false,
        "reset_at": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
    });

    if let Some(config_obj) = config.as_object_mut() {
        config_obj.insert("setup".to_string(), setup_obj);
        write_config_json(&config)
    } else {
        // If config is not an object, create a new one
        let new_config = serde_json::json!({
            "setup": setup_obj
        });
        write_config_json(&new_config)
    }
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

    let mut config = read_config_json()?;
    let config_obj = config
        .as_object_mut()
        .ok_or_else(|| "config.json must be a JSON object".to_string())?;

    config_obj.insert("http_proxy".to_string(), Value::String(http_proxy.clone()));
    config_obj.insert(
        "https_proxy".to_string(),
        Value::String(https_proxy.clone()),
    );

    // Never persist plaintext proxy auth fields.
    config_obj.remove("http_proxy_auth");
    config_obj.remove("https_proxy_auth");
    config_obj.remove("proxy_auth");

    // Legacy keys (back-compat): older builds stored per-scheme encrypted values.
    // We now persist the canonical Bamboo field `proxy_auth_encrypted`.
    config_obj.remove("http_proxy_auth_encrypted");
    config_obj.remove("https_proxy_auth_encrypted");

    if remember && has_auth && (!http_proxy.is_empty() || !https_proxy.is_empty()) {
        let auth = bamboo_agent::core::ProxyAuth {
            username: username.clone(),
            password: password.clone(),
        };

        let auth_json =
            serde_json::to_string(&auth).map_err(|e| format!("Failed to serialize auth: {}", e))?;
        let encrypted = bamboo_agent::core::encryption::encrypt(&auth_json)
            .map_err(|e| format!("Failed to encrypt auth: {}", e))?;

        config_obj.insert("proxy_auth_encrypted".to_string(), Value::String(encrypted));
    } else {
        config_obj.remove("proxy_auth_encrypted");
    }

    write_config_json(&config)?;

    // Note: Runtime proxy auth is handled by frontend via HTTP API (POST /bamboo/proxy-auth)
    // The bamboo-agent will read proxy auth from config.json when needed

    Ok(())
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
