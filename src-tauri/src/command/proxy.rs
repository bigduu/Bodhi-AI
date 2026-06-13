use crate::app_settings;
use bamboo_agent::core::ProxyAuth;
use bamboo_agent::Config;

#[tauri::command]
pub async fn get_proxy_config() -> Result<serde_json::Value, String> {
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
pub async fn set_proxy_config(
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
