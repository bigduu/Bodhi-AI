use crate::bamboo_profile::{is_link, persist, Profile};
use crate::component_channel::Combination;
use crate::component_download::{DownloadSettings, DownloadSource};
use chrono::Utc;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Read};

const JOURNAL: &str = "components-v1.json";
const DOWNLOAD_SETTINGS: &str = "component-download-settings-v1.json";
const VERIFIED_DOWNLOAD: &str = "component-verified-download-v1.json";
const MAX_STATE: u64 = 2 * 1024 * 1024;
const HISTORY_LIMIT: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Versions {
    pub bamboo: String,
    pub lotus: String,
}

impl From<&Combination> for Versions {
    fn from(pair: &Combination) -> Self {
        Self {
            bamboo: pair.bamboo.version.clone(),
            lotus: pair.lotus.version.clone(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct History {
    pub sequence: u64,
    pub at: String,
    pub from: Option<Versions>,
    pub to: Versions,
    pub effective: Option<Versions>,
    pub error: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Journal {
    pub active: Option<Combination>,
    pub queued: Option<Combination>,
    pub trial: Option<Combination>,
    pub history: Vec<History>,
    #[serde(default)]
    pub source: DownloadSource,
    #[serde(default)]
    pub last_check: Option<String>,
    #[serde(default)]
    pub remind_after: Option<i64>,
}

impl Journal {
    pub fn read(profile: &Profile) -> Result<Self, String> {
        Ok(read_json(profile, JOURNAL)?.unwrap_or_default())
    }

    pub fn save(&self, profile: &Profile) -> Result<(), String> {
        save_json(profile, JOURNAL, self)
    }

    pub fn next(&self) -> Option<&Combination> {
        self.trial
            .as_ref()
            .or(self.queued.as_ref())
            .or(self.active.as_ref())
    }

    pub fn record(&mut self, selected: &Combination, error: Option<String>) {
        let from = self.active.as_ref().map(Versions::from);
        if error.is_none()
            && self
                .active
                .as_ref()
                .is_some_and(|active| active.identity() == selected.identity())
        {
            return;
        }
        self.history.push(History {
            sequence: selected.sequence,
            at: Utc::now().to_rfc3339(),
            from,
            to: Versions::from(selected),
            effective: error.is_none().then(|| Versions::from(selected)),
            error,
        });
        if self.history.len() > HISTORY_LIMIT {
            self.history.drain(..self.history.len() - HISTORY_LIMIT);
        }
    }
}

pub(super) fn read_settings(profile: &Profile) -> Result<DownloadSettings, String> {
    if let Some(settings) = read_json::<DownloadSettings>(profile, DOWNLOAD_SETTINGS)? {
        return settings.validated();
    }
    Ok(DownloadSettings {
        source: Journal::read(profile)?.source,
        ..DownloadSettings::default()
    })
}

pub(super) fn save_settings(profile: &Profile, settings: &DownloadSettings) -> Result<(), String> {
    save_json(profile, DOWNLOAD_SETTINGS, settings)
}

pub(super) fn read_downloaded(profile: &Profile) -> Result<Option<Combination>, String> {
    read_json(profile, VERIFIED_DOWNLOAD)
}

pub(super) fn save_downloaded(profile: &Profile, pair: &Combination) -> Result<(), String> {
    save_json(profile, VERIFIED_DOWNLOAD, pair)
}

fn read_json<T: DeserializeOwned>(profile: &Profile, name: &str) -> Result<Option<T>, String> {
    let path = profile.state_dir.join(name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > MAX_STATE {
        return Err(format!("Invalid component profile state file: {name}"));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_STATE + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_STATE {
        return Err("The component profile state exceeds its size limit".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn save_json(profile: &Profile, name: &str, state: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_STATE {
        return Err("The component profile state exceeds its size limit".into());
    }
    let mut file =
        tempfile::NamedTempFile::new_in(&profile.state_dir).map_err(|error| error.to_string())?;
    io::Write::write_all(&mut file, &bytes).map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    persist(file.into_temp_path(), &profile.state_dir.join(name)).map_err(|error| error.to_string())
}
