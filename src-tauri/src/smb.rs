//! SMB client (Windows file sharing, NAS boxes, Samba) on top of the pure-Rust
//! `smb` crate: SMB 2 and 3 with signing and encryption, no system libraries.
//!
//! Paths in Bitcrane are "/<share>/<folder>/<file>". "/" lists the shares of
//! the server where the server allows it; with a share in the server settings
//! the connection starts there.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{FileEntry, WalkItem};
use crate::paths::{remote_join, remote_name, remote_parent};
use futures_util::StreamExt;
use serde::Deserialize;
use smb::{
    Client, ClientConfig, CreateOptions, DirAccessMask, Directory, File, FileAccessMask, FileAttributes, FileBasicInformation, FileCreateArgs, FileDispositionInformation,
    FileIdBothDirectoryInformation, FileNetworkOpenInformation, FileRenameInformation, Resource, UncPath,
};
use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SmbParams {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    /// "user", "DOMAIN\user" or "user@domain"; empty for guest access.
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password: Option<String>,
    /// Share to start in; empty starts in the list of shares.
    #[serde(default)]
    pub share: String,
    /// Insist on SMB 3 encryption.
    #[serde(default)]
    pub encrypt: bool,
}

fn default_port() -> u16 {
    445
}

/// Bytes per read or write request (capped by what the server negotiated)
/// and how many requests are in flight at once.
const CHUNK: u32 = 1024 * 1024;
const IN_FLIGHT: usize = 4;

pub struct SmbConn {
    params: SmbParams,
    client: Mutex<Arc<Client>>,
    /// Shares this client is connected to.
    shares: Mutex<HashSet<String>>,
    pub home: String,
}

/// NTSTATUS values that get their own message.
mod status {
    pub const ACCESS_DENIED: u32 = 0xC000_0022;
    pub const NAME_NOT_FOUND: u32 = 0xC000_0034;
    pub const NAME_COLLISION: u32 = 0xC000_0035;
    pub const PATH_NOT_FOUND: u32 = 0xC000_003A;
    pub const SHARING_VIOLATION: u32 = 0xC000_0043;
    pub const DELETE_PENDING: u32 = 0xC000_0056;
    pub const LOGON_FAILURE: u32 = 0xC000_006D;
    pub const ACCOUNT_RESTRICTION: u32 = 0xC000_006E;
    pub const PASSWORD_EXPIRED: u32 = 0xC000_0071;
    pub const ACCOUNT_DISABLED: u32 = 0xC000_0072;
    pub const BAD_NETWORK_NAME: u32 = 0xC000_00CC;
    pub const NOT_A_DIRECTORY: u32 = 0xC000_0103;
    pub const DIRECTORY_NOT_EMPTY: u32 = 0xC000_0101;
    pub const FILE_IS_A_DIRECTORY: u32 = 0xC000_00BA;
}

fn status_of(e: &smb::Error) -> Option<u32> {
    match e {
        smb::Error::ReceivedErrorMessage(s, _) | smb::Error::UnexpectedMessageStatus(s) => Some(*s),
        _ => None,
    }
}

/// The connection is gone (idle timeout of the server, network change):
/// worth one new attempt with a fresh connection.
fn is_connection_error(e: &smb::Error) -> bool {
    matches!(e, smb::Error::ConnectionStopped | smb::Error::TransportError(_) | smb::Error::IoError(_))
}

