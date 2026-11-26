//! User-owned credentials for the Bamboo metadata client.
use chrono::{DateTime, Utc};
use reqwest::header::HeaderValue;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Mutex;
use tokio::sync::OnceCell;

const MAX_TOKEN_BYTES: usize = 1024;
const STORE_UNAVAILABLE: &str = "credential-store-unavailable";

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GitHubUpdateTokenState {
    #[default]
    None,
    Session,
    Stored,
    Unavailable,
}

struct Token {
    authorization: HeaderValue,
    state: GitHubUpdateTokenState,
}

impl Token {
    fn new(value: &str, state: GitHubUpdateTokenState) -> Result<Self, &'static str> {
        let is_personal_access_token = ["github_pat_", "ghp_"].into_iter().any(|prefix| {
            value
                .strip_prefix(prefix)
                .is_some_and(|suffix| !suffix.is_empty())
        });
        if !is_personal_access_token
            || value.len() > MAX_TOKEN_BYTES
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err("invalid-token");
        }
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {value}")).map_err(|_| "invalid-token")?;
        authorization.set_sensitive(true);
        Ok(Self {
            authorization,
            state,
        })
    }
}

#[derive(Default)]
struct State {
    token: Option<Token>,
    store_unavailable: bool,
    retry_at: BTreeMap<Option<String>, DateTime<Utc>>,
}

#[derive(Default)]
pub(crate) struct GitHubUpdateCredentials {
    loaded: OnceCell<()>,
    state: Mutex<State>,
}

impl GitHubUpdateCredentials {
    pub(crate) async fn initialize(&self) {
        self.loaded
            .get_or_init(|| async {
                let loaded = match tokio::task::spawn_blocking(store::load).await {
                    Ok(Ok(Some(raw))) => std::str::from_utf8(&raw)
                        .map_err(|_| STORE_UNAVAILABLE)
                        .and_then(|value| Token::new(value, GitHubUpdateTokenState::Stored))
                        .map(Some),
                    Ok(Ok(None)) => Ok(None),
                    _ => Err(STORE_UNAVAILABLE),
                };
                match loaded {
                    Ok(token) => {
                        let _ = self.replace(token);
                    }
                    Err(_) => {
                        if let Ok(mut state) = self.state.lock() {
                            state.store_unavailable = true;
                        }
                        log::info!("The Bamboo GitHub update credential store is unavailable");
                    }
                }
            })
            .await;
    }

    fn replace(&self, token: Option<Token>) -> Result<(), &'static str> {
        let mut state = self.state.lock().map_err(|_| STORE_UNAVAILABLE)?;
        state.token = token;
        state.store_unavailable = false;
        state.retry_at.clear();
        Ok(())
    }

    pub(crate) fn status(&self) -> GitHubUpdateTokenState {
        self.state
            .lock()
            .ok()
            .map(|state| {
                state.token.as_ref().map_or_else(
                    || {
                        if state.store_unavailable {
                            GitHubUpdateTokenState::Unavailable
                        } else {
                            GitHubUpdateTokenState::None
                        }
                    },
                    |token| token.state,
                )
            })
            .unwrap_or_default()
    }

    pub(crate) fn authorization(&self) -> Option<HeaderValue> {
        self.state
            .lock()
            .ok()?
            .token
            .as_ref()
            .map(|token| token.authorization.clone())
    }

    pub(crate) fn retry_at(
        &self,
        proxy: &Option<String>,
        now: DateTime<Utc>,
    ) -> Option<DateTime<Utc>> {
        self.state
            .lock()
            .ok()?
            .retry_at
            .get(proxy)
            .copied()
            .filter(|at| *at > now)
    }

    pub(crate) fn restrict(&self, proxy: Option<String>, now: DateTime<Utc>, until: DateTime<Utc>) {
        if let Ok(mut state) = self.state.lock() {
            state.retry_at.retain(|_, deadline| *deadline > now);
            state.retry_at.insert(proxy, until);
        }
    }

    pub(crate) async fn save(&self, value: String) -> Result<(), &'static str> {
        let value = value.trim().to_owned();
        let mut token = Token::new(&value, GitHubUpdateTokenState::Session)?;
        self.initialize().await;
        let result = tokio::task::spawn_blocking(move || store::save(value.as_bytes()))
            .await
            .map_err(|_| STORE_UNAVAILABLE)?;
        if result.is_ok() {
            token.state = GitHubUpdateTokenState::Stored;
        } else if self.status() == GitHubUpdateTokenState::Stored {
            return Err(STORE_UNAVAILABLE);
        }
        self.replace(Some(token))
    }

    pub(crate) async fn remove(&self) -> Result<(), &'static str> {
        self.initialize().await;
        self.remove_from_store(store::remove).await
    }

    async fn remove_from_store(
        &self,
        delete: impl FnOnce() -> Result<(), ()> + Send + 'static,
    ) -> Result<(), &'static str> {
        // A locked store can hide a persisted token while the current token is
        // session-only. Deletion must be confirmed independently of memory.
        tokio::task::spawn_blocking(delete)
            .await
            .map_err(|_| STORE_UNAVAILABLE)?
            .map_err(|_| STORE_UNAVAILABLE)?;
        self.replace(None)
    }
}

