//! File transfers (SFTP, FTP, WebDAV) with progress reporting, pause/cancel and resume.
//!
//! Uploads are written under a temporary name (`.name.bitcrane-part`) and
//! renamed only when complete, so the server never sees a half-written file
//! (important for running bots that reload on change). A paused or broken
//! transfer keeps its partial file, so it can continue where it stopped.
//! Optional: keep the original modification time, set permissions after the
//! upload, keep older versions of replaced files, limit the speed.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::paths::{remote_join, remote_name, remote_parent, to_native};
use crate::remote::Remote;
use serde::Deserialize;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const CHUNK: usize = 256 * 1024;
const REPORT_EVERY: Duration = Duration::from_millis(120);
/// Folder next to a replaced file that holds its older versions.
pub const VERSIONS_DIR: &str = ".bitcrane-versions";

/// Progress callback: (bytes done, total bytes).
pub type Progress<'a> = &'a (dyn Fn(u64, u64) + Send + Sync);

/// Control flag of a running transfer.
pub const RUN: u8 = 0;
/// Stop and keep the partial file (pause, or app quits).
pub const PAUSE: u8 = 1;
/// Stop and delete the partial file (user removed the transfer).
pub const DISCARD: u8 = 2;

/// Options chosen in the settings or by a folder watch.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransferOptions {
    /// Write under a temporary name first ("Erst unter einem Zwischennamen hochladen").
    pub temp_name: bool,
    /// Keep the modification time of the source.
    pub keep_mtime: bool,
    /// Continue a partial file from an earlier attempt.
    pub resume: bool,
    /// Permissions for the uploaded file (e.g. 0o644); otherwise keep existing ones.
    pub file_perms: Option<u32>,
    /// Permissions for folders created on the server (e.g. 0o755).
    pub dir_perms: Option<u32>,
    /// Keep this many older versions of a replaced file (0 = off).
    pub keep_versions: u32,
    /// Speed limit in KB/s for this transfer (0 = unlimited).
    pub limit_kbps: u64,
}

impl Default for TransferOptions {
    fn default() -> Self {
        Self { temp_name: true, keep_mtime: true, resume: true, file_perms: None, dir_perms: None, keep_versions: 0, limit_kbps: 0 }
    }
}

fn stopped(flag: &AtomicU8) -> Option<AppError> {
    match flag.load(Ordering::Relaxed) {
        RUN => None,
        _ => Some(AppError::new(ErrorKind::Cancelled, "Abgebrochen.")),
    }
}

/// Name of the partial file of an upload.
pub fn temp_name(path: &str) -> String {
    remote_join(&remote_parent(path), &format!(".{}.bitcrane-part", remote_name(path)))
}

/// Name of the partial file of a download.
pub fn local_temp(native: &std::path::Path) -> std::path::PathBuf {
    native.with_file_name(format!(".{}.bitcrane-part", native.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
}

/// Waits so the transfer stays below the speed limit.
struct Throttle {
    limit: u64,
    start: Instant,
    bytes: u64,
}

impl Throttle {
    fn new(limit_kbps: u64) -> Self {
        Self { limit: limit_kbps * 1024, start: Instant::now(), bytes: 0 }
    }

    async fn add(&mut self, n: usize) {
        if self.limit == 0 {
            return;
        }
        self.bytes += n as u64;
        let should_take = Duration::from_secs_f64(self.bytes as f64 / self.limit as f64);
        let elapsed = self.start.elapsed();
        if should_take > elapsed {
            tokio::time::sleep(should_take - elapsed).await;
        }
    }
}

fn write_err(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::ConnectionLost, "Schreiben auf dem Server fehlgeschlagen.").with_detail(e.to_string())
}

fn read_err(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::ConnectionLost, "Lesen vom Server fehlgeschlagen.").with_detail(e.to_string())
}

