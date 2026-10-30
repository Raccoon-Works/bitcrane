//! Command line for scripts: transfers with saved servers, without a window.
//!
//! ```text
//! bitcrane servers
//! bitcrane ls <server>[:<path>]
//! bitcrane upload <local>... --to <server>[:<folder>]
//! bitcrane download <server>:<path>... [--to <local folder>]
//! ```
//!
//! Servers are the ones saved in Bitcrane (matched by name, case-insensitive,
//! or by id). Passwords and passphrases come from the system keychain, host
//! keys and certificates must have been confirmed once in the app. Exit code:
//! 0 success, 1 a transfer or connection failed, 2 wrong usage.
//!
//! On Windows Bitcrane is a windowed program, so the command line attaches to
//! the console it was started from.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::paths::{remote_join, remote_name, to_ui};
use crate::remote::Remote;
use crate::ssh::KnownHosts;
use crate::transfer::{TransferOptions, RUN};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::AtomicU8;
use std::sync::Arc;

const COMMANDS: [&str; 6] = ["servers", "ls", "upload", "download", "help", "--help"];

const USAGE: &str = "Bitcrane command line

  bitcrane servers                                  saved servers
  bitcrane ls <server>[:<path>]                     list a server folder
  bitcrane upload <local>... --to <server>[:<dir>]  upload files and folders
  bitcrane download <server>:<path>... [--to <dir>] download (default: current folder)

  <server> is the name of a server saved in Bitcrane (or its id). Without a
  path, the server's start folder is used. Passwords come from the system
  keychain; connect once in the app to confirm host keys and save passwords.

Options:
  --quiet   only print errors
";

/// Runs a command when Bitcrane was started with one; `None` starts the app.
pub fn run_from_args() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let first = args.first()?;
    if !COMMANDS.contains(&first.as_str()) {
        return None;
    }
    attach_console();
    if first == "help" || first == "--help" {
        print!("{USAGE}");
        return Some(0);
    }
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("bitcrane: {e}");
            return Some(1);
        }
    };
    Some(rt.block_on(run(args)))
}

#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    // SAFETY: plain Win32 call without pointers; fails harmlessly without a parent console.
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn attach_console() {}

fn config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| crate::paths::home().join(".config")).join("de.raccoonworks.bitcrane")
}

struct Ctx {
    servers: Vec<Value>,
    settings: Value,
    known: Arc<KnownHosts>,
    quiet: bool,
}

async fn run(mut args: Vec<String>) -> i32 {
    let quiet = take_flag(&mut args, "--quiet");
    let dir = config_dir();
    let config = match crate::config::load(&dir) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("bitcrane: {}", e.message);
            return 1;
        }
    };
    let ctx = Ctx {
        servers: config.get("servers").and_then(Value::as_array).cloned().unwrap_or_default(),
        settings: config.get("settings").cloned().unwrap_or(Value::Null),
        known: Arc::new(KnownHosts::load(dir.join("known_hosts.json"))),
        quiet,
    };
    let command = args.remove(0);
    let result = match command.as_str() {
        "servers" => {
            servers(&ctx);
            Ok(())
        }
        "ls" => ls(&ctx, &args).await,
        "upload" => upload(&ctx, args).await,
        "download" => download(&ctx, args).await,
        _ => Err(usage("unknown command")),
    };
    match result {
        Ok(()) => 0,
        Err(e) if e.kind == ErrorKind::Other && e.detail.as_deref() == Some("usage") => {
            eprintln!("bitcrane: {}\n\n{USAGE}", e.message);
            2
        }
        Err(e) => {
            match &e.detail {
                Some(d) if d != "usage" => eprintln!("bitcrane: {} ({d})", e.message),
                _ => eprintln!("bitcrane: {}", e.message),
            }
            1
        }
    }
}

fn usage(message: &str) -> AppError {
    AppError::other(message.to_string()).with_detail("usage")
}

fn take_flag(args: &mut Vec<String>, flag: &str) -> bool {
    let before = args.len();
    args.retain(|a| a != flag);
    args.len() != before
}

