//! Bitcrane application core.
//!
//! Exposes Tauri commands for local files, SSH/SFTP connections, transfers,
//! remote commands, folder watching, settings and secrets. Long-running
//! operations report progress through events:
//! - `transfer-progress` `{ id, done, total }`
//! - `watch-batch` `{ watchId, changed, removed }`

mod archive;
mod archive_vfs;
pub mod cli;
mod commands;
mod config;
mod dav;
mod dropbox;
mod error;
mod forward;
mod ftp;
mod gdrive;
mod git;
mod iconmenu;
mod import;
mod keys;
#[cfg(test)]
mod loadtest;
mod local;
mod model;
#[cfg(windows)]
mod mount_win;
mod netshares;
mod oauth;
mod onedrive;
mod paths;
mod proxy;
mod remote;
mod s3;
mod scp;
mod shell_integration;
mod smb;
mod ssh;
mod sshconfig;
mod sysicons;
mod tags;
mod terminal;
mod thumbs;
mod tls;
mod transfer;
mod tray;
mod vault;
mod watcher;

use commands::app::{update_marker, StartInfo};
use error::{AppError, AppResult, ErrorKind};
use ssh::KnownHosts;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// Shared state of the running app.
pub struct AppState {
    connections: Arc<tokio::sync::Mutex<HashMap<String, Arc<remote::Remote>>>>,
    terminals: terminal::Terminals,
    /// SSH tunnels (port forwarding) of the servers.
    forwards: forward::Forwards,
    /// Servers shown as folders in the Windows Explorer.
    #[cfg(windows)]
    mounts: mount_win::Mounts,
    known_hosts: Arc<KnownHosts>,
    watches: watcher::Watches,
    cancels: Mutex<HashMap<String, Arc<AtomicU8>>>,
    /// Open questions of servers during login, waiting for the user's answers.
    prompts: PendingPrompts,
    config_dir: PathBuf,
}

