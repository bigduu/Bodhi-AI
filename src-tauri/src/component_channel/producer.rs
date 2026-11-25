use super::{bamboo_release, lotus_release, Combination, LotusRelease, UpdateKind};
use crate::component_download::DownloadSettings;
use semver::Version;
use std::cmp::Ordering;

pub(crate) struct Discovery {
    pub offers: Vec<Combination>,
    pub failures: Vec<String>,
}

pub(crate) async fn discover(
    settings: &DownloadSettings,
    current: &Combination,
    downloaded: Option<&Combination>,
    suppressed_lotus: Option<&str>,
    rolled_back_lotus: Option<&LotusRelease>,
    legacy_lotus: impl FnOnce(&LotusRelease) -> bool,
) -> Discovery {
    let (bamboo, lotus) = tokio::join!(
        bamboo_release::load_latest(settings),
        lotus_release::discover_lotus(settings, None),
    );
    let bamboo = bamboo.and_then(|(release, changes)| {
        if !is_newer(
            &current.bamboo,
            &current.bamboo.version,
            &release,
            &release.version,
        )? {
            return Ok(None);
        }
        let mut pair = next_pair(current, 1)?;
        pair.bamboo = release;
        pair.changes.bamboo = changes;
        Ok(Some(pair))
    });
    let lotus = lotus.and_then(|found| {
        if rolled_back_lotus.is_some_and(|recorded| {
            recorded.version == found.release.version && recorded != &found.release
        }) {
            return Err(
                "The official release identity differs from the rolled-back version".into(),
            );
        }
        if !is_newer(
            &current.lotus,
            &current.lotus.version,
            &found.release,
            &found.release.version,
        )? {
            return Ok(None);
        }
        if found.requirements.is_none() && !legacy_lotus(&found.release) {
            return Err("This Lotus Next release has no verified Bootstrap requirements".into());
        }
        let mut pair = next_pair(current, 2)?;
        pair.lotus = found.release;
        pair.changes.lotus = found.changes;
        Ok(Some(pair))
    });
    collect(current, downloaded, suppressed_lotus, bamboo, lotus)
}

fn collect(
    current: &Combination,
    downloaded: Option<&Combination>,
    suppressed_lotus: Option<&str>,
    bamboo: Result<Option<Combination>, String>,
    lotus: Result<Option<Combination>, String>,
) -> Discovery {
    let mut discovery = Discovery {
        offers: Vec::new(),
        failures: Vec::new(),
    };
    let mut retained = downloaded.filter(|pair| {
        pair.accepts_update_from(current.sequence, &current.identity())
            && (eligible(current, pair, suppressed_lotus)
                || (!pair.producer_release
                    && pair.update_kind(current) == Some(UpdateKind::Pair)
                    && suppressed_lotus != Some(pair.lotus.manifest_sha256.as_str())))
    });
    for (name, result) in [("Bamboo", bamboo), ("Lotus Next", lotus)] {
        match result {
            Ok(Some(mut pair)) if eligible(current, &pair, suppressed_lotus) => {
                if let Some(saved) = retained {
                    let matches_version =
                        match (pair.update_kind(current), saved.update_kind(current)) {
                            (Some(UpdateKind::Bamboo), Some(UpdateKind::Bamboo)) => {
                                pair.bamboo.version == saved.bamboo.version
                            }
                            (Some(UpdateKind::Lotus), Some(UpdateKind::Lotus)) => {
                                pair.lotus.version == saved.lotus.version
                            }
                            _ => false,
                        };
                    if matches_version {
                        if pair.bamboo != saved.bamboo || pair.lotus != saved.lotus {
                            discovery.failures.push(format!(
                                "{name} changed the identity of a downloaded release"
                            ));
                            retained = None;
                        }
                        continue;
                    }
                    if saved.sequence == pair.sequence {
                        let Some(sequence) = pair.sequence.checked_add(2) else {
                            discovery
                                .failures
                                .push(format!("{name} update sequence overflow"));
                            continue;
                        };
                        pair.sequence = sequence;
                    }
                }
                discovery.offers.push(pair);
            }
            Ok(_) => {}
            Err(error) => discovery.failures.push(format!("{name}: {error}")),
        }
    }
    if let Some(saved) = retained {
        discovery.offers.push(saved.clone());
    }
    discovery
}

fn eligible(current: &Combination, pair: &Combination, suppressed_lotus: Option<&str>) -> bool {
    match pair.update_kind(current) {
        Some(UpdateKind::Bamboo) => newer_version(&pair.bamboo.version, &current.bamboo.version),
        Some(UpdateKind::Lotus) => {
            suppressed_lotus != Some(pair.lotus.manifest_sha256.as_str())
                && newer_version(&pair.lotus.version, &current.lotus.version)
        }
        _ => false,
    }
}

