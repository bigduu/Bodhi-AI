use crate::command::copy::copy_to_clipboard;
use crate::command::image::read_local_image;
use crate::command::notification::show_desktop_notification;
use crate::command::window::{is_main_window_focused, set_window_theme};
use crate::i18n::{Language, Locale};
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::menu::WINDOW_SUBMENU_ID;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, Submenu, HELP_SUBMENU_ID};
use tauri::Manager;
use tauri::{App, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_fs::FsExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tokio::time::sleep;

pub mod app_settings;
mod bamboo_profile;
mod bamboo_update;
mod bamboo_update_page;
pub mod browser_runtime;
#[cfg(test)]
#[path = "../build_support.rs"]
mod build_support;
pub mod cli_install;
pub mod command;
pub mod component_browser;
pub mod component_channel;
mod component_download;
pub mod component_kernel;
mod component_startup;
pub mod frontend;
mod i18n;
pub mod sidecar;
#[cfg(target_os = "macos")]
mod webview_recovery;
mod window_size;

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
    let locale = i18n::active(app);
    let title = locale.text("startup.failed");
    if let Some(window) = app.get_webview_window("main") {
        let encoded_title = serde_json::to_string(title).unwrap_or_default();
        let encoded_detail = serde_json::to_string(&format!("\n\n{message}")).unwrap_or_default();
        let _ = window.eval(format!(
            r#"(() => {{
                document.documentElement.lang = '{}';
                const title = document.createElement('strong');
                title.dataset.i18n = 'startup.failed';
                title.textContent = {encoded_title};
                document.body.replaceChildren(title, {encoded_detail});
                document.body.style.cssText = 'display:block;white-space:pre-wrap;padding:32px;font:15px system-ui;color:#e0918a;background:#121416';
            }})();"#,
            locale.tag()
        ));
    }
    // This also remains visible if the splash hasn't finished loading yet.
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom(
            locale.text("dialog.ok").into(),
        ))
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
    index_hash: Option<&str>,
) -> Result<tauri::Url, String> {
    if sidecar_frontend {
        let mut url = tauri::Url::parse(&format!("http://127.0.0.1:{port}"))
            .map_err(|error| format!("bad sidecar url: {error}"))?;
        if let Some(hash) = index_hash {
            // A WebView can keep a fresh cached index across app upgrades.
            // The verified index hash gives each entry page its own URL
            // while preserving the origin used by the app's local storage.
            url.query_pairs_mut().append_pair("frontend", hash);
        }
        return Ok(url);
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

fn uses_sidecar_frontend() -> bool {
    !cfg!(debug_assertions) || std::env::var("BODHI_SIDECAR_FRONTEND").is_ok()
}

fn setup<R: Runtime>(app: &mut App<R>) -> std::result::Result<(), Box<dyn std::error::Error>> {
    // Tauri's path resolver is available by setup, after its menu builder runs.
    let language = Language::load(app.handle());
    let preference = language.preference();
    let menu = build_app_menu(app.handle(), language.resolve(preference), preference)?;
    app.manage(language);
    app.set_menu(menu)?;

    window_size::create_main_window(app)?;

    #[cfg(target_os = "macos")]
    webview_recovery::observe(app.handle());

    let app_data_dir = app_settings::bamboo_dir();
    std::fs::create_dir_all(&app_data_dir)?;
    let profile = bamboo_profile::Profile::open(&app_data_dir)?;
    // The profile state is trusted by the native launcher even if the user
    // chooses a data directory normally writable by the WebView.
    app.fs_scope().forbid_directory(&profile.state_dir, true)?;
    log::info!("App data dir: {:?}", profile.data);

    // Run the bamboo backend as a managed sidecar process (replaces the in-process
    // WebService). The child is held in SidecarState and killed on app exit; it also
    // self-exits if this process dies uncleanly — see `sidecar` and the
    // `--parent-pid` orphan guard on `bamboo serve`.
    app.manage(sidecar::SidecarState::default());
    if component_startup::enabled() {
        app.manage(component_startup::Manager::new(profile)?);
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let manager = handle.state::<component_startup::Manager>();
            match manager.launch(&handle).await {
                Ok(true) => manager.poll(&handle).await,
                Ok(false) => (),
                Err(error) => log::error!("Bodhi failed to start: {error}"),
            }
        });
        return Ok(());
    }
    let sidecar_app = app.handle().clone();
    let development_url = app.config().build.dev_url.clone();
    tauri::async_runtime::spawn(async move {
        let frontend = match frontend::prepare(&sidecar_app, &profile).await {
            Ok(frontend) => frontend,
            Err(error) => {
                show_startup_failure(&sidecar_app, &error);
                return;
            }
        };
        let owns_frontend = frontend.static_dir.is_some();
        let port = web_service_port();
        if owns_frontend {
            if let Err(error) = sidecar::require_available_port(port) {
                show_startup_failure(
                    &sidecar_app,
                    &format!(
                        "{error}\n\n{}",
                        i18n::active(&sidecar_app).text("startup.portHint")
                    ),
                );
                return;
            }
        }
        if let Some(manifest) = frontend.manifest_sha256.clone() {
            match bamboo_update::Updates::for_app(&sidecar_app, profile.clone(), manifest) {
                Ok(updates) => {
                    sidecar_app.manage(updates);
                }
                Err(error) => {
                    show_startup_failure(&sidecar_app, &error);
                    return;
                }
            }
        }
        let updates = sidecar_app.try_state::<bamboo_update::Updates>();
        // Only the explicitly selected legacy rollback package retains
        // external-server reuse. Lotus Next source and package builds always own
        // the backend serving their verified resource directory.
        let launch = async {
            if !owns_frontend && sidecar::backend_already_running(port).await {
                bamboo_update::check_unmanaged_profile(&profile)?;
                log::info!("Backend already running on port {port}; reusing it");
                return Ok((None, None));
            }
            let runtime = sidecar_app.state::<sidecar::SidecarState>();
            let writer = profile.writer()?;
            let selected = match &updates {
                Some(updates) => updates.prepare_launch().await?,
                None => {
                    bamboo_update::check_unmanaged_profile(&profile)?;
                    None
                }
            };
            let command = sidecar::command(
                &sidecar_app,
                port,
                &profile.data,
                frontend.static_dir.as_deref(),
                selected.as_ref().map(|kernel| kernel.executable.as_path()),
                None,
            )?;
            let status = runtime.start(command, writer, port, None)?;
            Ok::<_, String>((Some(status), selected))
        };
        let (owned, selected) = match launch.await {
            Ok(result) => result,
            Err(error) => {
                show_startup_failure(&sidecar_app, &error);
                return;
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
            show_startup_failure(
                &sidecar_app,
                &format!(
                    "{error}\n\n{}",
                    i18n::active(&sidecar_app).text("startup.logsHint")
                ),
            );
            return;
        }
        let reported = if let (Some(_), Some(status)) = (&updates, &owned) {
            let reported = sidecar::owned_version(port, status).await;
            if let Some(kernel) = &selected {
                if reported.as_deref() != Ok(kernel.version.as_str()) {
                    sidecar::kill(&sidecar_app);
                    show_startup_failure(
                        &sidecar_app,
                        &i18n::active(&sidecar_app)
                            .format("startup.wrongVersion", &[("version", &kernel.version)]),
                    );
                    return;
                }
            }
            reported.ok()
        } else {
            None
        };
        if let Some(win) = sidecar_app.get_webview_window("main") {
            let result = ready_frontend_url(
                uses_sidecar_frontend(),
                port,
                development_url.as_ref(),
                frontend.index_hash.as_deref(),
            )
            .and_then(|url| {
                log::info!("Managed backend ready; navigating webview to {url}");
                win.navigate(url).map_err(|error| error.to_string())
            });
            if let Err(error) = result {
                sidecar::kill(&sidecar_app);
                show_startup_failure(&sidecar_app, &error);
                return;
            }
        }
        if let (Some(updates), Some(version), Some(status)) = (updates, reported, owned) {
            log::info!("Managed Bamboo {version} is ready on port {port}");
            updates.mark_ready(version, status);
        }
    });

    maybe_open_devtools(app);
    schedule_webview_diag(app);

    // One-time first-launch offer, also available from the Help menu.
    cli_install::maybe_offer_on_startup(app.handle());

    Ok(())
}

/// Build the app menu: the platform default menu (keeps the standard Edit
/// clipboard roles, which macOS needs for Cmd+C/V in the webview) with the
/// shell's own menu items.
fn build_app_menu<R: Runtime>(
    handle: &tauri::AppHandle<R>,
    locale: Locale,
    preference: Option<Locale>,
) -> std::result::Result<Menu<R>, tauri::Error> {
    let menu = Menu::default(handle)?;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            let key = match submenu.text()?.as_str() {
                "File" => "menu.file",
                "Edit" => "menu.edit",
                "View" => "menu.view",
                "Window" => "menu.window",
                "Help" => "menu.help",
                _ => continue,
            };
            submenu.set_text(locale.text(key))?;
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(window_menu) = menu
        .get(WINDOW_SUBMENU_ID)
        .as_ref()
        .and_then(|item| item.as_submenu())
    {
        window_menu.append(&MenuItem::with_id(
            handle,
            webview_recovery::RELOAD_MENU_ID,
            locale.text("menu.reload"),
            true,
            Some("Cmd+R"),
        )?)?;
    }

    let install_item = MenuItem::with_id(
        handle,
        cli_install::MENU_ID,
        locale.text("menu.installCli"),
        true,
        None::<&str>,
    )?;
    let update_kernel = MenuItem::with_id(
        handle,
        bamboo_update::MENU_ID,
        locale.text("menu.installKernel"),
        true,
        None::<&str>,
    )?;
    let apply_kernel = MenuItem::with_id(
        handle,
        bamboo_update::APPLY_MENU_ID,
        locale.text("menu.applyKernel"),
        true,
        None::<&str>,
    )?;
    let updates = MenuItem::with_id(
        handle,
        component_startup::updates::MENU_ID,
        locale.text("menu.updates"),
        true,
        None::<&str>,
    )?;
    let items = if component_startup::enabled() {
        vec![&install_item, &updates]
    } else {
        vec![&install_item, &update_kernel, &apply_kernel]
    };

    let help = menu
        .get(HELP_SUBMENU_ID)
        .and_then(|item| item.as_submenu().cloned());
    let help = if let Some(help) = help {
        help
    } else {
        let help = Submenu::with_id(handle, HELP_SUBMENU_ID, locale.text("menu.help"), true)?;
        menu.append(&help)?;
        help
    };
    for item in items {
        help.append(item)?;
    }
    let language_menu = Submenu::new(handle, locale.text("menu.language"), true)?;
    for choice in std::iter::once(None).chain(Locale::ALL.into_iter().map(Some)) {
        let label = choice.map_or_else(
            || locale.text("menu.system"),
            |language| language.text("locale.name"),
        );
        language_menu.append(&CheckMenuItem::with_id(
            handle,
            Locale::menu_id(choice),
            label,
            true,
            preference == choice,
            None::<&str>,
        )?)?;
    }
    help.append(&language_menu)?;

    Ok(menu)
}

fn change_language<R: Runtime>(
    handle: &tauri::AppHandle<R>,
    preference: Option<Locale>,
) -> anyhow::Result<()> {
    let language = handle.state::<Language>();
    let locale = language.resolve(preference);
    let menu = build_app_menu(handle, locale, preference)?;
    language.set_preference(preference)?;
    handle.set_menu(menu)?;
    if let Some(window) = handle.get_webview_window(component_startup::updates::MENU_ID) {
        window.set_title(locale.text("updates.title"))?;
    }
    // Notify the startup page even when the component manager is unavailable.
    if let Some(window) = handle
        .get_webview_window("main")
        .filter(|window| component_startup::updates::authorize(window, true).is_ok())
    {
        let _ = window.eval(format!("void window.bodhiI18n?.sync('{}');", locale.tag()));
    }
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
    let mut last_window_size = None;

    tauri::Builder::default()
        .enable_macos_default_menu(false)
        .register_uri_scheme_protocol(bamboo_update_page::SCHEME, |context, _| {
            bamboo_update_page::response(i18n::active(context.app_handle()))
        })
        .append_invoke_initialization_script(
            if component_startup::enabled() || frontend::uses_managed_frontend() {
                managed_backend_initialization(web_service_port())
            } else {
                String::new()
            },
        )
        .plugin(fs_plugin)
        .plugin(dialog_plugin)
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .on_menu_event(|app, event| {
            if let Some(preference) = Locale::from_menu_id(event.id().as_ref()) {
                if let Err(error) = change_language(app, preference) {
                    let locale = i18n::active(app);
                    if let Ok(menu) =
                        build_app_menu(app, locale, app.state::<Language>().preference())
                    {
                        let _ = app.set_menu(menu);
                    }
                    app.dialog()
                        .message(error.to_string())
                        .title(locale.text("language.saveFailed"))
                        .kind(MessageDialogKind::Error)
                        .buttons(MessageDialogButtons::OkCustom(
                            locale.text("dialog.ok").into(),
                        ))
                        .show(|_| {});
                }
                return;
            }
            if event.id() == cli_install::MENU_ID {
                cli_install::run_from_menu(app);
            }
            if event.id() == bamboo_update::MENU_ID {
                bamboo_update::run_from_menu(app);
            }
            if event.id() == bamboo_update::APPLY_MENU_ID {
                bamboo_update::apply_from_menu(app);
            }
            if event.id() == component_startup::updates::MENU_ID {
                if let Err(error) = component_startup::updates::open(app) {
                    let locale = i18n::active(app);
                    app.dialog()
                        .message(error)
                        .title(locale.text("updates.title"))
                        .kind(MessageDialogKind::Error)
                        .buttons(MessageDialogButtons::OkCustom(
                            locale.text("dialog.ok").into(),
                        ))
                        .show(|_| {});
                }
            }
            #[cfg(target_os = "macos")]
            if event.id() == webview_recovery::RELOAD_MENU_ID {
                webview_recovery::reload(app);
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
            component_startup::updates::shell_translations,
            component_startup::updates::component_snapshot,
            component_startup::updates::check_components,
            component_startup::updates::download_component_update,
            component_startup::updates::import_local_bamboo_update,
            component_startup::updates::set_component_version_skipped,
            component_startup::updates::apply_component_update,
            component_startup::updates::force_component_update,
            component_startup::updates::rollback_lotus_component,
            component_startup::updates::resume_lotus_updates,
            component_startup::updates::retry_component_startup,
            component_startup::updates::open_component_updates,
            component_startup::updates::set_component_download_settings,
            component_startup::updates::set_component_check_interval,
            component_startup::updates::save_github_update_token,
            component_startup::updates::test_github_update_token,
            component_startup::updates::remove_github_update_token,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| match &event {
            tauri::RunEvent::ExitRequested { api, .. }
                if app_handle
                    .try_state::<sidecar::SidecarState>()
                    .is_some_and(|state| state.update_requires_process()) =>
            {
                api.prevent_exit();
            }
            // App is exiting (incl. after `app_handle.exit(0)` below): make sure the
            // bamboo sidecar goes with us. Its parent-pid guard is the crash-safe
            // backstop; this is the clean path.
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                if matches!(event, tauri::RunEvent::Exit) {
                    if let Err(error) = window_size::save(app_handle, last_window_size) {
                        log::warn!("Could not save main window size: {error}");
                    }
                    #[cfg(target_os = "macos")]
                    webview_recovery::remove_observers();
                }
                sidecar::kill(app_handle);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: window_event,
                ..
            } => {
                if label == "main"
                    && matches!(
                        window_event,
                        tauri::WindowEvent::Resized(_)
                            | tauri::WindowEvent::ScaleFactorChanged { .. }
                            | tauri::WindowEvent::CloseRequested { .. }
                    )
                {
                    last_window_size = window_size::capture(app_handle).or(last_window_size);
                }
                let is_close_requested =
                    matches!(window_event, tauri::WindowEvent::CloseRequested { .. });
                if should_exit_on_main_window_close(label, is_close_requested) {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = window_event {
                        if app_handle
                            .try_state::<sidecar::SidecarState>()
                            .is_some_and(|state| state.update_requires_process())
                        {
                            api.prevent_close();
                            return;
                        }
                    }
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
            super::ready_frontend_url(false, 9562, Some(&startup), Some(&"a".repeat(64)))
                .unwrap()
                .as_str(),
            "http://127.0.0.1:1420/"
        );
        assert!(super::ready_frontend_url(false, 9562, None, None).is_err());
        assert_eq!(
            super::ready_frontend_url(true, 19562, Some(&startup), None)
                .unwrap()
                .as_str(),
            "http://127.0.0.1:19562/"
        );
    }

    #[test]
    fn ready_navigation_uses_a_distinct_url_when_the_verified_index_changes() {
        let previous_hash = "a".repeat(64);
        let next_hash = "b".repeat(64);
        let previous = super::ready_frontend_url(true, 19562, None, Some(&previous_hash)).unwrap();
        let next = super::ready_frontend_url(true, 19562, None, Some(&next_hash)).unwrap();
        assert_eq!(
            previous.as_str(),
            format!("http://127.0.0.1:19562/?frontend={previous_hash}")
        );
        assert_eq!(
            next.as_str(),
            format!("http://127.0.0.1:19562/?frontend={next_hash}")
        );
        assert_eq!(next.origin(), previous.origin());
        assert_eq!(next.path(), previous.path());
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