/// Turns an SMB error into a message. `what` names the object ("„a.txt“").
fn map_err(e: smb::Error, what: &str) -> AppError {
    let detail = e.to_string();
    let err = match status_of(&e) {
        Some(status::ACCESS_DENIED) => AppError::new(ErrorKind::PermissionDenied, format!("Kein Zugriff auf {what}.")),
        Some(status::NAME_NOT_FOUND | status::PATH_NOT_FOUND) => AppError::new(ErrorKind::NotFound, format!("{what} gibt es nicht.")),
        Some(status::NAME_COLLISION) => AppError::new(ErrorKind::AlreadyExists, format!("{what} gibt es hier schon.")),
        Some(status::SHARING_VIOLATION) => AppError::other(format!("{what} ist auf dem Server gerade geöffnet.")),
        Some(status::DELETE_PENDING) => AppError::new(ErrorKind::NotFound, format!("{what} wird gerade gelöscht.")),
        Some(status::LOGON_FAILURE) => AppError::new(ErrorKind::AuthFailed, "Benutzername oder Passwort stimmen nicht."),
        Some(status::ACCOUNT_RESTRICTION | status::ACCOUNT_DISABLED) => AppError::new(ErrorKind::AuthFailed, "Das Konto darf sich so nicht anmelden (gesperrt oder ohne Passwort)."),
        Some(status::PASSWORD_EXPIRED) => AppError::new(ErrorKind::AuthFailed, "Das Passwort ist abgelaufen."),
        Some(status::BAD_NETWORK_NAME) => AppError::new(ErrorKind::NotFound, format!("Die Freigabe {what} gibt es auf dem Server nicht.")),
        Some(status::DIRECTORY_NOT_EMPTY) => AppError::other(format!("{what} ist nicht leer.")),
        Some(status::NOT_A_DIRECTORY) => AppError::other(format!("{what} ist kein Ordner.")),
        Some(status::FILE_IS_A_DIRECTORY) => AppError::other(format!("{what} ist ein Ordner.")),
        _ if is_connection_error(&e) => AppError::new(ErrorKind::ConnectionLost, "Die Verbindung zum Server ist abgebrochen."),
        _ => AppError::other(format!("Der Server hat {what} abgelehnt.")),
    };
    err.with_detail(detail)
}

fn io_err(e: std::io::Error) -> AppError {
    AppError::new(ErrorKind::ConnectionLost, "Übertragung über SMB abgebrochen.").with_detail(e.to_string())
}

fn quoted(path: &str) -> String {
    format!("„{}“", remote_name(path))
}

/// "/share/a/b" -> ("share", "a/b"); "/" -> None.
fn split(path: &str) -> Option<(String, String)> {
    let p = path.trim_matches('/');
    if p.is_empty() {
        return None;
    }
    match p.split_once('/') {
        Some((share, rest)) => Some((share.to_string(), rest.to_string())),
        None => Some((p.to_string(), String::new())),
    }
}

fn need_share(path: &str) -> AppResult<(String, String)> {
    split(path).ok_or_else(|| AppError::other("In der Liste der Freigaben lassen sich keine Dateien anlegen oder ändern."))
}

/// Windows file time (100 ns since 1601) -> milliseconds since 1970.
fn to_ms(t: &smb::binrw_util::prelude::FileTime) -> i64 {
    let v = **t;
    if v == 0 {
        return 0;
    }
    (v / 10_000) as i64 - 11_644_473_600_000
}

fn from_secs(secs: u32) -> smb::binrw_util::prelude::FileTime {
    smb::binrw_util::prelude::FileTime::from((secs as u64 + 11_644_473_600) * 10_000_000)
}

fn entry(name: String, dir: bool, size: u64, mtime: i64) -> FileEntry {
    FileEntry {
        name,
        kind: if dir { "dir" } else { "file" }.into(),
        size: if dir { 0 } else { size },
        mtime,
        perms: String::new(),
        owner: String::new(),
        group: String::new(),
        link: None,
        hidden: 0,
    }
}

fn sort(list: &mut [FileEntry]) {
    list.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
}

impl SmbConn {
    fn new_client(params: &SmbParams) -> Client {
        let mut config = ClientConfig::default();
        config.connection.port = Some(params.port);
        config.connection.timeout = Some(Duration::from_secs(20));
        config.connection.allow_unsigned_guest_access = params.user.trim().is_empty();
        if params.encrypt {
            config.connection.encryption_mode = smb::connection::EncryptionMode::Required;
        }
        // DFS links (\\domain\dfs\...) are followed like folders.
        config.dfs = true;
        Client::new(config)
    }

    pub async fn connect(params: SmbParams) -> AppResult<SmbConn> {
        let host = params.host.trim().trim_start_matches('\\').trim_end_matches(['\\', '/']).to_string();
        if host.is_empty() {
            return Err(AppError::other("Bitte einen Servernamen oder eine IP-Adresse angeben."));
        }
        let params = SmbParams { host, share: params.share.trim().trim_matches(['/', '\\']).to_string(), ..params };
        let home = if params.share.is_empty() { "/".to_string() } else { format!("/{}", params.share) };
        let conn = SmbConn { client: Mutex::new(Arc::new(Self::new_client(&params))), shares: Mutex::new(HashSet::new()), params, home };
        // Check the login right away, so wrong passwords show up when connecting.
        if conn.params.share.is_empty() {
            conn.list_shares().await?;
        } else {
            let client = conn.client().await;
            conn.ensure_share(&client, &conn.params.share).await?;
        }
        Ok(conn)
    }

