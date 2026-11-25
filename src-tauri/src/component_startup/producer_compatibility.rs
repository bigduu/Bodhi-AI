//! Prove the Bootstrap contract of the exact authenticated component pair.
use crate::bamboo_profile::Profile;
use crate::component_channel::{lotus_release::read_requirements, LotusRelease};
use crate::component_kernel::VerifiedKernel;
use crate::frontend::VerifiedFrontend;
use crate::sidecar::{self, SidecarState, StartupStatus};
use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::net::{Ipv4Addr, TcpListener};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const BOOTSTRAP_PATH: &str = "/api/v1/bootstrap";
const MAX_BOOTSTRAP_BYTES: usize = 64 * 1024;

// These cataloged, pre-declaration Lotus releases all ship the same
// serverBootstrap.ts blob (0ffa5c23ba99049ea7e357d3f8764e63b0d4ee6b).
const LEGACY_LOTUS_REQUIREMENTS: &str = r#"{
  "schema_version": 1,
  "server": {"product": "bamboo"},
  "api": {"name": "bamboo.agent", "canonical_base_path": "/api/v1", "version": 1},
  "realtime": {
    "name": "bamboo.v2", "path": "/v2/stream", "version": 2,
    "subprotocol": {"name": "bamboo.v2", "encoding": "json"}
  },
  "capabilities": [
    "auth.ws_hello_ack.v1",
    "realtime.account_feed.v1",
    "realtime.agent_events.v1",
    "realtime.application_heartbeat.v1",
    "realtime.feed_cursor.v1",
    "realtime.feed_reset.v1",
    "realtime.stop_control.v1"
  ],
  "auth": {
    "password_enabled": {
      "capability": "auth.password_cookie.v1", "verify_path": "/api/v1/bamboo/access/verify"
    },
    "device_auth_enabled": {"capability": "auth.device_bearer.v1", "pair_path": "/v2/pair"}
  }
}"#;

