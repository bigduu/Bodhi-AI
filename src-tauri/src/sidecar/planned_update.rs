//! Per-process control channel for a planned Bamboo replacement.

use super::{ManagedChild, SidecarState};
use crate::bamboo_profile::{is_link, persist};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

const VERSION: u8 = 1;
const MAX_RESULT: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Action {
    Prepare,
    PrepareImmediate,
    Commit,
    Abort,
    Resume,
}

#[derive(Serialize)]
struct Command {
    version: u8,
    request_id: Uuid,
    sequence: u64,
    command: Action,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    Busy,
    Ready,
    Revoked,
    Aborted,
    Committing,
    Committed,
    Resumed,
    Error,
}

#[derive(Deserialize)]
pub(crate) struct Reply {
    version: u8,
    request_id: Uuid,
    sequence: u64,
    pub(crate) status: Status,
    #[serde(default)]
    pub(crate) pending_sessions: Vec<String>,
    pub(crate) message: Option<String>,
    pub(crate) report: Option<ResumeReport>,
}

#[derive(Deserialize)]
pub(crate) struct ResumeReport {
    pub(crate) pending_sessions: Vec<String>,
}

pub(crate) fn read_control(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > limit {
        return Err(format!(
            "Invalid Bamboo update control file: {}",
            path.display()
        ));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("The Bamboo update control file exceeds its size limit".into());
    }
    Ok(Some(bytes))
}

/// Consult the verified executable before choosing the compatibility path.
pub(crate) async fn executable_supports(path: &Path) -> Result<bool, String> {
    let mut command = tokio::process::Command::new(path);
    command
        .arg("--managed-update-protocol")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "The Bamboo update protocol probe timed out")?
        .map_err(|error| error.to_string())?;
    match (output.status.success(), output.stdout.as_slice()) {
        (true, b"1\n" | b"1\r\n") => Ok(true),
        (false, _) => Ok(false),
        _ => Err("Unsupported Bamboo update protocol response".into()),
    }
}

impl ManagedChild {
    pub(super) fn update_owner(&self) -> Option<&str> {
        self.shutdown
            .as_ref()
            .and_then(|directory| directory.path().file_name())
            .and_then(|name| name.to_str())
    }
}

impl SidecarState {
    pub(crate) fn planned_update_owner(&self) -> Result<String, String> {
        self.owned_child()?
            .update_owner()
            .map(str::to_owned)
            .ok_or("Missing identity of the owned Bamboo process".into())
    }

    #[cfg(test)]
    pub(crate) fn planned_update_available(&self) -> Result<bool, String> {
        self.has_update_capability("planned-update-v1")
    }

    pub(crate) fn immediate_update_available(&self) -> Result<bool, String> {
        self.has_update_capability("immediate-update-v1")
    }

    fn has_update_capability(&self, marker: &str) -> Result<bool, String> {
        let child = self.owned_child()?;
        let directory = child
            .shutdown
            .as_ref()
            .ok_or("Missing Bamboo control directory")?;
        Ok(read_control(&directory.path().join(marker), 0)?.is_some())
    }

    pub(crate) async fn planned_update(
        &self,
        request_id: Uuid,
        action: Action,
        timeout: Duration,
    ) -> Result<Reply, String> {
        let child = self.owned_child()?;
        let directory = child
            .shutdown
            .as_ref()
            .ok_or("Missing Bamboo control directory")?
            .path();
        let mut sequence = child.update_sequence.lock().await;
        *sequence = sequence
            .checked_add(1)
            .ok_or("Bamboo update sequence exhausted")?;
        let command = Command {
            version: VERSION,
            request_id,
            sequence: *sequence,
            command: action,
        };
        let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut file, &command).map_err(|e| e.to_string())?;
        file.flush()
            .and_then(|()| file.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        persist(
            file.into_temp_path(),
            &directory.join("planned-update-command.json"),
        )
        .map_err(|e| e.to_string())?;
        let result_path = directory.join("planned-update-result.json");
        tokio::time::timeout(timeout, async {
            loop {
                if let Some(bytes) = read_control(&result_path, MAX_RESULT)? {
                    let reply: Reply = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                    if reply.version == VERSION
                        && reply.request_id == request_id
                        && reply.sequence == command.sequence
                    {
                        return Ok(reply);
                    }
                }
                if let Some(status) = child.process.try_wait().map_err(|e| e.to_string())? {
                    return Err(format!(
                        "Managed Bamboo exited with {status} before reporting update status"
                    ));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .map_err(|_| "Timed out waiting for the managed Bamboo update response")?
    }
}
