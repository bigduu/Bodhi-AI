use super::*;

const CATALOG: &[u8] = include_bytes!("fixture/channel-v1.json");

pub(crate) async fn fixture_channel() -> VerifiedChannel {
    parse(CATALOG).unwrap()
}

pub(crate) async fn initial_combination() -> Combination {
    fixture_channel().await.0.combinations.remove(0)
}

pub(crate) fn fixture_channel_with_lotus_only_update() -> VerifiedChannel {
    let mut catalog: serde_json::Value = serde_json::from_slice(CATALOG).unwrap();
    let combinations = catalog["combinations"].as_array_mut().unwrap();
    let mut later = combinations[1].clone();
    later["sequence"] = 3.into();
    later["bamboo"] = combinations[0]["bamboo"].clone();
    later["lotus"]["version"] = "2026.11.27".into();
    later["lotus"]["manifestSha256"] = "ac".repeat(32).into();
    later["changes"]["bamboo"] = serde_json::json!([]);
    combinations.push(later);
    parse(&serde_json::to_vec(&catalog).unwrap()).unwrap()
}

pub(crate) fn fixture_channel_with_independent_updates() -> VerifiedChannel {
    let mut channel = parse(CATALOG).unwrap();
    let initial = &channel.0.combinations[0];
    let pair = &channel.0.combinations[1];
    let bamboo = Combination {
        sequence: 3,
        bootstrap: false,
        lotus: initial.lotus.clone(),
        ..pair.clone()
    };
    let lotus = Combination {
        sequence: 4,
        bootstrap: false,
        bamboo: initial.bamboo.clone(),
        ..pair.clone()
    };
    let after_either = Combination {
        sequence: 5,
        bootstrap: false,
        accepts: vec![bamboo.identity(), lotus.identity()],
        ..pair.clone()
    };
    let mut unapproved = Combination {
        sequence: 6,
        accepts: Vec::new(),
        ..bamboo.clone()
    };
    unapproved.bamboo.version = "2026.11.40".into();
    unapproved.bamboo.manifest.sha256 = "cd".repeat(32);
    channel
        .0
        .combinations
        .extend([bamboo, lotus, after_either, unapproved]);
    channel
}

pub(crate) async fn lotus_fixtures() -> [LotusRelease; 2] {
    let channel = fixture_channel().await;
    [
        channel.0.combinations[0].lotus.clone(),
        channel.0.combinations[1].lotus.clone(),
    ]
}

#[tokio::test]
async fn selects_exact_native_asset_and_only_an_approved_transition() {
    let channel = fixture_channel().await;
    let current = channel.0.combinations[0].identity();
    let cases = [
        ("aarch64-apple-darwin", "bamboo-aarch64-apple-darwin"),
        (
            "aarch64-pc-windows-msvc",
            "bamboo-aarch64-pc-windows-msvc.exe",
        ),
        (
            "aarch64-unknown-linux-gnu",
            "bamboo-aarch64-unknown-linux-gnu",
        ),
        (
            "x86_64-pc-windows-msvc",
            "bamboo-x86_64-pc-windows-msvc.exe",
        ),
        (
            "x86_64-unknown-linux-gnu",
            "bamboo-x86_64-unknown-linux-gnu",
        ),
    ];
    for (target, expected) in cases {
        let selected = channel
            .select_for_target(Some((1, &current)), target)
            .unwrap()
            .unwrap();
        assert_eq!(selected.combination.sequence, 2);
        assert_eq!(selected.combination.bamboo.version, "2026.11.39");
        assert_eq!(selected.combination.lotus.version, "2026.11.26");
        assert_eq!(selected.artifact.target, target);
        assert_eq!(selected.artifact.asset_name, expected);
    }
    let install = channel
        .select(None)
        .unwrap()
        .unwrap()
        .combination
        .identity();
    assert!(channel.select(Some((2, &install))).unwrap().is_none());
    assert!(channel.select(Some((1, &install))).unwrap().is_none());
    assert!(channel
        .select_for_target(None, "x86_64-apple-darwin")
        .is_err());
}

