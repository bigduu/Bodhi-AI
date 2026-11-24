//! Selection from the official catalog of independently published components.
use crate::component_download::DownloadSettings;
use reqwest::{redirect::Policy, StatusCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const STABLE_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/bigduu/Bodhi-AI/components-stable/channel-v1.json";
const MAX_CHANNEL_BYTES: usize = 1024 * 1024;
pub const SHELL_PROTOCOL: u32 = 1;
pub const NATIVE_TARGETS: [&str; 5] = [
    "aarch64-apple-darwin",
    "aarch64-pc-windows-msvc",
    "aarch64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
];

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeArtifact {
    pub target: String,
    pub asset_name: String,
    pub executable: Asset,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_runtime: Option<BrowserRuntimeArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserRuntimeArtifact {
    pub asset_name: String,
    pub archive: Asset,
    pub receipt_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BambooRelease {
    pub version: String,
    pub source_revision: String,
    pub manifest: Asset,
    pub browser_host: Asset,
    pub artifacts: Vec<NativeArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LotusRelease {
    pub version: String,
    pub source_revision: String,
    pub manifest_sha256: String,
    pub resources_sha256: String,
    pub tarball: Asset,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairIdentity {
    pub bamboo_manifest_sha256: String,
    pub lotus_manifest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Changes {
    pub bamboo: Vec<String>,
    pub lotus: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Combination {
    pub sequence: u64,
    pub bootstrap: bool,
    accepts: Vec<PairIdentity>,
    pub bamboo: BambooRelease,
    pub lotus: LotusRelease,
    pub changes: Changes,
}

impl Combination {
    pub fn identity(&self) -> PairIdentity {
        PairIdentity {
            bamboo_manifest_sha256: self.bamboo.manifest.sha256.clone(),
            lotus_manifest_sha256: self.lotus.manifest_sha256.clone(),
        }
    }

    pub(crate) fn candidate(&self) -> Result<Candidate<'_>, String> {
        let target = env!("BODHI_BUILD_TARGET");
        let mut artifacts = self
            .bamboo
            .artifacts
            .iter()
            .filter(|artifact| artifact.target == target);
        let artifact = artifacts
            .next()
            .ok_or("The component release has no native asset for this target")?;
        if artifacts.next().is_some() {
            return Err("The component release contains duplicate native assets".into());
        }
        Ok(Candidate {
            combination: self,
            artifact,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Channel {
    schema_version: u32,
    shell_protocol: u32,
    combinations: Vec<Combination>,
}

#[derive(Debug)]
pub struct VerifiedChannel(Channel);

#[derive(Debug)]
pub struct Candidate<'a> {
    pub combination: &'a Combination,
    pub artifact: &'a NativeArtifact,
}

impl VerifiedChannel {
    pub fn select(
        &self,
        current: Option<(u64, &PairIdentity)>,
    ) -> Result<Option<Candidate<'_>>, String> {
        self.select_for_target(current, env!("BODHI_BUILD_TARGET"))
    }

    fn select_for_target(
        &self,
        current: Option<(u64, &PairIdentity)>,
        target: &str,
    ) -> Result<Option<Candidate<'_>>, String> {
        let target_index = NATIVE_TARGETS
            .iter()
            .position(|supported| *supported == target)
            .ok_or("The component channel does not support this native target")?;
        Ok(self.0.combinations.iter().rev().find_map(|combination| {
            let compatible = match current {
                None => combination.bootstrap,
                Some((sequence, identity)) => {
                    combination.sequence > sequence
                        && combination.identity() != *identity
                        && combination.accepts.contains(identity)
                }
            };
            compatible.then(|| Candidate {
                combination,
                artifact: &combination.bamboo.artifacts[target_index],
            })
        }))
    }
}

/// The catalog comes from the official repository over HTTPS. Download
/// mirrors apply to archives whose size and digest the catalog already fixes.
pub(crate) async fn load_stable(settings: &DownloadSettings) -> Result<VerifiedChannel, String> {
    let client = settings
        .client()?
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.without_url().to_string())?;
    let mut response = client
        .get(STABLE_CATALOG_URL)
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    if response.status() != StatusCode::OK {
        return Err(format!(
            "The component catalog returned HTTP {}",
            response.status()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| error.without_url().to_string())?
    {
        if chunk.len() > MAX_CHANNEL_BYTES - bytes.len() {
            return Err("The component catalog exceeds its size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse(&bytes)
}

fn parse(bytes: &[u8]) -> Result<VerifiedChannel, String> {
    let channel: Channel = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if channel.schema_version != 1 || channel.shell_protocol != SHELL_PROTOCOL {
        return Err("The component channel requires a different Bodhi protocol".into());
    }
    if !(1..=64).contains(&channel.combinations.len())
        || !channel
            .combinations
            .iter()
            .any(|combination| combination.bootstrap)
    {
        return Err("Invalid component catalog inventory".into());
    }
    let mut sequence = 0;
    for combination in &channel.combinations {
        let bamboo = &combination.bamboo;
        let lotus = &combination.lotus;
        if combination.sequence <= sequence
            || !stable_version(&bamboo.version)
            || !stable_version(&lotus.version)
            || !hex(&bamboo.source_revision, 40)
            || !hex(&lotus.source_revision, 40)
            || !hex(&lotus.manifest_sha256, 64)
            || !hex(&lotus.resources_sha256, 64)
            || !asset(&bamboo.manifest, 1, 1024 * 1024)
            || !asset(&bamboo.browser_host, 1, 8 * 1024 * 1024)
            || !asset(&lotus.tarball, 1, 32 * 1024 * 1024)
        {
            return Err("Invalid component release identity".into());
        }
        if bamboo.artifacts.len() != NATIVE_TARGETS.len()
            || !bamboo
                .artifacts
                .iter()
                .zip(NATIVE_TARGETS)
                .all(|(artifact, target)| {
                    artifact.target == target
                        && artifact.asset_name == native_asset_name(target)
                        && asset(&artifact.executable, 65_536, 1024 * 1024 * 1024)
                        && artifact.browser_runtime.as_ref().is_none_or(|runtime| {
                            runtime.asset_name
                                == format!("bamboo-browser-runtime-v1-{target}.tar.gz")
                                && asset(&runtime.archive, 1, 768 * 1024 * 1024)
                                && hex(&runtime.receipt_sha256, 64)
                        })
                })
        {
            return Err("Invalid Bamboo native artifact inventory".into());
        }
        if combination.accepts.len() > 64
            || !combination.accepts.iter().all(|identity| {
                hex(&identity.bamboo_manifest_sha256, 64)
                    && hex(&identity.lotus_manifest_sha256, 64)
            })
            || !notes(&combination.changes.bamboo)
            || !notes(&combination.changes.lotus)
        {
            return Err("Invalid compatibility or change record".into());
        }
        sequence = combination.sequence;
    }
    Ok(VerifiedChannel(channel))
}

fn native_asset_name(target: &str) -> String {
    let suffix = if target.ends_with("-windows-msvc") {
        ".exe"
    } else {
        ""
    };
    format!("bamboo-{target}{suffix}")
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn stable_version(version: &str) -> bool {
    semver::Version::parse(version)
        .is_ok_and(|parsed| parsed.major > 0 && parsed.pre.is_empty() && parsed.build.is_empty())
}

fn asset(value: &Asset, min: u64, max: u64) -> bool {
    (min..=max).contains(&value.size_bytes) && hex(&value.sha256, 64)
}

fn notes(lines: &[String]) -> bool {
    lines.len() <= 64
        && lines
            .iter()
            .all(|line| line.len() <= 2048 && !line.trim().is_empty())
}

#[cfg(test)]
pub(crate) mod tests;
