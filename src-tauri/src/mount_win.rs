//! Servers as folders in the Windows Explorer, through the Cloud Files API
//! (the interface OneDrive uses): the folder appears in the navigation pane,
//! files show up as placeholders and are downloaded when opened. Changes made
//! in the folder go back to the server:
//!
//! - opening a file: `fetch_data` reads the requested range from the server;
//! - opening a folder: `fetch_placeholders` lists it on the server;
//! - deleting or renaming in the Explorer: `delete` / `rename` do the same on
//!   the server first and only then let Windows go ahead;
//! - new or changed files: a folder watcher uploads them and marks them as
//!   in sync.
//!
//! The server connection is a normal Bitcrane connection under the id
//! `mount:<server id>`, opened by the interface (which has the passwords).
//! When it is missing, the interface is asked to connect again.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::paths::{remote_name, sync_root_to_remote as to_remote};
use crate::remote::Remote;
use cloud_filter::error::{CResult, CloudErrorKind};
use cloud_filter::filter::{info, ticket, Filter, Request};
use cloud_filter::metadata::Metadata;
use cloud_filter::placeholder::{ConvertOptions, Placeholder, UpdateOptions};
use cloud_filter::placeholder_file::PlaceholderFile;
use cloud_filter::root::{HydrationType, PopulationType, SecurityId, Session, SyncRootId, SyncRootIdBuilder, SyncRootInfo};
use cloud_filter::utility::{FileTime, WriteAt};
use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU8;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::runtime::Handle;

type Connections = Arc<tokio::sync::Mutex<HashMap<String, Arc<Remote>>>>;

/// Name under which Bitcrane registers its folders with Windows.
const PROVIDER: &str = "Bitcrane";
/// Bytes per piece when filling a placeholder; Windows wants 4 KiB steps.
const PIECE: usize = 1024 * 1024;

/// What the interface hears about a mounted server.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MountEvent {
    server_id: String,
    /// "uploaded", "error" or "connect" (the connection is gone, please connect again).
    kind: &'static str,
    name: String,
    message: String,
}

struct Mount {
    root: PathBuf,
    id: SyncRootId,
    // Dropping these ends the connection to Windows and the folder watcher.
    session: Box<dyn std::any::Any + Send>,
    _watcher: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
    pending: Arc<Mutex<HashSet<PathBuf>>>,
}

#[derive(Default)]
pub struct Mounts(Mutex<HashMap<String, Mount>>);

fn fail(message: &str, e: impl std::fmt::Debug) -> AppError {
    AppError::other(message.to_string()).with_detail(format!("{e:?}"))
}

/// Folder for a server: %USERPROFILE%\Bitcrane\<name>.
fn folder_for(name: &str) -> PathBuf {
    let clean: String = name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let clean = clean.trim().trim_end_matches('.').to_string();
    crate::paths::home().join("Bitcrane").join(if clean.is_empty() { "Server".to_string() } else { clean })
}

fn sync_root_id(server_id: &str) -> AppResult<SyncRootId> {
    let sid = SecurityId::current_user().map_err(|e| fail("Das Windows-Konto konnte nicht ermittelt werden.", e))?;
    Ok(SyncRootIdBuilder::new(PROVIDER).user_security_id(sid).account_name(server_id).build())
}

