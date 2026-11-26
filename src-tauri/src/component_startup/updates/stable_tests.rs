use super::*;
use crate::bamboo_profile::Profile;
use crate::component_channel::tests::initial_combination;
use crate::component_channel::{
    stable, Asset, BambooRelease, BrowserRuntimeArtifact, LotusRelease,
};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;

async fn direct_profile() -> (tempfile::TempDir, Profile, Combination) {
    let directory = tempfile::tempdir().unwrap();
    let profile = Profile::open(directory.path()).unwrap();
    let mut active = initial_combination().await;
    active.sequence = 200;
    active.bootstrap = false;
    active.producer_release = true;
    active.bamboo = bamboo_release(&active.bamboo, "2026.11.48", "b");
    active.lotus = lotus_release(&active.lotus, "2026.11.34", "c");
    Journal {
        active: Some(active.clone()),
        ..Journal::default()
    }
    .save(&profile)
    .unwrap();
    (directory, profile, active)
}

fn bamboo_release(base: &BambooRelease, version: &str, digest: &str) -> BambooRelease {
    let mut release = base.clone();
    release.version = version.into();
    release.manifest.sha256 = digest.repeat(64);
    for artifact in &mut release.artifacts {
        artifact.browser_runtime = Some(BrowserRuntimeArtifact {
            asset_name: format!("bamboo-browser-runtime-v1-{}.tar.gz", artifact.target),
            archive: Asset {
                sha256: "1".repeat(64),
                size_bytes: 65536,
            },
            receipt_sha256: "2".repeat(64),
        });
    }
    release
}

fn lotus_release(base: &LotusRelease, version: &str, digest: &str) -> LotusRelease {
    let mut release = base.clone();
    release.version = version.into();
    release.manifest_sha256 = digest.repeat(64);
    release
}

fn document<R: Serialize>(revision: u64, recommended: Option<&str>, releases: &[R]) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "schemaVersion": 1,
        "revision": revision,
        "recommendedVersion": recommended,
        "releases": releases.iter().map(|release| json!({
            "release": release,
            "changes": ["Approved by Bodhi"]
        })).collect::<Vec<_>>(),
    }))
    .unwrap()
}

#[tokio::test]
async fn native_stable_check_and_apply_confirmation_target_the_raw_catalog_when_unreachable() {
    let (_directory, profile, active) = direct_profile().await;
    let recommended = bamboo_release(&active.bamboo, "2026.11.49", "d");
    let downloaded = producer::bamboo_offer(&active, recommended, Vec::new())
        .unwrap()
        .unwrap();
    journal::save_downloaded(&profile, &downloaded).unwrap();

    // Observe CONNECT targets and simulate transport failure without accessing
    // any external service or relying on the host's proxy or GitHub quota.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let proxy = tokio::spawn(async move {
        while let Ok((connection, _)) = listener.accept().await {
            let mut request_line = String::new();
            BufReader::new(connection)
                .read_line(&mut request_line)
                .await
                .unwrap();
            if let Some(host) = request_line.split_whitespace().nth(1) {
                seen.lock().unwrap().push(host.to_owned());
            }
        }
    });

    let manager = Manager::new(profile.clone()).unwrap();
    manager
        .remember_settings(DownloadSettings {
            proxy_url: Some(proxy_url),
            ..DownloadSettings::default()
        })
        .unwrap();

    assert!(!manager.check().await);
    assert_eq!(
        journal::read_downloaded(&profile).unwrap(),
        Some(downloaded.clone())
    );
    let snapshot = manager.snapshot("0.0.0".into(), Locale::English).unwrap();
    assert!(snapshot
        .offers
        .iter()
        .any(|offer| offer.kind == UpdateKind::Bamboo && offer.downloaded));
    assert_eq!(manager.choose().await.unwrap(), active);

    let update = SelectedUpdate {
        current_sequence: active.sequence,
        current: active.identity(),
        candidate: downloaded,
    };
    assert!(matches!(
        manager
            .reconfirm_selected(&active, &update, Locale::English)
            .await,
        Err(ReleaseCheckError::Unavailable(_))
    ));
    allow_cached_immediate_update(manager.reconfirm_selected(&active, &update, Locale::English))
        .await
        .unwrap();

    let requests = requests.lock().unwrap();
    assert!(requests.len() >= 4, "{requests:?}");
    assert!(
        requests
            .iter()
            .all(|host| host == "raw.githubusercontent.com:443"),
        "{requests:?}"
    );
    proxy.abort();
}

