//! Platform-independent Matrix connection and messaging.
//!
//! The host owns secret storage and the cancellable sync loop. Session exports
//! contain credentials and MUST be protected by the host, never returned to UI.

use std::{path::Path, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use matrix_sdk::{
    Client, RoomState,
    authentication::matrix::MatrixSession,
    config::{RequestConfig, SyncSettings},
    encryption::{BackupDownloadStrategy, EncryptionSettings},
    room::MessagesOptions,
    ruma::{
        OwnedTransactionId, RoomId, RoomOrAliasId, events::room::message::RoomMessageEventContent,
        presence::PresenceState,
    },
    sliding_sync::VersionBuilder,
};
use matrix_sdk_crypto::CollectStrategy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

const DEVICE_NAME: &str = "Matrix Client Windows prototype";
pub const TEST_FIXTURE_ENABLED: bool = cfg!(feature = "test-fixture");
const MAX_MESSAGE_BYTES: usize = 16_000;
const MAX_HISTORY: u32 = 100;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub user_id: String,
    pub device_id: String,
    pub homeserver: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSummary {
    pub id: String,
    pub name: String,
    pub encrypted: bool,
    pub joined: bool,
    pub encryption_known: bool,
    pub is_space: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub sender: String,
    pub body: String,
    pub timestamp: u64,
    pub encrypted: bool,
    pub unable_to_decrypt: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacePage {
    pub rooms: Vec<SpaceChild>,
    pub next_batch: Option<String>,
}

#[derive(Serialize)]
pub struct SpaceChild {
    pub id: String,
    pub name: String,
    pub joined: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    pub device_verified: bool,
    pub recovery_state: String,
}

// Deliberately no Debug: this includes the access token.
#[derive(Serialize, Deserialize)]
struct SavedSession {
    version: u32,
    homeserver: String,
    session: MatrixSession,
}

#[derive(Clone)]
pub struct Core {
    client: Client,
}

impl Core {
    /// Login creates a new Matrix device. Never reuse an existing session's
    /// database directory for a fresh login; restore the saved session instead.
    pub async fn login_password(
        homeserver: &str,
        username: &str,
        password: &str,
        store_path: &Path,
        store_secret: &str,
    ) -> Result<Self> {
        ensure!(!username.trim().is_empty(), "Enter your Matrix username.");
        ensure!(!password.is_empty(), "Enter your password.");
        let client = build_client(homeserver, store_path, store_secret, true).await?;
        let auth = client.matrix_auth();
        let types = auth
            .get_login_types()
            .await
            .context("Could not check this server's sign-in methods.")?;
        let flows: Vec<Value> = types
            .flows
            .iter()
            .map(serde_json::to_value)
            .collect::<std::result::Result<_, _>>()?;
        ensure!(
            !prefers_browser_login(&flows),
            "This server requests browser sign-in. Use Sign in with browser."
        );
        ensure!(
            flows.iter().any(|v| v["type"] == "m.login.password"),
            "This server does not support password sign-in. Use Sign in with browser."
        );
        auth.login_username(username.trim(), password)
            .initial_device_display_name(DEVICE_NAME)
            .await
            .context("Could not sign in. Check your server, username and password.")?;
        Ok(Self { client })
    }

    /// Uses the SDK's loopback SSO callback listener. The callback opens only the
    /// SDK-generated URL in the external browser, not inside the app webview.
    pub async fn login_sso<F>(
        homeserver: &str,
        store_path: &Path,
        store_secret: &str,
        open_url: F,
    ) -> Result<Self>
    where
        F: FnOnce(String) -> std::result::Result<(), String> + Send + 'static,
    {
        let client = build_client(homeserver, store_path, store_secret, true).await?;
        let auth = client.matrix_auth();
        let types = auth
            .get_login_types()
            .await
            .context("Could not check this server's sign-in methods.")?;
        let flows: Vec<Value> = types
            .flows
            .iter()
            .map(serde_json::to_value)
            .collect::<std::result::Result<_, _>>()?;
        ensure!(
            flows.iter().any(|v| v["type"] == "m.login.sso"),
            "This server does not advertise compatible browser sign-in. Try password sign-in if available."
        );
        let login = auth
            .login_sso(move |sso_url| async move {
                let mut url = Url::parse(&sso_url).map_err(|_| {
                    matrix_sdk::Error::UnknownError(
                        anyhow::anyhow!("Invalid browser sign-in URL.").into(),
                    )
                })?;
                url.query_pairs_mut().append_pair("action", "login");
                open_url(url.to_string()).map_err(|_| {
                    matrix_sdk::Error::UnknownError(
                        anyhow::anyhow!("Could not open your browser.").into(),
                    )
                })
            })
            .initial_device_display_name(DEVICE_NAME);
        tokio::time::timeout(Duration::from_secs(300), login.into_future())
            .await
            .context("Browser sign-in timed out. Try again.")?
            .context("Browser sign-in failed or was cancelled.")?;
        Ok(Self { client })
    }

    pub async fn restore(
        serialized_session: &str,
        store_path: &Path,
        store_secret: &str,
    ) -> Result<Self> {
        let saved: SavedSession = serde_json::from_str(serialized_session)
            .context("The saved session could not be read.")?;
        ensure!(
            saved.version == 1,
            "This saved-session version is unsupported."
        );
        let client = build_client(&saved.homeserver, store_path, store_secret, false).await?;
        client
            .restore_session(saved.session)
            .await
            .context("Could not restore the saved session and encryption store.")?;
        Ok(Self { client })
    }

    pub fn account(&self) -> AccountInfo {
        AccountInfo {
            user_id: self
                .client
                .user_id()
                .map(ToString::to_string)
                .unwrap_or_default(),
            device_id: self
                .client
                .device_id()
                .map(ToString::to_string)
                .unwrap_or_default(),
            homeserver: self.client.homeserver().to_string(),
        }
    }

    /// Sensitive return value. Persist with a platform-protected secret store.
    pub fn export_session(&self) -> Result<String> {
        let session = self
            .client
            .matrix_auth()
            .session()
            .context("No active session to save.")?;
        serde_json::to_string(&SavedSession {
            version: 1,
            homeserver: self.client.homeserver().to_string(),
            session,
        })
        .context("Could not encode the session for protected storage.")
    }

    /// One SDK sync. The SDK reuses and persists its sync token; host code owns
    /// cancellation/backoff and must run at most one sync loop for this session.
    pub async fn sync_once(&self) -> Result<()> {
        self.client.sync_once(SyncSettings::default().timeout(Duration::from_secs(20)).set_presence(PresenceState::Offline))
            .await.context("Synchronization failed. Check the connection or sign in again if the session was revoked.")?;
        Ok(())
    }

    pub async fn rooms(&self) -> Result<Vec<RoomSummary>> {
        let mut rooms = Vec::new();
        for room in self.client.rooms() {
            if !matches!(room.state(), RoomState::Joined | RoomState::Invited) {
                continue;
            }
            let mut encryption = room.encryption_state();
            // Absence of an encryption event in sync is not proof that a room
            // is unencrypted. Resolve unknown state before presenting controls.
            if encryption.is_unknown()
                && room.state() == RoomState::Joined
                && let Ok(confirmed) = room.latest_encryption_state().await
            {
                encryption = confirmed;
            }
            rooms.push(RoomSummary {
                id: room.room_id().to_string(),
                name: room
                    .display_name()
                    .await
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| room.room_id().to_string()),
                encrypted: encryption.is_encrypted(),
                joined: room.state() == RoomState::Joined,
                encryption_known: !encryption.is_unknown(),
                is_space: room.is_space(),
            });
        }
        rooms.sort_by(|a, b| {
            b.joined
                .cmp(&a.joined)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(rooms)
    }

    pub async fn space_rooms(&self, room_id: &str, from: Option<String>) -> Result<SpacePage> {
        use matrix_sdk::ruma::api::client::space::get_hierarchy::v1::Request;
        let id = RoomId::parse(room_id)?;
        let room = self
            .client
            .get_room(&id)
            .context("Space is not available.")?;
        ensure!(room.is_space(), "Select a space first.");
        let mut request = Request::new(id.clone());
        request.max_depth = Some(1u32.into());
        request.limit = Some(100u32.into());
        request.from = from;
        let response = self
            .client
            .send(request)
            .await
            .map_err(|e| anyhow::anyhow!("Could not load the space's rooms: {e}"))?;
        let mut rooms = Vec::new();
        for entry in response.rooms {
            let summary = serde_json::to_value(entry.summary)?;
            let Some(child_id) = summary["room_id"].as_str() else {
                continue;
            };
            if child_id == id.as_str() {
                continue;
            }
            let child_id = RoomId::parse(child_id)?;
            rooms.push(SpaceChild {
                id: child_id.to_string(),
                name: summary["name"]
                    .as_str()
                    .unwrap_or(child_id.as_str())
                    .to_owned(),
                joined: self
                    .client
                    .get_room(&child_id)
                    .is_some_and(|r| r.state() == RoomState::Joined),
            });
        }
        Ok(SpacePage {
            rooms,
            next_batch: response.next_batch,
        })
    }

    pub async fn messages(&self, room_id: &str, limit: u32) -> Result<Vec<Message>> {
        let id = RoomId::parse(room_id).context("Invalid room ID.")?;
        let room = self
            .client
            .get_room(&id)
            .context("Room is not available. Join it and wait for synchronization.")?;
        ensure!(
            room.state() == RoomState::Joined,
            "Join this room before reading messages."
        );
        let mut options = MessagesOptions::backward();
        options.limit = limit.clamp(1, MAX_HISTORY).into();
        let page = room
            .messages(options)
            .await
            .context("Could not load messages. Check your connection.")?;
        let mut messages = Vec::new();
        for event in page.chunk {
            let raw: Value = serde_json::from_str(event.raw().json().get())
                .context("The server returned an invalid message.")?;
            if let Some(message) = parse_message(&raw, event.encryption_info().is_some()) {
                messages.push(message);
            }
        }
        // The API returns newest-to-oldest in topological order; reverse rather
        // than sorting by attacker-controlled timestamps.
        messages.reverse();
        Ok(messages)
    }

    pub async fn send_message(
        &self,
        room_id: &str,
        body: &str,
        transaction_id: &str,
    ) -> Result<String> {
        validate_message(body, transaction_id)?;
        let id = RoomId::parse(room_id).context("Invalid room ID.")?;
        let room = self
            .client
            .get_room(&id)
            .context("Room is not available. Wait for synchronization.")?;
        ensure!(
            room.state() == RoomState::Joined,
            "Join this room before sending messages."
        );
        ensure!(
            !room.is_space(),
            "This is a space, which organizes rooms. Select a chat room inside it to send a message."
        );
        let encryption = room
            .latest_encryption_state()
            .await
            .context("Could not confirm the room's encryption state. Nothing was sent.")?;
        ensure!(
            !encryption.is_unknown(),
            "The room's encryption state is unknown. Nothing was sent."
        );
        if encryption.is_encrypted() {
            ensure!(
                self.security_status().await?.device_verified,
                "Verify this device using your recovery key before sending encrypted messages."
            );
        }
        let txn: OwnedTransactionId = transaction_id.into();
        let result = room
            .send(RoomMessageEventContent::text_plain(body))
            .with_transaction_id(txn)
            .await
            .map_err(send_error)?;
        Ok(result.response.event_id.to_string())
    }

    pub async fn join_room(&self, room_id_or_alias: &str) -> Result<String> {
        let id = RoomOrAliasId::parse(room_id_or_alias.trim())
            .context("Enter a room ID (!room:server) or alias (#room:server).")?;
        let room = self.client.join_room_by_id_or_alias(&id, &[]).await.map_err(|e| anyhow::anyhow!("Could not join the room: {e}. A private room may require a separate invitation to this account."))?;
        Ok(room.room_id().to_string())
    }

    /// Imports existing secrets only; does not reset identity or replace backup.
    pub async fn recover(&self, recovery_key: &str) -> Result<()> {
        ensure!(
            !recovery_key.trim().is_empty(),
            "Enter your Matrix recovery key or recovery passphrase."
        );
        self.client.encryption().recovery().recover(recovery_key.trim()).await
            .context("Recovery failed. Check the recovery key/passphrase. No identity reset was requested.")?;
        Ok(())
    }

    pub async fn security_status(&self) -> Result<SecurityStatus> {
        let encryption = self.client.encryption();
        let device_verified = encryption
            .get_own_device()
            .await
            .context("Could not read this device's encryption status.")?
            .map(|device| device.is_verified_with_cross_signing())
            .unwrap_or(false);
        Ok(SecurityStatus {
            device_verified,
            recovery_state: format!("{:?}", encryption.recovery().state()),
        })
    }

    pub async fn logout(&self) -> Result<()> {
        match self.client.logout().await {
            Ok(_) => Ok(()),
            Err(error)
                if matches!(
                    error.client_api_error_kind(),
                    Some(matrix_sdk::ruma::api::error::ErrorKind::UnknownToken { .. })
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(error).context(
                "Could not revoke the session on the server. Check your connection and retry.",
            ),
        }
    }

    /// Only for synthetic identities owned by the local integration fixture.
    #[cfg(feature = "test-fixture")]
    pub async fn initialize_test_identity(&self) -> Result<()> {
        ensure!(
            self.client.homeserver().host_str().is_some_and(is_loopback),
            "Test identity setup is restricted to loopback."
        );
        self.client
            .encryption()
            .bootstrap_cross_signing(None)
            .await
            .context("Fixture identity bootstrap failed.")?;
        Ok(())
    }
}

async fn build_client(
    homeserver: &str,
    store_path: &Path,
    store_secret: &str,
    discover: bool,
) -> Result<Client> {
    let url = validate_homeserver(homeserver)?;
    ensure!(
        store_secret.len() >= 32,
        "The host must supply a strong random store secret of at least 32 characters."
    );
    let builder = Client::builder()
        .sqlite_store(store_path, Some(store_secret))
        .sliding_sync_version_builder(VersionBuilder::None)
        .request_config(
            RequestConfig::new()
                .timeout(Duration::from_secs(30))
                .retry_limit(2),
        )
        // Exclude unsigned recipient devices and reject changes to previously
        // verified identities. Cross-signing does not itself verify a contact.
        .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
        .with_encryption_settings(EncryptionSettings {
            auto_enable_cross_signing: false,
            auto_enable_backups: false,
            backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
        });
    // Discovery is used only for a new login; saved sessions retain the actual
    // resolved URL, so restoration cannot silently switch homeservers.
    let builder = if discover && url.scheme() == "https" {
        builder.server_name_or_homeserver_url(homeserver.trim())
    } else {
        builder.homeserver_url(url)
    };
    let client = builder
        .build()
        .await
        .context("Could not open the protected Matrix store or connect to the homeserver.")?;
    // A delegated .well-known response must not downgrade the credential and
    // token transport, even when the original discovery address used HTTPS.
    validate_homeserver(client.homeserver().as_str())?;
    Ok(client)
}

fn validate_homeserver(input: &str) -> Result<Url> {
    let input = input.trim();
    ensure!(
        !input.is_empty(),
        "Enter a homeserver, for example matrix.org."
    );
    let candidate = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&candidate).context("Enter a valid homeserver URL.")?;
    ensure!(url.host_str().is_some(), "The homeserver needs a hostname.");
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "Do not put credentials in the homeserver address."
    );
    ensure!(
        url.query().is_none() && url.fragment().is_none(),
        "The homeserver address cannot include query parameters or a fragment."
    );
    if url.scheme() != "https" {
        #[cfg(feature = "test-fixture")]
        if url.scheme() == "http" && url.host_str().is_some_and(is_loopback) {
            return Ok(url);
        }
        bail!("Use an HTTPS homeserver address.");
    }
    Ok(url)
}

#[cfg(feature = "test-fixture")]
fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "[::1]" | "::1" | "localhost")
}

