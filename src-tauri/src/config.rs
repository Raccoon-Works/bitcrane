//! Persistent settings.
//!
//! Servers, watches and preferences are stored as JSON in the app's config
//! folder (macOS: ~/Library/Application Support/de.raccoonworks.bitcrane,
//! Windows: %APPDATA%\de.raccoonworks.bitcrane). Passwords and key
//! passphrases never go into that file: they live in the system keychain
//! (see `secrets.rs`).

use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn config_file(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

/// Reads the stored configuration, or `null` on first start.
pub fn load(dir: &Path) -> AppResult<Value> {
    let path = config_file(dir);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| {
            let name = keep_damaged(&path);
            AppError::other("Die Einstellungen waren beschädigt und wurden nicht geladen. Eine Kopie liegt als {0} im Einstellungsordner.").param(name).with_detail(e.to_string())
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.into()),
    }
}

/// Writes the configuration atomically.
pub fn save(dir: &Path, value: &Value) -> AppResult<()> {
    Ok(write_atomic(&config_file(dir), &serde_json::to_string_pretty(value).expect("a JSON value always serializes"))?)
}

/// Writes one of Bitcrane's own files through a temporary file and a rename, so a crash or a full
/// disk leaves the previous version whole instead of a half-written file.
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Copies a file that could not be read aside ("<name>.damaged-<time>.json" next to it): the next
/// save would otherwise overwrite what may still be rescued by hand. Returns the copy's name.
pub fn keep_damaged(path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = format!("{stem}.damaged-{}.json", chrono::Local::now().format("%Y-%m-%d_%H-%M-%S"));
    if let Err(e) = std::fs::copy(path, path.with_file_name(&name)) {
        log::warn!("could not keep a copy of the damaged {}: {e}", path.display());
    }
    name
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

    #[test]
    fn a_damaged_file_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(config_file(dir.path()), "{ broken").unwrap();
        assert!(load(dir.path()).is_err());
        let copies: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("config.damaged-"))
            .collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(std::fs::read_to_string(dir.path().join(&copies[0])).unwrap(), "{ broken");
    }
}