#[cfg(target_os = "macos")]
mod store {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    const SERVICE: &str = "com.bodhi.app.github-update";
    const ACCOUNT: &str = "api.github.com";
    // errSecItemNotFound from Security/SecBase.h.
    const NOT_FOUND: i32 = -25300;

    pub(super) fn load() -> Result<Option<Vec<u8>>, ()> {
        match get_generic_password(SERVICE, ACCOUNT) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.code() == NOT_FOUND => Ok(None),
            Err(_) => Err(()),
        }
    }

    pub(super) fn save(value: &[u8]) -> Result<(), ()> {
        set_generic_password(SERVICE, ACCOUNT, value).map_err(|_| ())
    }

    pub(super) fn remove() -> Result<(), ()> {
        match delete_generic_password(SERVICE, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == NOT_FOUND => Ok(()),
            Err(_) => Err(()),
        }
    }
}

#[cfg(windows)]
mod store {
    use super::MAX_TOKEN_BYTES;
    use std::ptr;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND, FILETIME};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn target() -> Vec<u16> {
        "com.bodhi.app.github-update/api.github.com"
            .encode_utf16()
            .chain([0])
            .collect()
    }

    pub(super) fn load() -> Result<Option<Vec<u8>>, ()> {
        let mut item = ptr::null_mut();
        // The system owns the returned credential allocation until CredFree.
        unsafe {
            if CredReadW(target().as_ptr(), CRED_TYPE_GENERIC, 0, &mut item) == 0 {
                return if GetLastError() == ERROR_NOT_FOUND {
                    Ok(None)
                } else {
                    Err(())
                };
            }
            if item.is_null() {
                return Err(());
            }
            let credential = &*item;
            let size = credential.CredentialBlobSize as usize;
            let value =
                if (1..=MAX_TOKEN_BYTES).contains(&size) && !credential.CredentialBlob.is_null() {
                    Ok(Some(
                        std::slice::from_raw_parts(credential.CredentialBlob, size).to_vec(),
                    ))
                } else {
                    Err(())
                };
            CredFree(item.cast());
            value
        }
    }

    pub(super) fn save(value: &[u8]) -> Result<(), ()> {
        let mut target = target();
        let credential = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            Comment: ptr::null_mut(),
            LastWritten: FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            CredentialBlobSize: value.len() as u32,
            CredentialBlob: value.as_ptr().cast_mut(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: ptr::null_mut(),
            TargetAlias: ptr::null_mut(),
            UserName: ptr::null_mut(),
        };
        // CredWriteW reads the initialized fields and their borrowed buffers.
        (unsafe { CredWriteW(&credential, 0) } != 0)
            .then_some(())
            .ok_or(())
    }

    pub(super) fn remove() -> Result<(), ()> {
        // The target buffer is NUL terminated for the lifetime of each call.
        unsafe {
            if CredDeleteW(target().as_ptr(), CRED_TYPE_GENERIC, 0) != 0
                || GetLastError() == ERROR_NOT_FOUND
            {
                Ok(())
            } else {
                Err(())
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod store {
    pub(super) fn load() -> Result<Option<Vec<u8>>, ()> {
        Ok(None)
    }
    pub(super) fn save(_: &[u8]) -> Result<(), ()> {
        Err(())
    }
    pub(super) fn remove() -> Result<(), ()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_headers_are_validated_sensitive_and_never_used_for_ui_status() {
        let raw = "github_pat_fixture_123";
        let secret = Token::new(raw, GitHubUpdateTokenState::Session).unwrap();
        assert!(secret.authorization.is_sensitive());
        assert!(!format!("{:?}", secret.authorization).contains(raw));
        assert!(Token::new("secret\nX-Injected: true", GitHubUpdateTokenState::Session).is_err());
        assert!(Token::new("npm_fixture", GitHubUpdateTokenState::Session).is_err());
        assert!(Token::new("ghs_fixture", GitHubUpdateTokenState::Session).is_err());
        assert!(Token::new("ghp_fixture", GitHubUpdateTokenState::Session).is_ok());
        let credentials = GitHubUpdateCredentials::default();
        credentials.replace(Some(secret)).unwrap();
        assert_eq!(
            serde_json::to_string(&credentials.status()).unwrap(),
            "\"session\""
        );
    }

    #[test]
    fn replacing_and_removing_tokens_clears_previous_auth_quota() {
        let credentials = GitHubUpdateCredentials::default();
        let now = Utc::now();
        let deadline = now + chrono::TimeDelta::minutes(2);
        let first_proxy = None;
        let other_proxy = Some("http://127.0.0.1:8080".to_owned());
        credentials.restrict(first_proxy.clone(), now, deadline);
        assert_eq!(credentials.retry_at(&first_proxy, now), Some(deadline));
        assert!(credentials.retry_at(&other_proxy, now).is_none());
        let token = Token::new("github_pat_fixture_123", GitHubUpdateTokenState::Session).unwrap();
        credentials.replace(Some(token)).unwrap();
        assert!(credentials.retry_at(&first_proxy, now).is_none());
        credentials.restrict(other_proxy.clone(), now, deadline);
        credentials.replace(None).unwrap();
        assert!(credentials.retry_at(&other_proxy, now).is_none());
        assert!(credentials.authorization().is_none());
    }

    #[tokio::test]
    async fn removal_confirms_deletion_of_a_persisted_token_hidden_from_memory() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let credentials = GitHubUpdateCredentials::default();
        credentials.state.lock().unwrap().store_unavailable = true;
        assert!(credentials.status() == GitHubUpdateTokenState::Unavailable);

        let hidden_token = Arc::new(AtomicBool::new(true));
        let token = Token::new(
            "github_pat_session_fixture",
            GitHubUpdateTokenState::Session,
        )
        .unwrap();
        credentials.replace(Some(token)).unwrap();
        let now = Utc::now();
        let deadline = now + chrono::TimeDelta::minutes(2);
        credentials.restrict(None, now, deadline);

        assert_eq!(
            credentials.remove_from_store(|| Err(())).await,
            Err(STORE_UNAVAILABLE)
        );
        assert!(hidden_token.load(Ordering::SeqCst));
        assert!(credentials.status() == GitHubUpdateTokenState::Session);
        assert_eq!(credentials.retry_at(&None, now), Some(deadline));

        let store = Arc::clone(&hidden_token);
        credentials
            .remove_from_store(move || {
                store.store(false, Ordering::SeqCst);
                Ok(())
            })
            .await
            .unwrap();
        assert!(!hidden_token.load(Ordering::SeqCst));
        assert!(credentials.authorization().is_none());
        assert!(credentials.retry_at(&None, now).is_none());
    }
}
