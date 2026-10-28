//! One interface for all server protocols: SFTP, FTP/FTPS and WebDAV.
//!
//! The commands in `lib.rs` and the transfers in `transfer.rs` only talk to
//! `Remote`; what a protocol cannot do (commands on the server over FTP,
//! permissions over WebDAV, ...) comes back as a clear error.

use crate::dav::DavConn;
use crate::error::{AppError, AppResult, ErrorKind};
use crate::ftp::{FtpConn, FtpFinish, Io};
use crate::model::{FileEntry, WalkItem};
use crate::paths::{remote_join, remote_name};
use crate::ssh::Connection;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

pub enum Remote {
    Sftp(Connection),
    Ftp(Arc<FtpConn>),
    Dav(DavConn),
}

/// Size, modification time (seconds) and permission bits of a server file.
pub struct Meta {
    pub size: u64,
    pub mtime: Option<u32>,
    pub perms: Option<u32>,
}

fn unsupported(what: &str, protocol: &str) -> AppError {
    AppError::new(ErrorKind::Other, format!("{what} geht über {protocol} nicht."))
}

impl Remote {
    pub fn home(&self) -> &str {
        match self {
            Remote::Sftp(c) => &c.home,
            Remote::Ftp(c) => &c.home,
            Remote::Dav(c) => &c.home,
        }
    }

