//! FTP and FTPS client (explicit "AUTH TLS" and implicit TLS on its own port).
//!
//! Written for Bitcrane instead of using a library because the details that
//! matter in practice need full control: file names in UTF-8 or Latin-1,
//! server times in the server's time zone (LIST) or UTC (MLSD), text or
//! binary mode, TLS session reuse on the data connection (vsftpd requires
//! it), resuming with APPE/REST, and SOCKS/HTTP proxies.
//!
//! FTP can only do one thing at a time per control connection, so a
//! connection keeps a small pool of logged-in sessions: browsing uses one,
//! every transfer takes its own.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{perms_string, FileEntry, WalkItem};
use crate::paths::{remote_join, remote_name, remote_parent};
use crate::proxy::ProxyParams;
use crate::ssh::KnownHosts;
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

/// Byte stream of a control or data connection (plain or TLS).
pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type Io = Box<dyn Stream>;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FtpParams {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password: Option<String>,
    /// "none", "explicit" (AUTH TLS) or "implicit".
    #[serde(default = "default_tls")]
    pub tls: String,
    /// Only TLS 1.3 (otherwise 1.2 and 1.3).
    #[serde(default)]
    pub tls13_only: bool,
    /// File names: "utf8" or "latin1".
    #[serde(default = "default_encoding")]
    pub encoding: String,
    /// Server time zone in minutes east of UTC; LIST shows local server times.
    #[serde(default)]
    pub tz_offset_min: i32,
    /// "binary", "ascii" or "auto" (text files as text, everything else binary).
    #[serde(default = "default_mode")]
    pub mode: String,
    /// Certificate fingerprint the user has just confirmed.
    #[serde(default)]
    pub trust: Option<String>,
    #[serde(default)]
    pub proxy: Option<ProxyParams>,
    /// Seconds to wait for the server when connecting (per server, default 15).
    #[serde(default)]
    pub timeout: Option<u64>,
}

fn default_tls() -> String {
    "explicit".into()
}
fn default_encoding() -> String {
    "utf8".into()
}
fn default_mode() -> String {
    "binary".into()
}

/// Extensions sent in text mode with mode "auto".
const TEXT_EXT: &[&str] = &["txt", "html", "htm", "css", "js", "php", "py", "md", "json", "xml", "csv", "sh", "ini", "conf", "cfg", "yml", "yaml", "sql", "htaccess", "log"];

#[derive(Default, Clone, Debug)]
struct Feats {
    mlsd: bool,
    mlst: bool,
    mfmt: bool,
    utf8: bool,
    epsv: bool,
    /// MLSD/MLST can report unix.mode when asked (OPTS MLST).
    unix_mode: bool,
}

struct Shared {
    params: FtpParams,
    tls: Option<(Arc<rustls::ClientConfig>, rustls::pki_types::ServerName<'static>)>,
    seen: Option<Arc<Mutex<Option<crate::tls::SeenCert>>>>,
    host_id: String,
    known: Arc<KnownHosts>,
    feats: Mutex<Feats>,
    feats_known: std::sync::atomic::AtomicBool,
}

/// One logged-in control connection.
pub struct Session {
    ctrl: BufReader<Io>,
    shared: Arc<Shared>,
    /// TLS settings of this control connection (with its own session cache).
    tls: Option<Arc<rustls::ClientConfig>>,
    /// Current transfer type ("A" or "I"), to avoid repeating TYPE.
    kind: char,
    last_used: Instant,
    /// A reply may still be unread; the session must not be reused.
    broken: bool,
}

/// An FTP "connection" for Bitcrane: settings plus idle sessions.
pub struct FtpConn {
    shared: Arc<Shared>,
    idle: tokio::sync::Mutex<Vec<Session>>,
    pub home: String,
}

/* ------------------------------------------------------------------ Helpers */

fn lost(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::ConnectionLost, "Verbindung zum FTP-Server unterbrochen.").with_detail(e.to_string())
}

/// Maps a negative reply to an error the interface understands.
fn reply_error(code: u32, text: &str, what: &str) -> AppError {
    let t = text.to_lowercase();
    let kind = match code {
        530 => ErrorKind::AuthFailed,
        421 | 425 | 426 => ErrorKind::ConnectionLost,
        550 | 553 | 450 | 451 if t.contains("exist") && !t.contains("not exist") && !t.contains("no such") => ErrorKind::AlreadyExists,
        550 | 553 | 450 if t.contains("denied") || t.contains("permission") || t.contains("not allowed") => ErrorKind::PermissionDenied,
        550 | 450 => ErrorKind::NotFound,
        552 => ErrorKind::Other,
        _ => ErrorKind::Other,
    };
    let message = match kind {
        ErrorKind::AuthFailed => "Anmeldung abgelehnt: Benutzer oder Passwort falsch.".to_string(),
        ErrorKind::PermissionDenied => format!("{what}: keine Berechtigung."),
        ErrorKind::NotFound => format!("{what}: nicht gefunden."),
        ErrorKind::AlreadyExists => format!("{what}: gibt es schon."),
        _ => format!("{what} fehlgeschlagen."),
    };
    AppError::new(kind, message).with_detail(format!("{code} {}", text.trim()))
}

impl Shared {
    fn encode(&self, s: &str) -> Vec<u8> {
        if self.params.encoding == "latin1" {
            s.chars().map(|c| if (c as u32) < 256 { c as u8 } else { b'?' }).collect()
        } else {
            s.as_bytes().to_vec()
        }
    }

    fn decode(&self, b: &[u8]) -> String {
        if self.params.encoding == "latin1" {
            b.iter().map(|&c| c as char).collect()
        } else {
            String::from_utf8_lossy(b).into_owned()
        }
    }

    async fn tcp(&self, host: &str, port: u16) -> AppResult<TcpStream> {
        let connect = async {
            match &self.params.proxy {
                Some(p) => crate::proxy::connect(p, host, port).await,
                None => TcpStream::connect((host, port)).await.map_err(AppError::from),
            }
        };
        let stream = tokio::time::timeout(crate::ssh::connect_timeout(self.params.timeout), connect)
            .await
            .map_err(|_| AppError::new(ErrorKind::Unreachable, "Der Server antwortet nicht (Zeitüberschreitung)."))??;
        let _ = stream.set_nodelay(true);
        Ok(stream)
    }