/// Moves the current server file into the versions folder and keeps only the
/// newest `keep` versions there.
async fn keep_old_version(conn: &Remote, remote_path: &str, keep: u32) -> AppResult<()> {
    if !conn.exists(remote_path).await {
        return Ok(());
    }
    let dir = remote_join(&remote_parent(remote_path), VERSIONS_DIR);
    if !conn.exists(&dir).await {
        conn.mkdir(&dir).await?;
    }
    let name = remote_name(remote_path);
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    // Two uploads within one second get "-2", "-3", ... instead of clashing.
    let existing: std::collections::HashSet<String> = conn.list(&dir).await?.into_iter().map(|e| e.name).collect();
    let mut version = format!("{name}.{stamp}");
    let mut n = 2;
    while existing.contains(&version) {
        version = format!("{name}.{stamp}-{n}");
        n += 1;
    }
    conn.rename(remote_path, &remote_join(&dir, &version)).await?;
    // Remove the oldest versions of this file beyond the limit (names sort by time).
    // Only exact "<name>.<stamp>" names count, so ".env" leaves ".env.example.<stamp>" alone.
    let mut versions: Vec<String> = conn.list(&dir).await?.into_iter().map(|e| e.name).filter(|n| is_version_of(n, &name)).collect();
    versions.sort();
    while versions.len() > keep as usize {
        let old = versions.remove(0);
        let _ = conn.remove_file(&remote_join(&dir, &old)).await;
    }
    Ok(())
}

/// True for "<name>.YYYY-MM-DD_HH-MM-SS" (optionally "-N").
fn is_version_of(candidate: &str, name: &str) -> bool {
    let Some(stamp) = candidate.strip_prefix(name).and_then(|r| r.strip_prefix('.')) else { return false };
    let Some(base) = stamp.get(..19) else { return false };
    let shape = base.char_indices().all(|(i, c)| match i {
        4 | 7 | 13 | 16 => c == '-',
        10 => c == '_',
        _ => c.is_ascii_digit(),
    });
    let counter_ok = match &stamp[19..] {
        "" => true,
        rest => rest.strip_prefix('-').is_some_and(|n| !n.is_empty() && n.chars().all(|d| d.is_ascii_digit())),
    };
    shape && counter_ok
}

/// Uploads one local file to `remote_path`.
pub async fn upload(conn: &Remote, local_path: &str, remote_path: &str, opts: &TransferOptions, progress: Progress<'_>, flag: Arc<AtomicU8>) -> AppResult<u64> {
    let native = to_native(local_path);
    let meta = tokio::fs::metadata(&native).await?;
    let total = meta.len();
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as u32);
    let keep_mtime = mtime.filter(|_| opts.keep_mtime);

    let parent = remote_parent(remote_path);
    if !conn.exists(&parent).await {
        conn.mkdir_all_with(&parent, opts.dir_perms).await?;
    }
    // Keep the permissions of a file that is being replaced, unless set explicitly.
    let perms = match opts.file_perms {
        Some(p) => Some(p),
        None => conn.meta(remote_path).await.and_then(|m| m.perms),
    };

    let target = if opts.temp_name { temp_name(remote_path) } else { remote_path.to_string() };
    // Continue a partial upload when its size fits, the protocol can append and
    // the local file has not changed since the partial was written (else the
    // new file's tail would land on the old file's head).
    let offset = if opts.temp_name && opts.resume && conn.can_append(remote_path) {
        conn.meta(&target)
            .await
            .filter(|m| m.size <= total && matches!((m.mtime, mtime), (Some(part), Some(src)) if part + conn.mtime_slack() >= src))
            .map(|m| m.size)
            .unwrap_or(0)
    } else {
        0
    };
    let mut src = tokio::fs::File::open(&native).await?;
    if offset > 0 {
        src.seek(std::io::SeekFrom::Start(offset)).await?;
    }
    let mut dst = conn.writer(&target, offset, Some(total), keep_mtime).await?;

    let mut buf = vec![0u8; CHUNK];
    let mut done = offset;
    let mut last = Instant::now();
    let mut throttle = Throttle::new(opts.limit_kbps);
    progress(done, total);
    let result: AppResult<()> = async {
        loop {
            if let Some(e) = stopped(&flag) {
                return Err(e);
            }
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await.map_err(write_err)?;
            done += n as u64;
            throttle.add(n).await;
            if last.elapsed() >= REPORT_EVERY {
                progress(done, total);
                last = Instant::now();
            }
        }
        Ok(())
    }
    .await;
    let result = match result {
        Ok(()) => dst.close().await,
        Err(e) => {
            dst.abort();
            Err(e)
        }
    };

    if let Err(e) = result {
        // Keep the partial file for resuming unless the user threw the transfer away.
        // Without a temp name the target is the real file: it is never deleted.
        if opts.temp_name && (flag.load(Ordering::Relaxed) == DISCARD || !conn.can_append(remote_path)) {
            let _ = conn.remove_file(&target).await;
        }
        return Err(e);
    }

    conn.set_attrs(&target, keep_mtime, perms).await;
    if opts.temp_name {
        if opts.keep_versions > 0 {
            keep_old_version(conn, remote_path, opts.keep_versions).await?;
        }
        // On failure the complete temp file stays; the next try only renames it.
        conn.replace(&target, remote_path).await?;
    }
    progress(total, total);
    Ok(total)
}

