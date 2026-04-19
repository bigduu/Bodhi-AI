pub use bamboo_agent::infrastructure::paths::{bamboo_dir, config_json_path, keyword_masking_json_path};

pub fn load_config_json(path: &std::path::Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse config.json: {e}"))
}

