//! Bitcrane application core.
//!
//! Exposes Tauri commands for local files, SSH/SFTP connections, transfers,
//! remote commands, folder watching, settings and secrets. Long-running
//! operations report progress through events:
//! - `transfer-progress` `{ id, done, total }`
//! - `watch-batch` `{ watchId, changed, removed }`

pub mod cli;
mod config;
mod error;
mod dav;
mod archive;
mod archive_vfs;
mod shell_integration;
mod dropbox;
mod gdrive;
mod onedrive;
mod oauth;
mod ftp;
mod import;
mod keys;
mod local;
mod model;
#[cfg(windows)]
mod mount_win;
mod paths;
mod proxy;
mod remote;
mod tls;
mod ssh;
mod smb;
mod scp;
mod sshconfig;
mod sysicons;
mod tray;
mod transfer;
mod watcher;

use error::{AppError, AppResult, ErrorKind};
use model::{FileEntry, Place, WalkItem};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ssh::{ConnectParams, KnownHosts};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

/// Shared state of the running app.
pub struct AppState {
    connections: Arc<tokio::sync::Mutex<HashMap<String, Arc<remote::Remote>>>>,
    /// Servers shown as folders in the Windows Explorer.
    #[cfg(windows)]
    mounts: mount_win::Mounts,
    known_hosts: Arc<KnownHosts>,
    watches: watcher::Watches,
    cancels: Mutex<HashMap<String, Arc<AtomicU8>>>,
    /// Open questions of servers during login, waiting for the user's answers.
    prompts: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<Option<Vec<String>>>>>>,
    config_dir: PathBuf,
}

impl AppState {
    fn new(config_dir: PathBuf) -> Self {
        Self {
            connections: Default::default(),
            known_hosts: Arc::new(KnownHosts::load(config_dir.join("known_hosts.json"))),
            watches: Default::default(),
            #[cfg(windows)]
            mounts: Default::default(),
            cancels: Default::default(),
            prompts: Default::default(),
            config_dir,
        }
    }

    async fn conn(&self, server_id: &str) -> AppResult<Arc<remote::Remote>> {
        let map = self.connections.lock().await;
        match map.get(server_id) {
            Some(c) if !c.is_closed() => Ok(c.clone()),
            _ => Err(AppError::new(ErrorKind::NotConnected, "Keine Verbindung zum Server.")),
        }
    }

    /// Forgets a connection whose session has died so the UI can reconnect.
    async fn check_lost(&self, server_id: &str, err: AppError) -> AppError {
        let mut map = self.connections.lock().await;
        if let Some(c) = map.get(server_id) {
            if c.is_closed() {
                map.remove(server_id);
                return AppError::new(ErrorKind::ConnectionLost, "Verbindung unterbrochen").with_detail(err.message);
            }
        }
        err
    }
}

/* ------------------------------------------------------------------ Local */

#[tauri::command]
fn local_list(path: String) -> AppResult<Vec<FileEntry>> {
    local::list(&path)
}

#[tauri::command]
fn local_stat(path: String) -> AppResult<FileEntry> {
    local::stat(&path)
}

#[tauri::command]
fn local_mkdir(path: String) -> AppResult<()> {
    local::mkdir(&path)
}

#[tauri::command]
fn local_rename(path: String, new_name: String) -> AppResult<()> {
    local::rename(&path, &new_name)
}

#[tauri::command]
fn local_trash(paths: Vec<String>) -> AppResult<()> {
    local::trash(&paths)
}

/// Opens a web address in the default browser (only http and https).
/// Opens the macOS privacy settings at "Festplattenvollzugriff" (Full Disk Access), so Bitcrane
/// can be allowed once for all folders instead of one question per protected folder.
#[tauri::command]
fn open_full_disk_access() -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .spawn()
            .map(|_| ())
            .map_err(AppError::from)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// "Nach Abschluss" (WinSCP "Once empty"): puts the computer to sleep or shuts it down
/// once all transfers are done. The interface asks with a countdown before calling this.
#[tauri::command]
fn system_power(action: String) -> AppResult<()> {
    let (program, args): (&str, Vec<&str>) = match action.as_str() {
        #[cfg(target_os = "macos")]
        "sleep" => ("osascript", vec!["-e", "tell application \"System Events\" to sleep"]),
        #[cfg(target_os = "macos")]
        "shutdown" => ("osascript", vec!["-e", "tell application \"System Events\" to shut down"]),
        #[cfg(windows)]
        "sleep" => ("rundll32.exe", vec!["powrprof.dll,SetSuspendState", "0,1,0"]),
        #[cfg(windows)]
        "shutdown" => ("shutdown", vec!["/s", "/t", "0"]),
        #[cfg(all(unix, not(target_os = "macos")))]
        "sleep" => ("systemctl", vec!["suspend"]),
        #[cfg(all(unix, not(target_os = "macos")))]
        "shutdown" => ("systemctl", vec!["poweroff"]),
        _ => return Err(AppError::other("Unbekannte Aktion.")),
    };
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console window flashes up.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().map(|_| ()).map_err(AppError::from)
}

#[tauri::command]
fn open_url(url: String) -> AppResult<()> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::other("Nur http- und https-Adressen lassen sich öffnen."));
    }
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    // Windows: "explorer <url>" fails on long addresses with "&" and "=" (sign-in
    // pages) and then opens the Documents folder instead; the URL handler of the
    // shell passes the address unchanged to the default browser.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler").creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(&url).spawn().map(|_| ()).map_err(AppError::from)
}

/* ----------------------------------------------------------- Cloud services */

/// Which cloud services this build has app keys for (Google Drive needs the user's own).
#[tauri::command]
fn cloud_services() -> oauth::CloudServices {
    oauth::services()
}

