#[tauri::command]
pub fn set_window_theme(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
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

#[tauri::command]
pub fn is_main_window_focused(app: tauri::AppHandle) -> bool {
    use tauri::Manager;

    app.get_webview_window("main")
        .map(|w| w.is_focused().unwrap_or(true))
        .unwrap_or(true)
}
