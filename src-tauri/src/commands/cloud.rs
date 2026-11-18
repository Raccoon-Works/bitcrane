//! Cloud services: which ones this build offers, and signing in to them with OAuth (connecting is
//! the same as for every server, see `connect.rs`).

use super::app::open_url;
use crate::error::{AppError, AppResult};
use crate::secrets::{Keychain, SecretRef, SecretStore};
use crate::{dropbox, gdrive, oauth, onedrive};

/// Which cloud services this build has app keys for (Google Drive needs the user's own).
#[tauri::command]
pub(crate) fn cloud_services() -> oauth::CloudServices {
    oauth::services()
}

/// Signs in to a cloud service in the browser and keeps the sign-in (a refresh token) in the
/// keychain for the server entry `server_id`, which the interface creates or renews with it.
/// Returns the account name. Google Drive signs in with the user's own app key: `google_client_id`
/// from the settings and the secret from the keychain.
#[tauri::command]
pub(crate) async fn cloud_sign_in(service: String, server_id: String, google_client_id: String) -> AppResult<String> {
    let open = |url: &str| open_url(url.to_string());
    let signed_in = match service.as_str() {
        "dropbox" => dropbox::sign_in(open).await?,
        "onedrive" => onedrive::sign_in(open).await?,
        "gdrive" => {
            let (client_id, client_secret) = crate::login::google_key(&google_client_id, &Keychain)?;
            gdrive::sign_in(&client_id, &client_secret, open).await?
        }
        _ => return Err(AppError::other("Diesen Cloud-Dienst kennt Bitcrane noch nicht.")),
    };
    Keychain.set(&SecretRef::Cloud { server_id }, &signed_in.refresh_token)?;
    Ok(signed_in.account)
}

/// Stops a sign-in that is waiting for the browser.
#[tauri::command]
pub(crate) fn cloud_sign_in_cancel() {
    oauth::cancel();
}
