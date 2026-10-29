//! Servers that speak SSH but have no SFTP server (routers, NAS boxes, very
//! old systems; WinSCP calls this the "SCP" mode). Everything runs as shell
//! commands over the SSH session: `ls` for listings, `cat` to read and write
//! files, `mv`, `rm`, `mkdir`, `cp`, `chmod` and `touch` for the rest.
//!
//! Bitcrane falls back to this by itself when a server refuses SFTP; the
//! server settings can also ask for it directly.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{FileEntry, WalkItem};
use crate::paths::{remote_join, remote_name, remote_parent};
use crate::ssh::{Handler, Session};
use chrono::{Datelike, Local, NaiveDate, TimeZone};
use russh::client;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub struct ScpConn {
    handle: client::Handle<Handler>,
    jump: Option<client::Handle<Handler>>,
    pub home: String,
}

/// Quotes a path for the POSIX shell: 'it'\''s' for "it's".
pub fn quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', r"'\''"))
}

struct Output {
    code: u32,
    out: Vec<u8>,
    err: String,
}

impl Output {
    /// Turns a failed command into a message, recognising the usual causes.
    fn check(self, what: &str) -> AppResult<Vec<u8>> {
        if self.code == 0 {
            return Ok(self.out);
        }
        let err = self.err.trim().to_string();
        let lower = err.to_lowercase();
        let kind_msg = if lower.contains("no such file") || lower.contains("not found") && !lower.contains("command not found") {
            (ErrorKind::NotFound, format!("{what} gibt es nicht."))
        } else if lower.contains("permission denied") || lower.contains("operation not permitted") || lower.contains("read-only") {
            (ErrorKind::PermissionDenied, format!("Kein Zugriff auf {what}."))
        } else if lower.contains("file exists") || lower.contains("already exists") {
            (ErrorKind::AlreadyExists, format!("{what} gibt es hier schon."))
        } else if lower.contains("no space") {
            (ErrorKind::Other, "Auf dem Server ist kein Platz mehr.".to_string())
        } else {
            (ErrorKind::Other, format!("Der Server hat {what} abgelehnt."))
        };
        Err(AppError::new(kind_msg.0, kind_msg.1).with_detail(if err.is_empty() { format!("exit {}", self.code) } else { err }))
    }
}