#[tokio::test]
async fn stable_check_offers_each_component_to_a_directly_updated_profile() {
    let (_directory, profile, active) = direct_profile().await;
    let manager = Manager::new(profile.clone()).unwrap();
    let bamboo = bamboo_release(&active.bamboo, "2026.11.49", "d");
    let lotus = lotus_release(&active.lotus, "2026.11.35", "e");
    let bamboo_json = document(1, Some(&bamboo.version), std::slice::from_ref(&bamboo));
    let lotus_json = document(1, Some(&lotus.version), std::slice::from_ref(&lotus));
    assert!(
        manager
            .check_with_catalogs(|_| async {
                (
                    stable::parse_bamboo(&bamboo_json),
                    stable::parse_lotus(&lotus_json),
                )
            })
            .await
    );
    let snapshot = manager.snapshot("0.0.0".into(), Locale::English).unwrap();
    assert_eq!(snapshot.offers.len(), 2);
    assert!(snapshot.display.error.is_none());
    for offer in snapshot.offers {
        let selected = manager
            .updates
            .selected(offer.sequence, &offer.identity, Locale::English)
            .unwrap();
        assert!(selected.candidate.sequence > active.sequence);
        assert!(selected.candidate.producer_release);
        let saved = Journal::read(&profile).unwrap();
        assert_eq!(selected.validate_transition(&saved).unwrap(), &active);
        match offer.kind {
            UpdateKind::Bamboo => {
                assert_eq!(selected.candidate.bamboo, bamboo);
                assert_eq!(selected.candidate.lotus, active.lotus);
                assert_eq!(offer.changes.bamboo, ["Approved by Bodhi"]);
            }
            UpdateKind::Lotus => {
                assert_eq!(selected.candidate.bamboo, active.bamboo);
                assert_eq!(selected.candidate.lotus, lotus);
                assert_eq!(offer.changes.lotus, ["Approved by Bodhi"]);
            }
            UpdateKind::Pair => panic!("independent catalogs offered a pair update"),
        }
    }
    assert_eq!(manager.choose().await.unwrap(), active);

    let older = bamboo_release(&active.bamboo, "2026.11.46", "a");
    let older_json = document(2, Some(&older.version), std::slice::from_ref(&older));
    assert!(
        manager
            .check_with_catalogs(|_| async {
                (
                    stable::parse_bamboo(&older_json),
                    stable::parse_lotus(&lotus_json),
                )
            })
            .await
    );
    let snapshot = manager.snapshot("0.0.0".into(), Locale::English).unwrap();
    assert_eq!(snapshot.offers.len(), 1);
    assert_eq!(snapshot.offers[0].kind, UpdateKind::Lotus);
    assert_eq!(snapshot.offers[0].versions.bamboo, active.bamboo.version);
}

#[tokio::test]
async fn first_catalog_cannot_pin_a_changed_active_release() {
    let (_directory, profile, active) = direct_profile().await;
    let manager = Manager::new(profile.clone()).unwrap();
    let rewritten = bamboo_release(&active.bamboo, &active.bamboo.version, "d");
    let newer = bamboo_release(&active.bamboo, "2026.11.49", "e");
    let lotus = document(
        1,
        Some(&active.lotus.version),
        std::slice::from_ref(&active.lotus),
    );
    let conflicting = document(9, Some(&newer.version), &[rewritten, newer.clone()]);
    assert!(
        !manager
            .check_with_catalogs(|_| async {
                (
                    stable::parse_bamboo(&conflicting),
                    stable::parse_lotus(&lotus),
                )
            })
            .await
    );
    let rejected = manager.snapshot("0.0.0".into(), Locale::English).unwrap();
    assert!(rejected
        .display
        .error
        .unwrap()
        .contains("changed the identity of an admitted version"));
    assert_eq!(manager.choose().await.unwrap(), active);

    let corrected = document(
        9,
        Some(&newer.version),
        &[active.bamboo.clone(), newer.clone()],
    );
    let reopened = Manager::new(profile).unwrap();
    assert!(
        reopened
            .check_with_catalogs(|_| async {
                (
                    stable::parse_bamboo(&corrected),
                    stable::parse_lotus(&lotus),
                )
            })
            .await
    );
    let accepted = reopened.snapshot("0.0.0".into(), Locale::English).unwrap();
    assert_eq!(accepted.offers.len(), 1);
    assert_eq!(accepted.offers[0].versions.bamboo, newer.version);
    assert!(accepted.display.error.is_none());
}

