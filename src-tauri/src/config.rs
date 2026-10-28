//! Persistent settings and secrets.
//!
//! Servers, watches and preferences are stored as JSON in the app's config
//! folder (macOS: ~/Library/Application Support/de.raccoonworks.bitcrane,
//! Windows: %APPDATA%\de.raccoonworks.bitcrane). Passwords and key
//! passphrases never go into that file: they live in the system keychain
//! (macOS Keychain, Windows Credential Manager).

use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::path::{Path, PathBuf};

const KEYRING_SERVICE: &str = "Bitcrane";

pub fn config_file(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

/// Reads the stored configuration, or `null` on first start.
pub fn load(dir: &Path) -> AppResult<Value> {
    match std::fs::read_to_string(config_file(dir)) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| {
            // Keep the broken file: the next save would otherwise overwrite it.
            let name = format!("config.damaged-{}.json", chrono::Local::now().format("%Y-%m-%d_%H-%M-%S"));
            let _ = std::fs::copy(config_file(dir), dir.join(&name));
            AppError::other(format!("Die Einstellungen waren beschädigt und wurden nicht geladen. Eine Kopie liegt als {name} im Einstellungsordner.")).with_detail(e.to_string())
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.into()),
    }
}

/// Writes the configuration atomically (temp file, then rename).
pub fn save(dir: &Path, value: &Value) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join("config.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(value).unwrap_or_default())?;
    std::fs::rename(tmp, config_file(dir))?;
    Ok(())
}

fn entry(account: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| AppError::other("Schlüsselbund nicht verfügbar.").with_detail(e.to_string()))
}

pub fn secret_get(account: &str) -> AppResult<Option<String>> {
    match entry(account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::other("Schlüsselbund nicht lesbar.").with_detail(e.to_string())),
    }
}

pub fn secret_set(account: &str, value: &str) -> AppResult<()> {
    entry(account)?.set_password(value).map_err(|e| AppError::other("Konnte nicht im Schlüsselbund speichern.").with_detail(e.to_string()))
}

pub fn secret_delete(account: &str) -> AppResult<()> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::other("Konnte nicht aus dem Schlüsselbund löschen.").with_detail(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), Value::Null);
        let v = serde_json::json!({ "servers": [{ "id": "ob" }] });
        save(dir.path(), &v).unwrap();
        assert_eq!(load(dir.path()).unwrap(), v);
    }
}
