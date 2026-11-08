mod vault;

const _: () = assert!(
    !client_core::TEST_FIXTURE_ENABLED,
    "The desktop app must not enable test-fixture"
);

use client_core::Core;
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

struct ActiveSession {
    core: Arc<Core>,
    task: tauri::async_runtime::JoinHandle<()>,
}

struct AppState {
    _instance_lock: std::fs::File,
    root: PathBuf,
    initialized: AtomicBool,
    operations: Mutex<()>,
    active: RwLock<Option<ActiveSession>>,
    sync_error: Arc<RwLock<Option<String>>>,
    syncing: Arc<AtomicBool>,
    cancel: Mutex<Option<CancellationToken>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStatus {
    authenticated: bool,
    user_id: Option<String>,
    device_id: Option<String>,
    syncing: bool,
    error: Option<String>,
    device_verified: bool,
    recovery_state: Option<String>,
    has_saved_session: bool,
}

impl AppState {
    async fn core(&self) -> Result<Arc<Core>, String> {
        self.active
            .read()
            .await
            .as_ref()
            .map(|active| active.core.clone())
            .ok_or_else(|| "Sign in first.".into())
    }

    async fn install(&self, core: Core) {
        let core = Arc::new(core);
        let worker = core.clone();
        let errors = self.sync_error.clone();
        let syncing = self.syncing.clone();
        *errors.write().await = None;
        let task = tauri::async_runtime::spawn(async move {
            let mut retry_seconds = 2;
            loop {
                match worker.sync_once().await {
                    Ok(()) => {
                        syncing.store(true, Ordering::SeqCst);
                        *errors.write().await = None;
                        retry_seconds = 2;
                    }
                    Err(error) => {
                        syncing.store(false, Ordering::SeqCst);
                        *errors.write().await = Some(format!("Sync paused: {error}"));
                        tokio::time::sleep(std::time::Duration::from_secs(retry_seconds)).await;
                        retry_seconds = (retry_seconds * 2).min(30);
                    }
                }
            }
        });
        let mut active = self.active.write().await;
        if let Some(old) = active.take() {
            old.task.abort();
        }
        *active = Some(ActiveSession { core, task });
    }