#[tokio::test]
async fn stable_check_withdraws_changed_or_removed_downloads_and_keeps_the_other_offer() {
    let (_directory, profile, active) = direct_profile().await;
    let manager = Manager::new(profile.clone()).unwrap();
    let bamboo = bamboo_release(&active.bamboo, "2026.11.49", "d");
    let mut rewritten = bamboo.clone();
    rewritten.artifacts[0].executable.sha256 = "9".repeat(64);
    let downloaded = producer::bamboo_offer(&active, bamboo.clone(), Vec::new())
        .unwrap()
        .unwrap();
    let lotus = lotus_release(&active.lotus, "2026.11.35", "e");
    let lotus_json = document(1, Some(&lotus.version), std::slice::from_ref(&lotus));

    let original = stable::parse_bamboo(&document(
        1,
        Some(&bamboo.version),
        std::slice::from_ref(&bamboo),
    ))
    .unwrap();
    producer::reconfirm(&original, &bamboo.version, &bamboo).unwrap();

    for (revision, recommendation, releases) in [
        (2, Some(rewritten.version.as_str()), vec![rewritten.clone()]),
        (3, None, Vec::new()),
    ] {
        journal::save_downloaded(&profile, &downloaded).unwrap();
        let bamboo_json = document(revision, recommendation, &releases);
        let rejected = stable::parse_bamboo(&bamboo_json).unwrap();
        assert!(matches!(
            producer::reconfirm(&rejected, &bamboo.version, &bamboo),
            Err(ReleaseCheckError::Rejected(_))
        ));
        assert!(
            manager
                .check_with_catalogs(|_| async {
                    (
                        stable::parse_bamboo(&bamboo_json),
                        stable::parse_lotus(&lotus_json),
                    )
                })
                .await
        );
        assert!(journal::read_downloaded(&profile).unwrap().is_none());
        let snapshot = manager.snapshot("0.0.0".into(), Locale::English).unwrap();
        assert_eq!(snapshot.offers.len(), 1);
        assert_eq!(snapshot.offers[0].kind, UpdateKind::Lotus);
        assert!(snapshot.display.error.unwrap().contains("Bamboo"));

        if recommendation.is_some() {
            // Removing the old download must never make this rewritten
            // version a fresh offer on a later check of the same catalog.
            assert!(
                manager
                    .check_with_catalogs(|_| async {
                        (
                            stable::parse_bamboo(&bamboo_json),
                            stable::parse_lotus(&lotus_json),
                        )
                    })
                    .await
            );
            let rechecked = manager.snapshot("0.0.0".into(), Locale::English).unwrap();
            assert_eq!(rechecked.offers.len(), 1);
            assert_eq!(rechecked.offers[0].kind, UpdateKind::Lotus);
        }
    }

    assert!(
        manager
            .check_with_catalogs(|_| async {
                (
                    Err(ReleaseCheckError::Unavailable("catalog unavailable".into())),
                    stable::parse_lotus(&lotus_json),
                )
            })
            .await
    );
    let snapshot = manager.snapshot("0.0.0".into(), Locale::English).unwrap();
    assert_eq!(snapshot.offers.len(), 1);
    assert_eq!(snapshot.offers[0].kind, UpdateKind::Lotus);
    assert!(snapshot.display.error.unwrap().contains("Bamboo"));
}