    pub fn protocol(&self) -> &'static str {
        match self {
            Remote::Sftp(_) => "SFTP",
            Remote::Ftp(_) => "FTP",
            Remote::Dav(_) => "WebDAV",
        }
    }

    /// Only SSH sessions can die for good; FTP and WebDAV reconnect per request.
    pub fn is_closed(&self) -> bool {
        match self {
            Remote::Sftp(c) => c.is_closed(),
            _ => false,
        }
    }

    pub async fn close(&self) {
        match self {
            Remote::Sftp(c) => c.close().await,
            Remote::Ftp(c) => c.close().await,
            Remote::Dav(_) => {}
        }
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        let mut list = match self {
            Remote::Sftp(c) => c.list(path).await,
            Remote::Ftp(c) => c.list(path).await,
            Remote::Dav(c) => c.list(path).await,
        }?;
        list.retain(|e| safe_name(&e.name));
        Ok(list)
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        match self {
            Remote::Sftp(c) => c.stat(path).await,
            Remote::Ftp(c) => c.stat(path).await,
            Remote::Dav(c) => c.stat(path).await,
        }
    }

    pub async fn exists(&self, path: &str) -> bool {
        match self {
            Remote::Sftp(c) => c.exists(path).await,
            Remote::Ftp(c) => c.exists(path).await,
            Remote::Dav(c) => c.exists(path).await,
        }
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        match self {
            Remote::Sftp(c) => c.mkdir(path).await,
            Remote::Ftp(c) => c.mkdir(path).await,
            Remote::Dav(c) => c.mkdir(path).await,
        }
    }

    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        self.mkdir_all_with(path, None).await
    }

    pub async fn mkdir_all_with(&self, path: &str, perms: Option<u32>) -> AppResult<()> {
        match self {
            Remote::Sftp(c) => c.mkdir_all_with(path, perms).await,
            Remote::Ftp(c) => {
                c.mkdir_all(path).await?;
                if let Some(p) = perms {
                    let _ = c.chmod(path, p, false).await;
                }
                Ok(())
            }
            Remote::Dav(c) => c.mkdir_all(path).await,
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        match self {
            Remote::Sftp(c) => c.rename(from, to).await,
            Remote::Ftp(c) => c.rename(from, to).await,
            Remote::Dav(c) => c.rename(from, to).await,
        }
    }

    /// Puts `from` in place of `to`. SFTP and FTP cannot overwrite in one
    /// step, so the old file is first renamed aside and only deleted once the
    /// new one is in place; if that fails, the old file is put back.
    pub async fn replace(&self, from: &str, to: &str) -> AppResult<()> {
        if let Remote::Dav(c) = self {
            return c.replace(from, to).await;
        }
        if !self.exists(to).await {
            return self.rename(from, to).await;
        }
        let aside = crate::paths::remote_join(&crate::paths::remote_parent(to), &format!(".{}.bitcrane-old", remote_name(to)));
        if self.exists(&aside).await {
            self.remove_file(&aside).await?;
        }
        self.rename(to, &aside).await?;
        if let Err(e) = self.rename(from, to).await {
            let _ = self.rename(&aside, to).await;
            return Err(e);
        }
        let _ = self.remove_file(&aside).await;
        Ok(())
    }

    pub async fn remove(&self, path: &str) -> AppResult<()> {
        match self {
            Remote::Sftp(c) => c.remove(path).await,
            Remote::Ftp(c) => c.remove(path).await,
            Remote::Dav(c) => c.remove(path).await,
        }
    }

    pub async fn remove_file(&self, path: &str) -> AppResult<()> {
        match self {
            Remote::Sftp(c) => c.sftp.remove_file(path).await.map_err(AppError::from),
            Remote::Ftp(c) => c.remove_file(path).await,
            Remote::Dav(c) => c.remove(path).await,
        }
    }

    pub async fn chmod(&self, path: &str, mode: u32, recursive: bool) -> AppResult<()> {
        match self {
            Remote::Sftp(c) => c.chmod(path, mode, recursive).await,
            Remote::Ftp(c) => c.chmod(path, mode, recursive).await,
            Remote::Dav(_) => Err(unsupported("Rechte setzen", "WebDAV")),
        }
    }

    pub async fn walk(&self, path: &str) -> AppResult<Vec<WalkItem>> {
        let mut items = match self {
            Remote::Sftp(c) => c.walk(path).await,
            Remote::Ftp(c) => c.walk(path).await,
            Remote::Dav(c) => c.walk(path).await,
        }?;
        items.retain(|i| i.relative.split('/').all(safe_name));
        Ok(items)
    }

    pub async fn exec(&self, command: &str) -> AppResult<(u32, String)> {
        match self {
            Remote::Sftp(c) => c.exec(command).await,
            _ => Err(AppError::new(ErrorKind::Other, format!("Befehle auf dem Server gibt es nur mit SFTP (SSH), nicht über {}.", self.protocol()))),
        }
    }

    pub async fn symlink(&self, link: &str, target: &str) -> AppResult<()> {
        match self {
            Remote::Sftp(c) => c.symlink(link, target).await,
            _ => Err(unsupported("Symbolische Links anlegen", self.protocol())),
        }
    }

    pub async fn clock_offset_ms(&self) -> Option<i64> {
        match self {
            Remote::Sftp(c) => c.clock_offset_ms().await,
            _ => None,
        }
    }

    pub async fn read_head(&self, path: &str, max: usize) -> AppResult<Vec<u8>> {
        match self {
            Remote::Sftp(c) => c.read_head(path, max).await,
            _ => {
                let r = self.reader(path, 0).await?;
                let mut buf = Vec::new();
                let mut limited = r.take(max as u64);
                limited.read_to_end(&mut buf).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Lesen vom Server fehlgeschlagen.").with_detail(e.to_string()))?;
                let _ = limited.into_inner().close(false).await;
                Ok(buf)
            }
        }
    }

    pub async fn checksum(&self, path: &str) -> AppResult<String> {
        match self {
            Remote::Sftp(c) => c.checksum(path).await,
            _ => {
                use sha2::{Digest, Sha256};
                let mut r = self.reader(path, 0).await?;
                let mut h = Sha256::new();
                let mut buf = vec![0u8; 256 * 1024];
                loop {
                    let n = r.read(&mut buf).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Lesen vom Server fehlgeschlagen.").with_detail(e.to_string()))?;
                    if n == 0 {
                        break;
                    }
                    h.update(&buf[..n]);
                }
                r.close(true).await?;
                Ok(format!("{:x}", h.finalize()))
            }
        }
    }

    /// Copies on the server: `cp` over SSH, COPY over WebDAV, through this
    /// computer over FTP (FTP has no copy command).
    pub async fn copy_within(&self, paths: &[String], dest_dir: &str) -> AppResult<Vec<String>> {
        match self {
            Remote::Sftp(c) => c.copy_within(paths, dest_dir).await,
            Remote::Dav(c) => c.copy_within(paths, dest_dir).await,
            Remote::Ftp(_) => {
                let mut taken: std::collections::HashSet<String> = self.list(dest_dir).await?.into_iter().map(|e| e.name).collect();
                let mut out = Vec::new();
                for from in paths {
                    if dest_dir == from.as_str() || dest_dir.starts_with(&format!("{from}/")) {
                        return Err(AppError::other("Ein Ordner kann nicht in sich selbst kopiert werden."));
                    }
                    let name = crate::local::copy_name(|n| taken.contains(n), &remote_name(from));
                    Box::pin(self.copy_through(from, &remote_join(dest_dir, &name))).await?;
                    taken.insert(name.clone());
                    out.push(name);
                }
                Ok(out)
            }
        }
    }

    async fn copy_through(&self, from: &str, to: &str) -> AppResult<()> {
        let e = self.stat(from).await?;
        if e.kind == "dir" {
            self.mkdir(to).await?;
            for c in self.list(from).await? {
                Box::pin(self.copy_through(&remote_join(from, &c.name), &remote_join(to, &c.name))).await?;
            }
            return Ok(());
        }
        let mut r = self.reader(from, 0).await?;
        let mut w = self.writer(to, 0, Some(e.size), None).await?;
        let copied = tokio::io::copy(&mut r, &mut w).await;
        let closed = r.close(copied.is_ok()).await;
        match copied {
            Ok(_) => match closed {
                Ok(()) => w.close().await,
                Err(e) => {
                    w.abort();
                    Err(e)
                }
            },
            Err(e) => {
                w.abort();
                Err(AppError::new(ErrorKind::ConnectionLost, "Kopieren auf dem Server fehlgeschlagen.").with_detail(e.to_string()))
            }
        }
    }

    /* ----------------------------------------------------------- Transfers */

    pub async fn meta(&self, path: &str) -> Option<Meta> {
        match self {
            Remote::Sftp(c) => c.sftp.metadata(path).await.ok().map(|a| Meta { size: a.size.unwrap_or(0), mtime: a.mtime, perms: a.permissions }),
            _ => self.stat(path).await.ok().filter(|e| e.kind == "file").map(|e| Meta {
                size: e.size,
                mtime: (e.mtime > 0).then(|| (e.mtime / 1000) as u32),
                perms: u32::from_str_radix(&e.perms, 8).ok(),
            }),
        }
    }

    /// Seconds a server time may lag behind: FTP listings without MLST only
    /// show minutes, so a just-written file can look up to a minute older.
    pub fn mtime_slack(&self) -> u32 {
        match self {
            Remote::Sftp(_) => 0,
            _ => 60,
        }
    }

    /// Whether a partial upload can be continued (append) for this file.
    pub fn can_append(&self, path: &str) -> bool {
        match self {
            Remote::Sftp(_) => true,
            Remote::Ftp(c) => c.binary_for(path),
            Remote::Dav(_) => false,
        }
    }

    /// Whether a download can start in the middle of the file.
    pub fn can_seek(&self, path: &str) -> bool {
        match self {
            Remote::Ftp(c) => c.binary_for(path),
            _ => true,
        }
    }

    pub async fn reader(&self, path: &str, offset: u64) -> AppResult<RemoteReader> {
        Ok(match self {
            Remote::Sftp(c) => {
                use tokio::io::AsyncSeekExt;
                let mut f = c.sftp.open(path).await?;
                if offset > 0 {
                    f.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Lesen vom Server fehlgeschlagen.").with_detail(e.to_string()))?;
                }
                RemoteReader::Plain(Box::new(f))
            }
            Remote::Ftp(c) => {
                let (io, fin) = c.reader(path, offset).await?;
                RemoteReader::Ftp(io, Some(fin))
            }
            Remote::Dav(c) => RemoteReader::Plain(c.reader(path, offset).await?),
        })
    }

    /// Opens a file for writing. `offset > 0` appends to a partial file.
    pub async fn writer(&self, path: &str, offset: u64, size: Option<u64>, mtime: Option<u32>) -> AppResult<RemoteWriter> {
        Ok(match self {
            Remote::Sftp(c) => {
                use russh_sftp::protocol::OpenFlags;
                use tokio::io::AsyncSeekExt;
                let f = if offset > 0 {
                    let mut f = c.sftp.open_with_flags(path, OpenFlags::WRITE).await?;
                    f.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Schreiben auf dem Server fehlgeschlagen.").with_detail(e.to_string()))?;
                    f
                } else {
                    c.sftp.open_with_flags(path, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE).await?
                };
                RemoteWriter::Plain(Box::new(f))
            }
            Remote::Ftp(c) => {
                let (io, fin) = c.writer(path, offset > 0).await?;
                RemoteWriter::Ftp(Some(io), Some(fin))
            }
            Remote::Dav(c) => {
                let (w, task) = c.writer(path, size.map(|s| s - offset), mtime);
                RemoteWriter::Dav(Some(w), Some(task))
            }
        })
    }

    /// Modification time and permissions after an upload, where possible.
    pub async fn set_attrs(&self, path: &str, mtime: Option<u32>, perms: Option<u32>) {
        match self {
            Remote::Sftp(c) => {
                let attrs = russh_sftp::protocol::FileAttributes { atime: mtime, mtime, permissions: perms, ..Default::default() };
                let _ = c.sftp.set_metadata(path, attrs).await;
            }
            Remote::Ftp(c) => c.set_attrs(path, mtime, perms).await,
            // Set with the upload itself where the server supports it.
            Remote::Dav(_) => {}
        }
    }
}