    async fn initialize(&self) {
        if self.initialized.load(Ordering::SeqCst) {
            return;
        }
        let _guard = self.operations.lock().await;
        if self.initialized.load(Ordering::SeqCst) {
            return;
        }
        let result = async {
            if let Some(saved) = vault::load(&self.root)? {
                let path = saved.store_path(&self.root)?;
                let core = Core::restore(&saved.session, &path, &saved.store_secret)
                    .await
                    .map_err(|e| e.to_string())?;
                self.install(core).await;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            *self.sync_error.write().await =
                Some(format!("Could not restore your saved login: {error}"));
        }
        self.initialized.store(true, Ordering::SeqCst);
    }

    async fn prepare_login(&self) -> Result<(String, PathBuf, Zeroizing<String>), String> {
        if self.active.read().await.is_some() || self.root.join("session.bin").exists() {
            return Err("A saved login already exists. Sign out or remove that saved login before signing in again.".into());
        }
        let profile = uuid::Uuid::new_v4().to_string();
        let path = self.root.join("profiles").join(&profile);
        let secret = Zeroizing::new(vault::new_secret()?);
        Ok((profile, path, secret))
    }

    async fn finish_login(
        &self,
        core: Core,
        profile_id: String,
        store_secret: &str,
    ) -> Result<(), String> {
        let saved = vault::SavedSession {
            version: 1,
            profile_id,
            store_secret: store_secret.to_owned(),
            session: core.export_session().map_err(|e| e.to_string())?,
        };
        if let Err(error) = vault::save(&self.root, &saved) {
            let _ = core.logout().await;
            return Err(error);
        }
        self.install(core).await;
        self.initialized.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[tauri::command]
async fn app_status(state: State<'_, AppState>) -> Result<AppStatus, String> {
    state.initialize().await;
    let core = state
        .active
        .read()
        .await
        .as_ref()
        .map(|active| active.core.clone());
    let mut status = AppStatus {
        authenticated: core.is_some(),
        user_id: None,
        device_id: None,
        syncing: state.syncing.load(Ordering::SeqCst),
        error: state.sync_error.read().await.clone(),
        device_verified: false,
        recovery_state: None,
        has_saved_session: state.root.join("session.bin").exists(),
    };
    if let Some(core) = core {
        let account = core.account();
        status.user_id = Some(account.user_id);
        status.device_id = Some(account.device_id);
        let security = core.security_status().await.map_err(|e| e.to_string())?;
        status.device_verified = security.device_verified;
        status.recovery_state = Some(security.recovery_state);
    }
    Ok(status)
}

#[tauri::command]
async fn login(
    state: State<'_, AppState>,
    homeserver: String,
    username: String,
    password: String,
) -> Result<(), String> {
    state.initialize().await;
    let _guard = state.operations.lock().await;
    let (profile, path, secret) = state.prepare_login().await?;
    let password = Zeroizing::new(password);
    let core = Core::login_password(&homeserver, &username, &password, &path, &secret)
        .await
        .map_err(|e| e.to_string())?;
    state.finish_login(core, profile, &secret).await
}

#[tauri::command]
async fn login_sso(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    homeserver: String,
) -> Result<(), String> {
    state.initialize().await;
    let _guard = state.operations.lock().await;
    let (profile, path, secret) = state.prepare_login().await?;
    let cancel = CancellationToken::new();
    *state.cancel.lock().await = Some(cancel.clone());
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("Browser sign-in cancelled. You may close the browser tab.".to_string()),
        result = Core::login_sso(&homeserver, &path, &secret, move |url| {
            if !url.starts_with("https://") { return Err("The sign-in server must use HTTPS.".into()); }
            app.opener().open_url(url, None::<&str>).map_err(|e| format!("Could not open the browser: {e}"))
        }) => result.map_err(|e| e.to_string()),
    };
    *state.cancel.lock().await = None;
    state.finish_login(result?, profile, &secret).await
}

#[tauri::command]
async fn cancel_login(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancel) = state.cancel.lock().await.as_ref() {
        cancel.cancel();
    }
    // Let the login command finish before the UI reads the resulting session.
    let _guard = state.operations.lock().await;
    Ok(())
}

#[tauri::command]
async fn list_rooms(state: State<'_, AppState>) -> Result<Vec<client_core::RoomSummary>, String> {
    state.core().await?.rooms().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn space_rooms(
    state: State<'_, AppState>,
    room_id: String,
    from: Option<String>,
) -> Result<client_core::SpacePage, String> {
    state
        .core()
        .await?
        .space_rooms(&room_id, from)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_messages(
    state: State<'_, AppState>,
    room_id: String,
) -> Result<Vec<client_core::Message>, String> {
    state
        .core()
        .await?
        .messages(&room_id, 100)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_message(
    state: State<'_, AppState>,
    room_id: String,
    body: String,
    transaction_id: String,
) -> Result<String, String> {
    let _guard = state.operations.lock().await;
    if body.trim().is_empty() || body.len() > 16_000 {
        return Err("Messages must contain text and be at most 16,000 bytes.".into());
    }
    uuid::Uuid::parse_str(&transaction_id).map_err(|_| "Invalid message transaction ID.")?;
    state
        .core()
        .await?
        .send_message(&room_id, &body, &transaction_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn join_room(state: State<'_, AppState>, room_id: String) -> Result<String, String> {
    let _guard = state.operations.lock().await;
    state
        .core()
        .await?
        .join_room(&room_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn recover(state: State<'_, AppState>, recovery_key: String) -> Result<(), String> {
    let _guard = state.operations.lock().await;
    let key = Zeroizing::new(recovery_key);
    state
        .core()
        .await?
        .recover(&key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn logout(state: State<'_, AppState>) -> Result<(), String> {
    let _guard = state.operations.lock().await;
    if let Some(core) = state
        .active
        .read()
        .await
        .as_ref()
        .map(|active| active.core.clone())
    {
        core.logout()
            .await
            .map_err(|e| format!("Server sign-out failed; the saved login is retained. {e}"))?;
    }
    vault::forget(&state.root)?;
    if let Some(active) = state.active.write().await.take() {
        active.task.abort();
    }
    state.syncing.store(false, Ordering::SeqCst);
    *state.sync_error.write().await = None;
    state.initialized.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Unoptimized Matrix SDK restore futures need more than Windows' small
    // default worker stack. Keep this runtime alive for the entire app.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(8 * 1024 * 1024)
        .build()
        .expect("Could not start the messaging runtime");
    tauri::async_runtime::set(runtime.handle().clone());
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            std::fs::create_dir_all(&root)?;
            let instance_lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(root.join("app.lock"))?;
            // A Matrix crypto store must have one active process and sync loop.
            if instance_lock.try_lock().is_err() {
                app.handle().exit(0);
                return Ok(());
            }
            app.manage(AppState {
                _instance_lock: instance_lock,
                root,
                initialized: AtomicBool::new(false),
                operations: Mutex::new(()),
                active: RwLock::new(None),
                sync_error: Arc::new(RwLock::new(None)),
                syncing: Arc::new(AtomicBool::new(false)),
                cancel: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_status,
            login,
            login_sso,
            cancel_login,
            list_rooms,
            space_rooms,
            get_messages,
            send_message,
            join_room,
            recover,
            logout
        ])
        .run(tauri::generate_context!())
        .expect("Could not launch Matrix Client Prototype");
}