    fn user(&self) -> (&str, String) {
        let user = self.params.user.trim();
        if user.is_empty() {
            ("Guest", String::new())
        } else {
            (user, self.params.password.clone().unwrap_or_default())
        }
    }

    fn unc(&self, share: &str) -> AppResult<UncPath> {
        UncPath::new(&self.params.host)
            .and_then(|u| u.with_share(share))
            .map_err(|e| AppError::other(format!("„{share}“ ist kein gültiger Name einer Freigabe.")).with_detail(e.to_string()))
    }

    async fn client(&self) -> Arc<Client> {
        self.client.lock().await.clone()
    }

    /// Replaces a dead connection with a new one.
    async fn reset(&self) {
        let old = std::mem::replace(&mut *self.client.lock().await, Arc::new(Self::new_client(&self.params)));
        self.shares.lock().await.clear();
        tokio::spawn(async move {
            let _ = old.close().await;
        });
    }

    fn connect_err(&self, e: smb::Error, share: &str) -> AppError {
        if matches!(e, smb::Error::TransportError(_) | smb::Error::IoError(_)) {
            return AppError::new(ErrorKind::Unreachable, format!("{} ist nicht erreichbar (Port {}).", self.params.host, self.params.port)).with_detail(e.to_string());
        }
        map_err(e, &format!("„{share}“"))
    }

    async fn ensure_share(&self, client: &Client, share: &str) -> AppResult<()> {
        if self.shares.lock().await.contains(share) {
            return Ok(());
        }
        let (user, password) = self.user();
        client.share_connect(&self.unc(share)?, user, password).await.map_err(|e| self.connect_err(e, share))?;
        self.shares.lock().await.insert(share.to_string());
        Ok(())
    }

    /// Opens a file or folder; one new attempt after a dropped connection.
    async fn open(&self, path: &str, args: &FileCreateArgs) -> AppResult<Resource> {
        let (share, rest) = need_share(path)?;
        let mut retried = false;
        loop {
            let client = self.client().await;
            let result = match self.ensure_share(&client, &share).await {
                Ok(()) => client.create_file(&self.unc(&share)?.with_path(&rest), args).await,
                Err(e) if e.kind == ErrorKind::Unreachable && !retried => Err(smb::Error::ConnectionStopped),
                Err(e) => return Err(e),
            };
            match result {
                Ok(r) => return Ok(r),
                Err(e) if !retried && is_connection_error(&e) => {
                    retried = true;
                    self.reset().await;
                }
                Err(e) => return Err(map_err(e, &quoted(path))),
            }
        }
    }

    async fn open_dir(&self, path: &str) -> AppResult<Arc<Directory>> {
        let access = DirAccessMask::new().with_list_directory(true).with_read_attributes(true).with_synchronize(true);
        let args = FileCreateArgs { options: CreateOptions::new().with_directory_file(true), ..FileCreateArgs::make_open_existing(access.into()) };
        match self.open(path, &args).await? {
            Resource::Directory(d) => Ok(Arc::new(d)),
            other => {
                close(other).await;
                Err(AppError::other(format!("{} ist kein Ordner.", quoted(path))))
            }
        }
    }

    async fn open_file(&self, path: &str, access: FileAccessMask) -> AppResult<File> {
        let args = FileCreateArgs { options: CreateOptions::new().with_non_directory_file(true), ..FileCreateArgs::make_open_existing(access) };
        match self.open(path, &args).await? {
            Resource::File(f) => Ok(f),
            other => {
                close(other).await;
                Err(AppError::other(format!("{} ist ein Ordner.", quoted(path))))
            }
        }
    }

