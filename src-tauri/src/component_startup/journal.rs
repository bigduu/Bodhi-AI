use crate::bamboo_profile::{is_link, persist, Profile};
use crate::component_channel::Combination;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Read};

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
}

impl Journal {
    pub fn read(profile: &Profile) -> Result<Self, String> {
        let path = profile.state_dir.join("components-v1.json");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.is_file() || is_link(&metadata) || metadata.len() > MAX_STATE {
            return Err("Invalid component profile state file".into());
        }
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|e| e.to_string())?
            .take(MAX_STATE + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_STATE {
            return Err("The component profile state exceeds its size limit".into());
        }
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }

    pub fn save(&self, profile: &Profile) -> Result<(), String> {
        let bytes = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_STATE {
            return Err("The component profile state exceeds its size limit".into());
        }
        let mut file =
            tempfile::NamedTempFile::new_in(&profile.state_dir).map_err(|e| e.to_string())?;
        io::Write::write_all(&mut file, &bytes).map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        persist(
            file.into_temp_path(),
            &profile.state_dir.join("components-v1.json"),
        )
        .map_err(|e| e.to_string())
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