/// Downloads one remote file to `local_path`.
pub async fn download(conn: &Remote, remote_path: &str, local_path: &str, opts: &TransferOptions, progress: Progress<'_>, flag: Arc<AtomicU8>) -> AppResult<u64> {
    let meta = conn.meta(remote_path).await.ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("„{}“ gibt es auf dem Server nicht.", remote_name(remote_path))))?;
    let total = meta.size;
    let native = to_native(local_path);
    if let Some(parent) = native.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = local_temp(&native);
    let offset = if opts.resume && conn.can_seek(remote_path) {
        // Only when the server file has not changed since the partial was written.
        let part_time = |m: &std::fs::Metadata| m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs());
        tokio::fs::metadata(&tmp)
            .await
            .ok()
            .filter(|m| m.len() <= total && matches!((part_time(m), meta.mtime), (Some(part), Some(src)) if part >= src as u64))
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };

    let mut src = conn.reader(remote_path, offset).await?;
    let mut dst = if offset > 0 { tokio::fs::OpenOptions::new().append(true).open(&tmp).await? } else { tokio::fs::File::create(&tmp).await? };
    let mut buf = vec![0u8; CHUNK];
    let mut done = offset;
    let mut last = Instant::now();
    let mut throttle = Throttle::new(opts.limit_kbps);
    progress(done, total);
    let result: AppResult<()> = async {
        loop {
            if let Some(e) = stopped(&flag) {
                return Err(e);
            }
            let n = src.read(&mut buf).await.map_err(read_err)?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await?;
            done += n as u64;
            throttle.add(n).await;
            if last.elapsed() >= REPORT_EVERY {
                progress(done, total);
                last = Instant::now();
            }
        }
        dst.flush().await?;
        Ok(())
    }
    .await;
    drop(dst);
    let closed = src.close(result.is_ok()).await;
    // A shorter file than announced means the connection ended early.
    let result = result.and(closed).and_then(|()| {
        if done < total {
            Err(AppError::new(ErrorKind::ConnectionLost, "Die Datei kam nicht vollständig an.").with_detail(format!("{done} von {total} Bytes")))
        } else {
            Ok(())
        }
    });
    if let Err(e) = result {
        if flag.load(Ordering::Relaxed) == DISCARD {
            let _ = tokio::fs::remove_file(&tmp).await;
        }
        return Err(e);
    }
    tokio::fs::rename(&tmp, &native).await?;
    if opts.keep_mtime {
        if let Some(m) = meta.mtime {
            let _ = filetime::set_file_mtime(&native, filetime::FileTime::from_unix_time(m as i64, 0));
        }
    }
    progress(total, total);
    Ok(total)
}