#[tokio::test]
async fn reopened_updater_rejects_replayed_and_rewritten_catalog_revisions() {
    let (_directory, profile, active) = direct_profile().await;
    let approved = document(
        4,
        Some(&active.bamboo.version),
        std::slice::from_ref(&active.bamboo),
    );
    let lotus = lotus_release(&active.lotus, "2026.11.35", "e");
    let lotus_json = document(1, Some(&lotus.version), std::slice::from_ref(&lotus));
    let manager = Manager::new(profile.clone()).unwrap();
    assert!(
        manager
            .check_with_catalogs(|_| async {
                (
                    stable::parse_bamboo(&approved),
                    stable::parse_lotus(&lotus_json),
                )
            })
            .await
    );
    let snapshot = manager.snapshot("0.0.0".into(), Locale::English).unwrap();
    assert!(snapshot.display.error.is_none());
    let approved_lotus = &snapshot.offers[0];
    let downloaded = manager
        .updates
        .selected(
            approved_lotus.sequence,
            &approved_lotus.identity,
            Locale::English,
        )
        .unwrap()
        .candidate
        .clone();
    journal::save_downloaded(&profile, &downloaded).unwrap();

    let reopened = Manager::new(profile.clone()).unwrap();
    let bamboo = bamboo_release(&active.bamboo, "2026.11.49", "d");
    let rewritten = bamboo_release(&active.bamboo, &active.bamboo.version, "d");
    for (revision, release, expected_error) in [
        (3, &bamboo, "older revision"),
        (4, &bamboo, "changed an existing revision"),
        (5, &rewritten, "changed the identity of an admitted version"),
    ] {
        let conflicting = document(
            revision,
            Some(&release.version),
            std::slice::from_ref(release),
        );
        assert!(
            !reopened
                .check_with_catalogs(|_| async {
                    (
                        stable::parse_bamboo(&conflicting),
                        stable::parse_lotus(&lotus_json),
                    )
                })
                .await
        );
        let snapshot = reopened.snapshot("0.0.0".into(), Locale::English).unwrap();
        assert_eq!(snapshot.offers.len(), 1);
        assert_eq!(snapshot.offers[0].kind, UpdateKind::Lotus);
        assert!(snapshot.offers[0].downloaded);
        assert!(snapshot.display.error.unwrap().contains(expected_error));
        assert_eq!(
            journal::read_downloaded(&profile).unwrap().as_ref(),
            Some(&downloaded)
        );
    }
}

#[tokio::test]
async fn apply_reconfirmation_invalidates_a_withdrawn_download_before_an_offline_retry() {
    let (_directory, profile, active) = direct_profile().await;
    let manager = Manager::new(profile.clone()).unwrap();
    let bamboo = bamboo_release(&active.bamboo, "2026.11.49", "d");
    let approved = document(1, Some(&bamboo.version), std::slice::from_ref(&bamboo));
    let no_lotus = document::<LotusRelease>(1, None, &[]);
    assert!(
        manager
            .check_with_catalogs(|_| async {
                (
                    stable::parse_bamboo(&approved),
                    stable::parse_lotus(&no_lotus),
                )
            })
            .await
    );
    let snapshot = manager.snapshot("0.0.0".into(), Locale::English).unwrap();
    let offer = &snapshot.offers[0];
    let update = manager
        .updates
        .selected(offer.sequence, &offer.identity, Locale::English)
        .unwrap();
    journal::save_downloaded(&profile, &update.candidate).unwrap();
    assert!(manager
        .force_target(offer.sequence, &offer.identity, Locale::English)
        .is_ok());

    let withdrawn = document::<BambooRelease>(2, None, &[]);
    assert!(matches!(
        manager
            .reconfirm_stable(
                &update,
                &active,
                Locale::English,
                |_| async { stable::parse_bamboo(&withdrawn) },
                |_| async { panic!("Bamboo apply queried the Lotus catalog") },
            )
            .await,
        Err(ReleaseCheckError::Rejected(_))
    ));
    assert!(journal::read_downloaded(&profile).unwrap().is_none());
    assert_eq!(
        manager
            .force_target(offer.sequence, &offer.identity, Locale::English)
            .err()
            .as_deref(),
        Some(Locale::English.text("updates.downloadRequired")),
    );
}
