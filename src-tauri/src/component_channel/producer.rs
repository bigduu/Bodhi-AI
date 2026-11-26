use super::stable::StableCatalog;
use super::{BambooRelease, Combination, LotusRelease, ReleaseCheckError, UpdateKind};
use semver::Version;
use std::cmp::Ordering;

pub(crate) struct Discovery {
    pub offers: Vec<Combination>,
    pub failures: Vec<String>,
    pub download_changed: bool,
}

pub(crate) fn discover(
    bamboo: Result<StableCatalog<BambooRelease>, ReleaseCheckError>,
    lotus: Result<StableCatalog<LotusRelease>, ReleaseCheckError>,
    current: &Combination,
    downloaded: Option<&Combination>,
    downloaded_local: bool,
    suppressed_lotus: Option<&str>,
    rolled_back_lotus: Option<&LotusRelease>,
) -> Discovery {
    let invalid_download = downloaded.filter(|pair| {
        !downloaded_local
            && pair.producer_release
            && match pair.update_kind(current) {
                Some(UpdateKind::Bamboo) => bamboo.as_ref().is_ok_and(|catalog| {
                    reconfirm(catalog, &pair.bamboo.version, &pair.bamboo).is_err()
                }),
                Some(UpdateKind::Lotus) => lotus.as_ref().is_ok_and(|catalog| {
                    reconfirm(catalog, &pair.lotus.version, &pair.lotus).is_err()
                }),
                _ => false,
            }
    });
    let bamboo = bamboo.map_err(String::from).and_then(|catalog| {
        let Some(entry) = catalog.recommended() else {
            return Ok(None);
        };
        if invalid_download.is_some_and(|pair| {
            pair.update_kind(current) == Some(UpdateKind::Bamboo)
                && pair.bamboo.version == entry.release.version
        }) {
            return Ok(None);
        }
        bamboo_offer(current, entry.release.clone(), entry.changes.clone())
    });
    let lotus = lotus.map_err(String::from).and_then(|catalog| {
        let Some(entry) = catalog.recommended() else {
            return Ok(None);
        };
        if invalid_download.is_some_and(|pair| {
            pair.update_kind(current) == Some(UpdateKind::Lotus)
                && pair.lotus.version == entry.release.version
        }) {
            return Ok(None);
        }
        if rolled_back_lotus.is_some_and(|recorded| {
            recorded.version == entry.release.version && recorded != &entry.release
        }) {
            return Err("The stable release identity differs from the rolled-back version".into());
        }
        if !is_newer(
            &current.lotus,
            &current.lotus.version,
            &entry.release,
            &entry.release.version,
        )? {
            return Ok(None);
        }
        let mut pair = next_pair(current, 2)?;
        pair.lotus = entry.release.clone();
        pair.changes.lotus = entry.changes.clone();
        Ok(Some(pair))
    });
    let mut discovery = collect(
        current,
        downloaded.filter(|pair| Some(*pair) != invalid_download),
        suppressed_lotus,
        bamboo,
        lotus,
    );
    if let Some(pair) = invalid_download {
        discovery.download_changed = true;
        let component = match pair.update_kind(current) {
            Some(UpdateKind::Bamboo) => "Bamboo",
            _ => "Lotus Next",
        };
        discovery.failures.push(format!(
            "{component}: The downloaded release was withdrawn from the stable catalog or its identity changed"
        ));
    }
    discovery
}

pub(crate) fn bamboo_offer(
    current: &Combination,
    release: BambooRelease,
    changes: Vec<String>,
) -> Result<Option<Combination>, String> {
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
        download_changed: false,
    };
    let mut retained = downloaded.filter(|pair| retain_download(current, pair, suppressed_lotus));
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
                            discovery.download_changed = true;
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

pub(crate) fn retain_download(
    current: &Combination,
    pair: &Combination,
    suppressed_lotus: Option<&str>,
) -> bool {
    pair.accepts_update_from(current.sequence, &current.identity())
        && (eligible(current, pair, suppressed_lotus)
            || (!pair.producer_release
                && pair.update_kind(current) == Some(UpdateKind::Pair)
                && suppressed_lotus != Some(pair.lotus.manifest_sha256.as_str())))
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

pub(crate) fn reconfirm<T: PartialEq>(
    catalog: &StableCatalog<T>,
    version: &str,
    selected: &T,
) -> Result<(), ReleaseCheckError> {
    match catalog.find(version) {
        Some(entry) if &entry.release == selected => Ok(()),
        Some(_) => Err("The stable release identity changed after discovery".into()),
        None => Err("This release is no longer listed in the Bodhi stable catalog".into()),
    }
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
        assert!(result.download_changed);
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
