//! Servers shown as folders in the system file manager.

#[cfg(not(windows))]
use crate::error::AppError;
use crate::error::AppResult;
use crate::AppState;
use tauri::State;

/// Shows a server as a folder in the Windows Explorer (Cloud Files API). The
/// interface has connected it under `connection_id` before. Returns the folder.
#[tauri::command]
pub(crate) async fn mount_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    server_id: String,
    name: String,
    remote_root: String,
) -> AppResult<String> {
    #[cfg(windows)]
    {
        state.mounts.start(app, state.connections.clone(), connection_id, server_id, name, remote_root)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, state, connection_id, server_id, name, remote_root);
        Err(AppError::other("Server als Ordner im Explorer gibt es bisher nur unter Windows."))
    }
}

/// Takes a server out of the Explorer; with `remove_folder` the local folder
/// goes too. Returns the folder when it had to stay.
#[tauri::command]
pub(crate) async fn mount_stop(
    state: State<'_, AppState>,
    server_id: String,
    remove_folder: bool,
) -> AppResult<Option<String>> {
    #[cfg(windows)]
    {
        state.mounts.stop(&server_id, remove_folder)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, server_id, remove_folder);
        Ok(None)
    }
}

/// Folder of a mounted server, if it is shown in the Explorer right now.
#[tauri::command]
pub(crate) fn mount_folder(state: State<'_, AppState>, server_id: String) -> Option<String> {
    #[cfg(windows)]
    {
        state.mounts.folder(&server_id)
    }
    #[cfg(not(windows))]
    {
        let _ = (state, server_id);
        None
    }
}