    /// TLS handshake; an unknown certificate becomes the "Erste Verbindung" question.
    async fn wrap(&self, config: Arc<rustls::ClientConfig>, tcp: TcpStream) -> AppResult<Io> {
        let name = self.tls.clone().expect("TLS configured").1;
        let connector = tokio_rustls::TlsConnector::from(config);
        match tokio::time::timeout(crate::ssh::connect_timeout(self.params.timeout), connector.connect(name, tcp)).await {
            Err(_) => Err(AppError::new(ErrorKind::Unreachable, "TLS-Verbindung: keine Antwort (Zeitüberschreitung).")),
            Ok(Ok(s)) => Ok(Box::new(s)),
            Ok(Err(e)) => Err(self.tls_error(e)),
        }
    }

    fn tls_error(&self, e: std::io::Error) -> AppError {
        let seen = self.seen.as_ref().and_then(|s| s.lock().unwrap().clone());
        if let Some(cert) = seen {
            let stored = self.known.get(&self.host_id);
            if stored.as_deref() != Some(cert.fingerprint.as_str()) && e.to_string().contains("certificate") {
                return cert_error(&self.params.host, cert.fingerprint, stored);
            }
        }
        AppError::new(ErrorKind::Unreachable, "TLS-Verbindung fehlgeschlagen.").with_detail(e.to_string())
    }
}

/// Unknown or changed server certificate, in the same shape as an SSH host key.
pub fn cert_error(host: &str, fingerprint: String, stored: Option<String>) -> AppError {
    let changed = stored.is_some();
    let mut err = AppError::new(
        if changed { ErrorKind::HostKeyChanged } else { ErrorKind::HostKeyUnknown },
        if changed { "Das Zertifikat des Servers hat sich geändert." } else { "Das Zertifikat dieses Servers ist noch nicht bekannt." },
    );
    err.host_key = Some(crate::error::HostKeyInfo { host: host.to_string(), algorithm: "TLS-Zertifikat".into(), fingerprint, previous: stored });
    err
}

/* ------------------------------------------------------------------ Session */

async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R) -> AppResult<Vec<u8>> {
    let mut line = Vec::new();
    let n = tokio::time::timeout(REPLY_TIMEOUT, r.read_until(b'\n', &mut line))
        .await
        .map_err(|_| AppError::new(ErrorKind::ConnectionLost, "Der FTP-Server antwortet nicht mehr."))?
        .map_err(lost)?;
    if n == 0 {
        return Err(lost("Verbindung geschlossen"));
    }
    while line.last().is_some_and(|c| *c == b'\n' || *c == b'\r') {
        line.pop();
    }
    Ok(line)
}

/// Reads one (possibly multi-line) reply: code and the text of all lines.
async fn read_reply<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R, shared: &Shared) -> AppResult<(u32, String)> {
    let first = read_line(r).await?;
    let code: u32 = std::str::from_utf8(first.get(..3).unwrap_or(b"")).ok().and_then(|c| c.parse().ok()).ok_or_else(|| lost(format!("Unerwartete Antwort: {}", String::from_utf8_lossy(&first))))?;
    let mut text = shared.decode(first.get(4..).unwrap_or(b""));
    if first.get(3) == Some(&b'-') {
        let end = format!("{code} ");
        loop {
            let line = read_line(r).await?;
            let s = shared.decode(&line);
            text.push('\n');
            if s.starts_with(&end) {
                text.push_str(&s[4..]);
                break;
            }
            text.push_str(&s);
        }
    }
    Ok((code, text))
}

async fn send_line<W: AsyncWrite + Unpin>(w: &mut W, shared: &Shared, cmd: &str, arg: Option<&str>) -> AppResult<()> {
    // A line break in a name would start a second command on the server.
    if arg.is_some_and(|a| a.contains(['\r', '\n'])) {
        return Err(AppError::other("Namen mit Zeilenumbrüchen gehen über FTP nicht."));
    }
    let mut line = cmd.as_bytes().to_vec();
    if let Some(a) = arg {
        line.push(b' ');
        line.extend(shared.encode(a));
    }
    line.extend_from_slice(b"\r\n");
    w.write_all(&line).await.map_err(lost)?;
    w.flush().await.map_err(lost)?;
    Ok(())
}

impl Session {
    async fn reply(&mut self) -> AppResult<(u32, String)> {
        let r = read_reply(&mut self.ctrl, &self.shared).await;
        self.last_used = Instant::now();
        r
    }

    async fn send(&mut self, cmd: &str, arg: Option<&str>) -> AppResult<()> {
        send_line(self.ctrl.get_mut(), &self.shared, cmd, arg).await
    }

    async fn cmd(&mut self, cmd: &str, arg: Option<&str>) -> AppResult<(u32, String)> {
        self.send(cmd, arg).await?;
        self.reply().await
    }

    /// Runs a command that must answer with one of `ok`.
    async fn expect(&mut self, cmd: &str, arg: Option<&str>, ok: &[u32], what: &str) -> AppResult<String> {
        let (code, text) = self.cmd(cmd, arg).await?;
        if ok.contains(&code) {
            Ok(text)
        } else {
            Err(reply_error(code, &text, what))
        }
    }