pub(crate) fn is_legacy_lotus(lotus: &LotusRelease) -> bool {
    // The manifest and archive verifiers bind their source and resource identities.
    let (manifest, archive) = match lotus.version.as_str() {
        "2026.11.27" => (
            "916e4664dc48277f6ce159b82fa347f272ceaf75aaf78b03443eec2fd8438a72",
            "51744fc6683ffc745e0ac3c654c62ac19ef32e7fbbd022bf3847495f5620964f",
        ),
        "2026.11.29" => (
            "3e86e724b1199f780130bff16fc1ac18635b7d9e74c7566fdfada0b60d67b794",
            "5b2aa0853bf643abce68c1be793ec07dcb525e92fffc50b35c183b4fc3dd4a15",
        ),
        "2026.11.30" => (
            "9244e297fbf6e0540c18f6b13ca3415af06704ed48fa8d8f3a0c4b083badfa9a",
            "f239743f72fc29f45cd798cee15acfbbab059c09c9d805720d98a52cfed6450a",
        ),
        "2026.11.31" => (
            "28e82c7d7563e909e0672db460e860b305ecfaf2f0658c01086d1ea8543ef21a",
            "5656557a0b88a17a92150f910e4457bad41d34390d231d97a9cbfb6f0a61cc60",
        ),
        _ => return false,
    };
    lotus.manifest_sha256 == manifest && lotus.tarball.sha256 == archive
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Requirements {
    schema_version: u32,
    server: RequiredServer,
    api: RequiredApi,
    realtime: RequiredRealtime,
    capabilities: Vec<String>,
    auth: RequiredAuth,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiredServer {
    product: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiredApi {
    name: String,
    canonical_base_path: String,
    version: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiredRealtime {
    name: String,
    path: String,
    version: u32,
    subprotocol: Subprotocol,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiredAuth {
    password_enabled: RequiredPassword,
    device_auth_enabled: RequiredDevice,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiredPassword {
    capability: String,
    verify_path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiredDevice {
    capability: String,
    pair_path: String,
}

#[derive(Deserialize)]
struct Bootstrap {
    schema_version: u32,
    server: Server,
    api: Api,
    realtime: Realtime,
    capabilities: Vec<String>,
    auth: Auth,
}

#[derive(Deserialize)]
struct Server {
    product: String,
    version: String,
}

#[derive(Deserialize)]
struct Api {
    name: String,
    canonical_base_path: String,
    min_version: u32,
    max_version: u32,
}

#[derive(Deserialize)]
struct Realtime {
    name: String,
    path: String,
    min_version: u32,
    max_version: u32,
    subprotocols: Vec<Subprotocol>,
}

#[derive(Deserialize, PartialEq, Eq)]
struct Subprotocol {
    name: String,
    encoding: String,
}

#[derive(Deserialize)]
struct Auth {
    policy: AuthPolicy,
    request_state: RequestState,
    password_enabled: bool,
    device_auth_enabled: bool,
    verify_path: String,
    pair_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum AuthPolicy {
    Open,
    CredentialRequired,
    RepairRequired,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RequestState {
    LocalBypass,
    Authenticated,
    Unauthenticated,
}

impl Auth {
    fn valid(&self) -> bool {
        match self.policy {
            AuthPolicy::Open => {
                self.request_state != RequestState::Authenticated
                    && !self.password_enabled
                    && !self.device_auth_enabled
            }
            AuthPolicy::CredentialRequired => self.password_enabled || self.device_auth_enabled,
            AuthPolicy::RepairRequired => self.request_state != RequestState::Authenticated,
        }
    }
}

fn compatibility_requirements(
    frontend: &VerifiedFrontend,
    lotus: &LotusRelease,
) -> Result<Requirements, String> {
    if frontend.manifest_sha256.as_deref() != Some(lotus.manifest_sha256.as_str())
        || frontend.index_hash.is_none()
    {
        return Err("Lotus Next compatibility requires the verified published frontend.".into());
    }
    let dist = frontend
        .static_dir
        .as_deref()
        .ok_or("Lotus Next compatibility requires an external frontend.")?;
    parse_requirements(read_requirements(dist, lotus)?, lotus)
}

fn parse_requirements(
    declaration: Option<Value>,
    lotus: &LotusRelease,
) -> Result<Requirements, String> {
    let requirements: Requirements = match declaration {
        Some(value) => serde_json::from_value(value),
        None if is_legacy_lotus(lotus) => serde_json::from_str(LEGACY_LOTUS_REQUIREMENTS),
        None => {
            return Err("This Lotus Next release has no verified Bootstrap requirements.".into())
        }
    }
    .map_err(|error| format!("Invalid Lotus Next Bootstrap requirements: {error}"))?;
    if requirements.schema_version != 1
        || requirements.server.product != "bamboo"
        || requirements.api.name != "bamboo.agent"
        || requirements.api.canonical_base_path != "/api/v1"
        || requirements.api.version != 1
        || !unique_nonempty(requirements.capabilities.iter().map(String::as_str))
    {
        return Err("This Bodhi shell does not support the Lotus Next Bootstrap schema.".into());
    }
    Ok(requirements)
}

fn unique_nonempty<'a>(names: impl IntoIterator<Item = &'a str>) -> bool {
    let mut seen = HashSet::new();
    names
        .into_iter()
        .all(|name| !name.is_empty() && seen.insert(name))
}

enum BootstrapCheck {
    Isolated,
    Live,
}

fn validate_bootstrap(
    required: &Requirements,
    actual: &Bootstrap,
    bamboo_version: &str,
    check: BootstrapCheck,
) -> Result<(), String> {
    if actual.schema_version != required.schema_version
        || actual.server.product != required.server.product
        || actual.server.version != bamboo_version
    {
        return Err("Bamboo Bootstrap does not identify the expected runtime.".into());
    }
    if actual.api.name != required.api.name
        || actual.api.canonical_base_path != required.api.canonical_base_path
        || !(actual.api.min_version..=actual.api.max_version).contains(&required.api.version)
    {
        return Err("Bamboo does not support the Lotus Next API contract.".into());
    }
    if actual.realtime.name != required.realtime.name
        || actual.realtime.path != required.realtime.path
        || !(actual.realtime.min_version..=actual.realtime.max_version)
            .contains(&required.realtime.version)
        || !unique_nonempty(
            actual
                .realtime
                .subprotocols
                .iter()
                .map(|item| item.name.as_str()),
        )
        || actual
            .realtime
            .subprotocols
            .iter()
            .any(|item| item.encoding.is_empty())
        || !actual
            .realtime
            .subprotocols
            .contains(&required.realtime.subprotocol)
    {
        return Err("Bamboo does not support the Lotus Next realtime contract.".into());
    }
    if !unique_nonempty(actual.capabilities.iter().map(String::as_str))
        || !required
            .capabilities
            .iter()
            .all(|capability| actual.capabilities.contains(capability))
    {
        return Err("Bamboo does not provide the required Lotus Next capabilities.".into());
    }
    let auth = &actual.auth;
    if !auth.valid() || auth.verify_path.is_empty() || auth.pair_path.is_empty() {
        return Err("Bamboo Bootstrap reports an invalid authentication state.".into());
    }
    // A fresh profile reports open auth. Require both advertised contracts
    // before replacement so the user's enabled methods can still work.
    let isolated = matches!(check, BootstrapCheck::Isolated);
    if (isolated || auth.password_enabled)
        && (!actual
            .capabilities
            .contains(&required.auth.password_enabled.capability)
            || auth.verify_path != required.auth.password_enabled.verify_path)
    {
        return Err("Bamboo does not support the Lotus Next password contract.".into());
    }
    if (isolated || auth.device_auth_enabled)
        && (!actual
            .capabilities
            .contains(&required.auth.device_auth_enabled.capability)
            || auth.pair_path != required.auth.device_auth_enabled.pair_path)
    {
        return Err(
            "Bamboo does not support the Lotus Next device authentication contract.".into(),
        );
    }
    Ok(())
}

async fn probe_bootstrap(
    port: u16,
    owner: &StartupStatus,
    bamboo_version: &str,
    requirements: &Requirements,
    check: BootstrapCheck,
) -> Result<(), String> {
    if !owner.is_ready() {
        return Err("Bodhi does not own the Bamboo listener for the compatibility check.".into());
    }
    let mut response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?
        .get(format!("http://127.0.0.1:{port}{BOOTSTRAP_PATH}"))
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "Bamboo Bootstrap returned HTTP {}.",
            response.status()
        ));
    }
    let media_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if media_type != "application/json"
        && !(media_type.starts_with("application/") && media_type.ends_with("+json"))
    {
        return Err("Bamboo Bootstrap did not return JSON.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| error.without_url().to_string())?
    {
        if chunk.len() > MAX_BOOTSTRAP_BYTES - bytes.len() {
            return Err("Bamboo Bootstrap exceeds its size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !owner.is_ready() {
        return Err("The managed Bamboo exited during the compatibility check.".into());
    }
    let actual = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid Bamboo Bootstrap document: {error}"))?;
    validate_bootstrap(requirements, &actual, bamboo_version, check)
}

/// Recheck the specific managed replacement before recording a producer update as active.
pub(super) async fn prove_live_pair(
    port: u16,
    owner: &StartupStatus,
    bamboo_version: &str,
    frontend: &VerifiedFrontend,
    lotus: &LotusRelease,
) -> Result<(), String> {
    let requirements = compatibility_requirements(frontend, lotus)?;
    probe_bootstrap(
        port,
        owner,
        bamboo_version,
        &requirements,
        BootstrapCheck::Live,
    )
    .await
}

struct IsolatedBamboo(SidecarState);

impl Drop for IsolatedBamboo {
    fn drop(&mut self) {
        self.0.exit();
    }
}

fn isolated_command(kernel: &Path, frontend: &Path, scratch: &Path, port: u16) -> Command {
    let mut command = Command::new(kernel);
    command
        .current_dir(scratch)
        .env_clear()
        .env("BAMBOO_DATA_DIR", scratch)
        .env("BAMBOO_WORKSPACE_ROOT", scratch.join("workspace"))
        .env("BAMBOO_JIANDU_DATA_DIR", scratch.join("jiandu"))
        .env("RUST_LOG", "bamboo_server::server::entrypoints=info")
        .args([
            "serve",
            "--parent-pid",
            &std::process::id().to_string(),
            "--port",
            &port.to_string(),
            "--bind",
            "127.0.0.1",
            "--workers",
            "1",
            "--data-dir",
        ])
        .arg(scratch)
        .arg("--static-dir")
        .arg(frontend);
    // Redirect environment-based home lookup for this child only.
    #[cfg(unix)]
    command.env("HOME", scratch);
    #[cfg(target_os = "macos")]
    command.env("CFFIXED_USER_HOME", scratch);
    #[cfg(windows)]
    {
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system_root);
        }
        command
            .env("USERPROFILE", scratch)
            .env("APPDATA", scratch.join("roaming"))
            .env("LOCALAPPDATA", scratch.join("local"));
    }
    command
}

/// Probe a proposed pair without reusing the active profile, environment, or port.
pub(super) async fn prove_pair(
    kernel: &VerifiedKernel,
    frontend: &VerifiedFrontend,
    lotus: &LotusRelease,
) -> Result<(), String> {
    let requirements = compatibility_requirements(frontend, lotus)?;
    let static_dir = frontend
        .static_dir
        .as_deref()
        .ok_or("Lotus Next compatibility requires an external frontend.")?;
    let scratch = tempfile::Builder::new()
        .prefix("bodhi-component-probe-")
        .tempdir()
        .map_err(|error| error.to_string())?;
    let profile = Profile::open(scratch.path()).map_err(|error| error.to_string())?;
    let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|listener| listener.local_addr())
        .map_err(|error| error.to_string())?
        .port();
    let probe = IsolatedBamboo(SidecarState::default());
    let command = isolated_command(&kernel.executable, static_dir, &profile.data, port);
    let owner = probe
        .0
        .start(command, profile.writer()?, port, Some(&profile.state_dir))?;
    let proof = async {
        sidecar::wait_for_health(port, 30, Some(&owner), frontend.index_hash.as_deref()).await?;
        if sidecar::owned_version(port, &owner).await? != kernel.version {
            return Err("The isolated Bamboo version differs from the verified release.".into());
        }
        probe_bootstrap(
            port,
            &owner,
            &kernel.version,
            &requirements,
            BootstrapCheck::Isolated,
        )
        .await
    }
    .await;
    if probe
        .0
        .stop_for_update(Duration::from_secs(5))
        .await
        .is_err()
    {
        probe
            .0
            .force_stop_for_update(Duration::from_secs(5))
            .await
            .map_err(|error| format!("Cannot stop the isolated Bamboo probe: {error:?}"))?;
    }
    proof
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::component_channel::Asset;
    use serde_json::json;

    fn lotus_31() -> LotusRelease {
        LotusRelease {
            version: "2026.11.31".into(),
            source_revision: "6c254fbcc9dafd74524d1f1322606531d21aa5b2".into(),
            manifest_sha256: "28e82c7d7563e909e0672db460e860b305ecfaf2f0658c01086d1ea8543ef21a"
                .into(),
            resources_sha256: "fe8077c781c2b39d112e480abdbf113df90ae884ec9a5a237391f3c05c424c79"
                .into(),
            tarball: Asset {
                sha256: "5656557a0b88a17a92150f910e4457bad41d34390d231d97a9cbfb6f0a61cc60".into(),
                size_bytes: 4_146_409,
            },
        }
    }

    fn bootstrap_document() -> Value {
        json!({
            "schema_version": 1,
            "server": {"product": "bamboo", "version": "2026.11.46"},
            "api": {
                "name": "bamboo.agent", "canonical_base_path": "/api/v1", "min_version": 1, "max_version": 2
            },
            "realtime": {
                "name": "bamboo.v2", "path": "/v2/stream", "min_version": 2, "max_version": 3,
                "subprotocols": [{"name": "bamboo.v2", "encoding": "json"}],
            },
            "capabilities": [
                "auth.device_bearer.v1",
                "auth.password_cookie.v1",
                "auth.ws_hello_ack.v1",
                "realtime.account_feed.v1",
                "realtime.agent_events.v1",
                "realtime.application_heartbeat.v1",
                "realtime.feed_cursor.v1",
                "realtime.feed_reset.v1",
                "realtime.stop_control.v1",
                "future.additive.v1",
            ],
            "auth": {
                "policy": "credential_required",
                "request_state": "local_bypass",
                "password_enabled": true,
                "device_auth_enabled": true,
                "verify_path": "/api/v1/bamboo/access/verify",
                "pair_path": "/v2/pair",
            },
            "future": "additive"
        })
    }

    fn check_document(document: Value) -> Result<(), String> {
        let required = serde_json::from_str(LEGACY_LOTUS_REQUIREMENTS).unwrap();
        let actual = serde_json::from_value(document).unwrap();
        validate_bootstrap(&required, &actual, "2026.11.46", BootstrapCheck::Live)
    }

    #[test]
    fn legacy_requirements_are_bound_to_the_exact_published_lotus_artifact() {
        let release = lotus_31();
        assert!(parse_requirements(None, &release).is_ok());

        let mut changed = release.clone();
        changed.tarball.sha256 = "a".repeat(64);
        assert!(parse_requirements(None, &changed)
            .err()
            .unwrap()
            .contains("no verified Bootstrap requirements"));
        changed = release;
        changed.version = "2026.11.32".into();
        assert!(parse_requirements(None, &changed).is_err());
        assert!(parse_requirements(Some(json!({"schema_version":2})), &changed).is_err());
        let declared = serde_json::from_str(LEGACY_LOTUS_REQUIREMENTS).unwrap();
        assert!(parse_requirements(Some(declared), &changed).is_ok());
    }

    #[test]
    fn bootstrap_must_match_the_exact_bamboo_version_and_frontend_protocol() {
        let document = bootstrap_document();
        assert!(check_document(document.clone()).is_ok());
        for (field, wrong, reason) in [
            ("/server/version", json!("2026.11.45"), "expected runtime"),
            ("/api/min_version", json!(2), "API contract"),
            ("/realtime/path", json!("/v3/stream"), "realtime contract"),
            (
                "/realtime/subprotocols/0/encoding",
                json!("messagepack"),
                "realtime contract",
            ),
            (
                "/capabilities",
                json!([]),
                "required Lotus Next capabilities",
            ),
        ] {
            let mut incompatible = document.clone();
            *incompatible.pointer_mut(field).unwrap() = wrong;
            assert!(check_document(incompatible).unwrap_err().contains(reason));
        }
    }

    #[test]
    fn bootstrap_auth_paths_are_required_for_the_enabled_methods() {
        let mut document = bootstrap_document();
        document["auth"]["verify_path"] = json!("/incorrect");
        assert!(check_document(document.clone())
            .unwrap_err()
            .contains("password contract"));
        document["auth"]["password_enabled"] = json!(false);
        assert!(check_document(document.clone()).is_ok());
        document["auth"]["pair_path"] = json!("/incorrect");
        assert!(check_document(document.clone())
            .unwrap_err()
            .contains("device authentication contract"));
        document["auth"]["device_auth_enabled"] = json!(false);
        assert!(check_document(document.clone())
            .unwrap_err()
            .contains("invalid authentication state"));
        document["auth"]["policy"] = json!("open");
        assert!(check_document(document).is_ok());
    }

    #[test]
    fn open_isolated_probe_rejects_missing_auth_routes_and_capabilities() {
        let mut document = bootstrap_document();
        document["auth"]["policy"] = json!("open");
        document["auth"]["password_enabled"] = json!(false);
        document["auth"]["device_auth_enabled"] = json!(false);
        let required = serde_json::from_str(LEGACY_LOTUS_REQUIREMENTS).unwrap();
        let check = |value: Value| {
            let actual = serde_json::from_value(value).unwrap();
            validate_bootstrap(&required, &actual, "2026.11.46", BootstrapCheck::Isolated)
        };
        assert!(check(document.clone()).is_ok());

        let mut wrong_route = document.clone();
        wrong_route["auth"]["pair_path"] = json!("/incorrect");
        assert!(check_document(wrong_route.clone()).is_ok());
        assert!(check(wrong_route)
            .unwrap_err()
            .contains("device authentication contract"));

        document["capabilities"].as_array_mut().unwrap().remove(1);
        assert!(check_document(document.clone()).is_ok());
        assert!(check(document).unwrap_err().contains("password contract"));
    }

    #[tokio::test]
    async fn bootstrap_proof_refuses_an_unowned_listener() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let requirements = serde_json::from_str(LEGACY_LOTUS_REQUIREMENTS).unwrap();
        assert!(probe_bootstrap(
            port,
            &StartupStatus::default(),
            "2026.11.46",
            &requirements,
            BootstrapCheck::Live,
        )
        .await
        .unwrap_err()
        .contains("does not own"));
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    #[ignore = "requires the original Bamboo .47 executable and Lotus .30/.31 archives"]
    async fn proves_published_bamboo_with_both_published_lotus_versions() {
        use sha2::{Digest, Sha256};
        use std::fs::{self, File};

        let kernel = VerifiedKernel {
            executable: std::env::var_os("BODHI_TEST_COMPAT_BAMBOO_47")
                .unwrap()
                .into(),
            version: "2026.11.47".into(),
        };
        let mut hash = Sha256::new();
        std::io::copy(&mut File::open(&kernel.executable).unwrap(), &mut hash).unwrap();
        assert_eq!(
            format!("{:x}", hash.finalize()),
            "5bbefc45b855b2e07a498724a7aa61975e42d3452ca6849ce903ced961bca53d"
        );
        for (variable, version) in [
            ("BODHI_TEST_COMPAT_LOTUS_30", "2026.11.30"),
            ("BODHI_TEST_COMPAT_LOTUS_31", "2026.11.31"),
        ] {
            let scratch = tempfile::tempdir().unwrap();
            let archive = fs::read(std::env::var_os(variable).unwrap()).unwrap();
            let lotus = crate::frontend::inspect_release_archive(version, &archive, scratch.path())
                .unwrap();
            assert!(is_legacy_lotus(&lotus));
            let dist = scratch.path().join("dist");
            let frontend = VerifiedFrontend {
                index_hash: Some(crate::frontend::hash_bytes(
                    &fs::read(dist.join("index.html")).unwrap(),
                )),
                static_dir: Some(dist),
                manifest_sha256: Some(lotus.manifest_sha256.clone()),
            };
            prove_pair(&kernel, &frontend, &lotus).await.unwrap();
        }
    }
}