impl Mounts {
    /// Shows a server as a folder in the Explorer. Returns the folder.
    #[allow(clippy::too_many_arguments)]
    pub fn start(&self, app: AppHandle, connections: Connections, connection_id: String, server_id: String, name: String, remote_root: String) -> AppResult<String> {
        if !cloud_filter::root::is_supported().unwrap_or(false) {
            return Err(AppError::other("Diese Windows-Version kann Server nicht als Ordner im Explorer zeigen (ab Windows 10, Version 1709)."));
        }
        self.stop_inner(&server_id, false);
        let root = folder_for(&name);
        std::fs::create_dir_all(&root).map_err(|e| fail("Der Ordner für den Server konnte nicht angelegt werden.", e))?;
        let id = sync_root_id(&server_id)?;
        // A renamed server gets a new folder: the old registration goes first.
        if id.is_registered().unwrap_or(false) && id.info().map(|i| i.path() != root).unwrap_or(true) {
            let _ = id.unregister();
        }
        if !id.is_registered().unwrap_or(false) {
            let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            let info = SyncRootInfo::default()
                .with_display_name(format!("{name} (Bitcrane)"))
                .with_population_type(PopulationType::Full)
                .with_hydration_type(HydrationType::Full)
                .with_allow_pinning(true)
                .with_icon(format!("{exe},0"))
                .with_version(env!("CARGO_PKG_VERSION"))
                .with_path(&root)
                .map_err(|e| fail("Der Ordner konnte nicht bei Windows angemeldet werden.", e))?;
            id.register(info).map_err(|e| fail("Der Ordner konnte nicht bei Windows angemeldet werden.", e))?;
        }
        let pending: Arc<Mutex<HashSet<PathBuf>>> = Default::default();
        let filter = ServerFilter {
            app: app.clone(),
            connections: connections.clone(),
            connection_id: connection_id.clone(),
            server_id: server_id.clone(),
            root: root.clone(),
            remote_root: remote_root.clone(),
        };
        let rt = Handle::current();
        let session = Session::new()
            .connect_async(&root, filter, move |f| rt.block_on(f))
            .map_err(|e| fail("Die Verbindung zum Explorer konnte nicht hergestellt werden.", e))?;
        let watcher = start_watcher(Uploader { app, connections, connection_id, server_id: server_id.clone(), root: root.clone(), remote_root, pending: pending.clone(), rt: Handle::current() })?;
        let folder = root.to_string_lossy().to_string();
        self.0.lock().unwrap().insert(server_id, Mount { root, id, session: Box::new(session), _watcher: watcher, pending });
        Ok(folder)
    }

    /// Takes the folder out of the Explorer again. `remove_folder` also deletes
    /// the local copies, but only when no upload is outstanding.
    pub fn stop(&self, server_id: &str, remove_folder: bool) -> AppResult<Option<String>> {
        Ok(self.stop_inner(server_id, remove_folder))
    }

    /// Returns the folder when it had to stay (uploads outstanding or locked files).
    fn stop_inner(&self, server_id: &str, remove_folder: bool) -> Option<String> {
        let mount = self.0.lock().unwrap().remove(server_id);
        let (root, id, clean) = match mount {
            Some(m) => {
                let clean = m.pending.lock().unwrap().is_empty();
                // The connection to Windows ends before the folder is unregistered.
                drop(m.session);
                (m.root, m.id, clean)
            }
            None => {
                if !remove_folder {
                    return None;
                }
                let Ok(id) = sync_root_id(server_id) else { return None };
                let Ok(info) = id.info() else { return None };
                (info.path(), id, true)
            }
        };
        if !remove_folder {
            return None;
        }
        let _ = id.unregister();
        if clean && std::fs::remove_dir_all(&root).is_ok() {
            return None;
        }
        Some(root.to_string_lossy().to_string())
    }

    pub fn folder(&self, server_id: &str) -> Option<String> {
        self.0.lock().unwrap().get(server_id).map(|m| m.root.to_string_lossy().to_string())
    }
}

async fn connection(app: &AppHandle, connections: &Connections, connection_id: &str, server_id: &str) -> CResult<Arc<Remote>> {
    let found = connections.lock().await.get(connection_id).filter(|c| !c.is_closed()).cloned();
    match found {
        Some(c) => Ok(c),
        None => {
            let _ = app.emit("mount-event", MountEvent { server_id: server_id.to_string(), kind: "connect", name: String::new(), message: String::new() });
            Err(CloudErrorKind::NetworkUnavailable)
        }
    }
}

fn file_time(ms: i64) -> FileTime {
    FileTime::from_unix_time(ms.max(0) / 1000).unwrap_or_else(|_| FileTime::now())
}

struct ServerFilter {
    app: AppHandle,
    connections: Connections,
    connection_id: String,
    server_id: String,
    root: PathBuf,
    remote_root: String,
}

impl ServerFilter {
    fn remote_path(&self, local: &Path) -> CResult<String> {
        to_remote(&self.root, &self.remote_root, local).ok_or(CloudErrorKind::NotUnderSyncRoot)
    }