impl AppState {
    fn new(config_dir: PathBuf) -> Self {
        Self {
            connections: Default::default(),
            known_hosts: Arc::new(KnownHosts::load(config_dir.join("known_hosts.json"))),
            watches: Default::default(),
            terminals: Default::default(),
            forwards: Default::default(),
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

/// Login questions waiting for the user's answers, by question id (`None`: cancelled).
type PendingPrompts = Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<Option<Vec<String>>>>>>;

/// Entry point used by `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Before any window exists, so the taskbar button gets the app ID of the shortcuts (see iconmenu).
    #[cfg(windows)]
    iconmenu::set_app_id(&context.config().identifier);
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
            if let Some(action) = iconmenu::action_arg(&args) {
                tray::on_menu(app, &action);
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
        // Finder symbol of one item, e.g. an app's own icon (Mac, see sysicons::png_for_path).
        .register_asynchronous_uri_scheme_protocol("itemicon", |_ctx, request, responder| {
            let path = request.uri().path().to_string();
            std::thread::spawn(move || {
                let response = match sysicons::png_for_path(&path) {
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
        // Preview pictures in the icons view: local images, and images on a server when that is
        // turned on (see thumbs).
        .register_asynchronous_uri_scheme_protocol("thumb", |_ctx, request, responder| {
            let path = request.uri().path().to_string();
            std::thread::spawn(move || responder.respond(thumbs::response(local::thumb(&path))));
        })
        .register_asynchronous_uri_scheme_protocol("rthumb", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            let query = request.uri().query().unwrap_or_default().to_string();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AppState>();
                responder.respond(thumbs::response(thumbs::remote(&state, &path, &query).await));
            });
        })
        // Started at login: "--autostart" lets Bitcrane stay in the notification area if the user wants that.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .manage(tray::TrayState::new())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            // Server files copied for playing in the preview are only needed while Bitcrane runs.
            let _ = std::fs::remove_dir_all(std::env::temp_dir().join("bitcrane-preview"));
            let _ = std::fs::remove_dir_all(std::env::temp_dir().join("bitcrane-drag"));
            let _ = std::fs::remove_dir_all(std::env::temp_dir().join("bitcrane-archive"));
            let _ = std::fs::remove_dir_all(std::env::temp_dir().join(thumbs::CACHE_DIR));
            let dir = app.path().app_config_dir().unwrap_or_else(|_| paths::home().join(".bitcrane"));
            app.manage(AppState::new(dir));
            // The window is created invisible (tauri.conf.json). A normal start shows it at once;
            // a start at login waits for the interface, which keeps it hidden when "Beim Start nur im
            // Infobereich" is set. If the interface does not answer, the window appears anyway.
            // A restart after an update is never a start at login, whatever the arguments say.
            let after_update = std::fs::remove_file(update_marker(app.handle())).is_ok();
            let autostart = !after_update && std::env::args().any(|a| a == "--autostart");
            app.manage(StartInfo { autostart, decided: Arc::new(AtomicBool::new(!autostart)) });
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
            commands::app::start_info,
            commands::app::start_decided,
            commands::app::mark_update_restart,
            commands::local::local_list,
            commands::local::local_stat,
            commands::local::local_mkdir,
            commands::local::local_new_file,
            commands::local::local_rename,
            commands::local::local_trash,
            commands::local::local_walk,
            commands::local::local_copy,
            commands::local::local_move,
            commands::local::local_copy_files,
            commands::app::mac_full_disk_access,
            commands::app::open_mac_settings,
            commands::local::git_status,
            commands::local::local_tags,
            commands::local::local_tag_find,
            commands::local::local_real_paths,
            commands::local::local_free_space,
            commands::content::editor_read,
            commands::content::editor_mtime,
            commands::content::editor_write,
            commands::local::network_hosts,
            commands::local::local_tag,
            commands::local::git_action,
            commands::cloud::cloud_services,
            commands::cloud::cloud_sign_in,
            commands::cloud::cloud_sign_in_cancel,
            commands::cloud::dropbox_connect,
            commands::cloud::gdrive_connect,
            commands::cloud::onedrive_connect,
            commands::app::system_power,
            commands::local::local_checksum,
            commands::app::open_url,
            commands::local::local_places,
            commands::local::local_drives,
            commands::local::local_cloud_places,
            commands::local::local_zip,
            commands::local::archive_extract_temp,
            commands::app::take_pending_uploads,
            commands::app::take_start_action,
            commands::app::cli_path,
            commands::mount::mount_start,
            commands::mount::mount_stop,
            commands::mount::mount_folder,
            commands::app::shell_integration_set,
            commands::server::remote_share_link,
            commands::server::remote_presign,
            commands::local::local_grep,
            commands::server::drag_out,
            commands::server::remote_drag_prepare,
            commands::server::remote_grep,
            commands::local::local_unzip,
            commands::local::local_open,
            commands::local::local_reveal,
            commands::content::edit_temp_path,
            commands::terminals::open_terminal,
            commands::local::path_to_ui,
            commands::connect::ssh_connect,
            commands::connect::ssh_disconnect,
            commands::connect::ftp_connect,
            commands::connect::dav_connect,
            commands::connect::s3_connect,
            commands::connect::smb_connect,
            commands::terminals::term_open,
            commands::terminals::term_write,
            commands::terminals::term_shells,
            commands::terminals::forward_start,
            commands::terminals::forward_stop,
            commands::terminals::forward_active,
            commands::terminals::term_resize,
            commands::terminals::term_close,
            commands::connect::vault_open,
            commands::connect::vault_create,
            commands::connect::auth_prompt_answer,
            commands::connect::ssh_is_connected,
            commands::server::remote_list,
            commands::server::remote_stat,
            commands::server::remote_mkdir,
            commands::server::remote_new_file,
            commands::server::remote_rename,
            commands::server::remote_remove,
            commands::server::remote_move,
            commands::server::remote_chmod,
            commands::server::remote_walk,
            commands::server::remote_exec,
            commands::server::remote_copy,
            commands::server::remote_checksum,
            commands::server::remote_symlink,
            commands::transfers::transfer_upload,
            commands::transfers::transfer_download,
            commands::transfers::transfer_cross,
            commands::transfers::transfer_cancel,
            commands::transfers::transfer_discard,
            commands::transfers::watch_start,
            commands::transfers::watch_stop,
            commands::settings::config_load,
            commands::settings::config_save,
            commands::credentials::secret_get,
            commands::credentials::secret_set,
            commands::credentials::secret_delete,
            commands::settings::ssh_config_hosts,
            commands::settings::import_find,
            commands::settings::import_file,
            commands::settings::tabby_config,
            commands::settings::file_write,
            commands::transfers::sync_read,
            commands::app::keep_awake,
            commands::transfers::sync_write,
            commands::settings::file_read,
            commands::content::local_read_text,
            commands::content::local_preview,
            commands::content::remote_preview,
            commands::content::remote_media,
            commands::content::remote_read_text,
            commands::app::tray_update,
            commands::app::app_quit,
            commands::credentials::known_hosts_list,
            commands::credentials::key_info,
            commands::credentials::key_generate,
            commands::credentials::key_public,
            commands::credentials::ssh_test,
            commands::credentials::known_hosts_remove,
            commands::app::log_write,
            commands::app::log_path,
            commands::app::app_version,
        ])
        .build(context)
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
