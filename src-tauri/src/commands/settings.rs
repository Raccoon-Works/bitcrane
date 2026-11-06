//! Configuration files and importing servers from other apps and from ~/.ssh/config.

use crate::error::{AppError, AppResult};
use crate::{AppState, config, import, sshconfig};
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub(crate) fn config_load(state: State<'_, AppState>) -> AppResult<Value> {
    config::load(&state.config_dir)
}

#[tauri::command]
pub(crate) fn config_save(state: State<'_, AppState>, value: Value) -> AppResult<()> {
    config::save(&state.config_dir, &value)
}

/// Writes a text file chosen by the user (export of the settings).
#[tauri::command]
pub(crate) fn file_write(path: String, text: String) -> AppResult<()> {
    std::fs::write(std::path::Path::new(&path), text)?;
    Ok(())
}

/// Reads a text file chosen by the user (import of the settings).
#[tauri::command]
pub(crate) fn file_read(path: String) -> AppResult<String> {
    let p = std::path::Path::new(&path);
    if std::fs::metadata(p)?.len() > 10 * 1024 * 1024 {
        return Err(AppError::other("Die Datei ist zu groß."));
    }
    Ok(std::fs::read_to_string(p)?)
}

/// Tabby's config.yaml (for taking over its quick commands as snippets).
#[tauri::command]
pub(crate) fn tabby_config() -> Option<String> {
    import::tabby_config()
}

/// Servers saved in FileZilla, WinSCP and the SSH configuration.
#[tauri::command]
pub(crate) fn import_find() -> import::ImportResult {
    import::find_all()
}

/// Servers from an exported file the user chose (Transmit, FileZilla, WinSCP, Cyberduck).
#[tauri::command]
pub(crate) fn import_file(path: String) -> Vec<import::ImportedServer> {
    import::from_file(std::path::Path::new(&path))
}

#[tauri::command]
pub(crate) fn ssh_config_hosts() -> Vec<sshconfig::SshConfigHost> {
    sshconfig::read_hosts()
}