    async fn remote(&self) -> CResult<Arc<Remote>> {
        connection(&self.app, &self.connections, &self.connection_id, &self.server_id).await
    }

    fn report(&self, name: &str, e: &AppError) {
        let _ = self.app.emit("mount-event", MountEvent { server_id: self.server_id.clone(), kind: "error", name: name.to_string(), message: e.message.clone() });
    }
}

impl Filter for ServerFilter {
    async fn fetch_data(&self, request: Request, ticket: ticket::FetchData, info: info::FetchData) -> CResult<()> {
        let path = request.path();
        let remote_path = self.remote_path(&path)?;
        let conn = self.remote().await?;
        let range = info.required_file_range();
        let mut reader = conn.reader(&remote_path, range.start).await.map_err(|e| {
            self.report(&remote_name(&remote_path), &e);
            CloudErrorKind::Unsuccessful
        })?;
        let mut buf = vec![0u8; PIECE];
        let mut pos = range.start;
        let mut filled = 0usize;
        loop {
            let n = reader.read(&mut buf[filled..]).await.map_err(|_| CloudErrorKind::Unsuccessful)?;
            filled += n;
            let end = n == 0 || pos + filled as u64 >= range.end;
            // Pieces must be a multiple of 4 KiB, except the last one of the file.
            let len = if end { filled } else { filled - filled % 4096 };
            if (filled == buf.len() || end) && len > 0 {
                ticket.write_at(&buf[..len], pos).map_err(|_| CloudErrorKind::Unsuccessful)?;
                pos += len as u64;
                buf.copy_within(len..filled, 0);
                filled -= len;
                let _ = ticket.report_progress(range.end, pos);
            }
            if end {
                break;
            }
        }
        let _ = reader.close(pos >= request.file_size()).await;
        Ok(())
    }

    async fn fetch_placeholders(&self, request: Request, ticket: ticket::FetchPlaceholders, _info: info::FetchPlaceholders) -> CResult<()> {
        let dir = request.path();
        let remote_dir = self.remote_path(&dir)?;
        let conn = self.remote().await?;
        let entries = conn.list(&remote_dir).await.map_err(|e| {
            self.report(&remote_name(&remote_dir), &e);
            CloudErrorKind::Unsuccessful
        })?;
        let mut placeholders: Vec<PlaceholderFile> = entries
            .into_iter()
            // Half-written uploads stay invisible; existing local files are not replaced.
            .filter(|e| !e.name.ends_with(".bitcrane-part") && !dir.join(&e.name).exists())
            .map(|e| {
                let written = file_time(e.mtime);
                let meta = if e.kind == "dir" { Metadata::directory() } else { Metadata::file().size(e.size) };
                PlaceholderFile::new(&e.name).metadata(meta.written(written).created(written).changed(written)).mark_in_sync()
            })
            .collect();
        ticket.pass_with_placeholder(&mut placeholders).map_err(|_| CloudErrorKind::Unsuccessful)?;
        Ok(())
    }

    async fn delete(&self, request: Request, ticket: ticket::Delete, info: info::Delete) -> CResult<()> {
        if !info.is_undelete() {
            let remote_path = self.remote_path(&request.path())?;
            let conn = self.remote().await?;
            if let Err(e) = conn.remove(&remote_path).await {
                // Windows keeps the file when the server refuses.
                self.report(&remote_name(&remote_path), &e);
                return Err(CloudErrorKind::Unsuccessful);
            }
        }
        ticket.pass().map_err(|_| CloudErrorKind::Unsuccessful)
    }

    async fn rename(&self, request: Request, ticket: ticket::Rename, info: info::Rename) -> CResult<()> {
        let from = self.remote_path(&request.path())?;
        let conn = self.remote().await?;
        let result = if info.target_in_scope() {
            let to = self.remote_path(&info.target_path())?;
            conn.rename(&from, &to).await
        } else {
            // Moved out of the folder: like OneDrive, it leaves the server.
            conn.remove(&from).await
        };
        if let Err(e) = result {
            self.report(&remote_name(&from), &e);
            return Err(CloudErrorKind::Unsuccessful);
        }
        ticket.pass().map_err(|_| CloudErrorKind::Unsuccessful)
    }
}

