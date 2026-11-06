//! Transfers with progress events, folder watches and the sync state of places.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::{AppState, paths, transfer};
use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::path::PathBuf;
use tauri::{Emitter, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressEvent {
    id: String,
    done: u64,
    total: u64,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn transfer_upload(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    server_id: String,
    local_path: String,
    remote_path: String,
    options: Option<transfer::TransferOptions>,
) -> AppResult<u64> {
    let conn = state.conn(&server_id).await?;
    let flag = Arc::new(AtomicU8::new(transfer::RUN));
    state.cancels.lock().unwrap().insert(id.clone(), flag.clone());
    let emit_id = id.clone();
    let progress = move |done: u64, total: u64| {
        let _ = app.emit("transfer-progress", ProgressEvent { id: emit_id.clone(), done, total });
    };
    let opts = options.unwrap_or_default();
    let result = transfer::upload(&conn, &local_path, &remote_path, &opts, &progress, flag).await;
    state.cancels.lock().unwrap().remove(&id);
    match result {
        Ok(v) => Ok(v),
        Err(e) => Err(state.check_lost(&server_id, e).await),
    }
}

/// Server to server: copies a file between two connected servers.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn transfer_cross(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    from_server_id: String,
    from_path: String,
    server_id: String,
    remote_path: String,
    options: Option<transfer::TransferOptions>,
) -> AppResult<u64> {
    let src = state.conn(&from_server_id).await?;
    let dst = state.conn(&server_id).await?;
    let flag = Arc::new(AtomicU8::new(transfer::RUN));
    state.cancels.lock().unwrap().insert(id.clone(), flag.clone());
    let emit_id = id.clone();
    let progress = move |done: u64, total: u64| {
        let _ = app.emit("transfer-progress", ProgressEvent { id: emit_id.clone(), done, total });
    };
    let opts = options.unwrap_or_default();
    let result = transfer::cross(&src, &from_path, &dst, &remote_path, &opts, &progress, flag).await;
    state.cancels.lock().unwrap().remove(&id);
    match result {
        Ok(v) => Ok(v),
        Err(e) => {
            let e = state.check_lost(&from_server_id, e).await;
            Err(state.check_lost(&server_id, e).await)
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn transfer_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    server_id: String,
    remote_path: String,
    local_path: String,
    options: Option<transfer::TransferOptions>,
) -> AppResult<u64> {
    let conn = state.conn(&server_id).await?;
    let flag = Arc::new(AtomicU8::new(transfer::RUN));
    state.cancels.lock().unwrap().insert(id.clone(), flag.clone());
    let emit_id = id.clone();
    let progress = move |done: u64, total: u64| {
        let _ = app.emit("transfer-progress", ProgressEvent { id: emit_id.clone(), done, total });
    };
    let opts = options.unwrap_or_default();
    let result = transfer::download(&conn, &remote_path, &local_path, &opts, &progress, flag).await;
    state.cancels.lock().unwrap().remove(&id);
    match result {
        Ok(v) => Ok(v),
        Err(e) => Err(state.check_lost(&server_id, e).await),
    }
}

/// Stops a running transfer. `discard` deletes its partial file, otherwise it
/// stays so the transfer can continue later.
#[tauri::command]
pub(crate) fn transfer_cancel(state: State<'_, AppState>, id: String, discard: Option<bool>) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&id) {
        flag.store(if discard.unwrap_or(false) { transfer::DISCARD } else { transfer::PAUSE }, Ordering::Relaxed);
    }
}

/// Deletes the partial file of a transfer that will not be continued.
#[tauri::command]
pub(crate) async fn transfer_discard(state: State<'_, AppState>, server_id: String, direction: String, local_path: String, remote_path: String) -> AppResult<()> {
    if direction == "up" {
        if let Ok(conn) = state.conn(&server_id).await {
            transfer::discard_upload_part(&conn, &remote_path).await;
        }
    } else {
        transfer::discard_download_part(&local_path).await;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn watch_start(app: tauri::AppHandle, state: State<'_, AppState>, watch_id: String, local_path: String, recursive: bool, excludes: Vec<String>, delay_ms: u64) -> AppResult<()> {
    state.watches.start(watch_id, &local_path, recursive, &excludes, delay_ms, move |batch| {
        let _ = app.emit("watch-batch", batch);
    })
}

#[tauri::command]
pub(crate) fn watch_stop(state: State<'_, AppState>, watch_id: String) {
    state.watches.stop(&watch_id);
}

/// Shared settings file in a folder the user's cloud keeps in step between
/// computers ("Zwischen Rechnern abgleichen", after Panic Sync): "<folder>/Bitcrane/bitcrane-sync.json".
fn sync_file(dir: &str) -> PathBuf {
    paths::to_native(dir).join("Bitcrane").join("bitcrane-sync.json")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncFile {
    text: String,
    /// Modification time in milliseconds (to notice changes from the other computer).
    mtime: i64,
}

/// Reads the shared settings file; None when there is none yet.
#[tauri::command]
pub(crate) fn sync_read(dir: String) -> AppResult<Option<SyncFile>> {
    let p = sync_file(&dir);
    let meta = match std::fs::metadata(&p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
    Ok(Some(SyncFile { text: std::fs::read_to_string(&p)?, mtime }))
}

/// Writes the shared settings file (through a temporary file, so the cloud never copies half a file).
#[tauri::command]
pub(crate) fn sync_write(dir: String, text: String) -> AppResult<i64> {
    let p = sync_file(&dir);
    if !paths::to_native(&dir).is_dir() {
        return Err(AppError::new(ErrorKind::NotFound, "Der Ordner für den Abgleich ist nicht da (Cloud-Programm nicht angemeldet oder Ordner verschoben?)."));
    }
    std::fs::create_dir_all(p.parent().unwrap())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &p)?;
    let mtime = std::fs::metadata(&p)?.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
    Ok(mtime)
}