fn quoted(path: &str) -> String {
    format!("„{}“", remote_name(path))
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// Modification time of an `ls -l` line: seconds (`--time-style=+%s`) or
/// "Oct 29 17:01" (this year) / "Oct 29 2024". Returns ms and the tokens used.
fn parse_time(tokens: &[&str], now: chrono::DateTime<Local>) -> Option<(i64, usize)> {
    let first = *tokens.first()?;
    if first.len() >= 9 && first.bytes().all(|b| b.is_ascii_digit()) {
        return Some((first.parse::<i64>().ok()? * 1000, 1));
    }
    let month = MONTHS.iter().position(|m| first.to_lowercase().starts_with(m))? as u32 + 1;
    let day: u32 = tokens.get(1)?.parse().ok()?;
    let third = *tokens.get(2)?;
    let (date, hour, minute) = if let Some((h, m)) = third.split_once(':') {
        let mut d = NaiveDate::from_ymd_opt(now.year(), month, day)?;
        // ls shows times for the last six months; a date "ahead" is last year.
        if d > now.date_naive() + chrono::Duration::days(1) {
            d = NaiveDate::from_ymd_opt(now.year() - 1, month, day)?;
        }
        (d, h.parse().ok()?, m.parse().ok()?)
    } else {
        (NaiveDate::from_ymd_opt(third.parse().ok()?, month, day)?, 0, 0)
    };
    let local = Local.from_local_datetime(&date.and_hms_opt(hour, minute, 0)?).earliest()?;
    Some((local.timestamp_millis(), 3))
}

/// One line of `ls -la` into an entry; `None` for "total", ".", ".." and odd lines.
pub fn parse_ls_line(line: &str, now: chrono::DateTime<Local>) -> Option<FileEntry> {
    // Tokens with their start offsets, so the name keeps its spaces.
    let mut tokens: Vec<(usize, &str)> = Vec::new();
    let mut start = None;
    for (i, c) in line.char_indices() {
        match (c.is_whitespace(), start) {
            (false, None) => start = Some(i),
            (true, Some(s)) => {
                tokens.push((s, &line[s..i]));
                start = None;
            }
            _ => {}
        }
        if tokens.len() == 9 {
            break;
        }
    }
    if let Some(s) = start {
        if tokens.len() < 9 {
            tokens.push((s, &line[s..]));
        }
    }
    let perms = tokens.first()?.1;
    if perms.len() < 10 || !"-dlcbps".contains(&perms[..1]) {
        return None;
    }
    let (owner, group) = (tokens.get(2)?.1, tokens.get(3)?.1);
    let size: u64 = tokens.get(4)?.1.parse().ok()?;
    let rest: Vec<&str> = tokens.iter().skip(5).map(|t| t.1).collect();
    let (mtime, used) = parse_time(&rest, now)?;
    let name_start = tokens.get(5 + used)?.0;
    let mut name = line[name_start..].trim_end_matches(['\r', '\n']).to_string();
    let is_link = perms.starts_with('l');
    if is_link {
        if let Some(i) = name.find(" -> ") {
            name.truncate(i);
        }
    }
    if name == "." || name == ".." || name.is_empty() {
        return None;
    }
    let dir = perms.starts_with('d');
    Some(FileEntry {
        name,
        kind: if dir { "dir" } else { "file" }.into(),
        size: if dir { 0 } else { size },
        mtime,
        perms: perms_octal(perms),
        owner: owner.to_string(),
        group: group.to_string(),
        link: None,
        hidden: 0,
    })
}

/// "rwxr-xr-x" -> "755" (with setuid/setgid/sticky as the leading digit).
fn perms_octal(p: &str) -> String {
    let b = p.as_bytes();
    let bit = |i: usize, c: u8| (b.get(i) == Some(&c)) as u32;
    let special = |i: usize, set: [u8; 2]| set.contains(b.get(i).unwrap_or(&b'-'));
    let mut mode = 0u32;
    for (n, base) in [(1usize, 6u32), (4, 3), (7, 0)] {
        let x = if special(n + 2, [b's', b't']) { 1 } else { bit(n + 2, b'x') };
        mode |= ((bit(n, b'r') << 2) | (bit(n + 1, b'w') << 1) | x) << base;
    }
    let mut extra = 0;
    if special(3, [b's', b'S']) {
        extra |= 4;
    }
    if special(6, [b's', b'S']) {
        extra |= 2;
    }
    if special(9, [b't', b'T']) {
        extra |= 1;
    }
    if extra > 0 {
        format!("{extra}{mode:03o}")
    } else {
        format!("{mode:03o}")
    }
}

/// Listing commands: GNU first (exact seconds), then plain `ls` (busybox, BSD).
fn ls_command(path: &str, single: bool) -> String {
    let flags = if single { "-ladL" } else { "-laL" };
    let p = quote(path);
    format!("LC_ALL=C ls {flags} --time-style=+%s -- {p} 2>/dev/null || LC_ALL=C ls {flags} -- {p}")
}

impl ScpConn {
    pub async fn new(session: Session) -> AppResult<ScpConn> {
        let mut conn = ScpConn { handle: session.handle, jump: session.jump, home: "/".into() };
        let out = conn.run("pwd").await?;
        if out.code != 0 {
            return Err(AppError::other("Der Server bietet weder SFTP noch eine Shell für Dateibefehle an.").with_detail(out.err));
        }
        let home = String::from_utf8_lossy(&out.out).trim().to_string();
        if home.starts_with('/') {
            conn.home = home;
        }
        Ok(conn)
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed() || self.jump.as_ref().map(|j| j.is_closed()).unwrap_or(false)
    }

    pub async fn close(&self) {
        let _ = self.handle.disconnect(russh::Disconnect::ByApplication, "", "de").await;
        if let Some(j) = &self.jump {
            let _ = j.disconnect(russh::Disconnect::ByApplication, "", "de").await;
        }
    }

    /// Runs a command; stdout and stderr separately.
    async fn run(&self, command: &str) -> AppResult<Output> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        let mut out = Output { code: 0, out: Vec::new(), err: String::new() };
        let mut err = Vec::new();
        let read = async {
            while let Some(msg) = channel.wait().await {
                match msg {
                    russh::ChannelMsg::Data { data } => out.out.extend_from_slice(&data),
                    russh::ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
                    russh::ChannelMsg::ExitStatus { exit_status } => out.code = exit_status,
                    russh::ChannelMsg::ExitSignal { .. } => out.code = 128,
                    _ => {}
                }
            }
        };
        if tokio::time::timeout(Duration::from_secs(300), read).await.is_err() {
            return Err(AppError::new(ErrorKind::ConnectionLost, "Der Server antwortet nicht mehr."));
        }
        out.err = String::from_utf8_lossy(&err).into_owned();
        Ok(out)
    }

    async fn ok(&self, command: &str, what: &str) -> AppResult<Vec<u8>> {
        self.run(command).await?.check(what)
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        let out = self.ok(&ls_command(path, false), &quoted(path)).await?;
        let now = Local::now();
        let mut list: Vec<FileEntry> = String::from_utf8_lossy(&out).lines().filter_map(|l| parse_ls_line(l, now)).collect();
        list.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
            ("dir", "file") => std::cmp::Ordering::Less,
            ("file", "dir") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(list)
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        let out = self.ok(&ls_command(path, true), &quoted(path)).await?;
        let line = String::from_utf8_lossy(&out).lines().next().unwrap_or_default().to_string();
        // The name in the line is the path as given; the entry gets the plain name.
        let mut e = parse_ls_line(&line, Local::now()).ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{} gibt es nicht.", quoted(path))))?;
        e.name = remote_name(path);
        Ok(e)
    }

    pub async fn exists(&self, path: &str) -> bool {
        matches!(self.run(&format!("test -e {} || test -L {}", quote(path), quote(path))).await, Ok(o) if o.code == 0)
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        self.ok(&format!("mkdir -- {}", quote(path)), &quoted(path)).await.map(|_| ())
    }

    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        self.ok(&format!("mkdir -p -- {}", quote(path)), &quoted(path)).await.map(|_| ())
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        if self.exists(to).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("{} gibt es hier schon.", quoted(to))));
        }
        self.ok(&format!("mv -- {} {}", quote(from), quote(to)), &quoted(from)).await.map(|_| ())
    }

    pub async fn replace(&self, from: &str, to: &str) -> AppResult<()> {
        self.ok(&format!("mv -f -- {} {}", quote(from), quote(to)), &quoted(to)).await.map(|_| ())
    }

    pub async fn remove(&self, path: &str) -> AppResult<()> {
        self.ok(&format!("rm -rf -- {}", quote(path)), &quoted(path)).await.map(|_| ())
    }

    pub async fn chmod(&self, path: &str, mode: u32, recursive: bool) -> AppResult<()> {
        self.ok(&format!("chmod {}{:o} -- {}", if recursive { "-R " } else { "" }, mode, quote(path)), &quoted(path)).await.map(|_| ())
    }

    pub async fn symlink(&self, link: &str, target: &str) -> AppResult<()> {
        self.ok(&format!("ln -s -- {} {}", quote(target), quote(link)), &quoted(link)).await.map(|_| ())
    }

    pub async fn open_shell(&self, cols: u32, rows: u32, command: &str) -> AppResult<russh::Channel<client::Msg>> {
        crate::ssh::open_shell(&self.handle, cols, rows, command).await
    }

    pub async fn exec(&self, command: &str) -> AppResult<(u32, String)> {
        let o = self.run(command).await?;
        let mut text = String::from_utf8_lossy(&o.out).into_owned();
        text.push_str(&o.err);
        Ok((o.code, text))
    }

    /// Modification time (seconds) and permissions after an upload.
    pub async fn set_attrs(&self, path: &str, mtime: Option<u32>, perms: Option<u32>) {
        if let Some(m) = mtime {
            // GNU and busybox know "@seconds"; others keep the upload time.
            let _ = self.run(&format!("touch -m -d @{m} -- {} 2>/dev/null", quote(path))).await;
        }
        if let Some(p) = perms {
            let _ = self.run(&format!("chmod {:o} -- {}", p & 0o7777, quote(path))).await;
        }
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

    /// Copies on the server with `cp`, with "Kopie" names on clashes.
    pub async fn copy_within(&self, paths: &[String], dest_dir: &str) -> AppResult<Vec<String>> {
        let mut taken: std::collections::HashSet<String> = self.list(dest_dir).await?.into_iter().map(|e| e.name).collect();
        let mut out = Vec::new();
        for from in paths {
            if dest_dir == from.as_str() || dest_dir.starts_with(&format!("{from}/")) {
                return Err(AppError::other("Ein Ordner kann nicht in sich selbst kopiert werden."));
            }
            let name = crate::local::copy_name(|n| taken.contains(n), &remote_name(from));
            self.ok(&format!("cp -Rp -- {} {}", quote(from), quote(&remote_join(dest_dir, &name))), &quoted(from)).await?;
            taken.insert(name.clone());
            out.push(name);
        }
        Ok(out)
    }

    /// Reads a file from `offset` (`cat`, or `tail -c +N` to start further in).
    pub async fn reader(&self, path: &str, offset: u64) -> AppResult<Box<dyn AsyncRead + Unpin + Send>> {
        let command = if offset > 0 { format!("tail -c +{} -- {}", offset + 1, quote(path)) } else { format!("cat -- {}", quote(path)) };
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        let (mut w, r) = tokio::io::duplex(512 * 1024);
        tokio::spawn(async move {
            while let Some(msg) = channel.wait().await {
                if let russh::ChannelMsg::Data { data } = msg {
                    if w.write_all(&data).await.is_err() {
                        break; // reader dropped (pause or error)
                    }
                }
            }
            let _ = w.shutdown().await;
        });
        Ok(Box::new(r))
    }

    /// Writes a file with `cat`; `offset > 0` appends to a partial file of
    /// exactly that size. The task finishes the upload.
    pub async fn writer(&self, path: &str, offset: u64) -> AppResult<(Box<dyn AsyncWrite + Unpin + Send>, tokio::task::JoinHandle<AppResult<()>>)> {
        let command = format!("cat {} {}", if offset > 0 { ">>" } else { ">" }, quote(path));
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        let (w, mut r) = tokio::io::duplex(512 * 1024);
        let what = quoted(path);
        let task = tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = r.read(&mut buf).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Hochladen abgebrochen.").with_detail(e.to_string()))?;
                if n == 0 {
                    break;
                }
                channel.data(&buf[..n]).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Hochladen abgebrochen.").with_detail(e.to_string()))?;
            }
            channel.eof().await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Hochladen abgebrochen.").with_detail(e.to_string()))?;
            let mut out = Output { code: 0, out: Vec::new(), err: String::new() };
            while let Some(msg) = channel.wait().await {
                match msg {
                    russh::ChannelMsg::ExtendedData { data, .. } => out.err.push_str(&String::from_utf8_lossy(&data)),
                    russh::ChannelMsg::ExitStatus { exit_status } => out.code = exit_status,
                    russh::ChannelMsg::ExitSignal { .. } => out.code = 128,
                    _ => {}
                }
            }
            out.check(&what).map(|_| ())
        });
        Ok((Box::new(w), task))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> chrono::DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 29, 18, 0, 0).unwrap()
    }

    #[test]
    fn reads_gnu_listing_with_seconds() {
        let e = parse_ls_line("-rw-r--r-- 1 test test 1234 1793289000 name with  spaces.txt", now()).unwrap();
        assert_eq!((e.name.as_str(), e.size, e.mtime, e.perms.as_str(), e.kind.as_str()), ("name with  spaces.txt", 1234, 1_793_289_000_000, "644", "file"));
        let d = parse_ls_line("drwxr-sr-x 2 www-data www 4096 1793289000 html", now()).unwrap();
        assert_eq!((d.kind.as_str(), d.perms.as_str(), d.size), ("dir", "2755", 0));
    }

    #[test]
    fn reads_busybox_and_bsd_listing() {
        let e = parse_ls_line("-rw-r--r--    1 root     root          7 Oct 29 17:01 cmd.txt", now()).unwrap();
        assert_eq!(e.name, "cmd.txt");
        assert_eq!(e.mtime, Local.with_ymd_and_hms(2026, 10, 29, 17, 1, 0).unwrap().timestamp_millis());
        let old = parse_ls_line("-rw-r--r-- 1 root root 7 Dec 24  2024 alt.txt", now()).unwrap();
        assert_eq!(old.mtime, Local.with_ymd_and_hms(2024, 12, 24, 0, 0, 0).unwrap().timestamp_millis());
        // A time without a year that would lie ahead belongs to last year.
        let last = parse_ls_line("-rw-r--r-- 1 root root 7 Dec 30 10:00 x", now()).unwrap();
        assert_eq!(last.mtime, Local.with_ymd_and_hms(2025, 12, 30, 10, 0, 0).unwrap().timestamp_millis());
        assert!(parse_ls_line("total 12", now()).is_none());
        assert!(parse_ls_line("drwxr-xr-x 2 a a 4096 1793289000 .", now()).is_none());
        let link = parse_ls_line("lrwxrwxrwx 1 a a 4 1793289000 web -> /srv/www", now()).unwrap();
        assert_eq!(link.name, "web");
    }

    #[test]
    fn quotes_for_the_shell() {
        assert_eq!(quote("it's a file"), r"'it'\''s a file'");
    }
}