/// Signs in to a cloud service in the browser; returns the refresh token (the
/// interface keeps it in the keychain) and the account name.
#[tauri::command]
async fn cloud_sign_in(service: String, client_id: Option<String>, client_secret: Option<String>) -> AppResult<oauth::SignedIn> {
    let open = |url: &str| open_url(url.to_string());
    match service.as_str() {
        "dropbox" => dropbox::sign_in(open).await,
        // Google Drive: with the user's own app key (see docs/google-drive.md).
        "onedrive" => onedrive::sign_in(open).await,
        "gdrive" => gdrive::sign_in(client_id.as_deref().unwrap_or(""), client_secret.as_deref().unwrap_or(""), open).await,
        _ => Err(AppError::other("Diesen Cloud-Dienst kennt Bitcrane noch nicht.")),
    }
}

/// Stops a sign-in that is waiting for the browser.
#[tauri::command]
fn cloud_sign_in_cancel() {
    oauth::cancel();
}

#[tauri::command]
async fn dropbox_connect(state: State<'_, AppState>, server_id: String, params: dropbox::DropboxParams) -> AppResult<ConnectResult> {
    state.connections.lock().await.remove(&server_id);
    let conn = remote::Remote::Dropbox(Arc::new(dropbox::DropboxConn::connect(params).await?));
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

#[tauri::command]
async fn gdrive_connect(state: State<'_, AppState>, server_id: String, params: gdrive::GDriveParams) -> AppResult<ConnectResult> {
    state.connections.lock().await.remove(&server_id);
    let conn = remote::Remote::GDrive(Arc::new(gdrive::GDriveConn::connect(params).await?));
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

#[tauri::command]
async fn onedrive_connect(state: State<'_, AppState>, server_id: String, params: onedrive::OneDriveParams) -> AppResult<ConnectResult> {
    state.connections.lock().await.remove(&server_id);
    let conn = Arc::new(onedrive::OneDriveConn::connect(params).await?);
    let refresh_token = Some(conn.refresh_token().await);
    let remote = remote::Remote::OneDrive(conn);
    let home = remote.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(remote));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token })
}

/// How Bitcrane was started: `autostart` is true for a start at login.
struct StartInfo {
    autostart: bool,
    decided: Arc<std::sync::atomic::AtomicBool>,
}

/// True when Bitcrane was started at login ("--autostart").
#[tauri::command]
fn start_info(info: State<'_, StartInfo>) -> bool {
    info.autostart
}

/// The interface has decided whether the window stays hidden (no fallback needed).
#[tauri::command]
fn start_decided(info: State<'_, StartInfo>) {
    info.decided.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn local_checksum(path: String) -> AppResult<String> {
    local::checksum(&path)
}

/// Copies on a worker thread: two local halves can copy large folders,
/// which must not block the window.
#[tauri::command]
async fn local_copy(paths: Vec<String>, dest_dir: String, merge: Option<bool>) -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || local::copy(&paths, &dest_dir, merge.unwrap_or(false)))
        .await
        .map_err(|e| AppError::other("Kopieren wurde unterbrochen.").with_detail(e.to_string()))?
}

/// Packs files and folders of this computer into a zip next to them; returns the archive's name.
#[tauri::command]
async fn local_zip(paths: Vec<String>) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || archive::compress(&paths))
        .await
        .map_err(|e| AppError::other("Komprimieren wurde unterbrochen.").with_detail(e.to_string()))?
}

/// Unpacks a zip of this computer into a new folder next to it; returns the folder's name.
#[tauri::command]
async fn local_unzip(path: String) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || archive::extract(&path))
        .await
        .map_err(|e| AppError::other("Entpacken wurde unterbrochen.").with_detail(e.to_string()))?
}

/// Paths Bitcrane was started with from the Explorer menu ("--upload"), taken once by the window.
static UPLOADS_TAKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Shows a server as a folder in the Windows Explorer (Cloud Files API). The
/// interface has connected it under `connection_id` before. Returns the folder.
#[tauri::command]
async fn mount_start(app: tauri::AppHandle, state: State<'_, AppState>, connection_id: String, server_id: String, name: String, remote_root: String) -> AppResult<String> {
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
async fn mount_stop(state: State<'_, AppState>, server_id: String, remove_folder: bool) -> AppResult<Option<String>> {
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
fn mount_folder(state: State<'_, AppState>, server_id: String) -> Option<String> {
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

/// The program file, for calls from the command line (cli.rs).
#[tauri::command]
fn cli_path() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

#[tauri::command]
fn take_pending_uploads() -> Vec<String> {
    if UPLOADS_TAKEN.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Vec::new();
    }
    shell_integration::upload_args(&std::env::args().collect::<Vec<_>>())
}

/// "Mit Bitcrane hochladen" in the Explorer / Finder context menu on or off.
#[tauri::command]
fn shell_integration_set(enable: bool, label: String) -> AppResult<()> {
    shell_integration::set(enable, &label)
}

/// Extracts entries of archives into a temporary folder (to upload them); returns the folder and the names.
#[tauri::command]
async fn archive_extract_temp(paths: Vec<String>) -> AppResult<(String, Vec<String>)> {
    tauri::async_runtime::spawn_blocking(move || archive_vfs::extract_to_temp(&paths))
        .await
        .map_err(|e| AppError::other("Entpacken wurde unterbrochen.").with_detail(e.to_string()))?
}

/// Copies files to exact target paths, replacing existing ones (comparing two local folders).
#[tauri::command]
async fn local_copy_files(pairs: Vec<(String, String)>) -> AppResult<()> {
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
async fn local_move(paths: Vec<String>, dest_dir: String, merge: Option<bool>) -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || local::move_into(&paths, &dest_dir, merge.unwrap_or(false)))
        .await
        .map_err(|e| AppError::other("Verschieben wurde unterbrochen.").with_detail(e.to_string()))?
}

#[tauri::command]
fn local_walk(path: String) -> AppResult<Vec<WalkItem>> {
    local::walk(&path)
}

#[tauri::command]
fn local_places() -> Vec<Place> {
    local::places()
}

/// Cloud storage folders (Google Drive, OneDrive, Dropbox, iCloud Drive, Box).
#[tauri::command]
async fn local_cloud_places() -> Vec<local::CloudPlace> {
    tauri::async_runtime::spawn_blocking(local::cloud_places).await.unwrap_or_default()
}

/// Drives and volumes (checked off the main thread: a lost network drive can take a moment).
#[tauri::command]
async fn local_drives() -> Vec<Place> {
    tauri::async_runtime::spawn_blocking(local::drives).await.unwrap_or_default()
}

/// Opens a local file or folder with the system's default application.
#[tauri::command]
fn local_open(path: String, app: Option<String>) -> AppResult<()> {
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
        let mut c = std::process::Command::new(app.as_deref().map(|a| a.as_os_str()).unwrap_or_else(|| std::ffi::OsStr::new("xdg-open")));
        c.arg(&native);
        c
    };
    cmd.spawn().map(|_| ()).map_err(AppError::from)
}