    async fn open(shared: Arc<Shared>) -> AppResult<Session> {
        let p = &shared.params;
        // Every control connection gets its own session store: the data
        // connections must resume exactly this control connection's TLS session.
        let tls = shared.tls.as_ref().map(|(base, _)| {
            let mut c = (**base).clone();
            c.resumption = rustls::client::Resumption::in_memory_sessions(8);
            Arc::new(c)
        });
        let tcp = shared.tcp(&p.host, p.port).await?;
        let not_ftp = |code: u32, text: String| AppError::new(ErrorKind::Unreachable, "Der Server meldet sich nicht als FTP-Server.").with_detail(format!("{code} {text}"));
        let ctrl: BufReader<Io> = if p.tls == "implicit" {
            let mut c = BufReader::new(shared.wrap(tls.clone().expect("TLS"), tcp).await?);
            let (code, text) = read_reply(&mut c, &shared).await?;
            if code != 220 {
                return Err(not_ftp(code, text));
            }
            c
        } else {
            let mut plain = BufReader::new(tcp);
            let (code, text) = read_reply(&mut plain, &shared).await?;
            if code != 220 {
                return Err(not_ftp(code, text));
            }
            if p.tls == "explicit" {
                send_line(plain.get_mut(), &shared, "AUTH", Some("TLS")).await?;
                let (code, text) = read_reply(&mut plain, &shared).await?;
                if code != 234 {
                    return Err(AppError::other("Der Server bietet kein verschlüsseltes FTP (FTPS) an.").with_detail(format!("{code} {text}")));
                }
                BufReader::new(shared.wrap(tls.clone().expect("TLS"), plain.into_inner()).await?)
            } else {
                BufReader::new(Box::new(plain.into_inner()) as Io)
            }
        };
        let mut s = Session { ctrl, shared: shared.clone(), tls, kind: ' ', last_used: Instant::now(), broken: false };
        let user = if p.user.is_empty() { "anonymous" } else { p.user.as_str() };
        let (code, text) = s.cmd("USER", Some(user)).await?;
        match code {
            230 => {}
            331 | 332 => {
                let Some(pass) = p.password.clone().or_else(|| p.user.is_empty().then(|| "bitcrane@".to_string())) else {
                    return Err(AppError::new(ErrorKind::PasswordRequired, "Der Server möchte ein Passwort."));
                };
                let (code, text) = s.cmd("PASS", Some(&pass)).await?;
                if code != 230 && code != 202 {
                    return Err(reply_error(code, &text, "Anmeldung"));
                }
            }
            _ => return Err(reply_error(code, &text, "Anmeldung")),
        }
        if p.tls != "none" {
            s.expect("PBSZ", Some("0"), &[200], "TLS")
                .await
                .map_err(|e| AppError::other("Der Server lehnt verschlüsselte Datenverbindungen ab.").with_detail(e.detail.unwrap_or_default()))?;
            s.expect("PROT", Some("P"), &[200], "TLS")
                .await
                .map_err(|e| AppError::other("Der Server lehnt verschlüsselte Datenverbindungen ab.").with_detail(e.detail.unwrap_or_default()))?;
        }
        let first_session = !shared.feats_known.swap(true, std::sync::atomic::Ordering::Relaxed);
        if first_session {
            let (code, text) = s.cmd("FEAT", None).await?;
            if code == 211 {
                let mut f = Feats::default();
                for l in text.lines() {
                    let l = l.trim().to_uppercase();
                    f.mlsd |= l.starts_with("MLSD") || l.starts_with("MLST");
                    f.mlst |= l.starts_with("MLST");
                    f.unix_mode |= l.starts_with("MLST") && l.contains("UNIX.MODE");
                    f.mfmt |= l.starts_with("MFMT");
                    f.utf8 |= l.starts_with("UTF8");
                    f.epsv |= l.starts_with("EPSV");
                }
                *shared.feats.lock().unwrap() = f;
            }
        }
        if shared.feats.lock().unwrap().unix_mode {
            let _ = s.cmd("OPTS", Some("MLST type;size;modify;unix.mode;")).await?;
        }
        if p.encoding == "utf8" && shared.feats.lock().unwrap().utf8 {
            let _ = s.cmd("OPTS", Some("UTF8 ON")).await?;
        }
        s.set_type('I').await?;
        Ok(s)
    }

    async fn set_type(&mut self, kind: char) -> AppResult<()> {
        if self.kind != kind {
            self.expect("TYPE", Some(&kind.to_string()), &[200], "Übertragungsart").await?;
            self.kind = kind;
        }
        Ok(())
    }

    /// Text or binary for a file, by the server setting.
    fn kind_for(&self, path: &str) -> char {
        match self.shared.params.mode.as_str() {
            "ascii" => 'A',
            "auto" => {
                let name = remote_name(path).to_lowercase();
                let ext = name.rsplit('.').next().unwrap_or("");
                if name.contains('.') && TEXT_EXT.contains(&ext) { 'A' } else { 'I' }
            }
            _ => 'I',
        }
    }

