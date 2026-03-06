#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    // Use Web Clipboard API via JavaScript in Tauri
    // This avoids native clipboard library dependencies
    // The frontend should use navigator.clipboard as fallback
    #[cfg(not(target_os = "linux"))]
    {
        use arboard::Clipboard;
        let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
        clipboard.set_text(text).map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, suggest using Web API
        // The frontend should handle this gracefully
        Err("Clipboard not available on Linux - use Web API".to_string())
    }
}