fn prefers_browser_login(flows: &[Value]) -> bool {
    flows.iter().any(|flow| {
        flow["type"] == "m.login.sso"
            && (flow["oauth_aware_preferred"].as_bool() == Some(true)
                || flow["org.matrix.msc3824.delegated_oidc_compatibility"].as_bool() == Some(true))
    })
}

fn validate_message(body: &str, transaction_id: &str) -> Result<()> {
    ensure!(!body.trim().is_empty(), "Write a message first.");
    ensure!(
        body.len() <= MAX_MESSAGE_BYTES,
        "Message is too long (maximum 16,000 UTF-8 bytes)."
    );
    ensure!(
        !transaction_id.is_empty()
            && transaction_id.len() <= 128
            && transaction_id
                .bytes()
                .all(|v| v.is_ascii_alphanumeric() || b"-_".contains(&v)),
        "Invalid message transaction ID."
    );
    Ok(())
}

fn parse_message(raw: &Value, decrypted: bool) -> Option<Message> {
    let kind = raw["type"].as_str()?;
    if kind != "m.room.message" && kind != "m.room.encrypted" {
        return None;
    }
    let unable = kind == "m.room.encrypted";
    let body = if unable {
        "Encrypted message — keys are not available yet. Verify this device or restore recovery."
            .to_owned()
    } else if raw["unsigned"]["redacted_because"].is_object() {
        "Message removed".to_owned()
    } else {
        raw["content"]["body"].as_str()?.to_owned()
    };
    Some(Message {
        id: raw["event_id"].as_str()?.to_owned(),
        sender: raw["sender"].as_str()?.to_owned(),
        body,
        timestamp: raw["origin_server_ts"].as_u64().unwrap_or_default(),
        encrypted: decrypted || unable,
        unable_to_decrypt: unable,
    })
}