    async fn pwd(&mut self) -> AppResult<String> {
        let text = self.expect("PWD", None, &[257], "Startordner").await?;
        // 257 "/home/test" is the current directory ("" inside the name stands for ").
        let start = text.find('"').map(|i| i + 1).unwrap_or(0);
        let mut out = String::new();
        let mut chars = text[start..].chars().peekable();
        while let Some(c) = chars.next() {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    out.push('"');
                } else {
                    break;
                }
            } else {
                out.push(c);
            }
        }
        Ok(if out.is_empty() { "/".into() } else { out })
    }

    /// Opens a passive data connection and runs `cmd` on it. Returns the
    /// data stream once the server has accepted the command.
    async fn data(&mut self, cmd: &str, arg: Option<&str>, what: &str) -> AppResult<Io> {
        let host = self.shared.params.host.clone();
        let epsv = self.shared.feats.lock().unwrap().epsv;
        let port = if epsv {
            let text = self.expect("EPSV", None, &[229], "Datenverbindung").await?;
            // 229 Entering Extended Passive Mode (|||6446|)
            text.split('|').filter_map(|x| x.parse::<u16>().ok()).next().ok_or_else(|| lost(format!("EPSV: {text}")))?
        } else {
            let text = self.expect("PASV", None, &[227], "Datenverbindung").await?;
            let nums: Vec<u32> = text
                .split(|c: char| !c.is_ascii_digit())
                .filter(|x| !x.is_empty())
                .filter_map(|x| x.parse().ok())
                .collect::<Vec<u32>>();
            // The last six numbers are h1,h2,h3,h4,p1,p2; the address itself is
            // ignored (often internal behind NAT), the control host is used.
            let n = nums.len();
            if n < 6 {
                return Err(lost(format!("PASV: {text}")));
            }
            let (p1, p2) = (nums[n - 2], nums[n - 1]);
            if p1 > 255 || p2 > 255 {
                return Err(lost(format!("PASV: {text}")));
            }
            (p1 * 256 + p2) as u16
        };
        let tcp = self.shared.tcp(&host, port).await?;
        self.send(cmd, arg).await?;
        if let Some(tls) = self.tls.clone() {
            // Some servers start TLS on the data connection only after the
            // command; a rejected command must not leave us waiting for it.
            let shared = self.shared.clone();
            let mut handshake = Box::pin(async move { shared.wrap(tls, tcp).await });
            let mut pending_reply = None;
            // Waiting for control data (not reading it) keeps a reply whole
            // when the handshake wins the race.
            let io = tokio::select! {
                r = &mut handshake => match r {
                    Ok(io) => io,
                    Err(e) => {
                        self.broken = true;
                        return Err(e);
                    }
                },
                r = async { self.ctrl.fill_buf().await.map(|b| b.len()) } => {
                    r.map_err(lost)?;
                    let (code, text) = self.reply().await?;
                    if code >= 400 {
                        return Err(reply_error(code, &text, what));
                    }
                    pending_reply = Some(code);
                    match handshake.await {
                        Ok(io) => io,
                        Err(e) => {
                            // The closing reply of the transfer is still on its way.
                            self.broken = true;
                            return Err(e);
                        }
                    }
                }
            };
            if pending_reply.is_none() {
                let (code, text) = self.reply().await?;
                if code >= 400 {
                    return Err(reply_error(code, &text, what));
                }
            }
            Ok(io)
        } else {
            let (code, text) = self.reply().await?;
            if code >= 400 {
                return Err(reply_error(code, &text, what));
            }
            Ok(Box::new(tcp))
        }
    }

    /// Waits for the end of a transfer ("226 Transfer complete").
    async fn finish_data(&mut self, what: &str) -> AppResult<()> {
        let (code, text) = self.reply().await?;
        if (200..300).contains(&code) {
            Ok(())
        } else {
            Err(reply_error(code, &text, what))
        }
    }

    async fn read_all(&mut self, cmd: &str, arg: Option<&str>, what: &str) -> AppResult<Vec<u8>> {
        let mut data = self.data(cmd, arg, what).await?;
        let mut buf = Vec::new();
        data.read_to_end(&mut buf).await.map_err(lost)?;
        let _ = data.shutdown().await;
        drop(data);
        self.finish_data(what).await?;
        Ok(buf)
    }

    async fn list(&mut self, path: &str) -> AppResult<Vec<FileEntry>> {
        let mlsd = self.shared.feats.lock().unwrap().mlsd;
        let mut out = Vec::new();
        if mlsd {
            let raw = self.read_all("MLSD", Some(path), "Ordner lesen").await?;
            for line in raw.split(|c| *c == b'\n') {
                if let Some(e) = parse_mlsx(&self.shared.decode(line.strip_suffix(b"\r").unwrap_or(line))) {
                    out.push(e);
                }
            }
        } else {
            // "LIST -a" shows hidden files on most servers; the path goes via CWD
            // so names with spaces work everywhere.
            self.expect("CWD", Some(path), &[250], "Ordner öffnen").await?;
            let raw = self.read_all("LIST", Some("-a"), "Ordner lesen").await?;
            let tz = self.shared.params.tz_offset_min;
            for line in raw.split(|c| *c == b'\n') {
                if let Some(e) = parse_list_line(&self.shared.decode(line.strip_suffix(b"\r").unwrap_or(line)), tz) {
                    out.push(e);
                }
            }
        }
        out.retain(|e| e.name != "." && e.name != "..");
        out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
            ("dir", "file") => std::cmp::Ordering::Less,
            ("file", "dir") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    async fn stat(&mut self, path: &str) -> AppResult<FileEntry> {
        if path == "/" {
            return Ok(FileEntry { name: "/".into(), kind: "dir".into(), size: 0, mtime: 0, perms: "755".into(), owner: String::new(), group: String::new(), link: None, hidden: 0 });
        }
        if self.shared.feats.lock().unwrap().mlst {
            let (code, text) = self.cmd("MLST", Some(path)).await?;
            if code == 250 {
                if let Some(line) = text.lines().find(|l| l.starts_with(' ') || l.contains("type=")) {
                    if let Some(mut e) = parse_mlsx(line.trim_start()) {
                        e.name = remote_name(path);
                        return Ok(e);
                    }
                }
            } else if code >= 500 {
                return Err(reply_error(code, &text, &remote_name(path)));
            }
        }
        let name = remote_name(path);
        self.list(&remote_parent(path))
            .await?
            .into_iter()
            .find(|e| e.name == name)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("„{name}“ gibt es nicht.")))
    }

    async fn exists(&mut self, path: &str) -> AppResult<bool> {
        match self.stat(path).await {
            Ok(_) => Ok(true),
            Err(e) if e.kind == ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn mkdir(&mut self, path: &str) -> AppResult<()> {
        self.expect("MKD", Some(path), &[257, 250], &format!("Ordner „{}“ anlegen", remote_name(path))).await.map(|_| ())
    }

    async fn mkdir_all(&mut self, path: &str) -> AppResult<()> {
        let mut current = String::new();
        for seg in path.split('/').filter(|s| !s.is_empty()) {
            current.push('/');
            current.push_str(seg);
            if !self.exists(&current).await? {
                if let Err(e) = self.mkdir(&current).await {
                    if !self.exists(&current).await? {
                        return Err(e);
                    }
                }
            }
        }
        Ok(())
    }

    async fn rename(&mut self, from: &str, to: &str) -> AppResult<()> {
        self.expect("RNFR", Some(from), &[350], &format!("„{}“ umbenennen", remote_name(from))).await?;
        self.expect("RNTO", Some(to), &[250], &format!("„{}“ umbenennen", remote_name(from))).await.map(|_| ())
    }

    async fn delete_file(&mut self, path: &str) -> AppResult<()> {
        self.expect("DELE", Some(path), &[250, 200], &format!("„{}“ löschen", remote_name(path))).await.map(|_| ())
    }

    async fn remove(&mut self, path: &str) -> AppResult<()> {
        let e = self.stat(path).await?;
        if e.kind == "dir" && e.link.is_none() {
            for c in self.list(path).await? {
                Box::pin(self.remove(&remote_join(path, &c.name))).await?;
            }
            self.expect("RMD", Some(path), &[250, 200], &format!("Ordner „{}“ löschen", remote_name(path))).await?;
        } else {
            self.delete_file(path).await?;
        }
        Ok(())
    }

    async fn chmod(&mut self, path: &str, mode: u32, recursive: bool) -> AppResult<()> {
        let e = self.stat(path).await?;
        let own = if recursive && e.kind != "dir" { mode & 0o666 } else { mode };
        self.expect("SITE", Some(&format!("CHMOD {:o} {path}", own)), &[200, 250], "Rechte setzen").await?;
        if recursive && e.kind == "dir" {
            for c in self.list(path).await? {
                Box::pin(self.chmod(&remote_join(path, &c.name), mode, true)).await?;
            }
        }
        Ok(())
    }

    /// Modification time (seconds) and permissions after an upload, where the server allows it.
    async fn set_attrs(&mut self, path: &str, mtime: Option<u32>, perms: Option<u32>) {
        if let Some(m) = mtime {
            if self.shared.feats.lock().unwrap().mfmt {
                if let Some(t) = chrono::DateTime::from_timestamp(m as i64, 0) {
                    let _ = self.cmd("MFMT", Some(&format!("{} {path}", t.format("%Y%m%d%H%M%S")))).await;
                }
            }
        }
        if let Some(p) = perms {
            let _ = self.cmd("SITE", Some(&format!("CHMOD {:o} {path}", p & 0o7777))).await;
        }
    }
}

/* ------------------------------------------------------------------ Parsing */

fn perms_from_text(p: &str) -> String {
    let b = p.as_bytes();
    if b.len() < 10 {
        return "644".into();
    }
    let mut mode = 0u32;
    for (i, c) in b[1..10].iter().enumerate() {
        if *c != b'-' && *c != b'S' && *c != b'T' {
            mode |= 1 << (8 - i);
        }
    }
    perms_string(mode)
}

/// One line of MLSD / MLST: "type=file;size=12;modify=20261027120000; name".
pub fn parse_mlsx(line: &str) -> Option<FileEntry> {
    let (facts, name) = line.split_once(' ')?;
    if name.is_empty() {
        return None;
    }
    let mut e = FileEntry { name: name.to_string(), kind: "file".into(), size: 0, mtime: 0, perms: "644".into(), owner: String::new(), group: String::new(), link: None, hidden: 0 };
    for fact in facts.split(';').filter(|f| !f.is_empty()) {
        let (k, v) = fact.split_once('=')?;
        match k.to_lowercase().as_str() {
            "type" => {
                let v = v.to_lowercase();
                if v == "cdir" || v == "pdir" {
                    return None;
                }
                if v == "dir" {
                    e.kind = "dir".into();
                } else if let Some(target) = v.strip_prefix("os.unix=slink:") {
                    e.link = Some(target.to_string());
                } else if v.starts_with("os.unix=symlink") {
                    e.link = Some(String::new());
                }
            }
            "size" | "sizd" => e.size = v.parse().unwrap_or(0),
            "modify" => e.mtime = parse_mlsx_time(v).unwrap_or(0),
            "unix.mode" => e.perms = perms_string(u32::from_str_radix(v.trim_start_matches("0o").trim_start_matches('0'), 8).unwrap_or(0o644)),
            "unix.owner" | "unix.ownername" => e.owner = v.to_string(),
            "unix.group" | "unix.groupname" => e.group = v.to_string(),
            _ => {}
        }
    }
    if e.kind == "dir" {
        e.size = 0;
    }
    Some(e)
}

/// "20261027123456" or "20261027123456.123" (UTC) to milliseconds.
fn parse_mlsx_time(v: &str) -> Option<i64> {
    let (main, frac) = v.split_once('.').unwrap_or((v, ""));
    let t = chrono::NaiveDateTime::parse_from_str(main, "%Y%m%d%H%M%S").ok()?;
    let ms: i64 = frac.get(..3.min(frac.len())).and_then(|f| format!("{f:0<3}").parse().ok()).unwrap_or(0);
    Some(t.and_utc().timestamp_millis() + ms)
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// One line of LIST in Unix ("drwxr-xr-x 2 u g 4096 Oct 27 12:34 name") or
/// DOS/IIS format ("10-27-26  12:34PM <DIR> name"). Times are server-local.
pub fn parse_list_line(line: &str, tz_offset_min: i32) -> Option<FileEntry> {
    let line = line.trim_end();
    if line.is_empty() || line.starts_with("total ") {
        return None;
    }
    let offset_ms = tz_offset_min as i64 * 60_000;
    let first = line.chars().next()?;
    if "dl-bcps".contains(first) && line.len() > 10 {
        // Field positions by walking over whitespace-separated tokens.
        let mut fields: Vec<(usize, &str)> = Vec::new();
        let mut start = None;
        for (i, c) in line.char_indices() {
            match (c.is_whitespace(), start) {
                (false, None) => start = Some(i),
                (true, Some(s)) => {
                    fields.push((s, &line[s..i]));
                    start = None;
                    if fields.len() >= 9 {
                        break;
                    }
                }
                _ => {}
            }
        }
        if let Some(s) = start {
            fields.push((s, &line[s..]));
        }
        // Find the month: owner/group columns vary between servers.
        let mi = (3..fields.len().saturating_sub(2)).find(|&i| MONTHS.contains(&fields[i].1.to_lowercase().as_str()))?;
        if mi + 3 > fields.len() {
            return None;
        }
        let size: u64 = fields[mi - 1].1.parse().unwrap_or(0);
        let month = MONTHS.iter().position(|m| *m == fields[mi].1.to_lowercase())? as u32 + 1;
        let day: u32 = fields[mi + 1].1.parse().ok()?;
        let ty = fields[mi + 2].1;
        let name_start = fields.get(mi + 3).map(|f| f.0)?;
        let mut name = line[name_start..].to_string();
        let now = chrono::Utc::now();
        let mtime = if let Some((h, m)) = ty.split_once(':') {
            use chrono::Datelike;
            let mut year = now.year();
            let make = |y: i32| chrono::NaiveDate::from_ymd_opt(y, month, day).and_then(|d| d.and_hms_opt(h.parse().ok()?, m.parse().ok()?, 0));
            let mut t = make(year)?;
            // Without a year the date is within the last half year.
            if t.and_utc().timestamp_millis() - offset_ms > now.timestamp_millis() + 86_400_000 {
                year -= 1;
                t = make(year)?;
            }
            t.and_utc().timestamp_millis() - offset_ms
        } else {
            let y: i32 = ty.parse().ok()?;
            chrono::NaiveDate::from_ymd_opt(y, month, day)?.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() - offset_ms
        };
        let mut link = None;
        if first == 'l' {
            if let Some((n, target)) = name.clone().split_once(" -> ") {
                name = n.to_string();
                link = Some(target.to_string());
            }
        }
        let is_dir = first == 'd';
        return Some(FileEntry {
            name,
            kind: if is_dir { "dir".into() } else { "file".into() },
            size: if is_dir { 0 } else { size },
            mtime,
            perms: perms_from_text(fields[0].1),
            owner: fields.get(2).map(|f| f.1.to_string()).unwrap_or_default(),
            group: if mi >= 5 { fields[3].1.to_string() } else { String::new() },
            link,
            hidden: 0,
        });
    }
    // DOS: "10-27-26  12:34PM       <DIR>          name"
    // The name starts after the third token; searching for the size text
    // could match inside the date ("0" in "10-27-26").
    let mut rest = line;
    let mut token = || {
        rest = rest.trim_start();
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let (t, r) = rest.split_at(end);
        rest = r;
        (!t.is_empty()).then_some(t)
    };
    let date = token()?;
    let time = token()?;
    let what = token()?;
    let name = rest.trim_start().to_string();
    if name.is_empty() {
        return None;
    }
    let d = chrono::NaiveDate::parse_from_str(date, "%m-%d-%y").or_else(|_| chrono::NaiveDate::parse_from_str(date, "%m-%d-%Y")).ok()?;
    let t = chrono::NaiveTime::parse_from_str(time, "%I:%M%p").or_else(|_| chrono::NaiveTime::parse_from_str(time, "%H:%M")).ok()?;
    let is_dir = what.eq_ignore_ascii_case("<DIR>");
    Some(FileEntry {
        name,
        kind: if is_dir { "dir".into() } else { "file".into() },
        size: if is_dir { 0 } else { what.parse().ok()? },
        mtime: d.and_time(t).and_utc().timestamp_millis() - offset_ms,
        perms: if is_dir { "755".into() } else { "644".into() },
        owner: String::new(),
        group: String::new(),
        link: None,
        hidden: 0,
    })
}

/* ------------------------------------------------------------------ Connection */

/// Runs a browse operation on an idle session; a broken session is replaced once.
macro_rules! with_session {
    ($self:ident, |$s:ident| $body:expr) => {{
        let mut $s = $self.take().await?;
        let mut result = $body.await;
        if matches!(&result, Err(e) if e.kind == ErrorKind::ConnectionLost) {
            $s = $self.fresh().await?;
            result = $body.await;
        }
        if !matches!(&result, Err(e) if e.kind == ErrorKind::ConnectionLost) {
            $self.put($s).await;
        }
        result
    }};
}

impl FtpConn {
    pub async fn connect(params: FtpParams, known: Arc<KnownHosts>) -> AppResult<FtpConn> {
        let host_id = format!("ftps://{}:{}", params.host, params.port);
        let (tls, seen) = if params.tls == "none" {
            (None, None)
        } else {
            let (config, seen) = crate::tls::client_config(known.clone(), host_id.clone(), params.trust.clone(), params.tls13_only);
            let name = crate::tls::server_name(&params.host).map_err(|_| AppError::other("Ungültiger Servername für TLS."))?;
            (Some((config, name)), Some(seen))
        };
        let shared = Arc::new(Shared { params, tls, seen, host_id, known, feats: Mutex::new(Feats::default()), feats_known: Default::default() });
        let mut s = Session::open(shared.clone()).await?;
        let home = s.pwd().await?;
        let conn = FtpConn { shared, idle: tokio::sync::Mutex::new(vec![]), home };
        conn.put(s).await;
        Ok(conn)
    }

    /// An idle session (checked with NOOP after a pause) or a new one.
    async fn take(&self) -> AppResult<Session> {
        loop {
            let s = self.idle.lock().await.pop();
            match s {
                None => return Session::open(self.shared.clone()).await,
                Some(mut s) => {
                    if s.last_used.elapsed() < Duration::from_secs(20) || matches!(s.cmd("NOOP", None).await, Ok((200, _))) {
                        return Ok(s);
                    }
                }
            }
        }
    }

    async fn fresh(&self) -> AppResult<Session> {
        Session::open(self.shared.clone()).await
    }

    async fn put(&self, s: Session) {
        if s.broken {
            return;
        }
        let mut idle = self.idle.lock().await;
        if idle.len() < 4 {
            idle.push(s);
        }
    }

    pub async fn close(&self) {
        for mut s in self.idle.lock().await.drain(..) {
            let _ = s.cmd("QUIT", None).await;
        }
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        with_session!(self, |s| s.list(path))
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        with_session!(self, |s| s.stat(path))
    }

    pub async fn exists(&self, path: &str) -> bool {
        self.try_exists(path).await.unwrap_or(false)
    }

    async fn try_exists(&self, path: &str) -> AppResult<bool> {
        with_session!(self, |s| s.exists(path))
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        with_session!(self, |s| s.mkdir(path))
    }

    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        with_session!(self, |s| s.mkdir_all(path))
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        if self.exists(to).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("„{}“ gibt es hier schon.", remote_name(to))));
        }
        with_session!(self, |s| s.rename(from, to))
    }

    pub async fn remove(&self, path: &str) -> AppResult<()> {
        with_session!(self, |s| s.remove(path))
    }

    pub async fn remove_file(&self, path: &str) -> AppResult<()> {
        with_session!(self, |s| s.delete_file(path))
    }

    pub async fn chmod(&self, path: &str, mode: u32, recursive: bool) -> AppResult<()> {
        with_session!(self, |s| s.chmod(path, mode, recursive))
    }

    pub async fn set_attrs(&self, path: &str, mtime: Option<u32>, perms: Option<u32>) {
        if let Ok(mut s) = self.take().await {
            s.set_attrs(path, mtime, perms).await;
            self.put(s).await;
        }
    }

    pub async fn walk(&self, path: &str) -> AppResult<Vec<WalkItem>> {
        let base = remote_parent(path);
        let root = self.stat(path).await?;
        let mut out = Vec::new();
        if root.kind != "dir" {
            out.push(WalkItem { path: path.to_string(), relative: path.strip_prefix(&base).unwrap_or(path).trim_start_matches('/').to_string(), size: root.size, mtime: root.mtime });
            return Ok(out);
        }
        let mut stack = vec![path.to_string()];
        while let Some(dir) = stack.pop() {
            for e in self.list(&dir).await? {
                let p = remote_join(&dir, &e.name);
                if e.kind == "dir" {
                    if e.link.is_none() {
                        stack.push(p);
                    }
                } else {
                    let rel = p.strip_prefix(&base).unwrap_or(&p).trim_start_matches('/').to_string();
                    out.push(WalkItem { path: p, relative: rel, size: e.size, mtime: e.mtime });
                }
            }
        }
        Ok(out)
    }

    /// Opens a file for reading from `offset`. The session stays with the
    /// transfer and goes back to the pool in `finish`.
    pub async fn reader(self: &Arc<Self>, path: &str, offset: u64) -> AppResult<(Io, FtpFinish)> {
        let mut s = self.take().await?;
        let kind = s.kind_for(path);
        s.set_type(kind).await?;
        if offset > 0 {
            s.expect("REST", Some(&offset.to_string()), &[350], "Fortsetzen").await?;
        }
        let io = s.data("RETR", Some(path), &format!("„{}“ lesen", remote_name(path))).await?;
        Ok((io, FtpFinish { conn: self.clone(), session: Some(s), what: "Lesen".into() }))
    }

    /// Opens a file for writing; `append` continues a partial file.
    pub async fn writer(self: &Arc<Self>, path: &str, append: bool) -> AppResult<(Io, FtpFinish)> {
        let mut s = self.take().await?;
        let kind = s.kind_for(path);
        s.set_type(kind).await?;
        let io = s.data(if append { "APPE" } else { "STOR" }, Some(path), &format!("„{}“ schreiben", remote_name(path))).await?;
        Ok((io, FtpFinish { conn: self.clone(), session: Some(s), what: "Schreiben".into() }))
    }

    /// Text mode changes sizes, so resuming is only safe in binary mode.
    pub fn binary_for(&self, path: &str) -> bool {
        match self.shared.params.mode.as_str() {
            "ascii" => false,
            "auto" => {
                let name = remote_name(path).to_lowercase();
                let ext = name.rsplit('.').next().unwrap_or("");
                !(name.contains('.') && TEXT_EXT.contains(&ext))
            }
            _ => true,
        }
    }
}

