//! SSH keys and known hosts.

use crate::error::AppResult;
use crate::{keys, paths, AppState};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeyInfo {
    exists: bool,
    /// "ED25519", "RSA", "ECDSA" ...; empty when the file is no OpenSSH key.
    algorithm: String,
    encrypted: bool,
    /// The file could not be read as a key.
    invalid: bool,
}

/// Reads type and encryption of a private key without its passphrase.
#[tauri::command]
pub(crate) fn key_info(path: String) -> KeyInfo {
    let native = paths::to_native(&path);
    if !native.is_file() {
        return KeyInfo { exists: false, algorithm: String::new(), encrypted: false, invalid: false };
    }
    // Keys are text files; anything else (unreadable, binary) is no key Bitcrane can use.
    let Ok(text) = std::fs::read_to_string(&native) else {
        return KeyInfo { exists: true, algorithm: String::new(), encrypted: false, invalid: true };
    };
    if text.starts_with("PuTTY-User-Key-File") {
        let (algorithm, encrypted) = keys::ppk_info(&text);
        return KeyInfo { exists: true, algorithm, encrypted, invalid: false };
    }
    match russh::keys::PrivateKey::from_openssh(text.trim()).ok() {
        Some(k) => KeyInfo {
            exists: true,
            algorithm: match k.algorithm() {
                russh::keys::Algorithm::Ed25519 => "ED25519".into(),
                russh::keys::Algorithm::Rsa { .. } => "RSA".into(),
                russh::keys::Algorithm::Ecdsa { .. } => "ECDSA".into(),
                other => other.as_str().to_uppercase(),
            },
            encrypted: k.is_encrypted(),
            invalid: false,
        },
        // Older PEM keys ("BEGIN RSA PRIVATE KEY") are still usable for login.
        None => match russh::keys::decode_secret_key(&text, None) {
            Ok(_) => KeyInfo { exists: true, algorithm: "RSA".into(), encrypted: false, invalid: false },
            Err(russh::keys::Error::KeyIsEncrypted) => {
                KeyInfo { exists: true, algorithm: String::new(), encrypted: true, invalid: false }
            }
            Err(_) => KeyInfo { exists: true, algorithm: String::new(), encrypted: false, invalid: true },
        },
    }
}

/// Creates a new ED25519 key pair; returns the public key line.
#[tauri::command]
pub(crate) fn key_generate(path: String, comment: String, passphrase: Option<String>) -> AppResult<String> {
    keys::generate(&path, &comment, passphrase.as_deref())
}

/// Public key line of a private key (for copying or adding to a server).
#[tauri::command]
pub(crate) fn key_public(path: String) -> AppResult<String> {
    keys::public_of(&path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnownHostEntry {
    host: String,
    fingerprint: String,
}

#[tauri::command]
pub(crate) fn known_hosts_list(state: State<'_, AppState>) -> Vec<KnownHostEntry> {
    state.known_hosts.list().into_iter().map(|(host, fingerprint)| KnownHostEntry { host, fingerprint }).collect()
}

#[tauri::command]
pub(crate) fn known_hosts_remove(state: State<'_, AppState>, host: String) -> AppResult<()> {
    state.known_hosts.remove(&host)
}
