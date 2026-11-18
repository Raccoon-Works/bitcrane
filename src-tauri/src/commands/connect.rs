//! Connecting to servers and vaults, including the questions a server asks during login.

use crate::error::AppResult;
use crate::login::{Env, Login};
use crate::secrets::Keychain;
use crate::serverconfig::Server;
use crate::{remote, ssh, vault, AppState, PendingPrompts};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectResult {
    pub(super) home: String,
    /// Server clock minus local clock in milliseconds, if it could be measured.
    pub(super) clock_offset_ms: Option<i64>,
}

/// A login as the interface asks for it: the server (saved, temporary or a draft being tested),
/// its jump server, and what the user has just typed or confirmed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectRequest {
    server: Server,
    #[serde(default)]
    jump: Option<Server>,
    #[serde(flatten)]
    login: Login,
}

impl ConnectRequest {
    /// Opens the connection; `prompt_id` is the server the login questions are shown for.
    async fn open(&self, app: tauri::AppHandle, state: &AppState, prompt_id: String) -> AppResult<remote::Remote> {
        let env = Env {
            known: state.known_hosts.clone(),
            prompter: Some(make_prompter(app, state.prompts.clone(), prompt_id)),
            secrets: &Keychain,
            connections: state.connections.clone(),
        };
        crate::login::open(&self.server, self.jump.as_ref(), &self.login, &env).await
    }
}

/// Event payload for a question of the server (shown as a dialog).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthPromptEvent {
    id: String,
    server_id: String,
    #[serde(flatten)]
    request: ssh::PromptRequest,
}

/// Forwards server questions to the interface and waits up to 3 minutes for answers.
pub(super) fn make_prompter(app: tauri::AppHandle, pending: PendingPrompts, server_id: String) -> ssh::Prompter {
    Arc::new(move |request| {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        pending.lock().unwrap().insert(id.clone(), tx);
        let _ = app.emit("auth-prompt", AuthPromptEvent { id: id.clone(), server_id: server_id.clone(), request });
        let pending = pending.clone();
        Box::pin(async move {
            let answer =
                tokio::time::timeout(std::time::Duration::from_secs(180), rx).await.ok().and_then(|r| r.ok()).flatten();
            pending.lock().unwrap().remove(&id);
            answer
        })
    })
}

/// Answers of the user to a server question; `None` cancels the login.
#[tauri::command]
pub(crate) fn auth_prompt_answer(state: State<'_, AppState>, id: String, answers: Option<Vec<String>>) {
    if let Some(tx) = state.prompts.lock().unwrap().remove(&id) {
        let _ = tx.send(answers);
    }
}

/// Connects to a server with any protocol and keeps the connection under `server_id` (the
/// server's id, or another id for a second connection such as the Explorer folder's).
#[tauri::command]
pub(crate) async fn server_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    request: ConnectRequest,
) -> AppResult<ConnectResult> {
    // Take it out first: closing can take a while and must not hold the lock.
    let old = state.connections.lock().await.remove(&server_id);
    if let Some(old) = old {
        old.close().await;
    }
    let conn = request.open(app, &state, server_id.clone()).await?;
    let home = conn.home().to_string();
    let clock_offset_ms = conn.clock_offset_ms().await;
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms })
}

/// "Verbindung testen": logs in with a connection of its own and closes it again; resolves to the
/// start folder.
#[tauri::command]
pub(crate) async fn server_test(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: ConnectRequest,
) -> AppResult<String> {
    let conn = request.open(app, &state, String::new()).await?;
    let home = conn.home().to_string();
    conn.close().await;
    Ok(home)
}

/// Creates a new, empty Cryptomator vault in the folder `location`.
#[tauri::command]
pub(crate) async fn vault_create(
    state: State<'_, AppState>,
    location: String,
    storage_id: Option<String>,
    password: String,
) -> AppResult<()> {
    let store = match storage_id {
        Some(id) => vault::Store::Remote { connections: state.connections.clone(), id },
        None => vault::Store::Local,
    };
    vault::VaultConn::create(store, &location, &password).await
}

#[tauri::command]
pub(crate) async fn ssh_disconnect(state: State<'_, AppState>, server_id: String) -> AppResult<()> {
    state.forwards.stop_server(&server_id).await;
    let old = state.connections.lock().await.remove(&server_id);
    if let Some(c) = old {
        c.close().await;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn ssh_is_connected(state: State<'_, AppState>, server_id: String) -> AppResult<bool> {
    Ok(state.conn(&server_id).await.is_ok())
}
