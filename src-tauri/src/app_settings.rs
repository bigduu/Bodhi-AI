//! Self-contained config-path helpers for the Bodhi shell.
//!
//! These replicate bamboo's data-dir resolution (`BAMBOO_DATA_DIR` env, else
//! `~/.bamboo`) so the shell reads/writes the same `config.json` the bamboo
//! sidecar uses. Bodhi also passes this dir to the sidecar via `--data-dir`,
//! keeping both sides in lockstep without linking the bamboo crate.

use std::path::PathBuf;

/// Resolve the bamboo data directory. Mirrors `bamboo_config::paths::resolve_bamboo_dir`:
/// 1) the `BAMBOO_DATA_DIR` environment variable, else 2) `${HOME}/.bamboo`, else 3) `.bamboo`.
pub fn bamboo_dir() -> PathBuf {
    match std::env::var("BAMBOO_DATA_DIR") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => match dirs::home_dir() {
            Some(home) => home.join(".bamboo"),
            None => PathBuf::from(".bamboo"),
        },
    }
}

/// Path to `config.json` in the data directory.
pub fn config_json_path() -> PathBuf {
    bamboo_dir().join("config.json")
}

/// Path to `keyword_masking.json` in the data directory.
pub fn keyword_masking_json_path() -> PathBuf {
    bamboo_dir().join("keyword_masking.json")
}

/// Read `config.json` as a raw JSON value (empty object if the file is absent).
pub fn load_config_json(path: &std::path::Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse config.json: {e}"))
}