fn newer_version(new: &str, old: &str) -> bool {
    Version::parse(new)
        .ok()
        .zip(Version::parse(old).ok())
        .is_some_and(|(new, old)| new > old)
}

fn is_newer<T: PartialEq>(
    current: &T,
    current_version: &str,
    published: &T,
    published_version: &str,
) -> Result<bool, String> {
    let version = |value: &str| Version::parse(value).map_err(|error| error.to_string());
    match version(published_version)?.cmp(&version(current_version)?) {
        Ordering::Greater => Ok(true),
        Ordering::Equal if published != current => {
            Err("The official release identity differs from the active version".into())
        }
        _ => Ok(false),
    }
}

fn next_pair(current: &Combination, offset: u64) -> Result<Combination, String> {
    let mut pair = current.clone();
    pair.sequence = current
        .sequence
        .checked_add(offset)
        .ok_or("Update sequence overflow")?;
    pair.bootstrap = false;
    pair.producer_release = true;
    pair.accepts = vec![current.identity()];
    pair.changes.bamboo.clear();
    pair.changes.lotus.clear();
    Ok(pair)
}

pub(crate) async fn reconfirm(
    settings: &DownloadSettings,
    current: &Combination,
    selected: &Combination,
) -> Result<(), String> {
    if !selected.producer_release
        || !selected.accepts_update_from(current.sequence, &current.identity())
        || !eligible(current, selected, None)
    {
        return Err("This producer release is no longer applicable".into());
    }
    let matches = match selected.update_kind(current) {
        Some(UpdateKind::Bamboo) => {
            bamboo_release::load_version(settings, &selected.bamboo.version)
                .await?
                .0
                == selected.bamboo
        }
        Some(UpdateKind::Lotus) => {
            lotus_release::discover_lotus(settings, Some(&selected.lotus.version))
                .await?
                .release
                == selected.lotus
        }
        _ => false,
    };
    if !matches {
        return Err("The official release identity changed after discovery".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::component_channel::tests::initial_combination;

    #[tokio::test]
    async fn producer_offers_keep_the_active_peer_and_survive_a_peer_failure() {
        let active = initial_combination().await;
        let mut bamboo = next_pair(&active, 1).unwrap();
        bamboo.bamboo.version = "2026.11.95".into();
        bamboo.bamboo.manifest.sha256 = "d".repeat(64);
        let result = collect(
            &active,
            None,
            None,
            Ok(Some(bamboo.clone())),
            Err("registry is unavailable".into()),
        );
        assert_eq!(result.offers, [bamboo.clone()]);
        assert_eq!(bamboo.lotus, active.lotus);
        assert!(bamboo.accepts_update_from(active.sequence, &active.identity()));
        assert_eq!(result.failures, ["Lotus Next: registry is unavailable"]);
    }

    #[tokio::test]
    async fn discovery_retains_an_exact_staged_version_when_the_producer_advances() {
        let active = initial_combination().await;
        let mut staged = next_pair(&active, 1).unwrap();
        staged.bamboo.version = "2026.11.95".into();
        staged.bamboo.manifest.sha256 = "e".repeat(64);
        let mut newer = staged.clone();
        newer.bamboo.version = "2026.11.96".into();
        newer.bamboo.manifest.sha256 = "f".repeat(64);
        let result = collect(&active, Some(&staged), None, Ok(Some(newer)), Ok(None));
        assert_eq!(result.offers.len(), 2);
        assert_ne!(result.offers[0].sequence, staged.sequence);
        assert_eq!(result.offers[1], staged);

        let mut rewritten = staged.clone();
        rewritten.bamboo.manifest.sha256 = "f".repeat(64);
        let result = collect(&active, Some(&staged), None, Ok(Some(rewritten)), Ok(None));
        assert!(result.offers.is_empty());
        assert_eq!(result.failures.len(), 1);
    }

    #[tokio::test]
    async fn rollback_suppression_and_identity_checks_apply_to_producer_updates() {
        let active = initial_combination().await;
        let mut lotus = next_pair(&active, 2).unwrap();
        lotus.lotus.version = "2026.11.95".into();
        lotus.lotus.manifest_sha256 = "e".repeat(64);
        let suppressed = lotus.lotus.manifest_sha256.clone();
        let result = collect(&active, None, Some(&suppressed), Ok(None), Ok(Some(lotus)));
        assert!(result.offers.is_empty());
        assert!(!is_newer(&"digest", "2026.11.4", &"digest", "2026.11.3").unwrap());
        assert!(is_newer(&"digest", "2026.11.4", &"changed", "2026.11.4").is_err());
    }
}