/* ----------------------------------------------------------- Streams */

pub enum RemoteReader {
    Plain(Box<dyn AsyncRead + Unpin + Send>),
    Ftp(Io, Option<FtpFinish>),
}

impl RemoteReader {
    /// Ends reading. `complete`: the whole file was read (FTP then waits for
    /// the server's confirmation and reuses the session).
    /// The server's confirmation is the only end-of-file signal FTP has, so its
    /// error (426/451 after an aborted transfer) is passed on.
    pub async fn close(self, complete: bool) -> AppResult<()> {
        if let RemoteReader::Ftp(io, fin) = self {
            drop(io);
            if let Some(f) = fin {
                if complete {
                    return f.finish().await;
                }
                f.abandon();
            }
        }
        Ok(())
    }
}

impl AsyncRead for RemoteReader {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            RemoteReader::Plain(r) => Pin::new(r).poll_read(cx, buf),
            RemoteReader::Ftp(io, _) => Pin::new(io).poll_read(cx, buf),
        }
    }
}

pub enum RemoteWriter {
    Plain(Box<dyn AsyncWrite + Unpin + Send>),
    Ftp(Option<Io>, Option<FtpFinish>),
    Dav(Option<Box<dyn AsyncWrite + Unpin + Send>>, Option<tokio::task::JoinHandle<AppResult<()>>>),
}