/* ------------------------------------------------- Uploads of local changes */

struct Uploader {
    app: AppHandle,
    connections: Connections,
    connection_id: String,
    server_id: String,
    root: PathBuf,
    remote_root: String,
    pending: Arc<Mutex<HashSet<PathBuf>>>,
    rt: Handle,
}

/// Whether a file or folder still has to go to the server: everything that is
/// not a placeholder yet, and placeholders changed since the last sync.
fn needs_upload(path: &Path) -> bool {
    match Placeholder::open(path).and_then(|p| p.info()) {
        Ok(Some(info)) => !info.is_in_sync(),
        _ => true,
    }
}

fn skip_name(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    // Office lock files, temporary files and Explorer leftovers stay local.
    name.starts_with("~$") || name.ends_with(".tmp") || name == "desktop.ini" || name == "thumbs.db" || name.ends_with(".bitcrane-part")
}

impl Uploader {
    async fn sync(&self, paths: Vec<PathBuf>) {
        let Ok(conn) = connection(&self.app, &self.connections, &self.connection_id, &self.server_id).await else {
            // Tried again with the next change, once the interface has connected.
            self.pending.lock().unwrap().extend(paths);
            return;
        };
        let mut all: Vec<PathBuf> = paths;
        all.extend(self.pending.lock().unwrap().drain());
        all.sort();
        all.dedup();
        for path in all {
            if !path.exists() || skip_name(&path) || !needs_upload(&path) {
                continue;
            }
            let Some(remote_path) = to_remote(&self.root, &self.remote_root, &path) else { continue };
            let result = if path.is_dir() {
                conn.mkdir_all(&remote_path).await.map(|_| ConvertOptions::default().mark_in_sync().has_children())
            } else {
                let ui = path.to_string_lossy().replace('\\', "/");
                crate::transfer::upload(&conn, &ui, &remote_path, &Default::default(), &|_, _| {}, Arc::new(AtomicU8::new(crate::transfer::RUN)))
                    .await
                    .map(|_| ConvertOptions::default().mark_in_sync())
            };
            match result {
                Ok(options) => {
                    if mark_synced(&path, options) {
                        if path.is_file() {
                            let _ = self.app.emit("mount-event", MountEvent { server_id: self.server_id.clone(), kind: "uploaded", name: remote_name(&remote_path), message: String::new() });
                        }
                    } else {
                        // Still open in another program: try again later.
                        self.pending.lock().unwrap().insert(path);
                    }
                }
                Err(e) => {
                    self.pending.lock().unwrap().insert(path);
                    let _ = self.app.emit("mount-event", MountEvent { server_id: self.server_id.clone(), kind: "error", name: remote_name(&remote_path), message: e.message.clone() });
                }
            }
        }
    }
}

/// Turns an uploaded file or folder into an in-sync placeholder.
fn mark_synced(path: &Path, options: ConvertOptions) -> bool {
    let Ok(mut p) = Placeholder::open(path) else { return false };
    match p.info() {
        Ok(Some(_)) => p.update(UpdateOptions::default().mark_in_sync(), None).is_ok(),
        _ => p.convert_to_placeholder(options, None).is_ok(),
    }
}

fn start_watcher(uploader: Uploader) -> AppResult<Debouncer<notify::RecommendedWatcher, RecommendedCache>> {
    let root = uploader.root.clone();
    let uploader = Arc::new(uploader);
    let mut debouncer = new_debouncer(Duration::from_secs(2), None, move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let mut paths = Vec::new();
        for ev in events {
            if matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                paths.extend(ev.paths.iter().cloned());
            }
        }
        if paths.is_empty() {
            return;
        }
        let u = uploader.clone();
        u.rt.clone().spawn(async move { u.sync(paths).await });
    })
    .map_err(|e| fail("Der Ordner kann nicht überwacht werden.", e))?;
    debouncer.watch(&root, RecursiveMode::Recursive).map_err(|e| fail("Der Ordner kann nicht überwacht werden.", e))?;
    Ok(debouncer)
}