    async fn list_shares(&self) -> AppResult<Vec<FileEntry>> {
        let mut retried = false;
        loop {
            let client = self.client().await;
            let (user, password) = self.user();
            let result = match client.ipc_connect(&self.params.host, user, password).await {
                Ok(()) => client.list_shares(&self.params.host).await,
                Err(e) => Err(e),
            };
            match result {
                Ok(shares) => {
                    let mut out: Vec<FileEntry> = shares
                        .into_iter()
                        .filter_map(|s| s.netname.as_ref().map(|n| (**n).to_string()))
                        // Administrative and hidden shares (C$, IPC$, print$) stay out of the list.
                        .filter(|n| !n.is_empty() && !n.ends_with('$'))
                        .map(|n| entry(n, true, 0, 0))
                        .collect();
                    sort(&mut out);
                    return Ok(out);
                }
                Err(e) if !retried && matches!(e, smb::Error::ConnectionStopped) => {
                    retried = true;
                    self.reset().await;
                }
                Err(e) if status_of(&e).is_some() || matches!(e, smb::Error::TransportError(_) | smb::Error::IoError(_)) => {
                    let err = self.connect_err(e, "IPC$");
                    if matches!(err.kind, ErrorKind::AuthFailed | ErrorKind::Unreachable) {
                        return Err(err);
                    }
                    return Err(AppError::other("Der Server gibt seine Freigaben nicht heraus. Trage die Freigabe in den Servereinstellungen ein.").with_detail(err.detail.unwrap_or_default()));
                }
                Err(e) => return Err(AppError::other("Der Server gibt seine Freigaben nicht heraus. Trage die Freigabe in den Servereinstellungen ein.").with_detail(e.to_string())),
            }
        }
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        if split(path).is_none() {
            return self.list_shares().await;
        }
        let dir = self.open_dir(path).await?;
        let mut out = Vec::new();
        let result = async {
            let mut stream = Directory::query::<FileIdBothDirectoryInformation>(&dir, "*").await?;
            while let Some(item) = stream.next().await {
                let item = item?;
                let name = item.file_name.to_string();
                if name == "." || name == ".." {
                    continue;
                }
                out.push(entry(name, item.file_attributes.directory(), item.end_of_file, to_ms(&item.last_write_time)));
            }
            Ok::<(), smb::Error>(())
        }
        .await;
        let _ = dir.close().await;
        result.map_err(|e| map_err(e, &quoted(path)))?;
        sort(&mut out);
        Ok(out)
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        let Some((share, rest)) = split(path) else {
            return Ok(entry("/".into(), true, 0, 0));
        };
        let args = FileCreateArgs::make_open_existing(FileAccessMask::new().with_file_read_attributes(true).with_synchronize(true));
        let res = self.open(path, &args).await?;
        let info = match &res {
            Resource::File(f) => f.query_info::<FileNetworkOpenInformation>().await,
            Resource::Directory(d) => d.query_info::<FileNetworkOpenInformation>().await,
            Resource::Pipe(_) => Err(smb::Error::UnsupportedOperation("pipe".into())),
        };
        close(res).await;
        let info = info.map_err(|e| map_err(e, &quoted(path)))?;
        let name = if rest.is_empty() { share } else { remote_name(path) };
        Ok(entry(name, info.file_attributes.directory(), info.end_of_file, to_ms(&info.last_write_time)))
    }