impl RemoteWriter {
    /// Completes the file on the server.
    pub async fn close(mut self) -> AppResult<()> {
        let done = |e: std::io::Error| AppError::new(ErrorKind::ConnectionLost, "Datei konnte nicht abgeschlossen werden.").with_detail(e.to_string());
        match &mut self {
            RemoteWriter::Plain(w) => w.shutdown().await.map_err(done),
            RemoteWriter::Ftp(io, fin) => {
                crate::ftp::close_data(io.take().expect("open")).await?;
                fin.take().expect("open").finish().await
            }
            RemoteWriter::Dav(w, task) => {
                let mut w = w.take().expect("open");
                w.shutdown().await.map_err(done)?;
                drop(w);
                task.take().expect("open").await.map_err(|e| AppError::other("Hochladen abgebrochen.").with_detail(e.to_string()))?
            }
        }
    }

    /// Stops writing without completing (pause or error).
    pub fn abort(mut self) {
        match &mut self {
            RemoteWriter::Plain(_) => {}
            RemoteWriter::Ftp(io, fin) => {
                io.take();
                if let Some(f) = fin.take() {
                    f.abandon();
                }
            }
            RemoteWriter::Dav(w, task) => {
                w.take();
                if let Some(t) = task.take() {
                    t.abort();
                }
            }
        }
    }
}

impl AsyncWrite for RemoteWriter {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            RemoteWriter::Plain(w) => Pin::new(w).poll_write(cx, buf),
            RemoteWriter::Ftp(Some(io), _) => Pin::new(io).poll_write(cx, buf),
            RemoteWriter::Dav(Some(w), _) => Pin::new(w).poll_write(cx, buf),
            _ => Poll::Ready(Err(std::io::Error::other("closed"))),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            RemoteWriter::Plain(w) => Pin::new(w).poll_flush(cx),
            RemoteWriter::Ftp(Some(io), _) => Pin::new(io).poll_flush(cx),
            RemoteWriter::Dav(Some(w), _) => Pin::new(w).poll_flush(cx),
            _ => Poll::Ready(Ok(())),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            RemoteWriter::Plain(w) => Pin::new(w).poll_shutdown(cx),
            RemoteWriter::Ftp(Some(io), _) => Pin::new(io).poll_shutdown(cx),
            RemoteWriter::Dav(Some(w), _) => Pin::new(w).poll_shutdown(cx),
            _ => Poll::Ready(Ok(())),
        }
    }
}

