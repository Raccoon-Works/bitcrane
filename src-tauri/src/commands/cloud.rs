//! Cloud services: signing in with OAuth and connecting Dropbox, Google Drive and OneDrive.

use crate::error::{AppError, AppResult};
use crate::{AppState, dropbox, gdrive, oauth, onedrive, remote};
use super::app::open_url;
use super::connect::ConnectResult;
use std::sync::Arc;
use tauri::State;

/// Which cloud services this build has app keys for (Google Drive needs the user's own).
#[tauri::command]
pub(crate) fn cloud_services() -> oauth::CloudServices {
    oauth::services()
}

/// Signs in to a cloud service in the browser; returns the refresh token (the
/// interface keeps it in the keychain) and the account name.
#[tauri::command]
pub(crate) async fn cloud_sign_in(service: String, client_id: Option<String>, client_secret: Option<String>) -> AppResult<oauth::SignedIn> {
    let open = |url: &str| open_url(url.to_string());
    match service.as_str() {
        "dropbox" => dropbox::sign_in(open).await,
        // Google Drive: with the user's own app key (see docs/google-drive.md).
        "onedrive" => onedrive::sign_in(open).await,
        "gdrive" => gdrive::sign_in(client_id.as_deref().unwrap_or(""), client_secret.as_deref().unwrap_or(""), open).await,
        _ => Err(AppError::other("Diesen Cloud-Dienst kennt Bitcrane noch nicht.")),
    }
}

/// Stops a sign-in that is waiting for the browser.
#[tauri::command]
pub(crate) fn cloud_sign_in_cancel() {
    oauth::cancel();
}

#[tauri::command]
pub(crate) async fn dropbox_connect(state: State<'_, AppState>, server_id: String, params: dropbox::DropboxParams) -> AppResult<ConnectResult> {
    state.connections.lock().await.remove(&server_id);
    let conn = remote::Remote::Dropbox(Arc::new(dropbox::DropboxConn::connect(params).await?));
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

#[tauri::command]
pub(crate) async fn gdrive_connect(state: State<'_, AppState>, server_id: String, params: gdrive::GDriveParams) -> AppResult<ConnectResult> {
    state.connections.lock().await.remove(&server_id);
    let conn = remote::Remote::GDrive(Arc::new(gdrive::GDriveConn::connect(params).await?));
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

#[tauri::command]
pub(crate) async fn onedrive_connect(state: State<'_, AppState>, server_id: String, params: onedrive::OneDriveParams) -> AppResult<ConnectResult> {
    state.connections.lock().await.remove(&server_id);
    let conn = Arc::new(onedrive::OneDriveConn::connect(params).await?);
    let refresh_token = Some(conn.refresh_token().await);
    let remote = remote::Remote::OneDrive(conn);
    let home = remote.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(remote));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token })
}