fn take_option(args: &mut Vec<String>, name: &str) -> AppResult<Option<String>> {
    let Some(i) = args.iter().position(|a| a == name) else { return Ok(None) };
    if i + 1 >= args.len() {
        return Err(usage(&format!("{name} needs a value")));
    }
    let v = args.remove(i + 1);
    args.remove(i);
    Ok(Some(v))
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn servers(ctx: &Ctx) {
    for s in &ctx.servers {
        let protocol = match str_of(s, "protocol") {
            "" => "sftp",
            p => p,
        };
        println!("{}\t{}\t{}@{}:{}", str_of(s, "name"), protocol, str_of(s, "user"), str_of(s, "host"), s.get("port").and_then(Value::as_u64).unwrap_or(0));
    }
}

/// "name:path" -> (server, path). A Windows drive ("C:\x") is not a server.
fn split_target<'a>(ctx: &'a Ctx, spec: &str) -> AppResult<(&'a Value, Option<String>)> {
    let (name, path) = match spec.split_once(':') {
        Some((n, p)) => (n, Some(p.to_string()).filter(|p| !p.is_empty())),
        None => (spec, None),
    };
    let found = ctx.servers.iter().find(|s| str_of(s, "id") == name).or_else(|| ctx.servers.iter().find(|s| str_of(s, "name").eq_ignore_ascii_case(name)));
    found.map(|s| (s, path)).ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("No saved server called \"{name}\" (see: bitcrane servers).")))
}

fn secret(account: &str) -> Option<String> {
    crate::config::secret_get(account).ok().flatten()
}

/// Login data for SSH, built like the app does (live.ts buildAuth).
fn ssh_params(ctx: &Ctx, s: &Value, depth: u8) -> AppResult<crate::ssh::ConnectParams> {
    let host = str_of(s, "host");
    let port = s.get("port").and_then(Value::as_u64).unwrap_or(22);
    let user = str_of(s, "user");
    let key_path = str_of(s, "keyPath");
    let password = secret(&format!("password:{user}@{host}:{port}"));
    let passphrase = secret(&format!("passphrase:{key_path}"));
    let auth = match str_of(s, "auth") {
        "key" => json!({ "method": "key", "path": key_path, "passphrase": passphrase }),
        "agent" => json!({ "method": "agent" }),
        "password" => match password {
            Some(p) => json!({ "method": "password", "password": p }),
            None => return Err(AppError::new(ErrorKind::PasswordRequired, format!("No password saved for {}. Connect once in Bitcrane and save it.", str_of(s, "name")))),
        },
        _ => json!({ "method": "auto", "keyPath": if key_path.is_empty() { Value::Null } else { json!(key_path) }, "passphrase": passphrase, "password": password }),
    };
    let jump = match s.get("jumpServerId").and_then(Value::as_str) {
        Some(id) if depth < 4 && id != str_of(s, "id") => match ctx.servers.iter().find(|x| str_of(x, "id") == id) {
            Some(j) => Some(Box::new(ssh_params(ctx, j, depth + 1)?)),
            None => None,
        },
        _ => None,
    };
    let mut params: crate::ssh::ConnectParams = serde_json::from_value(json!({
        "host": host, "port": port, "user": user, "auth": auth,
        "keepalive": true, "scp": s.get("scp").and_then(Value::as_bool).unwrap_or(false),
    }))
    .map_err(|e| AppError::other("Server entry not readable.").with_detail(e.to_string()))?;
    params.jump = jump;
    params.proxy = proxy(s);
    Ok(params)
}

fn proxy(s: &Value) -> Option<crate::proxy::ProxyParams> {
    let p = s.get("proxy")?;
    let host = str_of(p, "host");
    if host.is_empty() {
        return None;
    }
    let port = p.get("port").and_then(Value::as_u64).unwrap_or(1080);
    let user = p.get("user").and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_string);
    let password = user.as_ref().and_then(|u| secret(&format!("proxy:{u}@{host}:{port}")));
    Some(crate::proxy::ProxyParams { kind: str_of(p, "kind").to_string(), host: host.to_string(), port: port as u16, user, password })
}