    pub async fn exists(&self, path: &str) -> bool {
        self.stat(path).await.is_ok()
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        let (_, rest) = need_share(path)?;
        if rest.is_empty() {
            return Err(AppError::other("Neue Freigaben lassen sich nur auf dem Server selbst anlegen."));
        }
        let args = FileCreateArgs::make_create_new(FileAttributes::new().with_directory(true), CreateOptions::new().with_directory_file(true));
        close(self.open(path, &args).await?).await;
        Ok(())
    }

    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        let Some((share, rest)) = split(path) else { return Ok(()) };
        let mut current = format!("/{share}");
        for seg in rest.split('/').filter(|s| !s.is_empty()) {
            current = remote_join(&current, seg);
            if !self.exists(&current).await {
                if let Err(e) = self.mkdir(&current).await {
                    if !self.exists(&current).await {
                        return Err(e);
                    }
                }
            }
        }
        Ok(())
    }

    async fn move_to(&self, from: &str, to: &str, replace: bool) -> AppResult<()> {
        let (share_a, rest_a) = need_share(from)?;
        let (share_b, rest_b) = need_share(to)?;
        if rest_a.is_empty() || rest_b.is_empty() {
            return Err(AppError::other("Freigaben lassen sich nur auf dem Server selbst umbenennen."));
        }
        if share_a != share_b {
            return Err(AppError::other("Zwischen zwei Freigaben lässt sich nur kopieren, nicht verschieben."));
        }
        let args = FileCreateArgs::make_open_existing(FileAccessMask::new().with_delete(true).with_file_read_attributes(true).with_synchronize(true));
        let res = self.open(from, &args).await?;
        let info = FileRenameInformation { replace_if_exists: replace.into(), root_directory: 0, file_name: rest_b.replace('/', "\\").as_str().into() };
        let result = match &res {
            Resource::File(f) => f.set_info(info).await,
            Resource::Directory(d) => d.set_info(info).await,
            Resource::Pipe(_) => Err(smb::Error::UnsupportedOperation("pipe".into())),
        };
        close(res).await;
        result.map_err(|e| map_err(e, &quoted(to)))
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        if self.exists(to).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("{} gibt es hier schon.", quoted(to))));
        }
        self.move_to(from, to, false).await
    }

    pub async fn replace(&self, from: &str, to: &str) -> AppResult<()> {
        self.move_to(from, to, true).await
    }

    async fn delete_one(&self, path: &str) -> AppResult<()> {
        let args = FileCreateArgs::make_open_existing(FileAccessMask::new().with_delete(true).with_synchronize(true));
        let res = match self.open(path, &args).await {
            Ok(r) => r,
            Err(e) if e.kind == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        let mark = FileDispositionInformation { delete_pending: true.into() };
        let result = match &res {
            Resource::File(f) => f.set_info(mark).await,
            Resource::Directory(d) => d.set_info(mark).await,
            Resource::Pipe(_) => Err(smb::Error::UnsupportedOperation("pipe".into())),
        };
        close(res).await;
        result.map_err(|e| map_err(e, &quoted(path)))
    }

    /// Deletes a file or a folder with everything in it.
    pub async fn remove(&self, path: &str) -> AppResult<()> {
        let (_, rest) = need_share(path)?;
        if rest.is_empty() {
            return Err(AppError::other("Freigaben lassen sich nur auf dem Server selbst entfernen."));
        }
        let st = match self.stat(path).await {
            Ok(s) => s,
            Err(e) if e.kind == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if st.kind == "dir" {
            // Depth first: a folder can only go once it is empty.
            let mut dirs = vec![path.to_string()];
            let mut order = Vec::new();
            while let Some(dir) = dirs.pop() {
                for e in self.list(&dir).await? {
                    let p = remote_join(&dir, &e.name);
                    if e.kind == "dir" {
                        dirs.push(p);
                    } else {
                        self.delete_one(&p).await?;
                    }
                }
                order.push(dir);
            }
            for dir in order.iter().rev() {
                self.delete_one(dir).await?;
            }
            return Ok(());
        }
        self.delete_one(path).await
    }

    pub async fn walk(&self, path: &str) -> AppResult<Vec<WalkItem>> {
        let base = remote_parent(path);
        let root = self.stat(path).await?;
        let rel = |p: &str| p.strip_prefix(&base).unwrap_or(p).trim_start_matches('/').to_string();
        if root.kind != "dir" {
            return Ok(vec![WalkItem { path: path.to_string(), relative: rel(path), size: root.size, mtime: root.mtime }]);
        }
        let mut out = Vec::new();
        let mut stack = vec![path.to_string()];
        while let Some(dir) = stack.pop() {
            for e in self.list(&dir).await? {
                let p = remote_join(&dir, &e.name);
                if e.kind == "dir" {
                    stack.push(p);
                } else {
                    out.push(WalkItem { relative: rel(&p), path: p, size: e.size, mtime: e.mtime });
                }
            }
        }
        Ok(out)
    }

    /// Copies one file on the server: server-side where the server can
    /// (same share), otherwise through this computer.
    async fn copy_file(&self, from: &str, to: &str) -> AppResult<()> {
        let src = self.open_file(from, FileAccessMask::new().with_generic_read(true)).await?;
        let args = FileCreateArgs { options: CreateOptions::new().with_non_directory_file(true), ..FileCreateArgs::make_create_new(FileAttributes::new(), CreateOptions::new()) };
        let dst = match self.open(to, &args).await? {
            Resource::File(f) => f,
            other => {
                close(other).await;
                let _ = src.close().await;
                return Err(AppError::other(format!("{} lässt sich nicht anlegen.", quoted(to))));
            }
        };
        let mut result = if dst.same_tree(&src) { dst.srv_copy(&src).await.map_err(|e| map_err(e, &quoted(to))) } else { Err(AppError::other("")) };
        if result.is_err() {
            result = async {
                let len = smb::GetLen::get_len(&src).await.map_err(|e| map_err(e, &quoted(from)))?;
                let chunk = self.chunk_size().await as u64;
                let mut buf = vec![0u8; chunk as usize];
                let mut pos = 0u64;
                while pos < len {
                    let n = src.read_block(&mut buf, pos, None, false).await.map_err(io_err)?;
                    if n == 0 {
                        break;
                    }
                    write_all_at(&dst, &buf[..n], pos).await?;
                    pos += n as u64;
                }
                Ok(())
            }
            .await;
        }
        let _ = src.close().await;
        let _ = dst.close().await;
        if result.is_err() {
            let _ = self.delete_one(to).await;
        }
        result
    }

    async fn copy_tree(&self, from: &str, to: &str) -> AppResult<()> {
        if self.stat(from).await?.kind != "dir" {
            return self.copy_file(from, to).await;
        }
        self.mkdir(to).await?;
        for e in self.list(from).await? {
            Box::pin(self.copy_tree(&remote_join(from, &e.name), &remote_join(to, &e.name))).await?;
        }
        Ok(())
    }

    /// Copies on the server, with "Kopie" names on clashes.
    pub async fn copy_within(&self, paths: &[String], dest_dir: &str) -> AppResult<Vec<String>> {
        let mut taken: HashSet<String> = self.list(dest_dir).await?.into_iter().map(|e| e.name).collect();
        let mut out = Vec::new();
        for from in paths {
            if dest_dir == from.as_str() || dest_dir.starts_with(&format!("{from}/")) {
                return Err(AppError::other("Ein Ordner kann nicht in sich selbst kopiert werden."));
            }
            let name = crate::local::copy_name(|n| taken.contains(n), &remote_name(from));
            self.copy_tree(from, &remote_join(dest_dir, &name)).await?;
            taken.insert(name.clone());
            out.push(name);
        }
        Ok(out)
    }

    /// Bytes per request, within what the server allows for reads and writes.
    async fn chunk_size(&self) -> u32 {
        let client = self.client().await;
        let Ok(conn) = client.get_connection(&self.params.host).await else { return 64 * 1024 };
        match conn.conn_info() {
            Some(info) => CHUNK.min(info.negotiation.max_read_size).min(info.negotiation.max_write_size).max(64 * 1024),
            None => 64 * 1024,
        }
    }

    /// Reads a file from `offset`, with several requests in flight.
    pub async fn reader(&self, path: &str, offset: u64) -> AppResult<Box<dyn AsyncRead + Unpin + Send>> {
        let file = OpenFile(Arc::new(self.open_file(path, FileAccessMask::new().with_generic_read(true)).await?));
        let len = smb::GetLen::get_len(&*file.0).await.map_err(|e| map_err(e, &quoted(path)))?;
        let chunk = self.chunk_size().await as u64;
        let (mut w, r) = tokio::io::duplex(2 * chunk as usize);
        tokio::spawn(async move {
            let mut pending = VecDeque::new();
            let mut next = offset;
            loop {
                while pending.len() < IN_FLIGHT && next < len {
                    let f = file.0.clone();
                    let at = next;
                    let n = chunk.min(len - at) as usize;
                    pending.push_back(tokio::spawn(async move {
                        let mut buf = vec![0u8; n];
                        let mut got = 0;
                        while got < n {
                            let k = f.read_block(&mut buf[got..], at + got as u64, None, false).await?;
                            if k == 0 {
                                break;
                            }
                            got += k;
                        }
                        buf.truncate(got);
                        Ok::<Vec<u8>, std::io::Error>(buf)
                    }));
                    next += n as u64;
                }
                let Some(task) = pending.pop_front() else { break };
                match task.await {
                    Ok(Ok(b)) if !b.is_empty() => {
                        if w.write_all(&b).await.is_err() {
                            break; // reader dropped (pause or error)
                        }
                    }
                    // A short read ends the stream; the transfer notices the missing bytes.
                    _ => break,
                }
            }
            for t in pending {
                t.abort();
            }
            let _ = w.shutdown().await;
            file.close().await;
        });
        Ok(Box::new(r))
    }

    /// Writes a file (`offset > 0` continues a partial one). The task returned
    /// finishes the upload; `mtime` (seconds) is set at the end.
    pub async fn writer(&self, path: &str, offset: u64, mtime: Option<u32>) -> AppResult<(Box<dyn AsyncWrite + Unpin + Send>, tokio::task::JoinHandle<AppResult<()>>)> {
        let access = FileAccessMask::new().with_generic_read(true).with_generic_write(true).with_synchronize(true);
        let args = if offset > 0 {
            FileCreateArgs { options: CreateOptions::new().with_non_directory_file(true), ..FileCreateArgs::make_open_existing(access) }
        } else {
            FileCreateArgs { options: CreateOptions::new().with_non_directory_file(true), ..FileCreateArgs::make_overwrite(FileAttributes::new(), CreateOptions::new()) }
        };
        let file = match self.open(path, &args).await? {
            Resource::File(f) => OpenFile(Arc::new(f)),
            other => {
                close(other).await;
                return Err(AppError::other(format!("{} ist ein Ordner.", quoted(path))));
            }
        };
        if offset > 0 {
            smb::resource::SetLen::set_len(&*file.0, offset).await.map_err(|e| map_err(e, &quoted(path)))?;
        }
        let chunk = self.chunk_size().await as usize;
        let (w, mut r) = tokio::io::duplex(2 * chunk);
        let what = quoted(path);
        let task = tokio::spawn(async move {
            let result = async {
                let mut pending: VecDeque<tokio::task::JoinHandle<AppResult<()>>> = VecDeque::new();
                let mut pos = offset;
                let mut eof = false;
                while !eof {
                    // Wait for data, then gather up to one request's worth; a
                    // short pause of the sender sends what is there (so a paused
                    // upload leaves its bytes on the server).
                    let mut buf = vec![0u8; chunk];
                    let mut filled = r.read(&mut buf).await.map_err(io_err)?;
                    eof = filled == 0;
                    while !eof && filled < chunk {
                        match tokio::time::timeout(Duration::from_millis(30), r.read(&mut buf[filled..])).await {
                            Ok(Ok(0)) => eof = true,
                            Ok(Ok(n)) => filled += n,
                            Ok(Err(e)) => return Err(io_err(e)),
                            Err(_) => break,
                        }
                    }
                    if filled == 0 {
                        break;
                    }
                    buf.truncate(filled);
                    let f = file.0.clone();
                    let at = pos;
                    pending.push_back(tokio::spawn(async move { write_all_at(&f, &buf, at).await }));
                    pos += filled as u64;
                    while pending.len() >= IN_FLIGHT {
                        join(pending.pop_front().expect("pending")).await?;
                    }
                }
                while let Some(t) = pending.pop_front() {
                    join(t).await?;
                }
                if let Some(m) = mtime {
                    let _ = file.0.set_info(basic_times(m)).await;
                }
                Ok::<(), AppError>(())
            }
            .await;
            let closed = file.0.close().await;
            result?;
            closed.map_err(|e| map_err(e, &what))
        });
        Ok((Box::new(w), task))
    }

    /// Modification time after an upload or copy.
    pub async fn set_mtime(&self, path: &str, mtime: u32) {
        let Ok(f) = self.open_file(path, FileAccessMask::new().with_file_write_attributes(true).with_synchronize(true)).await else { return };
        let _ = f.set_info(basic_times(mtime)).await;
        let _ = f.close().await;
    }

    pub async fn close(&self) {
        let _ = self.client().await.close().await;
    }
}

/// New modification (and access) time; zero fields stay as they are.
fn basic_times(secs: u32) -> FileBasicInformation {
    let t = from_secs(secs);
    let keep = smb::binrw_util::prelude::FileTime::ZERO;
    FileBasicInformation { creation_time: keep, last_access_time: t, last_write_time: t, change_time: keep, file_attributes: FileAttributes::new() }
}

async fn join(t: tokio::task::JoinHandle<AppResult<()>>) -> AppResult<()> {
    t.await.map_err(|e| AppError::other("Hochladen abgebrochen.").with_detail(e.to_string()))?
}

/// An open server file that is closed when the transfer ends, also when the
/// transfer task is cancelled (pause): a handle left open would block the
/// file for the next attempt.
struct OpenFile(Arc<File>);

impl OpenFile {
    async fn close(self) {
        let _ = self.0.close().await;
    }
}

impl Drop for OpenFile {
    fn drop(&mut self) {
        let f = self.0.clone();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                // Requests still under way (the last pieces of a paused
                // upload) finish first, so their bytes count for resuming.
                for _ in 0..1500 {
                    if Arc::strong_count(&f) <= 1 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                let _ = f.close().await;
            });
        }
    }
}

