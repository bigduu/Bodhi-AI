use crate::command::copy::copy_to_clipboard;
use crate::command::image::read_local_image;
use crate::command::notification::show_desktop_notification;
use crate::command::window::{is_main_window_focused, set_window_theme};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, Submenu, HELP_SUBMENU_ID};
use tauri::Manager;
use tauri::{App, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tokio::time::sleep;

pub mod app_settings;
pub mod browser_runtime;
#[cfg(test)]
#[path = "../build_support.rs"]
mod build_support;
pub mod cli_install;
pub mod command;
pub mod frontend;
pub mod sidecar;

/// Default port for the bamboo sidecar backend.
/// Centralized here so the value is defined in exactly one place.
pub const DEFAULT_WEB_SERVICE_PORT: u16 = 9562;

/// Resolve the backend port, allowing a `BODHI_BACKEND_PORT` env override
/// (useful for dev, automated tests, or running multiple instances side by side).
fn web_service_port() -> u16 {
    std::env::var("BODHI_BACKEND_PORT")
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .unwrap_or(DEFAULT_WEB_SERVICE_PORT)
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

#[cfg(feature = "dev")]
fn should_open_devtools() -> bool {
    std::env::var("BODHI_OPEN_DEVTOOLS")
        .map(|value| parse_truthy_flag(&value))
        .unwrap_or(false)
}

#[cfg(feature = "dev")]
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

/// No-op when the `dev` feature is disabled (release builds).
#[cfg(not(feature = "dev"))]
fn maybe_open_devtools<R: Runtime>(_app: &App<R>) {}

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

fn show_startup_failure<R: Runtime>(app: &tauri::AppHandle<R>, message: &str) {
    log::error!("Bodhi failed to start: {message}");
    if let Some(window) = app.get_webview_window("main") {
        let encoded = serde_json::to_string(message).unwrap_or_default();
        let _ = window.eval(format!(
            "document.body.textContent = 'Bodhi failed to start\\n\\n' + {encoded}; document.body.style.cssText = 'white-space:pre-wrap;padding:32px;font:15px system-ui;color:#e0918a;background:#121416';"
        ));
    }
    // This also remains visible if the splash hasn't finished loading yet.
    app.dialog()
        .message(message)
        .title("Bodhi failed to start")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

fn managed_backend_initialization(port: u16) -> String {
    // Installed before page modules evaluate, including after navigation. The
    // existing Lotus Next runtime gives this trusted numeric port priority over
    // a persisted browser endpoint; no machine address enters the built dist.
    format!("window.__BAMBOO_BACKEND_PORT__ = {port};")
}

fn ready_frontend_url(
    sidecar_frontend: bool,
    port: u16,
    development_url: Option<&tauri::Url>,
) -> Result<tauri::Url, String> {
    if sidecar_frontend {
        return format!("http://127.0.0.1:{port}")
            .parse()
            .map_err(|error| format!("bad sidecar url: {error}"));
    }
    let mut url = development_url
        .cloned()
        .ok_or("Missing development frontend URL. Use npm run tauri:dev.")?;
    // The configured startup route serves only the splash. Keep the verified
    // dev origin, and load Lotus modules only after managed backend readiness.
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn setup<R: Runtime>(app: &mut App<R>) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let frontend = match frontend::resolve(app.handle()) {
        Ok(frontend) => frontend,
        Err(error) => {
            show_startup_failure(app.handle(), &error);
            return Ok(());
        }
    };
    let owns_frontend = frontend.static_dir.is_some();
    let port = web_service_port();
    if owns_frontend {
        if let Err(error) = sidecar::require_available_port(port) {
            show_startup_failure(app.handle(), &error);
            return Ok(());
        }
    }
    let app_data_dir = app_settings::bamboo_dir();
    std::fs::create_dir_all(&app_data_dir)?;
    log::info!("App data dir: {:?}", app_data_dir);

    // Run the bamboo backend as a managed sidecar process (replaces the in-process
    // WebService). The child is held in SidecarState and killed on app exit; it also
    // self-exits if this process dies uncleanly — see `sidecar` and the
    // `--parent-pid` orphan guard on `bamboo serve`.
    let data_dir = app_data_dir.clone();
    app.manage(sidecar::SidecarState::default());

    let sidecar_app = app.handle().clone();
    let development_url = app.config().build.dev_url.clone();
    tauri::async_runtime::spawn(async move {
        // Only the explicitly selected legacy rollback package retains
        // external-server reuse. Lotus Next source and package builds always own
        // the backend serving their verified resource directory.
        let owned = if !owns_frontend && sidecar::backend_already_running(port).await {
            log::info!("Backend already running on port {port}; reusing it");
            None
        } else {
            match sidecar::spawn(
                &sidecar_app,
                port,
                &data_dir,
                frontend.static_dir.as_deref(),
            ) {
                Ok(status) => {
                    log::info!("bamboo sidecar spawned on port {port}");
                    Some(status)
                }
                Err(error) => {
                    show_startup_failure(&sidecar_app, &error);
                    return;
                }
            }
        };

        // The initial development URL is a module-free startup page. Release
        // starts at its bundled splash. Both enter Lotus only after this same
        // owned-sidecar readiness boundary, so bootstrap cannot race startup.
        if let Err(error) = sidecar::wait_for_health(
            port,
            60,
            if owns_frontend { owned.as_ref() } else { None },
            frontend.index_hash.as_deref(),
        )
        .await
        {
            sidecar::kill(&sidecar_app);
            show_startup_failure(&sidecar_app, &error);
            return;
        }
        let use_sidecar_frontend =
            !cfg!(debug_assertions) || std::env::var("BODHI_SIDECAR_FRONTEND").is_ok();
        if let Some(win) = sidecar_app.get_webview_window("main") {
            let result = ready_frontend_url(use_sidecar_frontend, port, development_url.as_ref())
                .and_then(|url| {
                    log::info!("Managed backend ready; navigating webview to {url}");
                    win.navigate(url).map_err(|error| error.to_string())
                });
            if let Err(error) = result {
                sidecar::kill(&sidecar_app);
                show_startup_failure(&sidecar_app, &error);
            }
        }
    });

    maybe_open_devtools(app);
    schedule_webview_diag(app);

    // One-time first-launch offer, also available from the Help menu.
    cli_install::maybe_offer_on_startup(app.handle());

    Ok(())
}

/// Build the app menu: the platform default menu (keeps the standard Edit
/// clipboard roles — macOS needs them for Cmd+C/V in the webview) with the
/// CLI-install item appended under Help.
fn build_app_menu<R: Runtime>(
    handle: &tauri::AppHandle<R>,
) -> std::result::Result<Menu<R>, tauri::Error> {
    let menu = Menu::default(handle)?;
    let install_item = MenuItem::with_id(
        handle,
        cli_install::MENU_ID,
        cli_install::MENU_LABEL,
        true,
        None::<&str>,
    )?;

    let mut appended = false;
    if let Some(kind) = menu.get(HELP_SUBMENU_ID) {
        if let Some(help) = kind.as_submenu() {
            help.append(&install_item)?;
            appended = true;
        }
    }
    if !appended {
        // No Help submenu in this platform's default menu — add one so the
        // item is still reachable.
        let help = Submenu::with_items(handle, "Help", true, &[&install_item])?;
        menu.append(&help)?;
    }

    Ok(menu)
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
    // Lightweight shell logging to stderr (the bamboo sidecar owns file logging
    // under its data dir). `RUST_LOG` overrides the default level.
    env_logger::Builder::new()
        .filter_level(if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        })
        .parse_default_env()
        .init();

    let dialog_plugin = tauri_plugin_dialog::init();
    let fs_plugin = tauri_plugin_fs::init();

    tauri::Builder::default()
        .append_invoke_initialization_script(if frontend::uses_managed_frontend() {
            managed_backend_initialization(web_service_port())
        } else {
            String::new()
        })
        .plugin(fs_plugin)
        .plugin(dialog_plugin)
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            if event.id() == cli_install::MENU_ID {
                cli_install::run_from_menu(app);
            }
        })
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
            read_local_image,
            set_window_theme,
            show_desktop_notification,
            is_main_window_focused,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match &event {
            // App is exiting (incl. after `app_handle.exit(0)` below): make sure the
            // bamboo sidecar goes with us. The stdin death-link is the crash-safe
            // backstop; this is the clean path.
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                sidecar::kill(app_handle);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: window_event,
                ..
            } => {
                let is_close_requested =
                    matches!(window_event, tauri::WindowEvent::CloseRequested { .. });
                if should_exit_on_main_window_close(label, is_close_requested) {
                    log::info!("Main window close requested, exiting application...");
                    app_handle.exit(0);
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn ready_navigation_keeps_the_dev_origin_and_removes_startup_only_identity() {
        let startup = tauri::Url::parse("http://127.0.0.1:1420/__bodhi_startup?run=owned").unwrap();
        assert_eq!(
            super::ready_frontend_url(false, 9562, Some(&startup))
                .unwrap()
                .as_str(),
            "http://127.0.0.1:1420/"
        );
        assert!(super::ready_frontend_url(false, 9562, None).is_err());
        assert_eq!(
            super::ready_frontend_url(true, 19562, Some(&startup))
                .unwrap()
                .as_str(),
            "http://127.0.0.1:19562/"
        );
    }

    #[test]
    fn lotus_next_runtime_gets_only_its_numeric_managed_port() {
        assert_eq!(
            super::managed_backend_initialization(19562),
            "window.__BAMBOO_BACKEND_PORT__ = 19562;"
        );
    }

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
