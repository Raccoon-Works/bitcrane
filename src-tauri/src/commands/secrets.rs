//! Secrets in the system keychain, and the encrypted secrets of export files and the sync file.
//! The interface names secrets but never reads them (see `secrets.rs`).

use crate::error::{AppError, AppResult};
use crate::secrets::{self, Keychain, Sealed, SecretMap, SecretRef, SecretStore};
use crate::serverconfig::Server;
use serde::Serialize;
use serde_json::Value;

/// Stores a secret the user has entered (a password with "sichern", a proxy password, the Google
/// app secret, the sync password, a new key's passphrase).
#[tauri::command]
pub(crate) fn secret_store(secret: SecretRef, value: String) -> AppResult<()> {
    Keychain.set(&secret, &value)
}

#[tauri::command]
pub(crate) fn secret_forget(secret: SecretRef) -> AppResult<()> {
    Keychain.delete(&secret)
}

/// Whether a secret is stored, so the interface knows whether to ask for it. A keychain that
/// cannot be read counts as one without it, as when logging in.
#[tauri::command]
pub(crate) fn secret_exists(secret: SecretRef) -> bool {
    secrets::saved(&Keychain, &secret).is_some()
}

/// Removes the secrets of a deleted server, except those a remaining server uses as well (two
/// entries for the same login share one password).
#[tauri::command]
pub(crate) fn server_forget_secrets(removed: Server, remaining: Vec<Server>) {
    let in_use: Vec<SecretRef> = remaining.iter().flat_map(Server::all_secrets).collect();
    for secret in removed.all_secrets().into_iter().filter(|s| !in_use.contains(s)) {
        // Most of these entries were never stored; a failed removal leaves nothing the user can act on.
        if let Err(e) = Keychain.delete(&secret) {
            log::warn!("could not remove {} from the keychain: {e}", secret.account());
        }
    }
}

fn servers_of(payload: &Value) -> AppResult<Vec<Server>> {
    serde_json::from_value(payload["servers"].clone())
        .map_err(|e| AppError::other("Unerwarteter Fehler.").with_detail(e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SealedExport {
    encrypted: Sealed,
    /// How many secrets went into the file.
    secrets: usize,
}

/// Encrypts the payload of an export file (servers, watches, settings) with the user's password.
/// `with_secrets` adds the stored passwords, passphrases and proxy passwords of its servers.
#[tauri::command]
pub(crate) fn export_seal(mut payload: Value, password: String, with_secrets: bool) -> AppResult<SealedExport> {
    let mut count = 0;
    if with_secrets {
        let refs = servers_of(&payload)?.iter().flat_map(|s| s.transferable_secrets(false)).collect::<Vec<_>>();
        let found = secrets::collect(&Keychain, refs);
        count = found.len();
        payload["secrets"] = serde_json::to_value(found).expect("a map of strings always serializes");
    }
    Ok(SealedExport { encrypted: secrets::seal(&payload.to_string(), &password), secrets: count })
}

#[derive(Serialize)]
pub(crate) struct OpenedExport {
    /// The payload without its secrets, which are in the keychain now.
    data: Value,
    /// How many secrets were stored.
    restored: usize,
}

/// Decrypts an encrypted export file and puts its secrets into the keychain (replacing stored
/// ones, as the user imports on purpose). `None` when the password is wrong.
#[tauri::command]
pub(crate) fn import_unseal(sealed: Sealed, password: String) -> Option<OpenedExport> {
    let mut data: Value = serde_json::from_str(&secrets::unseal(&sealed, &password)?).ok()?;
    let found: SecretMap =
        data.as_object_mut()?.remove("secrets").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    let restored = secrets::restore(&Keychain, &found, true);
    if let Some(e) = restored.refused {
        log::warn!("the keychain refused secrets of an imported file: {e}");
    }
    Some(OpenedExport { data, restored: restored.count })
}

/// The secrets of these servers for the sync file, encrypted with this computer's sync password:
/// passwords, passphrases, proxy passwords, cloud sign-ins and the Google app secret. `None` when
/// no sync password is set.
#[tauri::command]
pub(crate) fn sync_secrets_seal(servers: Vec<Server>) -> Option<Sealed> {
    let password = secrets::saved(&Keychain, &SecretRef::SyncPassword)?;
    let refs = servers.iter().flat_map(|s| s.transferable_secrets(true)).chain([SecretRef::GoogleClient]);
    let found = secrets::collect(&Keychain, refs);
    Some(secrets::seal(&serde_json::to_string(&found).expect("a map of strings always serializes"), &password))
}

/// Takes the secrets of the sync file into the keychain, only where none is stored here: a
/// password changed on this computer is not overwritten. Fails when the sync password does not
/// open them; resolves to the keychain's refusal, if any, which the interface reports while the
/// rest of the sync goes on.
#[tauri::command]
pub(crate) fn sync_secrets_unseal(sealed: Sealed) -> AppResult<Option<AppError>> {
    let Some(password) = secrets::saved(&Keychain, &SecretRef::SyncPassword) else { return Ok(None) };
    let found: SecretMap = secrets::unseal(&sealed, &password)
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| {
            AppError::other(
                "Die Passwörter im Abgleich lassen sich mit deinem Abgleich-Passwort nicht entschlüsseln. Ist es auf allen Rechnern gleich?",
            )
        })?;
    Ok(secrets::restore(&Keychain, &found, false).refused)
}
