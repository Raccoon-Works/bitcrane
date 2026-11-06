//! Files and folders on this computer: listing, operations, archives, tags and Git.

use crate::error::{AppError, AppResult};
use crate::model::{FileEntry, Place, WalkItem};
use crate::{archive, archive_vfs, git, local, model, netshares, paths, tags};

#[tauri::command]
pub(crate) fn local_list(path: String) -> AppResult<Vec<FileEntry>> {
    local::list(&path)
}

#[tauri::command]
pub(crate) fn local_stat(path: String) -> AppResult<FileEntry> {
    local::stat(&path)
}

#[tauri::command]
pub(crate) fn local_mkdir(path: String) -> AppResult<()> {
    local::mkdir(&path)
}

#[tauri::command]
pub(crate) fn local_new_file(path: String) -> AppResult<()> {
    local::new_file(&path)
}

#[tauri::command]
pub(crate) fn local_rename(path: String, new_name: String) -> AppResult<()> {
    local::rename(&path, &new_name)
}

#[tauri::command]
pub(crate) fn local_trash(paths: Vec<String>) -> AppResult<()> {
    local::trash(&paths)
}

/// Finder tags of the entries of a local folder (macOS; empty elsewhere).
#[tauri::command]
pub(crate) async fn local_tags(dir: String) -> std::collections::HashMap<String, Vec<tags::Tag>> {
    tokio::task::spawn_blocking(move || tags::list(&dir)).await.unwrap_or_default()
}

/// Files of this computer with a Finder tag (Spotlight; empty elsewhere).
#[tauri::command]
pub(crate) async fn local_tag_find(name: String) -> Vec<tags::Tagged> {
    tokio::task::spawn_blocking(move || tags::find(&name, 500)).await.unwrap_or_default()
}

/// Turns a Finder colour tag on or off for files of this computer.
#[tauri::command]
pub(crate) fn local_tag(paths: Vec<String>, name: String, color: u8, on: bool) -> AppResult<()> {
    tags::toggle(&paths, &name, color, on)
}

/// Git state of a folder of this computer (None outside a working copy or without git).
#[tauri::command]
pub(crate) async fn git_status(dir: String) -> Option<git::GitStatus> {
    tokio::task::spawn_blocking(move || git::status(&dir)).await.ok().flatten()
}

/// Add, commit, pull or push in a working copy (see git.rs).
#[tauri::command]
pub(crate) async fn git_action(
    root: String,
    what: String,
    paths: Vec<String>,
    message: String,
    all: bool,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || git::action(&root, &what, &paths, &message, all))
        .await
        .map_err(|e| AppError::other(e.to_string()))?
}

#[tauri::command]
pub(crate) fn local_checksum(path: String, algo: Option<String>) -> AppResult<String> {
    local::checksum_with(&path, local::Algo::parse(algo.as_deref()))
}

/// Copies on a worker thread: two local halves can copy large folders,
/// which must not block the window.
#[tauri::command]
pub(crate) async fn local_copy(paths: Vec<String>, dest_dir: String, merge: Option<bool>) -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || local::copy(&paths, &dest_dir, merge.unwrap_or(false)))
        .await
        .map_err(|e| AppError::other("Kopieren wurde unterbrochen.").with_detail(e.to_string()))?
}

/// Packs files and folders of this computer into a zip next to them; returns the archive's name.
#[tauri::command]
pub(crate) async fn local_zip(paths: Vec<String>) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || archive::compress(&paths))
        .await
        .map_err(|e| AppError::other("Komprimieren wurde unterbrochen.").with_detail(e.to_string()))?
}

/// Unpacks a zip of this computer into a new folder next to it; returns the folder's name.
#[tauri::command]
pub(crate) async fn local_unzip(path: String) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || archive::extract(&path))
        .await
        .map_err(|e| AppError::other("Entpacken wurde unterbrochen.").with_detail(e.to_string()))?
}

/// Extracts entries of archives into a temporary folder (to upload them); returns the folder and the names.
#[tauri::command]
pub(crate) async fn archive_extract_temp(paths: Vec<String>) -> AppResult<(String, Vec<String>)> {
    tauri::async_runtime::spawn_blocking(move || archive_vfs::extract_to_temp(&paths))
        .await
        .map_err(|e| AppError::other("Entpacken wurde unterbrochen.").with_detail(e.to_string()))?
}

/// Copies files to exact target paths, replacing existing ones (comparing two local folders).
#[tauri::command]
pub(crate) async fn local_copy_files(pairs: Vec<(String, String)>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        for (from, to) in &pairs {
            local::copy_file_over(from, to)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::other("Kopieren wurde unterbrochen.").with_detail(e.to_string()))?
}