use std::future::IntoFuture;

// Keep the SDK/server reason visible without serializing requests or credentials.
// Previously an anyhow context hid every cause behind the same generic message.
fn send_error(error: matrix_sdk::Error) -> anyhow::Error {
    use matrix_sdk_crypto::{OlmError, SessionRecipientCollectionError as RecipientError};
    if let matrix_sdk::Error::OlmError(olm) = &error
        && let OlmError::SessionRecipientCollectionError(reason) = olm.as_ref()
    {
        let explanation = match reason {
                RecipientError::VerifiedUserChangedIdentity(users) => format!("Encryption blocked: a previously verified member changed their identity: {}. Verify their identity again with a trusted client before retrying.", users.iter().map(ToString::to_string).collect::<Vec<_>>().join(", ")),
                RecipientError::CrossSigningNotSetup => "Encryption blocked: account cross-signing is not set up. Set up recovery in Element, then recover keys here.".into(),
                RecipientError::SendingFromUnverifiedDevice => "Encryption blocked: this device is not verified. Recover your existing keys under Encryption setup.".into(),
                _ => format!("Encryption blocked: {reason}. Check the affected devices in a trusted client."),
            };
        return anyhow::anyhow!(explanation);
    }
    anyhow::anyhow!("Matrix send failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn send_errors_preserve_reason_and_explain_identity_changes() {
        let error = matrix_sdk::Error::OlmError(Box::new(
            matrix_sdk_crypto::OlmError::SessionRecipientCollectionError(
                matrix_sdk_crypto::SessionRecipientCollectionError::VerifiedUserChangedIdentity(
                    vec![matrix_sdk::ruma::UserId::parse("@member:example.org").unwrap()],
                ),
            ),
        ));
        let text = send_error(error).to_string();
        assert!(text.contains("@member:example.org") && text.contains("changed their identity"));
        assert!(
            send_error(matrix_sdk::Error::InsufficientData)
                .to_string()
                .contains("Local cache")
        );
    }

    #[test]
    fn rejects_credentials_and_insecure_remote_homeservers() {
        assert!(validate_homeserver("http://matrix.org").is_err());
        assert!(validate_homeserver("https://name:password@example.org").is_err());
        assert!(validate_homeserver("https://example.org/?access_token=secret").is_err());
        assert_eq!(
            validate_homeserver("matrix.org").unwrap().as_str(),
            "https://matrix.org/"
        );
    }

    #[test]
    fn respects_preferred_browser_auth() {
        assert!(prefers_browser_login(&[
            json!({"type":"m.login.sso","oauth_aware_preferred":true})
        ]));
        assert!(!prefers_browser_login(&[
            json!({"type":"m.login.password"})
        ]));
    }

    #[test]
    fn encrypted_failure_never_displays_ciphertext_as_plaintext() {
        let m = parse_message(&json!({"type":"m.room.encrypted","event_id":"$e","sender":"@a:test","content":{"body":"untrusted","ciphertext":"secret"}}), false).unwrap();
        assert!(m.encrypted && m.unable_to_decrypt);
        assert!(!m.body.contains("untrusted") && !m.body.contains("secret"));
    }

    #[test]
    fn validates_bytes_and_stable_transaction_ids() {
        assert!(validate_message(" ", "transaction").is_err());
        assert!(validate_message(&"界".repeat(6000), "transaction").is_err());
        assert!(validate_message("hello", "../bad").is_err());
        assert!(validate_message("hello", "send-123_abc").is_ok());
    }
}