/// Copies one file from one server to another (both halves show a server).
/// The data streams through this computer; nothing is stored on it. The
/// target gets the same temp-name and replace handling as an upload; there is
/// no resume, a stopped transfer starts again from the beginning.
#[allow(clippy::too_many_arguments)]
pub async fn cross(src: &Remote, src_path: &str, dst: &Remote, dst_path: &str, opts: &TransferOptions, progress: Progress<'_>, flag: Arc<AtomicU8>) -> AppResult<u64> {
    let meta = src.meta(src_path).await.ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("„{}“ gibt es auf dem Quell-Server nicht.", remote_name(src_path))))?;
    let total = meta.size;
    let keep_mtime = meta.mtime.filter(|_| opts.keep_mtime);
    let parent = remote_parent(dst_path);
    if !dst.exists(&parent).await {
        dst.mkdir_all_with(&parent, opts.dir_perms).await?;
    }
    let perms = match opts.file_perms {
        Some(p) => Some(p),
        None => dst.meta(dst_path).await.and_then(|m| m.perms),
    };
    let target = if opts.temp_name { temp_name(dst_path) } else { dst_path.to_string() };
    let mut reader = src.reader(src_path, 0).await?;
    let mut writer = match dst.writer(&target, 0, Some(total), keep_mtime).await {
        Ok(w) => w,
        Err(e) => {
            let _ = reader.close(false).await;
            return Err(e);
        }
    };
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    let mut last = Instant::now();
    let mut throttle = Throttle::new(opts.limit_kbps);
    progress(0, total);
    let copied: AppResult<()> = async {
        loop {
            if let Some(e) = stopped(&flag) {
                return Err(e);
            }
            let n = reader.read(&mut buf).await.map_err(read_err)?;
            if n == 0 {
                break;
            }
            writer.write_all(&buf[..n]).await.map_err(write_err)?;
            done += n as u64;
            throttle.add(n).await;
            if last.elapsed() >= REPORT_EVERY {
                progress(done, total);
                last = Instant::now();
            }
        }
        Ok(())
    }
    .await;
    let closed = reader.close(copied.is_ok()).await;
    let result = match copied.and(closed).and_then(|()| {
        if done < total {
            Err(AppError::new(ErrorKind::ConnectionLost, "Die Datei kam nicht vollständig an.").with_detail(format!("{done} von {total} Bytes")))
        } else {
            Ok(())
        }
    }) {
        Ok(()) => writer.close().await,
        Err(e) => {
            writer.abort();
            Err(e)
        }
    };
    if let Err(e) = result {
        if opts.temp_name {
            let _ = dst.remove_file(&target).await;
        }
        return Err(e);
    }
    dst.set_attrs(&target, keep_mtime, perms).await;
    if opts.temp_name {
        if opts.keep_versions > 0 {
            keep_old_version(dst, dst_path, opts.keep_versions).await?;
        }
        dst.replace(&target, dst_path).await?;
    }
    progress(total, total);
    Ok(total)
}

/// Removes the partial file of a transfer the user skipped or removed.
pub async fn discard_upload_part(conn: &Remote, remote_path: &str) {
    let _ = conn.remove_file(&temp_name(remote_path)).await;
}

pub async fn discard_download_part(local_path: &str) {
    let _ = tokio::fs::remove_file(local_temp(&to_native(local_path))).await;
}

#[cfg(test)]
mod version_tests {
    use super::is_version_of;

    #[test]
    fn matches_only_own_versions() {
        assert!(is_version_of(".env.2026-10-27_18-51-02", ".env"));
        assert!(is_version_of(".env.2026-10-27_18-51-02-2", ".env"));
        assert!(!is_version_of(".env.example.2026-10-27_18-51-02", ".env"));
        assert!(!is_version_of(".env.2026-10-27", ".env"));
        assert!(!is_version_of("bot.py", ".env"));
    }
}
