//! Secrets in the system keychain, and the encrypted secrets of export files and the sync file.
//!
//! The interface stores, forgets and asks about secrets but has no command that reads one back
//! (see `secrets.rs` for what that does and does not guarantee). Commands that derive a key or use
//! the keychain run on a worker thread: PBKDF2 and a keychain that asks the system can take
//! seconds, which must not freeze the window.

use crate::error::{AppError, AppResult};
use crate::secrets::{self, Keychain, Sealed, SecretMap, SecretRef, SecretStore};
use crate::serverconfig::{read_servers, Server};
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

/// The servers among these entries the core can read; the others are logged and left out, so one
/// damaged entry does not stop an export or the sync of all the others.
fn readable(entries: Vec<Value>) -> Vec<Server> {
    read_servers(entries).0
}

/// The stored secrets an export file carries for these server entries.
fn export_secrets(store: &dyn SecretStore, entries: Vec<Value>) -> SecretMap {
    secrets::collect(store, readable(entries).iter().flat_map(|s| s.transferable_secrets(false)))
}

/// The stored secrets the sync file carries for these server entries, with the Google app secret.
fn sync_secrets(store: &dyn SecretStore, entries: Vec<Value>) -> SecretMap {
    let servers = readable(entries);
    let refs = servers.iter().flat_map(|s| s.transferable_secrets(true)).chain([SecretRef::GoogleClient]);
    secrets::collect(store, refs)
}

/// Removes the secrets of a deleted server, except those a remaining server uses as well (two
/// entries for the same login share one password).
#[tauri::command]
pub(crate) async fn server_forget_secrets(removed: Value, remaining: Vec<Value>) -> AppResult<()> {
    let Some(removed) = readable(vec![removed]).pop() else { return Ok(()) };
    let remaining = readable(remaining);
    tokio::task::spawn_blocking(move || {
        let in_use: Vec<SecretRef> = remaining.iter().flat_map(Server::all_secrets).collect();
        for secret in removed.all_secrets().into_iter().filter(|s| !in_use.contains(s)) {
            // Most of these entries were never stored; a failed removal leaves nothing the user can act on.
            if let Err(e) = Keychain.delete(&secret) {
                log::warn!("could not remove {} from the keychain: {e}", secret.account());
            }
        }
    })
    .await?;
    Ok(())
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
pub(crate) async fn export_seal(mut payload: Value, password: String, with_secrets: bool) -> AppResult<SealedExport> {
    Ok(tokio::task::spawn_blocking(move || {
        let mut count = 0;
        if with_secrets {
            let entries = payload["servers"].as_array().cloned().unwrap_or_default();
            let found = export_secrets(&Keychain, entries);
            count = found.len();
            payload["secrets"] = serde_json::to_value(found).expect("a map of strings always serializes");
        }
        SealedExport { encrypted: secrets::seal(&payload.to_string(), &password), secrets: count }
    })
    .await?)
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
pub(crate) async fn import_unseal(sealed: Sealed, password: String) -> AppResult<Option<OpenedExport>> {
    Ok(tokio::task::spawn_blocking(move || {
        let mut data: Value = serde_json::from_str(&secrets::unseal(&sealed, &password)?).ok()?;
        let found: SecretMap =
            data.as_object_mut()?.remove("secrets").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        let restored = secrets::restore(&Keychain, &found, true);
        if let Some(e) = restored.refused {
            log::warn!("the keychain refused secrets of an imported file: {e}");
        }
        Some(OpenedExport { data, restored: restored.count })
    })
    .await?)
}

/// The secrets of these servers for the sync file, encrypted with this computer's sync password:
/// passwords, passphrases, proxy passwords, cloud sign-ins and the Google app secret. `None` when
/// no sync password is set.
#[tauri::command]
pub(crate) async fn sync_secrets_seal(servers: Vec<Value>) -> AppResult<Option<Sealed>> {
    Ok(tokio::task::spawn_blocking(move || {
        let password = secrets::saved(&Keychain, &SecretRef::SyncPassword)?;
        let found = sync_secrets(&Keychain, servers);
        Some(secrets::seal(&serde_json::to_string(&found).expect("a map of strings always serializes"), &password))
    })
    .await?)
}

/// Takes the secrets of the sync file into the keychain, only where none is stored here: a
/// password changed on this computer is not overwritten. Fails when the sync password does not
/// open them; resolves to the keychain's refusal, if any, which the interface reports while the
/// rest of the sync goes on.
#[tauri::command]
pub(crate) async fn sync_secrets_unseal(sealed: Sealed) -> AppResult<Option<AppError>> {
    tokio::task::spawn_blocking(move || {
        let Some(password) = secrets::saved(&Keychain, &SecretRef::SyncPassword) else { return Ok(None) };
        let found: SecretMap = secrets::unseal(&sealed, &password)
            .and_then(|text| serde_json::from_str(&text).ok())
            .ok_or_else(|| {
                AppError::other(
                    "Die Passwörter im Abgleich lassen sich mit deinem Abgleich-Passwort nicht entschlüsseln. Ist es auf allen Rechnern gleich?",
                )
            })?;
        Ok(secrets::restore(&Keychain, &found, false).refused)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::tests::MemoryStore;
    use serde_json::json;

    #[test]
    fn a_server_the_core_cannot_read_does_not_stop_the_others() {
        let entries = || {
            vec![
                json!({ "id": "a", "name": "Webserver", "host": "web.example", "port": 22, "user": "anna" }),
                // Edited by hand: no port fits into 16 bits, no version writes this encoding.
                json!({ "id": "b", "name": "Kaputt", "host": "bad.example", "port": 70000, "user": "x" }),
                json!({ "id": "c", "protocol": "ftp", "host": "ftp.example", "ftpEncoding": "utf-16" }),
                json!({ "id": "d", "name": "Bucket", "protocol": "s3", "host": "s3.example", "port": 443, "user": "AK" }),
            ]
        };
        let store = MemoryStore::default();
        for account in ["password:anna@web.example:22", "password:AK@s3.example:443", "cloud-client:gdrive"] {
            store.0.lock().unwrap().insert(account.into(), format!("secret of {account}"));
        }
        let accounts = |map: SecretMap| map.into_keys().collect::<Vec<_>>();
        assert_eq!(
            accounts(export_secrets(&store, entries())),
            ["password:AK@s3.example:443", "password:anna@web.example:22"]
        );
        assert_eq!(
            accounts(sync_secrets(&store, entries())),
            ["cloud-client:gdrive", "password:AK@s3.example:443", "password:anna@web.example:22"]
        );
    }
}