/// Connects to a saved server with any protocol.
async fn connect(ctx: &Ctx, s: &Value) -> AppResult<Remote> {
    let name = str_of(s, "name");
    if !ctx.quiet {
        eprintln!("Connecting to {name} ...");
    }
    let host = str_of(s, "host").to_string();
    let port = s.get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
    let user = str_of(s, "user").to_string();
    let password = || secret(&format!("password:{user}@{host}:{port}"));
    let cloud_token = || secret(&format!("cloud:{}", str_of(s, "id"))).ok_or_else(|| AppError::new(ErrorKind::AuthFailed, format!("{name} is not signed in. Sign in once in Bitcrane.")));
    let protocol = str_of(s, "protocol");
    let conn = match protocol {
        "ftp" | "ftps" => {
            let tls = if protocol == "ftp" { "none" } else if s.get("implicitTls").and_then(Value::as_bool).unwrap_or(false) { "implicit" } else { "explicit" };
            let params = crate::ftp::FtpParams {
                host: host.clone(),
                port,
                user: user.clone(),
                password: password(),
                tls: tls.into(),
                tls13_only: s.get("tls13Only").and_then(Value::as_bool).unwrap_or(false),
                encoding: s.get("ftpEncoding").and_then(Value::as_str).unwrap_or("utf8").into(),
                tz_offset_min: s.get("ftpTimezone").and_then(Value::as_i64).unwrap_or(0) as i32,
                mode: s.get("ftpMode").and_then(Value::as_str).unwrap_or("binary").into(),
                trust: None,
                proxy: proxy(s),
            };
            Remote::Ftp(Arc::new(crate::ftp::FtpConn::connect(params, ctx.known.clone()).await?))
        }
        "webdav" => {
            let https = s.get("davHttps").and_then(Value::as_bool).unwrap_or(true);
            let port_part = if port == 0 || port == if https { 443 } else { 80 } { String::new() } else { format!(":{port}") };
            let path = match str_of(s, "davPath") {
                "" => "/".to_string(),
                p if p.starts_with('/') => p.to_string(),
                p => format!("/{p}"),
            };
            let url = format!("{}://{host}{port_part}{path}", if https { "https" } else { "http" });
            let params = crate::dav::DavParams { url, user: user.clone(), password: password(), tls13_only: s.get("tls13Only").and_then(Value::as_bool).unwrap_or(false), trust: None, proxy: proxy(s) };
            Remote::Dav(crate::dav::DavConn::connect(params, ctx.known.clone()).await?)
        }
        "s3" => {
            let http = s.get("s3Http").and_then(Value::as_bool).unwrap_or(false);
            let port_part = if port == 0 || port == if http { 80 } else { 443 } { String::new() } else { format!(":{port}") };
            let params = crate::s3::S3Params {
                endpoint: format!("{}://{host}{port_part}", if http { "http" } else { "https" }),
                region: str_of(s, "s3Region").to_string(),
                bucket: str_of(s, "s3Bucket").to_string(),
                access_key: user.clone(),
                secret: password(),
                path_style: s.get("s3PathStyle").and_then(Value::as_bool).unwrap_or(false),
                tls13_only: s.get("tls13Only").and_then(Value::as_bool).unwrap_or(false),
                trust: None,
                proxy: proxy(s),
            };
            Remote::S3(Arc::new(crate::s3::S3Conn::connect(params, ctx.known.clone()).await?))
        }
        "smb" => {
            let params = crate::smb::SmbParams {
                host: host.clone(),
                port: if port == 0 { 445 } else { port },
                user: user.clone(),
                password: password(),
                share: str_of(s, "smbShare").to_string(),
                encrypt: s.get("smbEncrypt").and_then(Value::as_bool).unwrap_or(false),
            };
            Remote::Smb(Arc::new(crate::smb::SmbConn::connect(params).await?))
        }
        "dropbox" => Remote::Dropbox(Arc::new(crate::dropbox::DropboxConn::connect(crate::dropbox::DropboxParams { refresh_token: cloud_token()? }).await?)),
        "onedrive" => {
            let conn = Arc::new(crate::onedrive::OneDriveConn::connect(crate::onedrive::OneDriveParams { refresh_token: cloud_token()? }).await?);
            // Microsoft renews the sign-in with each use; keep the newest one.
            let _ = crate::config::secret_set(&format!("cloud:{}", str_of(s, "id")), &conn.refresh_token().await);
            Remote::OneDrive(conn)
        }
        "gdrive" => {
            let client_id = str_of(&ctx.settings, "googleClientId").trim().to_string();
            let client_secret = secret("cloud-client:gdrive").unwrap_or_default();
            if client_id.is_empty() || client_secret.is_empty() {
                return Err(AppError::other("The Google app key is missing. Enter it once in Bitcrane."));
            }
            Remote::GDrive(Arc::new(crate::gdrive::GDriveConn::connect(crate::gdrive::GDriveParams { refresh_token: cloud_token()?, client_id, client_secret }).await?))
        }
        _ => crate::remote::connect_ssh(&ssh_params(ctx, s, 0)?, ctx.known.clone(), None).await.map_err(|e| match e.kind {
            ErrorKind::HostKeyUnknown | ErrorKind::HostKeyChanged => AppError::new(e.kind, format!("The host key of {name} is not confirmed. Connect once in Bitcrane.")),
            _ => e,
        })?,
    };
    Ok(conn)
}

/// The folder a command works in: the given path, else the server's start folder.
fn start_dir(conn: &Remote, s: &Value, path: Option<String>) -> String {
    match path {
        Some(p) if p.starts_with('/') => p,
        Some(p) => remote_join(conn.home(), &p),
        None => match str_of(s, "remoteStart") {
            p if p.starts_with('/') => p.to_string(),
            _ => conn.home().to_string(),
        },
    }
}