/// What "Terminal öffnen" connects to.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalTarget {
    /// Local folder (UI path) when no server is given.
    local_path: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    key_path: Option<String>,
    remote_path: Option<String>,
}

/// Single-quotes a value for a POSIX shell.
fn sh_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', "'\\''"))
}

/// Characters cmd.exe interprets even inside double quotes (or that end them).
#[cfg(windows)]
const CMD_UNSAFE: &[char] = &['"', '%', '!', '\r', '\n'];

/// Builds the `ssh` command line for "Terminal öffnen". Every value is quoted
/// for the local shell, and the folder once more for the shell on the server,
/// so names from a server listing can never run as commands on this computer.
fn terminal_ssh_command(host: &str, target: &TerminalTarget) -> AppResult<String> {
    let user = target.user.clone().unwrap_or_default();
    let plain = |v: &str| v.chars().all(|c| c.is_ascii_alphanumeric() || "._-:[]".contains(c));
    if !plain(host) || !(user.is_empty() || user.chars().all(|c| c.is_ascii_alphanumeric() || "._-@+".contains(c))) {
        return Err(AppError::other("Für diesen Server kann kein Terminal geöffnet werden (ungewöhnliche Zeichen im Namen oder in der Adresse)."));
    }
    let dir = target.remote_path.clone().unwrap_or_else(|| "~".into());
    let key = target.key_path.as_ref().filter(|k| !k.is_empty()).map(|k| paths::to_native(k).display().to_string());
    #[cfg(windows)]
    if dir.contains(CMD_UNSAFE) || key.as_deref().is_some_and(|k| k.contains(CMD_UNSAFE)) {
        return Err(AppError::other("Dieser Ordner kann nicht im Terminal geöffnet werden (ungewöhnliche Zeichen im Namen)."));
    }
    // "~" stays unquoted so the server shell expands it.
    let cd = if dir == "~" { "cd".to_string() } else { format!("cd {}", sh_quote(&dir)) };
    let remote = format!("{cd} && exec $SHELL -l");
    // POSIX shells (macOS Terminal, Linux) get single quotes; cmd.exe double quotes.
    let q = |v: &str| if cfg!(windows) { format!("\"{v}\"") } else { sh_quote(v) };
    let mut parts = vec!["ssh".to_string(), "-t".to_string()];
    if let Some(p) = target.port.filter(|p| *p != 22) {
        parts.push("-p".into());
        parts.push(p.to_string());
    }
    if let Some(k) = key {
        parts.push("-i".into());
        parts.push(q(&k));
    }
    parts.push(if user.is_empty() { host.to_string() } else { format!("{user}@{host}") });
    parts.push(q(&remote));
    Ok(parts.join(" "))
}

/// Opens the system terminal: in a local folder, or with an SSH session that
/// starts in the server folder shown in Bitcrane.
#[tauri::command]
fn open_terminal(target: TerminalTarget) -> AppResult<()> {
    let ssh_cmd = match target.host.as_ref() {
        Some(host) => Some(terminal_ssh_command(host, &target)?),
        None => None,
    };
    let local = target.local_path.as_deref().map(paths::to_native).unwrap_or_else(paths::home);

    #[cfg(target_os = "macos")]
    {
        let status = match &ssh_cmd {
            Some(cmd) => {
                let script = cmd.replace('\\', "\\\\").replace('"', "\\\"");
                std::process::Command::new("osascript")
                    .arg("-e").arg(format!("tell application \"Terminal\" to do script \"{script}\""))
                    .arg("-e").arg("tell application \"Terminal\" to activate")
                    .spawn()
            }
            None => std::process::Command::new("open").arg("-a").arg("Terminal").arg(&local).spawn(),
        };
        status.map(|_| ()).map_err(AppError::from)
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Windows Terminal when installed, otherwise a classic console window.
        let wt = std::process::Command::new("wt.exe").arg("-d").arg(&local).args(ssh_cmd.as_ref().map(|c| vec!["cmd".to_string(), "/k".to_string(), c.clone()]).unwrap_or_default()).spawn();
        if wt.is_ok() {
            return Ok(());
        }
        let mut c = std::process::Command::new("cmd");
        c.current_dir(&local);
        match &ssh_cmd {
            Some(cmd) => c.raw_arg(format!("/c start \"Bitcrane\" cmd /k {cmd}")),
            None => c.raw_arg("/c start \"Bitcrane\" cmd"),
        };
        c.spawn().map(|_| ()).map_err(AppError::from)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut c = std::process::Command::new("x-terminal-emulator");
        c.current_dir(&local);
        if let Some(cmd) = &ssh_cmd {
            c.arg("-e").arg("sh").arg("-c").arg(cmd);
        }
        c.spawn().map(|_| ()).map_err(AppError::from)
    }
}