/// Integration test against the test SSH server, forced into shell mode.
#[cfg(test)]
mod integration {
    use super::*;

    #[tokio::test]
    async fn scp_round_trip() {
        let (Ok(target), Ok(key)) = (std::env::var("BITCRANE_TEST_SSH"), std::env::var("BITCRANE_TEST_KEY")) else { return };
        let (host, port) = target.split_once(':').unwrap();
        let dir = tempfile::tempdir().unwrap();
        let known = std::sync::Arc::new(crate::ssh::KnownHosts::load(dir.path().join("known.json")));
        let mut params: crate::ssh::ConnectParams = serde_json::from_value(serde_json::json!({
            "host": host, "port": port.parse::<u16>().unwrap(), "user": std::env::var("BITCRANE_TEST_USER").unwrap_or_else(|_| "test".into()),
            "auth": { "method": "key", "path": key }, "scp": true,
        }))
        .unwrap();
        let session = match crate::ssh::open(&params, known.clone(), None).await {
            Ok(s) => s,
            Err(e) => {
                params.trust = Some(e.host_key.expect("host key").fingerprint);
                crate::ssh::open(&params, known, None).await.unwrap()
            }
        };
        let conn = crate::remote::Remote::Scp(std::sync::Arc::new(ScpConn::new(session).await.unwrap()));
        let home = conn.home().to_string();
        crate::remote::integration::check(conn, home).await;
    }
}