async fn ls(ctx: &Ctx, args: &[String]) -> AppResult<()> {
    let [spec] = args else { return Err(usage("ls needs exactly one <server>[:<path>]")) };
    let (s, path) = split_target(ctx, spec)?;
    let conn = connect(ctx, s).await?;
    let dir = start_dir(&conn, s, path);
    let list = conn.list(&dir).await;
    conn.close().await;
    for e in list? {
        let when = chrono::DateTime::from_timestamp_millis(e.mtime).map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default();
        let size = if e.kind == "dir" { "-".to_string() } else { e.size.to_string() };
        println!("{}\t{size}\t{when}\t{}", if e.kind == "dir" { "d" } else { "f" }, if e.kind == "dir" { format!("{}/", e.name) } else { e.name });
    }
    Ok(())
}

fn options(ctx: &Ctx) -> TransferOptions {
    let st = &ctx.settings;
    TransferOptions {
        temp_name: st.get("uploadTempName").and_then(Value::as_bool).unwrap_or(true),
        keep_mtime: st.get("keepMtime").and_then(Value::as_bool).unwrap_or(true),
        ..Default::default()
    }
}

async fn upload(ctx: &Ctx, mut args: Vec<String>) -> AppResult<()> {
    let to = take_option(&mut args, "--to")?.ok_or_else(|| usage("upload needs --to <server>[:<folder>]"))?;
    if args.is_empty() {
        return Err(usage("upload needs at least one local file or folder"));
    }
    let (s, path) = split_target(ctx, &to)?;
    let conn = connect(ctx, s).await?;
    let dest = start_dir(&conn, s, path);
    let opts = options(ctx);
    let mut failed = 0;
    for local in &args {
        let abs = std::fs::canonicalize(local).map_err(|e| AppError::new(ErrorKind::NotFound, format!("\"{local}\" not found.")).with_detail(e.to_string()))?;
        let ui = to_ui(&abs);
        for item in crate::local::walk(&ui)? {
            let target = remote_join(&dest, &item.relative);
            match crate::transfer::upload(&conn, &item.path, &target, &opts, &|_, _| {}, Arc::new(AtomicU8::new(RUN))).await {
                Ok(n) => {
                    if !ctx.quiet {
                        println!("uploaded {target} ({n} bytes)");
                    }
                }
                Err(e) => {
                    failed += 1;
                    eprintln!("failed {target}: {}", e.message);
                }
            }
        }
    }
    conn.close().await;
    if failed > 0 {
        return Err(AppError::other(format!("{failed} file(s) failed.")));
    }
    Ok(())
}

async fn download(ctx: &Ctx, mut args: Vec<String>) -> AppResult<()> {
    let to = take_option(&mut args, "--to")?.unwrap_or_else(|| ".".into());
    if args.is_empty() {
        return Err(usage("download needs at least one <server>:<path>"));
    }
    let dest = std::fs::canonicalize(&to).map_err(|e| AppError::new(ErrorKind::NotFound, format!("Local folder \"{to}\" not found.")).with_detail(e.to_string()))?;
    let dest_ui = to_ui(&dest);
    let mut failed = 0;
    // One connection per server, even when several paths name the same one.
    let mut open: Vec<(String, Remote)> = Vec::new();
    for spec in &args {
        let (s, path) = split_target(ctx, spec)?;
        let Some(path) = path else { return Err(usage("download needs <server>:<path>")) };
        let id = str_of(s, "id").to_string();
        if !open.iter().any(|(i, _)| *i == id) {
            open.push((id.clone(), connect(ctx, s).await?));
        }
        let conn = &open.iter().find(|(i, _)| *i == id).expect("connected").1;
        let remote = if path.starts_with('/') { path } else { remote_join(conn.home(), &path) };
        let items = conn.walk(&remote).await?;
        if items.is_empty() {
            eprintln!("nothing to download in {}", remote_name(&remote));
        }
        for item in items {
            let target = remote_join(&dest_ui, &item.relative);
            match crate::transfer::download(conn, &item.path, &target, &options(ctx), &|_, _| {}, Arc::new(AtomicU8::new(RUN))).await {
                Ok(n) => {
                    if !ctx.quiet {
                        println!("downloaded {} ({n} bytes)", item.relative);
                    }
                }
                Err(e) => {
                    failed += 1;
                    eprintln!("failed {}: {}", item.path, e.message);
                }
            }
        }
    }
    for (_, c) in open {
        c.close().await;
    }
    if failed > 0 {
        return Err(AppError::other(format!("{failed} file(s) failed.")));
    }
    Ok(())
}