/// Transfers through `transfer.rs` over FTP(S) and WebDAV (needs the same
/// test servers as the protocol tests).
#[cfg(test)]
mod integration {
    use super::*;
    use crate::transfer::{TransferOptions, PAUSE, RUN};
    use std::sync::atomic::AtomicU8;

    async fn check(conn: Remote, home: String) {
        let dir = tempfile::tempdir().unwrap();
        let data: Vec<u8> = (0..1_500_000u32).map(|i| (i % 251) as u8).collect();
        let local = dir.path().join("big.bin");
        std::fs::write(&local, &data).unwrap();
        let local_ui = local.to_string_lossy().replace('\\', "/");
        let base = remote_join(&home, &format!("bitcrane-tr-{}", uuid::Uuid::new_v4().simple()));
        let target = format!("{base}/sub/big.bin");

        // Paused upload, then continued (where the protocol can append).
        let flag = Arc::new(AtomicU8::new(RUN));
        let f2 = flag.clone();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            f2.store(PAUSE, std::sync::atomic::Ordering::Relaxed);
        });
        let slow = TransferOptions { limit_kbps: 1024, ..Default::default() };
        let paused = crate::transfer::upload(&conn, &local_ui, &target, &slow, &|_, _| {}, flag).await;
        stopper.await.unwrap();
        assert_eq!(paused.err().map(|e| e.kind), Some(ErrorKind::Cancelled), "{}", conn.protocol());
        let first = std::sync::Mutex::new(None);
        let seen = |d: u64, _t: u64| { first.lock().unwrap().get_or_insert(d); };
        crate::transfer::upload(&conn, &local_ui, &target, &TransferOptions::default(), &seen, Arc::new(AtomicU8::new(RUN))).await.unwrap();
        let resumed_at = first.lock().unwrap().unwrap();
        if conn.can_append(&target) {
            assert!(resumed_at > 0, "{}: continued", conn.protocol());
        }
        assert_eq!(conn.stat(&target).await.unwrap().size, 1_500_000);
        assert!(!conn.exists(&crate::transfer::temp_name(&target)).await, "no partial file left");

        let back = dir.path().join("back.bin");
        crate::transfer::download(&conn, &target, &back.to_string_lossy().replace('\\', "/"), &TransferOptions::default(), &|_, _| {}, Arc::new(AtomicU8::new(RUN))).await.unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), data, "{}", conn.protocol());
        assert_eq!(conn.read_head(&target, 10).await.unwrap(), data[..10].to_vec());
        let local_sum = crate::local::checksum(&local_ui).unwrap();
        assert_eq!(conn.checksum(&target).await.unwrap(), local_sum);
        assert_eq!(conn.copy_within(&[target.clone()], &format!("{base}/sub")).await.unwrap(), vec!["big Kopie.bin".to_string()]);
        assert_eq!(conn.stat(&format!("{base}/sub/big Kopie.bin")).await.unwrap().size, 1_500_000);
        assert!(conn.exec("true").await.is_err());
        conn.remove(&base).await.unwrap();
    }

    #[tokio::test]
    async fn transfers_over_ftp_and_dav() {
        let dir = tempfile::tempdir().unwrap();
        let known = Arc::new(crate::ssh::KnownHosts::load(dir.path().join("known.json")));
        if let Ok(v) = std::env::var("BITCRANE_TEST_FTP") {
            let (host, ports) = v.split_once(':').unwrap();
            for (port, tls) in ports.split(',').map(|p| p.parse::<u16>().unwrap()).zip(["none", "explicit", "implicit"]) {
                let mut p = crate::ftp::FtpParams {
                    host: host.into(), port, user: "test".into(), password: Some("geheim123".into()), tls: tls.into(), tls13_only: false,
                    encoding: "utf8".into(), tz_offset_min: 0, mode: "binary".into(), trust: None, proxy: None,
                };
                let c = match FtpConn::connect(p.clone(), known.clone()).await {
                    Ok(c) => c,
                    Err(e) => {
                        p.trust = Some(e.host_key.expect("certificate").fingerprint);
                        FtpConn::connect(p, known.clone()).await.unwrap()
                    }
                };
                let home = c.home.clone();
                check(Remote::Ftp(Arc::new(c)), home).await;
            }
        }
        if let Ok(urls) = std::env::var("BITCRANE_TEST_DAV") {
            for url in urls.split(',') {
                let mut p = crate::dav::DavParams { url: url.into(), user: "test".into(), password: Some("geheim123".into()), tls13_only: false, trust: None, proxy: None };
                let c = match DavConn::connect(p.clone(), known.clone()).await {
                    Ok(c) => c,
                    Err(e) => {
                        p.trust = Some(e.host_key.expect("certificate").fingerprint);
                        DavConn::connect(p, known.clone()).await.unwrap()
                    }
                };
                check(Remote::Dav(c), "/".into()).await;
            }
        }
    }

    /// Server to server: FTP -> WebDAV and back, through this computer.
    #[tokio::test]
    async fn copies_between_two_servers() {
        let (Ok(ftp), Ok(dav)) = (std::env::var("BITCRANE_TEST_FTP"), std::env::var("BITCRANE_TEST_DAV")) else { return };
        let dir = tempfile::tempdir().unwrap();
        let known = Arc::new(crate::ssh::KnownHosts::load(dir.path().join("known.json")));
        let (host, ports) = ftp.split_once(':').unwrap();
        let port: u16 = ports.split(',').next().unwrap().parse().unwrap();
        let f = FtpConn::connect(
            crate::ftp::FtpParams {
                host: host.into(), port, user: "test".into(), password: Some("geheim123".into()), tls: "none".into(), tls13_only: false,
                encoding: "utf8".into(), tz_offset_min: 0, mode: "binary".into(), trust: None, proxy: None,
            },
            known.clone(),
        )
        .await
        .unwrap();
        let ftp_home = f.home.clone();
        let ftp = Remote::Ftp(Arc::new(f));
        let url = dav.split(',').find(|u| u.starts_with("http://")).unwrap();
        let dav = Remote::Dav(DavConn::connect(crate::dav::DavParams { url: url.into(), user: "test".into(), password: Some("geheim123".into()), tls13_only: false, trust: None, proxy: None }, known).await.unwrap());

        let data: Vec<u8> = (0..700_000u32).map(|i| (i % 241) as u8).collect();
        let local = dir.path().join("x.bin");
        std::fs::write(&local, &data).unwrap();
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let on_ftp = remote_join(&ftp_home, &format!("bitcrane-x-{tag}.bin"));
        let on_dav = format!("/bitcrane-x-{tag}/copy.bin");
        let run = || Arc::new(AtomicU8::new(RUN));
        crate::transfer::upload(&ftp, &local.to_string_lossy(), &on_ftp, &TransferOptions::default(), &|_, _| {}, run()).await.unwrap();
        let n = crate::transfer::cross(&ftp, &on_ftp, &dav, &on_dav, &TransferOptions::default(), &|_, _| {}, run()).await.unwrap();
        assert_eq!(n, 700_000);
        assert_eq!(dav.stat(&on_dav).await.unwrap().size, 700_000);
        // And back again, replacing the original.
        crate::transfer::cross(&dav, &on_dav, &ftp, &on_ftp, &TransferOptions::default(), &|_, _| {}, run()).await.unwrap();
        let back = dir.path().join("back.bin");
        crate::transfer::download(&ftp, &on_ftp, &back.to_string_lossy(), &TransferOptions::default(), &|_, _| {}, run()).await.unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), data);
        ftp.remove(&on_ftp).await.unwrap();
        dav.remove(&crate::paths::remote_parent(&on_dav)).await.unwrap();
    }
}

/// False for names a server must not be able to send: they would leave the
/// target folder when a download writes them to this computer ("..", "a/../b",
/// on Windows also "..\x" or "C:x").
pub fn safe_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
        return false;
    }
    !(cfg!(windows) && name.contains(['\\', ':']))
}

#[cfg(test)]
mod name_tests {
    use super::safe_name;

    #[test]
    fn rejects_names_that_leave_the_folder() {
        assert!(safe_name("bot.py"));
        assert!(safe_name(".env"));
        assert!(safe_name("..hidden"));
        assert!(!safe_name(""));
        assert!(!safe_name(".."));
        assert!(!safe_name("../../.ssh/authorized_keys"));
        assert!(!safe_name("a\0b"));
    }
}
