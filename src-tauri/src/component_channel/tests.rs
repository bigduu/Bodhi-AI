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
