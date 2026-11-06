//! Files on a connected server: listing, operations, commands and drag and drop out of the app.

use crate::error::{AppError, AppResult};
use crate::model::{FileEntry, WalkItem};
use crate::{local, model, paths, AppState};
use serde::Serialize;
use tauri::State;

#[tauri::command]
pub(crate) async fn remote_list(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
) -> AppResult<Vec<FileEntry>> {
    remote!(state, server_id, |c| c.list(&path))
}

#[tauri::command]
pub(crate) async fn remote_stat(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<FileEntry> {
    remote!(state, server_id, |c| c.stat(&path))
}

#[tauri::command]
pub(crate) async fn remote_mkdir(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<()> {
    remote!(state, server_id, |c| c.mkdir(&path))
}

#[tauri::command]
pub(crate) async fn remote_new_file(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<()> {
    remote!(state, server_id, |c| c.new_file(&path))
}

#[tauri::command]
pub(crate) async fn remote_rename(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    new_name: String,
) -> AppResult<()> {
    let to = paths::remote_join(&paths::remote_parent(&path), &new_name);
    remote!(state, server_id, |c| c.rename(&path, &to))
}

/// Moves or renames a file or folder to any path on the same server
/// (used when a watched file is renamed or moved locally).
#[tauri::command]
pub(crate) async fn remote_move(
    state: State<'_, AppState>,
    server_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    remote!(state, server_id, |c| async {
        let parent = paths::remote_parent(&to);
        if !c.exists(&parent).await {
            c.mkdir_all(&parent).await?;
        }
        c.rename(&from, &to).await
    })
}

#[tauri::command]
pub(crate) async fn remote_remove(state: State<'_, AppState>, server_id: String, paths: Vec<String>) -> AppResult<()> {
    let c = state.conn(&server_id).await?;
    for p in paths {
        if let Err(e) = c.remove(&p).await {
            return Err(state.check_lost(&server_id, e).await);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn remote_chmod(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    perms: String,
    recursive: bool,
) -> AppResult<()> {
    let mode =
        u32::from_str_radix(&perms, 8).map_err(|_| AppError::other("Rechte müssen drei Ziffern von 0 bis 7 sein."))?;
    remote!(state, server_id, |c| c.chmod(&path, mode, recursive))
}

/// Link to share a file or folder on a cloud service.
#[tauri::command]
pub(crate) async fn remote_share_link(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
) -> AppResult<String> {
    remote!(state, server_id, |c| c.share_link(&path))
}

/// Starts a drag of files of this computer out of the window, into the
/// Finder, the Explorer or another program (Transmit, ForkLift, WinSCP).
/// Runs on the main thread, as both systems require; the files are copied.
#[tauri::command]
pub(crate) fn drag_out(window: tauri::WebviewWindow, paths: Vec<String>) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        let files: Vec<std::path::PathBuf> = paths.iter().map(|p| paths::to_native(p)).collect();
        let w = window.clone();
        window
            .run_on_main_thread(move || {
                let icon = drag::Image::Raw(include_bytes!("../../icons/64x64.png").to_vec());
                if let Err(e) =
                    drag::start_drag(&w, drag::DragItem::Files(files), icon, |_, _| {}, drag::Options::default())
                {
                    log::warn!("drag out failed: {e}");
                }
            })
            .map_err(|e| AppError::other("Ziehen nicht möglich.").with_detail(e.to_string()))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = window;
        Err(AppError::other("Herausziehen gibt es auf diesem System nicht."))
    }
}

/// Copies server files into a temporary folder so they can be dragged out of
/// the window (the drag needs real files). Removed when Bitcrane ends.
#[tauri::command]
pub(crate) async fn remote_drag_prepare(
    state: State<'_, AppState>,
    server_id: String,
    paths: Vec<String>,
) -> AppResult<Vec<String>> {
    use tokio::io::AsyncWriteExt;
    let dir = std::env::temp_dir().join("bitcrane-drag").join(uuid::Uuid::new_v4().simple().to_string());
    std::fs::create_dir_all(&dir)?;
    let conn = state.conn(&server_id).await?;
    let mut out = Vec::new();
    for path in paths {
        let target = dir.join(paths::storable_name(&crate::paths::remote_name(&path)));
        let mut reader = conn.reader(&path, 0).await?;
        let mut file = tokio::fs::File::create(&target).await?;
        let copied = tokio::io::copy(&mut reader, &mut file).await;
        reader.close(copied.is_ok()).await?;
        copied?;
        file.flush().await?;
        out.push(paths::to_ui(&target));
    }
    Ok(out)
}

/// "Inhalt durchsuchen" on an SSH server.
#[tauri::command]
pub(crate) async fn remote_grep(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    query: String,
    max: Option<usize>,
) -> AppResult<Vec<model::GrepHit>> {
    let max = max.unwrap_or(500);
    remote!(state, server_id, |c| c.grep(&path, &query, max))
}

/// S3: a download link valid for `secs` seconds (at most 7 days).
#[tauri::command]
pub(crate) async fn remote_presign(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    secs: u64,
) -> AppResult<String> {
    remote!(state, server_id, |c| c.presigned_url(&path, secs))
}

#[tauri::command]
pub(crate) async fn remote_walk(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
) -> AppResult<Vec<WalkItem>> {
    remote!(state, server_id, |c| c.walk(&path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecResult {
    code: u32,
    output: String,
}

#[tauri::command]
pub(crate) async fn remote_checksum(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    algo: Option<String>,
) -> AppResult<String> {
    let algo = local::Algo::parse(algo.as_deref());
    remote!(state, server_id, |c| c.checksum_with(&path, algo))
}

#[tauri::command]
pub(crate) async fn remote_symlink(
    state: State<'_, AppState>,
    server_id: String,
    link: String,
    target: String,
) -> AppResult<()> {
    remote!(state, server_id, |c| c.symlink(&link, &target))
}

#[tauri::command]
pub(crate) async fn remote_copy(
    state: State<'_, AppState>,
    server_id: String,
    paths: Vec<String>,
    dest_dir: String,
) -> AppResult<Vec<String>> {
    remote!(state, server_id, |c| c.copy_within(&paths, &dest_dir))
}

#[tauri::command]
pub(crate) async fn remote_exec(
    state: State<'_, AppState>,
    server_id: String,
    command: String,
) -> AppResult<ExecResult> {
    let (code, output) = remote!(state, server_id, |c| c.exec(&command))?;
    Ok(ExecResult { code, output })
}