/// Local working copy of a server file that is opened in an editor:
/// <cache>/edit/<server id>/<path on the server>.
#[tauri::command]
fn edit_temp_path(app: tauri::AppHandle, server_id: String, remote_path: String) -> AppResult<String> {
    let base = app.path().app_cache_dir().map_err(|e| AppError::other("Kein Cache-Ordner.").with_detail(e.to_string()))?;
    let mut p = base.join("edit").join(server_id.replace(['/', '\\', ':'], "_"));
    for seg in remote_path.split('/').filter(|s| !s.is_empty() && *s != "..") {
        p.push(seg);
    }
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    Ok(paths::to_ui(&p))
}

/// Converts a native path (from the folder dialog) into the UI form ("~/...").
#[tauri::command]
fn path_to_ui(path: String) -> String {
    // Accepts native paths and typed UI paths ("~/x", "C:\x") alike.
    paths::to_ui(&paths::to_native(path.trim()))
}

/// Shows a file or folder in the Finder / Explorer with the item selected.
#[tauri::command]
fn local_reveal(path: String) -> AppResult<()> {
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

/* ------------------------------------------------------------------ SSH */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResult {
    home: String,
    /// Server clock minus local clock in milliseconds, if it could be measured.
    clock_offset_ms: Option<i64>,
    /// OneDrive: the renewed sign-in, to be kept in place of the old one.
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
}

/// Event payload for a question of the server (shown as a dialog).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthPromptEvent {
    id: String,
    server_id: String,
    #[serde(flatten)]
    request: ssh::PromptRequest,
}

/// Forwards server questions to the interface and waits up to 3 minutes for answers.
fn make_prompter(app: tauri::AppHandle, pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<Option<Vec<String>>>>>>, server_id: String) -> ssh::Prompter {
    Arc::new(move |request| {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        pending.lock().unwrap().insert(id.clone(), tx);
        let _ = app.emit("auth-prompt", AuthPromptEvent { id: id.clone(), server_id: server_id.clone(), request });
        let pending = pending.clone();
        Box::pin(async move {
            let answer = tokio::time::timeout(std::time::Duration::from_secs(180), rx).await.ok().and_then(|r| r.ok()).flatten();
            pending.lock().unwrap().remove(&id);
            answer
        })
    })
}

/// Answers of the user to a server question; `None` cancels the login.
#[tauri::command]
fn auth_prompt_answer(state: State<'_, AppState>, id: String, answers: Option<Vec<String>>) {
    if let Some(tx) = state.prompts.lock().unwrap().remove(&id) {
        let _ = tx.send(answers);
    }
}

#[tauri::command]
async fn ssh_connect(app: tauri::AppHandle, state: State<'_, AppState>, server_id: String, params: ConnectParams) -> AppResult<ConnectResult> {
    // Take it out first: closing can take a while and must not hold the lock.
    let old = state.connections.lock().await.remove(&server_id);
    if let Some(old) = old {
        old.close().await;
    }
    let prompter = make_prompter(app, state.prompts.clone(), server_id.clone());
    let conn = remote::connect_ssh(&params, state.known_hosts.clone(), Some(prompter)).await?;
    let home = conn.home().to_string();
    let clock_offset_ms = conn.clock_offset_ms().await;
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms, refresh_token: None })
}

#[tauri::command]
async fn ftp_connect(state: State<'_, AppState>, server_id: String, params: ftp::FtpParams) -> AppResult<ConnectResult> {
    // Take it out first: closing can take a while and must not hold the lock.
    let old = state.connections.lock().await.remove(&server_id);
    if let Some(old) = old {
        old.close().await;
    }
    let conn = remote::Remote::Ftp(Arc::new(ftp::FtpConn::connect(params, state.known_hosts.clone()).await?));
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

#[tauri::command]
async fn dav_connect(state: State<'_, AppState>, server_id: String, params: dav::DavParams) -> AppResult<ConnectResult> {
    state.connections.lock().await.remove(&server_id);
    let conn = remote::Remote::Dav(dav::DavConn::connect(params, state.known_hosts.clone()).await?);
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

#[tauri::command]
async fn smb_connect(state: State<'_, AppState>, server_id: String, params: smb::SmbParams) -> AppResult<ConnectResult> {
    let old = state.connections.lock().await.remove(&server_id);
    if let Some(old) = old {
        old.close().await;
    }
    let conn = remote::Remote::Smb(Arc::new(smb::SmbConn::connect(params).await?));
    let home = conn.home().to_string();
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms: None, refresh_token: None })
}

#[tauri::command]
async fn ssh_disconnect(state: State<'_, AppState>, server_id: String) -> AppResult<()> {
    let old = state.connections.lock().await.remove(&server_id);
    if let Some(c) = old {
        c.close().await;
    }
    Ok(())
}

#[tauri::command]
async fn ssh_is_connected(state: State<'_, AppState>, server_id: String) -> AppResult<bool> {
    Ok(state.conn(&server_id).await.is_ok())
}

/// Runs a remote operation and turns a dead session into `ConnectionLost`.
macro_rules! remote {
    ($state:expr, $server:expr, |$c:ident| $body:expr) => {{
        let $c = $state.conn(&$server).await?;
        match $body.await {
            Ok(v) => Ok(v),
            Err(e) => Err($state.check_lost(&$server, e).await),
        }
    }};
}

