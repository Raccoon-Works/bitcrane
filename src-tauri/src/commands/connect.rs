//! Connecting to servers and vaults, including the questions a server asks during login.

use crate::error::AppResult;
use crate::ssh::ConnectParams;
use crate::{AppState, dav, ftp, PendingPrompts, remote, s3, smb, ssh, vault};
use serde::Serialize;
use std::sync::Arc;
use tauri::{Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectResult {
    pub(super) home: String,
    /// Server clock minus local clock in milliseconds, if it could be measured.
    pub(super) clock_offset_ms: Option<i64>,
    /// OneDrive: the renewed sign-in, to be kept in place of the old one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) refresh_token: Option<String>,
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
            let answer = tokio::time::timeout(std::time::Duration::from_secs(180), rx).await.ok().and_then(|r| r.ok()).flatten();
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

#[tauri::command]
pub(crate) async fn ssh_connect(app: tauri::AppHandle, state: State<'_, AppState>, server_id: String, params: ConnectParams) -> AppResult<ConnectResult> {
    // Take it out first: closing can take a while and must not hold the lock.
    let old = state.connections.lock().await.remove(&server_id);
    if let Some(old) = old {
        old.close().await;
    }
    let prompter = make_prompter(app, state.prompts.clone(), server_id.clone());
    let conn = remote::connect_ssh(&params, state.known_hosts.clone(), Some(prompter)).await?;
    let home = conn.home().to_string();
    let clock_offset_ms = conn.clock_offset_ms().await;
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms, refresh_token: None })
}

#[tauri::command]
pub(crate) async fn ftp_connect(state: State<'_, AppState>, server_id: String, params: ftp::FtpParams) -> AppResult<ConnectResult> {
    // Take it out first: closing can take a while and must not hold the lock.
    let old = state.connections.lock().await.remove(&server_id);
    if let Some(old) = old {
        old.close().await;
    }
    let conn = remote::Remote::Ftp(Arc::new(ftp::FtpConn::connect(params, state.known_hosts.clone()).await?));
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

#[tauri::command]
pub(crate) async fn dav_connect(state: State<'_, AppState>, server_id: String, params: dav::DavParams) -> AppResult<ConnectResult> {
    state.connections.lock().await.remove(&server_id);
    let conn = remote::Remote::Dav(dav::DavConn::connect(params, state.known_hosts.clone()).await?);
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

#[tauri::command]
pub(crate) async fn s3_connect(state: State<'_, AppState>, server_id: String, params: s3::S3Params) -> AppResult<ConnectResult> {
    state.connections.lock().await.remove(&server_id);
    let conn = remote::Remote::S3(Arc::new(s3::S3Conn::connect(params, state.known_hosts.clone()).await?));
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

#[tauri::command]
pub(crate) async fn smb_connect(state: State<'_, AppState>, server_id: String, params: smb::SmbParams) -> AppResult<ConnectResult> {
    let old = state.connections.lock().await.remove(&server_id);
    if let Some(old) = old {
        old.close().await;
    }
    let conn = remote::Remote::Smb(Arc::new(smb::SmbConn::connect(params).await?));
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

/// Unlocks a Cryptomator vault and keeps it under `server_id` like a server.
/// `storage_id` is the connection of the server the vault lies on (none: this computer).
#[tauri::command]
pub(crate) async fn vault_open(state: State<'_, AppState>, server_id: String, location: String, storage_id: Option<String>, password: String) -> AppResult<ConnectResult> {
    let store = match storage_id {
        Some(id) => vault::Store::Remote { connections: state.connections.clone(), id },
        None => vault::Store::Local,
    };
    let conn = remote::Remote::Vault(Arc::new(vault::VaultConn::open(store, &location, &password).await?));
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

/// Creates a new, empty Cryptomator vault in the folder `location`.
#[tauri::command]
pub(crate) async fn vault_create(state: State<'_, AppState>, location: String, storage_id: Option<String>, password: String) -> AppResult<()> {
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