/// Closes a data connection after writing. Reads until the server closes it,
/// so TLS 1.3 session tickets sent on it are taken up; the next data
/// connection needs one to resume the session (servers like vsftpd insist).
pub async fn close_data(mut io: Io) -> AppResult<()> {
    io.shutdown().await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Datei konnte nicht abgeschlossen werden.").with_detail(e.to_string()))?;
    let mut sink = [0u8; 4096];
    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        while let Ok(n) = io.read(&mut sink).await {
            if n == 0 {
                break;
            }
        }
    })
    .await;
    Ok(())
}

/// Ends a transfer: waits for the server's confirmation and returns the
/// session to the pool.
pub struct FtpFinish {
    conn: Arc<FtpConn>,
    session: Option<Session>,
    what: String,
}

impl FtpFinish {
    pub async fn finish(mut self) -> AppResult<()> {
        let mut s = self.session.take().expect("session");
        let r = s.finish_data(&self.what).await;
        if r.is_ok() {
            self.conn.put(s).await;
        }
        r
    }

    /// The transfer was stopped early: the session is in an unknown state and is dropped.
    pub fn abandon(mut self) {
        self.session.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unix_list_lines() {
        let e = parse_list_line("-rw-r--r--    1 1000     1000         1234 Jan 05  2024 bot file.py", 0).unwrap();
        assert_eq!((e.name.as_str(), e.kind.as_str(), e.size, e.perms.as_str()), ("bot file.py", "file", 1234, "644"));
        assert_eq!(e.mtime, chrono::NaiveDate::from_ymd_opt(2024, 1, 5).unwrap().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis());
        let d = parse_list_line("drwxr-xr-x    2 ftp ftp 4096 Mar 01 10:20 cogs", 60).unwrap();
        assert_eq!((d.name.as_str(), d.kind.as_str(), d.perms.as_str()), ("cogs", "dir", "755"));
        let l = parse_list_line("lrwxrwxrwx 1 u g 7 Feb 2 2025 web -> /var/www", 0).unwrap();
        assert_eq!((l.name.as_str(), l.link.as_deref()), ("web", Some("/var/www")));
        // Without group column.
        let n = parse_list_line("-rw-r--r-- 1 owner 99 Dec 24 2023 x.txt", 0).unwrap();
        assert_eq!((n.name.as_str(), n.size), ("x.txt", 99));
        assert!(parse_list_line("total 12", 0).is_none());
    }

    #[test]
    fn parses_dos_list_lines() {
        let e = parse_list_line("10-27-26  12:34PM       <DIR>          Neuer Ordner", 0).unwrap();
        assert_eq!((e.name.as_str(), e.kind.as_str()), ("Neuer Ordner", "dir"));
        let f = parse_list_line("10-27-26  09:05AM                 2048 a b.txt", 0).unwrap();
        assert_eq!((f.name.as_str(), f.size), ("a b.txt", 2048));
        // Sizes that also appear in the date must not shift the name.
        let z = parse_list_line("10-27-26  09:05AM                    0 empty.txt", 0).unwrap();
        assert_eq!((z.name.as_str(), z.size), ("empty.txt", 0));
        let t = parse_list_line("10-27-26  09:05AM                   27 x.txt", 0).unwrap();
        assert_eq!((t.name.as_str(), t.size), ("x.txt", 27));
    }

    #[test]
    fn parses_mlsd() {
        let e = parse_mlsx("type=file;size=12;modify=20261027120000;unix.mode=0640; name with space.txt").unwrap();
        assert_eq!((e.name.as_str(), e.size, e.perms.as_str()), ("name with space.txt", 12, "640"));
        assert_eq!(e.mtime, chrono::NaiveDate::from_ymd_opt(2026, 10, 27).unwrap().and_hms_opt(12, 0, 0).unwrap().and_utc().timestamp_millis());
        assert!(parse_mlsx("type=cdir;modify=20261027120000; .").is_none());
        assert_eq!(parse_mlsx("type=dir;modify=20261027120000; sub").unwrap().kind, "dir");
    }

    #[test]
    fn maps_reply_errors() {
        assert_eq!(reply_error(530, "Login incorrect.", "x").kind, ErrorKind::AuthFailed);
        assert_eq!(reply_error(550, "Permission denied.", "x").kind, ErrorKind::PermissionDenied);
        assert_eq!(reply_error(550, "Failed to open file.", "x").kind, ErrorKind::NotFound);
        assert_eq!(reply_error(550, "Create directory operation failed. File exists", "x").kind, ErrorKind::AlreadyExists);
    }
}

/// Integration tests against real FTP servers (plain, explicit and implicit
/// TLS). They run only when `BITCRANE_TEST_FTP=host:plain,explicit,implicit`
/// is set, e.g. `127.0.0.1:2121,2990,2991`.
#[cfg(test)]
mod integration {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn env() -> Option<(String, Vec<u16>)> {
        let v = std::env::var("BITCRANE_TEST_FTP").ok()?;
        let (host, ports) = v.split_once(':')?;
        Some((host.to_string(), ports.split(',').filter_map(|p| p.parse().ok()).collect()))
    }