#[tauri::command]
async fn remote_list(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<Vec<FileEntry>> {
    remote!(state, server_id, |c| c.list(&path))
}

#[tauri::command]
async fn remote_stat(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<FileEntry> {
    remote!(state, server_id, |c| c.stat(&path))
}

#[tauri::command]
async fn remote_mkdir(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<()> {
    remote!(state, server_id, |c| c.mkdir(&path))
}

#[tauri::command]
async fn remote_rename(state: State<'_, AppState>, server_id: String, path: String, new_name: String) -> AppResult<()> {
    let to = paths::remote_join(&paths::remote_parent(&path), &new_name);
    remote!(state, server_id, |c| c.rename(&path, &to))
}

/// Moves or renames a file or folder to any path on the same server
/// (used when a watched file is renamed or moved locally).
#[tauri::command]
async fn remote_move(state: State<'_, AppState>, server_id: String, from: String, to: String) -> AppResult<()> {
    remote!(state, server_id, |c| async {
        let parent = paths::remote_parent(&to);
        if !c.exists(&parent).await {
            c.mkdir_all(&parent).await?;
        }
        c.rename(&from, &to).await
    })
}

#[tauri::command]
async fn remote_remove(state: State<'_, AppState>, server_id: String, paths: Vec<String>) -> AppResult<()> {
    let c = state.conn(&server_id).await?;
    for p in paths {
        if let Err(e) = c.remove(&p).await {
            return Err(state.check_lost(&server_id, e).await);
        }
    }
    Ok(())
}

#[tauri::command]
async fn remote_chmod(state: State<'_, AppState>, server_id: String, path: String, perms: String, recursive: bool) -> AppResult<()> {
    let mode = u32::from_str_radix(&perms, 8).map_err(|_| AppError::other("Rechte müssen drei Ziffern von 0 bis 7 sein."))?;
    remote!(state, server_id, |c| c.chmod(&path, mode, recursive))
}

/// Link to share a file or folder on a cloud service.
#[tauri::command]
async fn remote_share_link(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<String> {
    remote!(state, server_id, |c| c.share_link(&path))
}

#[tauri::command]
async fn remote_walk(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<Vec<WalkItem>> {
    remote!(state, server_id, |c| c.walk(&path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecResult {
    code: u32,
    output: String,
}

#[tauri::command]
async fn remote_checksum(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<String> {
    remote!(state, server_id, |c| c.checksum(&path))
}

#[tauri::command]
async fn remote_symlink(state: State<'_, AppState>, server_id: String, link: String, target: String) -> AppResult<()> {
    remote!(state, server_id, |c| c.symlink(&link, &target))
}

#[tauri::command]
async fn remote_copy(state: State<'_, AppState>, server_id: String, paths: Vec<String>, dest_dir: String) -> AppResult<Vec<String>> {
    remote!(state, server_id, |c| c.copy_within(&paths, &dest_dir))
}

#[tauri::command]
async fn remote_exec(state: State<'_, AppState>, server_id: String, command: String) -> AppResult<ExecResult> {
    let (code, output) = remote!(state, server_id, |c| c.exec(&command))?;
    Ok(ExecResult { code, output })
}

/* ------------------------------------------------------------------ Text preview / diff */

/// Largest file shown in the difference view and the text preview.
const TEXT_LIMIT: usize = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextContent {
    text: String,
    /// True when the file is longer than the limit and was cut off.
    truncated: bool,
}

/// Turns raw bytes into text; files with NUL bytes count as binary.
fn bytes_to_text(mut bytes: Vec<u8>) -> AppResult<TextContent> {
    let truncated = bytes.len() > TEXT_LIMIT;
    bytes.truncate(TEXT_LIMIT);
    if bytes.contains(&0) {
        return Err(AppError::other("Das ist keine Textdatei; Unterschiede lassen sich nur bei Text anzeigen."));
    }
    Ok(TextContent { text: String::from_utf8_lossy(&bytes).into_owned(), truncated })
}

#[tauri::command]
async fn local_read_text(path: String) -> AppResult<TextContent> {
    use tokio::io::AsyncReadExt;
    if let Some((archive, inner)) = archive_vfs::split(&path) {
        return bytes_to_text(archive_vfs::read(&archive, &inner, TEXT_LIMIT + 1)?);
    }
    let file = tokio::fs::File::open(paths::to_native(&path)).await?;
    let mut buf = Vec::new();
    file.take(TEXT_LIMIT as u64 + 1).read_to_end(&mut buf).await?;
    bytes_to_text(buf)
}

#[tauri::command]
async fn remote_read_text(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<TextContent> {
    let bytes = remote!(state, server_id, |c| c.read_head(&path, TEXT_LIMIT + 1))?;
    bytes_to_text(bytes)
}

/* ------------------------------------------------------------------ Keys and test */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyInfo {
    exists: bool,
    /// "ED25519", "RSA", "ECDSA" ...; empty when the file is no OpenSSH key.
    algorithm: String,
    encrypted: bool,
    /// The file could not be read as a key.
    invalid: bool,
}

/// Reads type and encryption of a private key without its passphrase.
#[tauri::command]
fn key_info(path: String) -> KeyInfo {
    let native = paths::to_native(&path);
    if !native.is_file() {
        return KeyInfo { exists: false, algorithm: String::new(), encrypted: false, invalid: false };
    }
    if let Ok(text) = std::fs::read_to_string(&native) {
        if text.starts_with("PuTTY-User-Key-File") {
            let (algorithm, encrypted) = keys::ppk_info(&text);
            return KeyInfo { exists: true, algorithm, encrypted, invalid: false };
        }
    }
    match std::fs::read_to_string(&native).ok().and_then(|t| russh::keys::PrivateKey::from_openssh(t.trim()).ok()) {
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
        None => match russh::keys::load_secret_key(&native, None) {
            Ok(_) => KeyInfo { exists: true, algorithm: "RSA".into(), encrypted: false, invalid: false },
            Err(russh::keys::Error::KeyIsEncrypted) => KeyInfo { exists: true, algorithm: String::new(), encrypted: true, invalid: false },
            Err(_) => KeyInfo { exists: true, algorithm: String::new(), encrypted: false, invalid: true },
        },
    }
}

/// Creates a new ED25519 key pair; returns the public key line.
#[tauri::command]
fn key_generate(path: String, comment: String, passphrase: Option<String>) -> AppResult<String> {
    keys::generate(&path, &comment, passphrase.as_deref())
}

/// Public key line of a private key (for copying or adding to a server).
#[tauri::command]
fn key_public(path: String) -> AppResult<String> {
    keys::public_of(&path)
}

/// "Verbindung testen": connects with a separate session and closes it again.
/// An unknown host key counts as reachable; the fingerprint is confirmed on
/// the real connection.
#[tauri::command]
async fn ssh_test(app: tauri::AppHandle, state: State<'_, AppState>, params: ConnectParams) -> AppResult<String> {
    let prompter = make_prompter(app, state.prompts.clone(), String::new());
    match remote::connect_ssh(&params, state.known_hosts.clone(), Some(prompter)).await {
        Ok(c) => {
            let home = c.home().to_string();
            c.close().await;
            Ok(home)
        }
        Err(e) if e.kind == ErrorKind::HostKeyUnknown => Ok(String::new()),
        Err(e) => Err(e),
    }
}

/* ------------------------------------------------------------------ Known hosts */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KnownHostEntry {
    host: String,
    fingerprint: String,
}

#[tauri::command]
fn known_hosts_list(state: State<'_, AppState>) -> Vec<KnownHostEntry> {
    state.known_hosts.list().into_iter().map(|(host, fingerprint)| KnownHostEntry { host, fingerprint }).collect()
}

#[tauri::command]
fn known_hosts_remove(state: State<'_, AppState>, host: String) {
    state.known_hosts.remove(&host);
}

/* ------------------------------------------------------------------ Log file */

/// The connection log is written here when "Protokoll für die Fehlersuche
/// schreiben" is switched on.
fn log_file(state: &AppState) -> PathBuf {
    state.config_dir.join("logs").join("bitcrane.log")
}

/// Appends lines to the log file; starts a new file above 5 MB.
#[tauri::command]
fn log_write(state: State<'_, AppState>, lines: Vec<String>) -> AppResult<()> {
    use std::io::Write;
    let path = log_file(&state);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(&path).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("old.log"));
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    for line in lines {
        writeln!(f, "{line}")?;
    }
    Ok(())
}

/// Path of the log file in UI form (for "Im Finder zeigen").
#[tauri::command]
fn log_path(state: State<'_, AppState>) -> String {
    paths::to_ui(&log_file(&state))
}

/* ------------------------------------------------------------------ Preview */

/// Largest image shown in the preview.
const IMAGE_LIMIT: usize = 8 * 1024 * 1024;
/// Text shown in the preview (the start of longer files).
const PREVIEW_TEXT_LIMIT: usize = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    /// "text", "image" or "binary".
    kind: &'static str,
    /// MIME type for images.
    mime: String,
    /// Text, or base64 of the image bytes.
    data: String,
    truncated: bool,
}

fn image_mime(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

fn make_preview(path: &str, mut bytes: Vec<u8>) -> Preview {
    use base64::Engine;
    if let Some(mime) = image_mime(path) {
        let truncated = bytes.len() > IMAGE_LIMIT;
        if truncated {
            return Preview { kind: "binary", mime: mime.into(), data: String::new(), truncated };
        }
        return Preview { kind: "image", mime: mime.into(), data: base64::engine::general_purpose::STANDARD.encode(&bytes), truncated: false };
    }
    let truncated = bytes.len() > PREVIEW_TEXT_LIMIT;
    bytes.truncate(PREVIEW_TEXT_LIMIT);
    // Text if there are no NUL bytes in the first part and it is mostly valid UTF-8.
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Preview { kind: "binary", mime: String::new(), data: String::new(), truncated };
    }
    Preview { kind: "text", mime: String::new(), data: String::from_utf8_lossy(&bytes).into_owned(), truncated }
}

#[tauri::command]
async fn local_preview(path: String) -> AppResult<Preview> {
    use tokio::io::AsyncReadExt;
    let limit = if image_mime(&path).is_some() { IMAGE_LIMIT } else { PREVIEW_TEXT_LIMIT };
    if let Some((archive, inner)) = archive_vfs::split(&path) {
        return Ok(make_preview(&path, archive_vfs::read(&archive, &inner, limit + 1)?));
    }
    let file = tokio::fs::File::open(paths::to_native(&path)).await?;
    let mut buf = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut buf).await?;
    Ok(make_preview(&path, buf))
}

/// Largest server file loaded for playing in the preview.
const MEDIA_LIMIT: u64 = 500 * 1024 * 1024;

/// Copies a PDF, audio or video file from the server into a temporary file
/// (kept until Bitcrane ends) and returns its path for the "media" scheme.
#[tauri::command]
async fn remote_media(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<String> {
    use tokio::io::AsyncWriteExt;
    let entry = remote!(state, server_id, |c| c.stat(&path))?;
    if entry.size > MEDIA_LIMIT {
        return Err(AppError::other("Die Datei ist für eine Vorschau zu groß (über 500 MB). Bitte herunterladen."));
    }
    let name = crate::paths::remote_name(&path);
    let dir = std::env::temp_dir().join("bitcrane-preview");
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(format!("{}-{}", uuid::Uuid::new_v4().simple(), name));
    let conn = state.conn(&server_id).await?;
    let mut reader = conn.reader(&path, 0).await?;
    let mut file = tokio::fs::File::create(&target).await?;
    let copied = tokio::io::copy(&mut reader, &mut file).await;
    reader.close(copied.is_ok()).await?;
    copied?;
    file.flush().await?;
    Ok(paths::to_ui(&target))
}

#[tauri::command]
async fn remote_preview(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<Preview> {
    let limit = if image_mime(&path).is_some() { IMAGE_LIMIT } else { PREVIEW_TEXT_LIMIT };
    let bytes = remote!(state, server_id, |c| c.read_head(&path, limit + 1))?;
    Ok(make_preview(&path, bytes))
}

/* ------------------------------------------------------------------ App shell */

/// Shows or hides the status icon and sets its tooltip and menu.
#[tauri::command]
fn tray_update(app: tauri::AppHandle, visible: bool, tooltip: String, items: Vec<tray::TrayItem>) -> AppResult<()> {
    tray::update(&app, visible, &tooltip, &items).map_err(|e| AppError::other("Das Symbol in der Menüleiste konnte nicht gesetzt werden.").with_detail(e.to_string()))
}

/// Quits the app for real (also when it would otherwise keep running in the background).
#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/* ------------------------------------------------------------------ Transfers */

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    id: String,
    done: u64,
    total: u64,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn transfer_upload(
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
async fn transfer_cross(
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
async fn transfer_download(
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
fn transfer_cancel(state: State<'_, AppState>, id: String, discard: Option<bool>) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&id) {
        flag.store(if discard.unwrap_or(false) { transfer::DISCARD } else { transfer::PAUSE }, Ordering::Relaxed);
    }
}

/// Deletes the partial file of a transfer that will not be continued.
#[tauri::command]
async fn transfer_discard(state: State<'_, AppState>, server_id: String, direction: String, local_path: String, remote_path: String) -> AppResult<()> {
    if direction == "up" {
        if let Ok(conn) = state.conn(&server_id).await {
            transfer::discard_upload_part(&conn, &remote_path).await;
        }
    } else {
        transfer::discard_download_part(&local_path).await;
    }
    Ok(())
}

/* ------------------------------------------------------------------ Watches */

#[tauri::command]
fn watch_start(app: tauri::AppHandle, state: State<'_, AppState>, watch_id: String, local_path: String, recursive: bool, excludes: Vec<String>, delay_ms: u64) -> AppResult<()> {
    state.watches.start(watch_id, &local_path, recursive, &excludes, delay_ms, move |batch| {
        let _ = app.emit("watch-batch", batch);
    })
}

#[tauri::command]
fn watch_stop(state: State<'_, AppState>, watch_id: String) {
    state.watches.stop(&watch_id);
}

/* ------------------------------------------------------------------ Settings */

#[tauri::command]
fn config_load(state: State<'_, AppState>) -> AppResult<Value> {
    config::load(&state.config_dir)
}

#[tauri::command]
fn config_save(state: State<'_, AppState>, value: Value) -> AppResult<()> {
    config::save(&state.config_dir, &value)
}

/// Writes a text file chosen by the user (export of the settings).
#[tauri::command]
fn file_write(path: String, text: String) -> AppResult<()> {
    std::fs::write(std::path::Path::new(&path), text)?;
    Ok(())
}

/// While transfers or watches are busy, the computer must not fall asleep
/// (idle sleep; the display may still turn off). One thread owns the lock,
/// because Windows ties it to the thread that took it.
static KEEP_AWAKE: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>> = std::sync::Mutex::new(None);

#[tauri::command]
fn keep_awake(on: bool) {
    let mut slot = KEEP_AWAKE.lock().unwrap();
    if on && slot.is_none() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let guard = keepawake::Builder::default()
                .idle(true)
                .reason("Bitcrane überträgt Dateien")
                .app_name("Bitcrane")
                .app_reverse_domain("de.raccoonworks.bitcrane")
                .create();
            // Waits until "off" (or the app ends); dropping the guard here releases the lock.
            let _ = rx.recv();
            drop(guard);
        });
        *slot = Some(tx);
    } else if !on {
        if let Some(tx) = slot.take() {
            let _ = tx.send(());
        }
    }
}

/// Shared settings file in a folder the user's cloud keeps in step between
/// computers ("Zwischen Rechnern abgleichen", after Panic Sync): "<folder>/Bitcrane/bitcrane-sync.json".
fn sync_file(dir: &str) -> std::path::PathBuf {
    paths::to_native(dir).join("Bitcrane").join("bitcrane-sync.json")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncFile {
    text: String,
    /// Modification time in milliseconds (to notice changes from the other computer).
    mtime: i64,
}

/// Reads the shared settings file; None when there is none yet.
#[tauri::command]
fn sync_read(dir: String) -> AppResult<Option<SyncFile>> {
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
fn sync_write(dir: String, text: String) -> AppResult<i64> {
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

/// Reads a text file chosen by the user (import of the settings).
#[tauri::command]
fn file_read(path: String) -> AppResult<String> {
    let p = std::path::Path::new(&path);
    if std::fs::metadata(p)?.len() > 10 * 1024 * 1024 {
        return Err(AppError::other("Die Datei ist zu groß."));
    }
    Ok(std::fs::read_to_string(p)?)
}

/// Servers saved in FileZilla, WinSCP and the SSH configuration.
#[tauri::command]
fn import_find() -> import::ImportResult {
    import::find_all()
}

#[tauri::command]
fn ssh_config_hosts() -> Vec<sshconfig::SshConfigHost> {
    sshconfig::read_hosts()
}

#[tauri::command]
fn secret_get(account: String) -> AppResult<Option<String>> {
    config::secret_get(&account)
}

#[tauri::command]
fn secret_set(account: String, value: String) -> AppResult<()> {
    config::secret_set(&account, &value)
}

#[tauri::command]
fn secret_delete(account: String) -> AppResult<()> {
    config::secret_delete(&account)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    platform: String,
    known_hosts: usize,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        known_hosts: state.known_hosts.count(),
    }
}

/// Entry point used by `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // A second start only brings the running Bitcrane to the front; started from the
        // Explorer menu ("--upload <path>") it passes the paths on to the window.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            tray::show_main_window(app);
            let paths = shell_integration::upload_args(&args);
            if !paths.is_empty() {
                let _ = app.emit("upload-files", paths);
            }
        }));
    }
    builder
        // sftp:// links (opt-in in the settings; on the Mac the scheme is declared in Info.plist).
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // System file symbols by extension (setting "Dateisymbole des Systems", see sysicons.rs).
        .register_asynchronous_uri_scheme_protocol("fileicon", |_ctx, request, responder| {
            let ext = request.uri().path().trim_start_matches('/').to_string();
            std::thread::spawn(move || {
                let response = match sysicons::png_for_ext(&ext) {
                    Some(bytes) => tauri::http::Response::builder()
                        .header("Content-Type", "image/png")
                        .header("Cache-Control", "max-age=3600")
                        .body(bytes),
                    None => tauri::http::Response::builder().status(404).body(Vec::new()),
                };
                if let Ok(r) = response {
                    responder.respond(r);
                }
            });
        })
        // PDF, audio and video in the preview window (see local::media_response).
        .register_asynchronous_uri_scheme_protocol("media", |_ctx, request, responder| {
            let path = request.uri().path().to_string();
            let range = request.headers().get("range").and_then(|r| r.to_str().ok()).map(String::from);
            std::thread::spawn(move || responder.respond(local::media_response(&path, range.as_deref())));
        })
        // Preview pictures of local images in the icons view (images only, see local::thumb).
        .register_asynchronous_uri_scheme_protocol("thumb", |_ctx, request, responder| {
            let path = request.uri().path().to_string();
            std::thread::spawn(move || {
                let response = match local::thumb(&path) {
                    Some((mime, bytes)) => tauri::http::Response::builder()
                        .header("Content-Type", mime)
                        .header("Cache-Control", "max-age=60")
                        .body(bytes),
                    None => tauri::http::Response::builder().status(404).body(Vec::new()),
                };
                if let Ok(r) = response {
                    responder.respond(r);
                }
            });
        })
        // Started at login: "--autostart" lets Bitcrane stay in the notification area if the user wants that.
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .manage(tray::TrayState::new())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            // Server files copied for playing in the preview are only needed while Bitcrane runs.
            let _ = std::fs::remove_dir_all(std::env::temp_dir().join("bitcrane-preview"));
            let _ = std::fs::remove_dir_all(std::env::temp_dir().join("bitcrane-archive"));
            let dir = app.path().app_config_dir().unwrap_or_else(|_| paths::home().join(".bitcrane"));
            app.manage(AppState::new(dir));
            // The window is created invisible (tauri.conf.json). A normal start shows it at once;
            // a start at login waits for the interface, which keeps it hidden when "Beim Start nur im
            // Infobereich" is set. If the interface does not answer, the window appears anyway.
            let autostart = std::env::args().any(|a| a == "--autostart");
            app.manage(StartInfo { autostart, decided: Arc::new(std::sync::atomic::AtomicBool::new(!autostart)) });
            if !autostart {
                tray::show_main_window(app.handle());
            } else {
                let handle = app.handle().clone();
                let decided = app.state::<StartInfo>().decided.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    if !decided.load(Ordering::SeqCst) {
                        tray::show_main_window(&handle);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_info,
            start_decided,
            local_list,
            local_stat,
            local_mkdir,
            local_rename,
            local_trash,
            local_walk,
            local_copy,
            local_move,
            local_copy_files,
            open_full_disk_access,
            cloud_services,
            cloud_sign_in,
            cloud_sign_in_cancel,
            dropbox_connect,
            gdrive_connect,
            onedrive_connect,
            system_power,
            local_checksum,
            open_url,
            local_places,
            local_drives,
            local_cloud_places,
            local_zip,
            archive_extract_temp,
            take_pending_uploads,
            cli_path,
            mount_start,
            mount_stop,
            mount_folder,
            shell_integration_set,
            remote_share_link,
            local_unzip,
            local_open,
            local_reveal,
            edit_temp_path,
            open_terminal,
            path_to_ui,
            ssh_connect,
            ssh_disconnect,
            ftp_connect,
            dav_connect,
            smb_connect,
            auth_prompt_answer,
            ssh_is_connected,
            remote_list,
            remote_stat,
            remote_mkdir,
            remote_rename,
            remote_remove,
            remote_move,
            remote_chmod,
            remote_walk,
            remote_exec,
            remote_copy,
            remote_checksum,
            remote_symlink,
            transfer_upload,
            transfer_download,
            transfer_cross,
            transfer_cancel,
            transfer_discard,
            watch_start,
            watch_stop,
            config_load,
            config_save,
            secret_get,
            secret_set,
            secret_delete,
            ssh_config_hosts,
            import_find,
            file_write,
            sync_read,
            keep_awake,
            sync_write,
            file_read,
            local_read_text,
            local_preview,
            remote_preview,
            remote_media,
            remote_read_text,
            tray_update,
            app_quit,
            known_hosts_list,
            key_info,
            key_generate,
            key_public,
            ssh_test,
            known_hosts_remove,
            log_write,
            log_path,
            app_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Bitcrane")
        .run(|app, event| {
            // macOS: clicking the Dock icon brings a hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main_window(app);
            }
            let _ = (app, event);
        });
}

#[cfg(all(test, unix))]
mod terminal_tests {
    use super::*;

    fn target(dir: &str, user: &str) -> TerminalTarget {
        TerminalTarget { local_path: None, host: Some("example.com".into()), port: Some(2222), user: Some(user.into()), key_path: None, remote_path: Some(dir.into()) }
    }

    #[test]
    fn server_folder_names_stay_quoted() {
        let cmd = terminal_ssh_command("example.com", &target("/srv/$(touch pwned)", "deploy")).unwrap();
        assert_eq!(cmd, "ssh -t -p 2222 deploy@example.com 'cd '\\''/srv/$(touch pwned)'\\'' && exec $SHELL -l'");
        // The local shell must see exactly four plain words plus one quoted argument.
        let out = std::process::Command::new("sh").arg("-c").arg(format!("printf '%s\\n' {}", cmd.trim_start_matches("ssh "))).output().unwrap();
        let args: Vec<_> = String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect();
        assert_eq!(args.last().unwrap(), "cd '/srv/$(touch pwned)' && exec $SHELL -l");
        assert!(terminal_ssh_command("example.com", &target("/x", "a;b")).is_err());
        assert!(terminal_ssh_command("ex$(x)", &target("/x", "a")).is_err());
    }
}