async fn write_all_at(f: &File, buf: &[u8], at: u64) -> AppResult<()> {
    let mut done = 0;
    while done < buf.len() {
        let n = f.write_block(&buf[done..], at + done as u64, None).await.map_err(io_err)?;
        if n == 0 {
            return Err(AppError::new(ErrorKind::ConnectionLost, "Der Server hat nichts mehr angenommen (Speicher voll?)."));
        }
        done += n;
    }
    Ok(())
}

async fn close(r: Resource) {
    let _ = match r {
        Resource::File(f) => f.close().await,
        Resource::Directory(d) => d.close().await,
        Resource::Pipe(p) => p.close().await,
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_paths_into_share_and_rest() {
        assert_eq!(split("/"), None);
        assert_eq!(split("/daten"), Some(("daten".into(), String::new())));
        assert_eq!(split("/daten/a b/c.txt"), Some(("daten".into(), "a b/c.txt".into())));
    }

    #[test]
    fn converts_file_times() {
        let t = from_secs(1_793_102_400);
        assert_eq!(to_ms(&t), 1_793_102_400_000);
        assert_eq!(to_ms(&smb::binrw_util::prelude::FileTime::ZERO), 0);
    }
}

/// Test server from `BITCRANE_TEST_SMB=host:port/share/user/password`.
#[cfg(test)]
pub fn test_params() -> Option<SmbParams> {
    let v = std::env::var("BITCRANE_TEST_SMB").ok()?;
    let mut it = v.split('/');
    let (host, port) = it.next()?.split_once(':')?;
    Some(SmbParams { host: host.into(), port: port.parse().ok()?, share: it.next()?.into(), user: it.next()?.into(), password: Some(it.next()?.into()), encrypt: false })
}

/// Integration test against an SMB server: `BITCRANE_TEST_SMB=host:port/share/user/password`.
#[cfg(test)]
mod integration {
    use super::*;

    #[tokio::test]
    async fn smb_round_trip() {
        let Some(p) = super::test_params() else { return };
        let wrong = SmbConn::connect(SmbParams { password: Some("falsch".into()), ..p.clone() }).await;
        assert_eq!(wrong.err().map(|e| e.kind), Some(ErrorKind::AuthFailed));
        let conn = SmbConn::connect(p.clone()).await.unwrap();
        assert_eq!(conn.home, format!("/{}", p.share));
        let base = format!("/{}/bitcrane-smb-{}", p.share, uuid::Uuid::new_v4().simple());
        conn.mkdir_all(&format!("{base}/a b")).await.unwrap();
        let file = format!("{base}/a b/über.txt");
        let (mut w, task) = conn.writer(&file, 0, Some(1_793_102_400)).await.unwrap();
        w.write_all(b"hallo welt!").await.unwrap();
        w.shutdown().await.unwrap();
        drop(w);
        task.await.unwrap().unwrap();
        let st = conn.stat(&file).await.unwrap();
        assert_eq!((st.size, st.name.as_str(), st.mtime), (11, "über.txt", 1_793_102_400_000));
        let mut r = conn.reader(&file, 6).await.unwrap();
        let mut got = String::new();
        r.read_to_string(&mut got).await.unwrap();
        assert_eq!(got, "welt!");
        assert_eq!(conn.copy_within(&[file.clone()], &format!("{base}/a b")).await.unwrap(), vec!["über Kopie.txt".to_string()]);
        assert_eq!(conn.rename(&file, &format!("{base}/a b/über Kopie.txt")).await.err().map(|e| e.kind), Some(ErrorKind::AlreadyExists));
        conn.rename(&file, &format!("{base}/neu.txt")).await.unwrap();
        assert_eq!(conn.walk(&base).await.unwrap().len(), 2);
        assert_eq!(conn.stat(&format!("{base}/fehlt")).await.err().map(|e| e.kind), Some(ErrorKind::NotFound));
        conn.remove(&base).await.unwrap();
        assert!(!conn.exists(&base).await);
        // A dropped connection is replaced on the next request.
        conn.reset().await;
        assert!(conn.list(&conn.home).await.is_ok());
    }
}