/// Moves files or folders between two local folders (two local halves).
#[tauri::command]
pub(crate) async fn local_move(paths: Vec<String>, dest_dir: String, merge: Option<bool>) -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || local::move_into(&paths, &dest_dir, merge.unwrap_or(false)))
        .await
        .map_err(|e| AppError::other("Verschieben wurde unterbrochen.").with_detail(e.to_string()))?
}

#[tauri::command]
pub(crate) fn local_walk(path: String) -> AppResult<Vec<WalkItem>> {
    local::walk(&path)
}

#[tauri::command]
pub(crate) fn local_places() -> Vec<Place> {
    local::places()
}

/// Cloud storage folders (Google Drive, OneDrive, Dropbox, iCloud Drive, Box).
#[tauri::command]
pub(crate) async fn local_cloud_places() -> Vec<local::CloudPlace> {
    tauri::async_runtime::spawn_blocking(local::cloud_places).await.unwrap_or_default()
}

/// Drives and volumes (checked off the main thread: a lost network drive can take a moment).
#[tauri::command]
pub(crate) async fn local_drives() -> Vec<Place> {
    tauri::async_runtime::spawn_blocking(local::drives).await.unwrap_or_default()
}

/// Opens a local file or folder with the system's default application.
#[tauri::command]
pub(crate) fn local_open(path: String, app: Option<String>) -> AppResult<()> {
    let native = paths::to_native(&path);
    let app = app.filter(|a| !a.trim().is_empty()).map(|a| paths::to_native(&a));
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        // "open -a App.app file" opens the file with a chosen program.
        if let Some(app) = &app {
            c.arg("-a").arg(app);
        }
        c.arg(&native);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        match &app {
            Some(app) => {
                let mut c = std::process::Command::new(app);
                c.arg(&native);
                c
            }
            None => {
                let mut c = std::process::Command::new("explorer");
                c.raw_arg(format!("\"{}\"", native.display()));
                c
            }
        }
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new(
            app.as_deref().map(|a| a.as_os_str()).unwrap_or_else(|| std::ffi::OsStr::new("xdg-open")),
        );
        c.arg(&native);
        c
    };
    cmd.spawn().map(|_| ()).map_err(AppError::from)
}

/// Converts a native path (from the folder dialog) into the UI form ("~/...").
#[tauri::command]
pub(crate) fn path_to_ui(path: String) -> String {
    // Accepts native paths and typed UI paths ("~/x", "C:\x") alike.
    paths::to_ui(&paths::to_native(path.trim()))
}

/// Free space on the disk that holds a folder of this computer (bytes).
#[tauri::command]
pub(crate) fn local_free_space(path: String) -> Option<u64> {
    fs4::available_space(paths::to_native(&path)).ok()
}

/// Computers in the local network that offer SMB shares (Bonjour), searched for about two seconds.
#[tauri::command]
pub(crate) async fn network_hosts() -> Vec<netshares::NetHost> {
    tokio::task::spawn_blocking(|| netshares::discover(std::time::Duration::from_millis(2200)))
        .await
        .unwrap_or_default()
}

/// Real target of each folder (links resolved), in the UI form; unchanged when
/// it cannot be resolved. Lets the sidebar show a folder reached by two paths once.
#[tauri::command]
pub(crate) fn local_real_paths(list: Vec<String>) -> Vec<String> {
    list.into_iter()
        .map(|p| std::fs::canonicalize(paths::to_native(&p)).map(|c| paths::to_ui(&c)).unwrap_or(p))
        .collect()
}

/// Shows a file or folder in the Finder / Explorer with the item selected.
#[tauri::command]
pub(crate) fn local_reveal(path: String) -> AppResult<()> {
    let native = paths::to_native(&path);
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(&native);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("explorer");
        c.raw_arg(format!("/select,\"{}\"", native.display()));
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(native.parent().unwrap_or(&native));
        c
    };
    cmd.spawn().map(|_| ()).map_err(AppError::from)
}

/// "Inhalt durchsuchen" on this computer.
#[tauri::command]
pub(crate) async fn local_grep(path: String, query: String, max: Option<usize>) -> AppResult<Vec<model::GrepHit>> {
    tokio::task::spawn_blocking(move || local::grep(&path, &query, max.unwrap_or(500)))
        .await
        .map_err(|e| AppError::other("Suche abgebrochen.").with_detail(e.to_string()))?
}