    fn params(host: &str, port: u16, tls: &str, trust: Option<String>) -> FtpParams {
        FtpParams { timeout: None,
            host: host.into(), port, user: "test".into(), password: Some("geheim123".into()), tls: tls.into(), tls13_only: false,
            encoding: "utf8".into(), tz_offset_min: 0, mode: "binary".into(), trust, proxy: None,
        }
    }

    async fn round_trip(conn: Arc<FtpConn>) {
        let base = remote_join(&conn.home, &format!("bitcrane-ftp-{}", uuid::Uuid::new_v4().simple()));
        conn.mkdir_all(&format!("{base}/a b/c")).await.unwrap();
        assert!(conn.exists(&format!("{base}/a b")).await);
        let file = format!("{base}/a b/über.txt");
        let (mut w, fin) = conn.writer(&file, false).await.unwrap();
        w.write_all(b"hallo ").await.unwrap();
        close_data(w).await.unwrap();
        fin.finish().await.unwrap();
        let (mut w, fin) = conn.writer(&file, true).await.unwrap();
        w.write_all(b"welt").await.unwrap();
        close_data(w).await.unwrap();
        fin.finish().await.unwrap();
        let st = conn.stat(&file).await.unwrap();
        assert_eq!((st.size, st.kind.as_str()), (10, "file"));
        let (mut r, fin) = conn.reader(&file, 6).await.unwrap();
        let mut got = String::new();
        r.read_to_string(&mut got).await.unwrap();
        drop(r);
        fin.finish().await.unwrap();
        assert_eq!(got, "welt");
        let names: Vec<String> = conn.list(&format!("{base}/a b")).await.unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["c".to_string(), "über.txt".to_string()]);
        conn.chmod(&file, 0o600, false).await.unwrap();
        assert_eq!(conn.stat(&file).await.unwrap().perms, "600");
        conn.rename(&file, &format!("{base}/neu.txt")).await.unwrap();
        assert_eq!(conn.rename(&format!("{base}/neu.txt"), &format!("{base}/a b")).await.err().map(|e| e.kind), Some(ErrorKind::AlreadyExists));
        assert_eq!(conn.walk(&base).await.unwrap().len(), 1);
        assert_eq!(conn.stat(&format!("{base}/fehlt")).await.err().map(|e| e.kind), Some(ErrorKind::NotFound));
        // Many operations in a row use the pooled sessions.
        for _ in 0..5 {
            conn.list(&base).await.unwrap();
        }
        conn.remove(&base).await.unwrap();
        assert!(!conn.exists(&base).await);
    }

