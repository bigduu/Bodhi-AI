use super::*;
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;
use tough::FilesystemTransport;

const TRUSTED_ROOT: &[u8] = include_bytes!("fixture/metadata/1.root.json");

struct TestRepository {
    _storage: TempDir,
    repository: PathBuf,
    datastore: PathBuf,
}

impl TestRepository {
    fn new() -> Self {
        let storage = tempfile::tempdir().unwrap();
        let repository = storage.path().join("repository");
        let datastore = storage.path().join("datastore");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/component_channel/fixture");
        fs::create_dir(&repository).unwrap();
        fs::create_dir(&datastore).unwrap();
        for directory in ["metadata", "targets"] {
            fs::create_dir(repository.join(directory)).unwrap();
            for entry in fs::read_dir(fixture.join(directory)).unwrap() {
                let entry = entry.unwrap();
                fs::copy(
                    entry.path(),
                    repository.join(directory).join(entry.file_name()),
                )
                .unwrap();
            }
        }
        let test = Self {
            _storage: storage,
            repository,
            datastore,
        };
        test.timestamp(include_bytes!("fixture/timestamp-2.json"));
        test
    }

    fn timestamp(&self, bytes: &[u8]) {
        fs::write(self.repository.join("metadata/timestamp.json"), bytes).unwrap();
    }

    async fn load(&self) -> Result<VerifiedChannel, String> {
        let base = Url::from_directory_path(&self.repository).unwrap();
        load(TRUSTED_ROOT, &self.datastore, &base, FilesystemTransport).await
    }
}

#[tokio::test]
async fn selects_exact_native_asset_and_only_an_approved_transition() {
    let channel = TestRepository::new().load().await.unwrap();
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

#[tokio::test]
async fn rejects_expired_and_rolled_back_signed_metadata() {
    let test = TestRepository::new();
    test.load().await.unwrap();
    test.timestamp(include_bytes!("fixture/timestamp-1.json"));
    assert!(test.load().await.is_err());

    let expired = TestRepository::new();
    expired.timestamp(include_bytes!("fixture/expired-timestamp.json"));
    assert!(expired.load().await.is_err());
}

#[tokio::test]
async fn a_signed_timestamp_cannot_authorize_replaced_target_bytes() {
    let test = TestRepository::new();
    for entry in fs::read_dir(test.repository.join("targets")).unwrap() {
        fs::write(entry.unwrap().path(), b"{}").unwrap();
    }
    assert!(test.load().await.is_err());
}

#[tokio::test]
async fn rejects_a_replaced_signature_before_using_the_catalog() {
    let test = TestRepository::new();
    let mut timestamp: serde_json::Value =
        serde_json::from_slice(include_bytes!("fixture/timestamp-2.json")).unwrap();
    timestamp["signatures"][0]["sig"] = "0".repeat(128).into();
    test.timestamp(&serde_json::to_vec(&timestamp).unwrap());
    assert!(test.load().await.is_err());
}

#[test]
fn incorrect_native_name_or_partial_inventory_is_invalid() {
    let test = TestRepository::new();
    let path = fs::read_dir(test.repository.join("targets"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut channel: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
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