#[test]
fn independent_selection_keeps_the_approved_peer_and_works_in_either_order() {
    let channel = fixture_channel_with_independent_updates();
    let current = &channel.0.combinations[0];
    let options = channel.select_updates(current).unwrap();
    assert_eq!(options.len(), 2);
    let bamboo = options[0];
    let lotus = options[1];
    assert_eq!(bamboo.sequence, 3);
    assert_eq!(bamboo.update_kind(current), Some(UpdateKind::Bamboo));
    assert_eq!(bamboo.lotus, current.lotus);
    assert_eq!(lotus.sequence, 4);
    assert_eq!(lotus.update_kind(current), Some(UpdateKind::Lotus));
    assert_eq!(lotus.bamboo, current.bamboo);

    let after_either = &channel.0.combinations[4];
    assert_eq!(channel.select_updates(bamboo).unwrap(), vec![after_either]);
    assert_eq!(after_either.update_kind(bamboo), Some(UpdateKind::Lotus));
    assert_eq!(channel.select_updates(lotus).unwrap(), vec![after_either]);
    assert_eq!(after_either.update_kind(lotus), Some(UpdateKind::Bamboo));
    assert!(channel.select_updates(after_either).unwrap().is_empty());
}

#[test]
fn independent_selection_chooses_the_newest_approved_record_per_component() {
    let mut channel = fixture_channel_with_independent_updates();
    let mut newer_bamboo = channel.0.combinations[5].clone();
    newer_bamboo.sequence = 7;
    newer_bamboo.accepts = vec![channel.0.combinations[0].identity()];
    channel.0.combinations.push(newer_bamboo);

    let options = channel.select_updates(&channel.0.combinations[0]).unwrap();
    let sequences: Vec<_> = options.iter().map(|option| option.sequence).collect();
    assert_eq!(sequences, vec![7, 4]);
}

#[test]
fn combined_update_is_a_fallback_when_neither_component_has_its_own_edge() {
    let channel = parse(CATALOG).unwrap();
    let current = &channel.0.combinations[0];
    let pair = &channel.0.combinations[1];
    assert_eq!(channel.select_updates(current).unwrap(), vec![pair]);
    assert_eq!(pair.update_kind(current), Some(UpdateKind::Pair));

    let mut current_at_same_sequence = current.clone();
    current_at_same_sequence.sequence = pair.sequence;
    assert!(channel
        .select_updates(&current_at_same_sequence)
        .unwrap()
        .is_empty());
}

#[test]
fn update_kind_checks_full_descriptors_but_selection_requires_an_identity_change() {
    let mut channel = parse(CATALOG).unwrap();
    let current = channel.0.combinations[0].clone();
    let mut changed = current.clone();
    changed.sequence = 3;
    changed.accepts = vec![current.identity()];
    changed.bamboo.browser_host.sha256 = "de".repeat(32);

    assert_eq!(current.update_kind(&current), None);
    assert_eq!(changed.identity(), current.identity());
    assert_eq!(changed.update_kind(&current), Some(UpdateKind::Bamboo));
    channel.0.combinations.push(changed);
    assert_eq!(
        channel.select_updates(&current).unwrap(),
        vec![&channel.0.combinations[1]]
    );
}

#[test]
fn update_kinds_have_stable_lowercase_labels() {
    for (kind, label) in [
        (UpdateKind::Bamboo, "bamboo"),
        (UpdateKind::Lotus, "lotus"),
        (UpdateKind::Pair, "pair"),
    ] {
        assert_eq!(serde_json::to_value(kind).unwrap(), label);
    }
}

#[test]
fn a_catalog_with_repeated_sequence_or_different_protocol_is_invalid() {
    let mut catalog: serde_json::Value = serde_json::from_slice(CATALOG).unwrap();
    catalog["combinations"][1]["sequence"] = 1.into();
    assert!(parse(&serde_json::to_vec(&catalog).unwrap()).is_err());
    catalog["combinations"][1]["sequence"] = 2.into();
    catalog["shellProtocol"] = 2.into();
    assert!(parse(&serde_json::to_vec(&catalog).unwrap()).is_err());
}

#[test]
fn incorrect_native_name_or_partial_inventory_is_invalid() {
    let mut channel: serde_json::Value = serde_json::from_slice(CATALOG).unwrap();
    assert!(parse(&serde_json::to_vec(&channel).unwrap()).is_ok());
    let artifacts = channel["combinations"][0]["bamboo"]["artifacts"]
        .as_array_mut()
        .unwrap();
    artifacts[1]["assetName"] = "bamboo-aarch64-apple-darwin".into();
    assert!(parse(&serde_json::to_vec(&channel).unwrap()).is_err());
    channel["combinations"][0]["bamboo"]["artifacts"]
        .as_array_mut()
        .unwrap()
        .remove(1);
    assert!(parse(&serde_json::to_vec(&channel).unwrap()).is_err());
}