    #[tokio::test]
    async fn ftp_plain_and_tls() {
        let Some((host, ports)) = env() else { return };
        let dir = tempfile::tempdir().unwrap();
        let known = Arc::new(KnownHosts::load(dir.path().join("known.json")));

        // Plain FTP; wrong password is reported as such.
        let mut bad = params(&host, ports[0], "none", None);
        bad.password = Some("falsch".into());
        assert_eq!(FtpConn::connect(bad, known.clone()).await.err().map(|e| e.kind), Some(ErrorKind::AuthFailed));
        let conn = Arc::new(FtpConn::connect(params(&host, ports[0], "none", None), known.clone()).await.expect("plain ftp"));
        assert!(conn.home.starts_with('/'));
        round_trip(conn.clone()).await;
        // Explicit TLS demanded from a server: works; self-signed certificate must be confirmed first.
        for (port, tls) in ports.iter().skip(1).copied().zip(["explicit", "implicit"]) {
            let err = FtpConn::connect(params(&host, port, tls, None), known.clone()).await.err().expect("unknown certificate");
            assert_eq!(err.kind, ErrorKind::HostKeyUnknown, "{tls}: {err:?}");
            let fp = err.host_key.unwrap().fingerprint;
            let conn = Arc::new(FtpConn::connect(params(&host, port, tls, Some(fp)), known.clone()).await.unwrap_or_else(|e| panic!("{tls}: {e:?}")));
            round_trip(conn).await;
        }
        // Plain FTP to a server that insists on TLS fails with a clear message.
        if let Some(&p) = ports.get(1) {
            assert!(FtpConn::connect(params(&host, p, "none", None), known.clone()).await.is_err());
        }
    }
}
