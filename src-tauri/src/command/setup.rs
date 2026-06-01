use crate::app_settings;
use bamboo_agent::Config;
use chrono::{SecondsFormat, Utc};

#[tauri::command]
pub async fn mark_setup_incomplete() -> Result<(), String> {
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
