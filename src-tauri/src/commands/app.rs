//! The app itself and its place in the system: start, updates, tray, power, log and
//! system settings.

use crate::error::{AppError, AppResult};
use crate::{iconmenu, links, paths, shell_integration, tray, AppState};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{Manager, State};

/// State of the macOS permissions Bitcrane can check: "Festplattenvollzugriff"
/// shows in whether the privacy database itself can be read (only with it).
#[tauri::command]
pub(crate) fn mac_full_disk_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        let db = paths::home().join("Library").join("Application Support").join("com.apple.TCC").join("TCC.db");
        std::fs::File::open(db).is_ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Opens a page of the macOS System Settings: "fullDisk", "localNetwork",
/// "notifications" or "loginItems".
#[tauri::command]
pub(crate) fn open_mac_settings(page: String) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        let url = match page.as_str() {
            "fullDisk" => "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
            "localNetwork" => "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
            "notifications" => "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "loginItems" => "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
            _ => return Err(AppError::other("Unbekannte Seite der Systemeinstellungen.")),
        };
        std::process::Command::new("open").arg(url).spawn().map(|_| ()).map_err(AppError::from)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = page;
        Ok(())
    }
}

/// "Nach Abschluss" (WinSCP "Once empty"): puts the computer to sleep or shuts it down
/// once all transfers are done. The interface asks with a countdown before calling this.
#[tauri::command]
pub(crate) fn system_power(action: String) -> AppResult<()> {
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

/// Opens a web address in the default browser (only http and https).
#[tauri::command]
pub(crate) fn open_url(url: String) -> AppResult<()> {
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

/// How Bitcrane was started: `autostart` is true for a start at login.
pub(crate) struct StartInfo {
    pub(crate) autostart: bool,
    pub(crate) decided: Arc<AtomicBool>,
}

/// True when Bitcrane was started at login ("--autostart").
#[tauri::command]
pub(crate) fn start_info(info: State<'_, StartInfo>) -> bool {
    info.autostart
}

/// Marker written right before an update installs. The Windows installer starts the new
/// version with the arguments of the old process; after a start at login those include
/// "--autostart", which would keep the window hidden. The marker makes it a normal start.
pub(crate) fn update_marker(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| paths::home().join(".bitcrane")).join("restart-after-update")
}

#[tauri::command]
pub(crate) fn mark_update_restart(app: tauri::AppHandle) -> AppResult<()> {
    let marker = update_marker(&app);
    if let Some(dir) = marker.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&marker, b"1")
        .map_err(|e| AppError::other("Update-Hinweis konnte nicht gespeichert werden.").with_detail(e.to_string()))
}

/// The interface has decided whether the window stays hidden (no fallback needed).
#[tauri::command]
pub(crate) fn start_decided(info: State<'_, StartInfo>) {
    info.decided.store(true, Ordering::SeqCst);
}

/// The program file, for calls from the command line (cli.rs).
#[tauri::command]
pub(crate) fn cli_path() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

/// The jump list entry Bitcrane was started from (Windows), once.
#[tauri::command]
pub(crate) fn take_start_action() -> Option<String> {
    static TAKEN: AtomicBool = AtomicBool::new(false);
    if TAKEN.swap(true, Ordering::SeqCst) {
        return None;
    }
    iconmenu::action_arg(&std::env::args().collect::<Vec<_>>())
}

/// Paths Bitcrane was started with from the Explorer menu ("--upload"), once.
#[tauri::command]
pub(crate) fn take_pending_uploads() -> Vec<String> {
    static TAKEN: AtomicBool = AtomicBool::new(false);
    if TAKEN.swap(true, Ordering::SeqCst) {
        return Vec::new();
    }
    shell_integration::upload_args(&std::env::args().collect::<Vec<_>>())
}

/// The sftp:// link Bitcrane was started with (Windows), once.
#[tauri::command]
pub(crate) fn take_start_link() -> Option<String> {
    static TAKEN: AtomicBool = AtomicBool::new(false);
    if TAKEN.swap(true, Ordering::SeqCst) {
        return None;
    }
    links::link_arg(&std::env::args().collect::<Vec<_>>())
}

/// Bitcrane as the program for sftp:// links on or off (Windows; the Mac declares it in the bundle).
#[tauri::command]
pub(crate) fn sftp_links_set(enable: bool) -> AppResult<()> {
    links::set(enable)
}

/// "Mit Bitcrane hochladen" in the Explorer / Finder context menu on or off.
#[tauri::command]
pub(crate) fn shell_integration_set(enable: bool, label: String) -> AppResult<()> {
    shell_integration::set(enable, &label)
}

/// The connection log is written here when "Protokoll für die Fehlersuche
/// schreiben" is switched on.
fn log_file(state: &AppState) -> PathBuf {
    state.config_dir.join("logs").join("bitcrane.log")
}

/// Appends lines to the log file; starts a new file above 5 MB.
#[tauri::command]
pub(crate) fn log_write(state: State<'_, AppState>, lines: Vec<String>) -> AppResult<()> {
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
pub(crate) fn log_path(state: State<'_, AppState>) -> String {
    paths::to_ui(&log_file(&state))
}

/// Shows or hides the status icon and sets its tooltip and menu.
#[tauri::command]
pub(crate) fn tray_update(
    app: tauri::AppHandle,
    visible: bool,
    tooltip: String,
    items: Vec<tray::TrayItem>,
) -> AppResult<()> {
    iconmenu::update(&app, &items);
    tray::update(&app, visible, &tooltip, &items).map_err(|e| {
        AppError::other("Das Symbol in der Menüleiste konnte nicht gesetzt werden.").with_detail(e.to_string())
    })
}

/// Quits the app for real (also when it would otherwise keep running in the background).
#[tauri::command]
pub(crate) fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Stops the thread that keeps the computer awake (set while it runs).
static KEEP_AWAKE: Mutex<Option<mpsc::Sender<()>>> = Mutex::new(None);

/// Keeps the computer from going to sleep while transfers run, until called with `false`.
/// While transfers or watches are busy, the computer must not fall asleep (idle sleep; the
/// display may still turn off). One thread owns the lock, because Windows ties it to the
/// thread that took it.
#[tauri::command]
pub(crate) fn keep_awake(on: bool) {
    let mut slot = KEEP_AWAKE.lock().unwrap();
    if on && slot.is_none() {
        let (tx, rx) = mpsc::channel::<()>();
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

/// Version of the running app (about dialog, settings, the note after an update).
#[tauri::command]
pub(crate) fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}
