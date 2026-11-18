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
//!
//! Everything it prints is English, as is usual for command lines and independent of the app's
//! language (docs/cli.md says so). Its own texts are written in English here; messages of the
//! core, whose keys are German, are printed with their English text from the interface's
//! dictionary (see `i18n.rs`).

use crate::error::{AppError, AppResult, ErrorKind, Message};
use crate::ftp::FtpTls;
use crate::model::EntryKind;
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
            eprintln!("bitcrane: {}", e.message.english());
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
            eprintln!("bitcrane: {}\n\n{USAGE}", e.message.english());
            2
        }
        Err(e) => {
            match &e.detail {
                Some(d) if d != "usage" => eprintln!("bitcrane: {} ({d})", e.message.english()),
                _ => eprintln!("bitcrane: {}", e.message.english()),
            }
            1
        }
    }
}

fn usage(message: impl Into<Message>) -> AppError {
    AppError::other(message).with_detail("usage")
}

fn take_flag(args: &mut Vec<String>, flag: &str) -> bool {
    let before = args.len();
    args.retain(|a| a != flag);
    args.len() != before
}

fn take_option(args: &mut Vec<String>, name: &str) -> AppResult<Option<String>> {
    let Some(i) = args.iter().position(|a| a == name) else { return Ok(None) };
    if i + 1 >= args.len() {
        return Err(usage(Message::new("{0} needs a value").param(name)));
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
        println!(
            "{}\t{}\t{}@{}:{}",
            str_of(s, "name"),
            protocol,
            str_of(s, "user"),
            str_of(s, "host"),
            s.get("port").and_then(Value::as_u64).unwrap_or(0)
        );
    }
}

/// Looks up a saved password or token by account name. The command line reads the system keychain;
/// tests pass their own.
type Secrets<'a> = &'a dyn Fn(&str) -> Option<String>;

fn keychain(account: &str) -> Option<String> {
    crate::config::secret_get(account).ok().flatten()
}

/// "name:path" -> (server, path). A Windows drive ("C:\x") is not a server.
fn find_target<'a>(servers: &'a [Value], spec: &str) -> AppResult<(&'a Value, Option<String>)> {
    let (name, path) = match spec.split_once(':') {
        Some((n, p)) => (n, Some(p.to_string()).filter(|p| !p.is_empty())),
        None => (spec, None),
    };
    let found = servers
        .iter()
        .find(|s| str_of(s, "id") == name)
        .or_else(|| servers.iter().find(|s| str_of(s, "name").eq_ignore_ascii_case(name)));
    found.map(|s| (s, path)).ok_or_else(|| {
        AppError::new(ErrorKind::NotFound, "No saved server called \"{0}\" (see: bitcrane servers).").param(name)
    })
}

/// Login data for SSH, built like the app does (live.ts buildAuth).
fn ssh_params(servers: &[Value], s: &Value, depth: u8, secrets: Secrets) -> AppResult<crate::ssh::ConnectParams> {
    let host = str_of(s, "host");
    let port = s.get("port").and_then(Value::as_u64).unwrap_or(22);
    let user = str_of(s, "user");
    let key_path = str_of(s, "keyPath");
    let password = secrets(&format!("password:{user}@{host}:{port}"));
    let passphrase = secrets(&format!("passphrase:{key_path}"));
    let auth = match str_of(s, "auth") {
        "key" => json!({ "method": "key", "path": key_path, "passphrase": passphrase }),
        "agent" => json!({ "method": "agent" }),
        "password" => match password {
            Some(p) => json!({ "method": "password", "password": p }),
            None => {
                return Err(AppError::new(
                    ErrorKind::PasswordRequired,
                    "No password saved for {0}. Connect once in Bitcrane and save it.",
                )
                .param(str_of(s, "name")))
            }
        },
        _ => {
            json!({ "method": "auto", "keyPath": if key_path.is_empty() { Value::Null } else { json!(key_path) }, "passphrase": passphrase, "password": password })
        }
    };
    let jump = match s.get("jumpServerId").and_then(Value::as_str) {
        Some(id) if depth < 4 && id != str_of(s, "id") => match servers.iter().find(|x| str_of(x, "id") == id) {
            Some(j) => Some(Box::new(ssh_params(servers, j, depth + 1, secrets)?)),
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
    params.proxy = proxy(s, secrets);
    Ok(params)
}

/// A stored server setting with a fixed set of values; an unknown value is refused instead of
/// silently becoming the default.
fn setting<T: serde::de::DeserializeOwned + Default>(s: &Value, key: &str) -> AppResult<T> {
    s.get(key).map_or(Ok(T::default()), |v| {
        serde_json::from_value(v.clone())
            .map_err(|e| AppError::other("Invalid {0}: {1}").param(key).param(e.to_string()))
    })
}

fn proxy(s: &Value, secrets: Secrets) -> Option<crate::proxy::ProxyParams> {
    let p = s.get("proxy")?;
    let host = str_of(p, "host");
    if host.is_empty() {
        return None;
    }
    let port = p.get("port").and_then(Value::as_u64).unwrap_or(1080);
    let user = p.get("user").and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_string);
    let password = user.as_ref().and_then(|u| secrets(&format!("proxy:{u}@{host}:{port}")));
    Some(crate::proxy::ProxyParams {
        kind: str_of(p, "kind").to_string(),
        host: host.to_string(),
        port: port as u16,
        user,
        password,
    })
}

/// Host, port (0 when not set: the protocol's default) and user of a server that is not SSH.
fn login(s: &Value) -> (String, u16, String) {
    let port = s.get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
    (str_of(s, "host").to_string(), port, str_of(s, "user").to_string())
}

fn saved_password(s: &Value, secrets: Secrets) -> Option<String> {
    let (host, port, user) = login(s);
    secrets(&format!("password:{user}@{host}:{port}"))
}

fn flag(s: &Value, key: &str, default: bool) -> bool {
    s.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// ":port" for a URL, empty for the default port of the scheme.
fn port_part(port: u16, default: u16) -> String {
    if port == 0 || port == default {
        String::new()
    } else {
        format!(":{port}")
    }
}

fn ftp_params(s: &Value, secrets: Secrets) -> AppResult<crate::ftp::FtpParams> {
    let (host, port, user) = login(s);
    let tls = if str_of(s, "protocol") == "ftp" {
        FtpTls::None
    } else if flag(s, "implicitTls", false) {
        FtpTls::Implicit
    } else {
        FtpTls::Explicit
    };
    Ok(crate::ftp::FtpParams {
        timeout: None,
        password: saved_password(s, secrets),
        host,
        port,
        user,
        tls,
        tls13_only: flag(s, "tls13Only", false),
        encoding: setting(s, "ftpEncoding")?,
        tz_offset_min: s.get("ftpTimezone").and_then(Value::as_i64).unwrap_or(0) as i32,
        mode: setting(s, "ftpMode")?,
        trust: None,
        proxy: proxy(s, secrets),
    })
}

fn dav_params(s: &Value, secrets: Secrets) -> crate::dav::DavParams {
    let (host, port, user) = login(s);
    let https = flag(s, "davHttps", true);
    let path = match str_of(s, "davPath") {
        "" => "/".to_string(),
        p if p.starts_with('/') => p.to_string(),
        p => format!("/{p}"),
    };
    let (scheme, default_port) = if https { ("https", 443) } else { ("http", 80) };
    crate::dav::DavParams {
        timeout: None,
        url: format!("{scheme}://{host}{}{path}", port_part(port, default_port)),
        password: saved_password(s, secrets),
        user,
        tls13_only: flag(s, "tls13Only", false),
        trust: None,
        proxy: proxy(s, secrets),
    }
}

fn s3_params(s: &Value, secrets: Secrets) -> crate::s3::S3Params {
    let (host, port, user) = login(s);
    let (scheme, default_port) = if flag(s, "s3Http", false) { ("http", 80) } else { ("https", 443) };
    crate::s3::S3Params {
        timeout: None,
        endpoint: format!("{scheme}://{host}{}", port_part(port, default_port)),
        region: str_of(s, "s3Region").to_string(),
        bucket: str_of(s, "s3Bucket").to_string(),
        secret: saved_password(s, secrets),
        access_key: user,
        path_style: flag(s, "s3PathStyle", false),
        tls13_only: flag(s, "tls13Only", false),
        trust: None,
        proxy: proxy(s, secrets),
    }
}

fn smb_params(s: &Value, secrets: Secrets) -> crate::smb::SmbParams {
    let (host, port, user) = login(s);
    crate::smb::SmbParams {
        timeout: None,
        password: saved_password(s, secrets),
        host,
        port: if port == 0 { 445 } else { port },
        user,
        share: str_of(s, "smbShare").to_string(),
        encrypt: flag(s, "smbEncrypt", false),
    }
}

/// Connects to a saved server with any protocol.
async fn connect(ctx: &Ctx, s: &Value) -> AppResult<Remote> {
    let name = str_of(s, "name");
    if !ctx.quiet {
        eprintln!("Connecting to {name} ...");
    }
    let cloud_token = || {
        keychain(&format!("cloud:{}", str_of(s, "id"))).ok_or_else(|| {
            AppError::new(ErrorKind::AuthFailed, "{0} is not signed in. Sign in once in Bitcrane.").param(name)
        })
    };
    let conn = match str_of(s, "protocol") {
        "ftp" | "ftps" => {
            Remote::Ftp(Arc::new(crate::ftp::FtpConn::connect(ftp_params(s, &keychain)?, ctx.known.clone()).await?))
        }
        "webdav" => Remote::Dav(crate::dav::DavConn::connect(dav_params(s, &keychain), ctx.known.clone()).await?),
        "s3" => Remote::S3(Arc::new(crate::s3::S3Conn::connect(s3_params(s, &keychain), ctx.known.clone()).await?)),
        "smb" => Remote::Smb(Arc::new(crate::smb::SmbConn::connect(smb_params(s, &keychain)).await?)),
        "dropbox" => Remote::Dropbox(Arc::new(
            crate::dropbox::DropboxConn::connect(crate::dropbox::DropboxParams { refresh_token: cloud_token()? })
                .await?,
        )),
        "onedrive" => {
            let conn = Arc::new(
                crate::onedrive::OneDriveConn::connect(crate::onedrive::OneDriveParams {
                    refresh_token: cloud_token()?,
                })
                .await?,
            );
            // Microsoft renews the sign-in with each use; keep the newest one.
            let _ = crate::config::secret_set(&format!("cloud:{}", str_of(s, "id")), &conn.refresh_token().await);
            Remote::OneDrive(conn)
        }
        "gdrive" => {
            let client_id = str_of(&ctx.settings, "googleClientId").trim().to_string();
            let client_secret = keychain("cloud-client:gdrive").unwrap_or_default();
            if client_id.is_empty() || client_secret.is_empty() {
                return Err(AppError::other("The Google app key is missing. Enter it once in Bitcrane."));
            }
            Remote::GDrive(Arc::new(
                crate::gdrive::GDriveConn::connect(crate::gdrive::GDriveParams {
                    pdf_export: false,
                    refresh_token: cloud_token()?,
                    client_id,
                    client_secret,
                })
                .await?,
            ))
        }
        _ => crate::remote::connect_ssh(&ssh_params(&ctx.servers, s, 0, &keychain)?, ctx.known.clone(), None)
            .await
            .map_err(|e| match e.kind {
                ErrorKind::HostKeyUnknown | ErrorKind::HostKeyChanged => {
                    AppError::new(e.kind, "The host key of {0} is not confirmed. Connect once in Bitcrane.").param(name)
                }
                _ => e,
            })?,
    };
    Ok(conn)
}

/// The folder a command works in: the given path, else the server's start folder.
fn start_dir(home: &str, s: &Value, path: Option<String>) -> String {
    match path {
        Some(p) if p.starts_with('/') => p,
        Some(p) => remote_join(home, &p),
        None => match str_of(s, "remoteStart") {
            p if p.starts_with('/') => p.to_string(),
            _ => home.to_string(),
        },
    }
}

async fn ls(ctx: &Ctx, args: &[String]) -> AppResult<()> {
    let [spec] = args else { return Err(usage("ls needs exactly one <server>[:<path>]")) };
    let (s, path) = find_target(&ctx.servers, spec)?;
    let conn = connect(ctx, s).await?;
    let dir = start_dir(conn.home(), s, path);
    let list = conn.list(&dir).await;
    conn.close().await;
    for e in list? {
        let when = chrono::DateTime::from_timestamp_millis(e.mtime)
            .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default();
        let size = if e.kind == EntryKind::Dir { "-".to_string() } else { e.size.to_string() };
        println!(
            "{}\t{size}\t{when}\t{}",
            if e.kind == EntryKind::Dir { "d" } else { "f" },
            if e.kind == EntryKind::Dir { format!("{}/", e.name) } else { e.name }
        );
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
    let (s, path) = find_target(&ctx.servers, &to)?;
    let conn = connect(ctx, s).await?;
    let dest = start_dir(conn.home(), s, path);
    let opts = options(ctx);
    let mut failed = 0;
    for local in &args {
        let abs = std::fs::canonicalize(local).map_err(|e| {
            AppError::new(ErrorKind::NotFound, "\"{0}\" not found.").param(local).with_detail(e.to_string())
        })?;
        let ui = to_ui(&abs);
        for item in crate::local::walk(&ui)? {
            let target = remote_join(&dest, &item.relative);
            match crate::transfer::upload(&conn, &item.path, &target, &opts, &|_, _| {}, Arc::new(AtomicU8::new(RUN)))
                .await
            {
                Ok(n) => {
                    if !ctx.quiet {
                        println!("uploaded {target} ({n} bytes)");
                    }
                }
                Err(e) => {
                    failed += 1;
                    eprintln!("failed {target}: {}", e.message.english());
                }
            }
        }
    }
    conn.close().await;
    if failed > 0 {
        return Err(AppError::other("{0} file(s) failed.").param(failed.to_string()));
    }
    Ok(())
}

async fn download(ctx: &Ctx, mut args: Vec<String>) -> AppResult<()> {
    let to = take_option(&mut args, "--to")?.unwrap_or_else(|| ".".into());
    if args.is_empty() {
        return Err(usage("download needs at least one <server>:<path>"));
    }
    let dest = std::fs::canonicalize(&to).map_err(|e| {
        AppError::new(ErrorKind::NotFound, "Local folder \"{0}\" not found.").param(to).with_detail(e.to_string())
    })?;
    let dest_ui = to_ui(&dest);
    let mut failed = 0;
    // One connection per server, even when several paths name the same one.
    let mut open: Vec<(String, Remote)> = Vec::new();
    for spec in &args {
        let (s, path) = find_target(&ctx.servers, spec)?;
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
            let target = remote_join(&dest_ui, &item.local_relative);
            match crate::transfer::download(
                conn,
                &item.path,
                &target,
                &options(ctx),
                &|_, _| {},
                Arc::new(AtomicU8::new(RUN)),
            )
            .await
            {
                Ok(n) => {
                    if !ctx.quiet {
                        println!("downloaded {} ({n} bytes)", item.relative);
                    }
                }
                Err(e) => {
                    failed += 1;
                    eprintln!("failed {}: {}", item.path, e.message.english());
                }
            }
        }
    }
    for (_, c) in open {
        c.close().await;
    }
    if failed > 0 {
        return Err(AppError::other("{0} file(s) failed.").param(failed.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ftp::FtpEncoding;
    use crate::ssh::AuthParams;

    /// Invented servers as the app stores them in its settings file.
    fn servers() -> Vec<Value> {
        vec![
            json!({ "id": "s1", "name": "Webserver", "host": "web.example", "port": 2222, "user": "anna",
                    "auth": "password", "jumpServerId": "s2" }),
            json!({ "id": "s2", "name": "Bastion", "host": "jump.example", "user": "ops", "auth": "key",
                    "keyPath": "~/.ssh/id_ed25519", "proxy": { "kind": "socks5", "host": "proxy.example",
                    "user": "pu" } }),
            json!({ "id": "f1", "name": "Shop FTP", "protocol": "ftps", "host": "ftp.example", "user": "shop",
                    "implicitTls": true, "ftpEncoding": "latin1" }),
            json!({ "id": "d1", "name": "Cloud", "protocol": "webdav", "host": "dav.example", "port": 8443,
                    "user": "ben", "davPath": "remote.php/dav" }),
            json!({ "id": "b1", "name": "Bucket", "protocol": "s3", "host": "s3.example", "port": 443,
                    "user": "AKIDEXAMPLE", "s3Region": "eu-central-1", "s3Bucket": "fotos" }),
            json!({ "id": "n1", "name": "NAS", "protocol": "smb", "host": "nas.example", "user": "ben",
                    "smbShare": "daten" }),
        ]
    }

    /// The keychain of the tests: every account has a password of its own name.
    fn secrets(account: &str) -> Option<String> {
        Some(format!("secret for {account}"))
    }

    fn no_secrets(_: &str) -> Option<String> {
        None
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn flags_and_options_are_taken_out_of_the_arguments() {
        let mut a = args(&["upload", "--quiet", "a.txt", "--to", "Webserver:/srv", "b.txt"]);
        assert!(take_flag(&mut a, "--quiet"));
        assert!(!take_flag(&mut a, "--quiet"));
        assert_eq!(take_option(&mut a, "--to").unwrap().as_deref(), Some("Webserver:/srv"));
        assert_eq!(a, args(&["upload", "a.txt", "b.txt"]));
        assert_eq!(take_option(&mut a, "--to").unwrap(), None);
        let missing = take_option(&mut args(&["download", "--to"]), "--to").unwrap_err();
        assert_eq!(missing.detail.as_deref(), Some("usage"));
        assert_eq!(missing.message.english(), "--to needs a value");
    }

    #[test]
    fn servers_are_found_by_id_or_name_with_an_optional_path() {
        let all = servers();
        let (s, path) = find_target(&all, "webserver:/var/www").unwrap();
        assert_eq!((str_of(s, "id"), path.as_deref()), ("s1", Some("/var/www")));
        let (s, path) = find_target(&all, "f1").unwrap();
        assert_eq!((str_of(s, "name"), path), ("Shop FTP", None));
        // "name:" without a path means the start folder.
        assert_eq!(find_target(&all, "NAS:").unwrap().1, None);
        let unknown = find_target(&all, "C:\\Users").unwrap_err();
        assert_eq!(unknown.kind, ErrorKind::NotFound);
        assert_eq!(unknown.message.english(), "No saved server called \"C\" (see: bitcrane servers).");
    }

    #[test]
    fn ssh_login_comes_from_the_entry_the_keychain_and_the_jump_server() {
        let all = servers();
        let p = ssh_params(&all, &all[0], 0, &secrets).unwrap();
        assert_eq!((p.host.as_str(), p.port, p.user.as_str()), ("web.example", 2222, "anna"));
        assert!(
            matches!(&p.auth, AuthParams::Password { password } if password == "secret for password:anna@web.example:2222")
        );
        let jump = p.jump.expect("jump server");
        assert_eq!((jump.host.as_str(), jump.port), ("jump.example", 22));
        assert!(matches!(&jump.auth, AuthParams::Key { path, passphrase: Some(_) } if path == "~/.ssh/id_ed25519"));
        let proxy = jump.proxy.expect("proxy");
        assert_eq!((proxy.host.as_str(), proxy.port, proxy.user.as_deref()), ("proxy.example", 1080, Some("pu")));
        assert_eq!(proxy.password.as_deref(), Some("secret for proxy:pu@proxy.example:1080"));
        assert!(p.proxy.is_none());
    }

    #[test]
    fn ssh_with_password_needs_a_saved_one() {
        let all = servers();
        let e = ssh_params(&all, &all[0], 0, &no_secrets).err().expect("no password saved");
        assert_eq!(e.kind, ErrorKind::PasswordRequired);
        assert_eq!(e.message.english(), "No password saved for Webserver. Connect once in Bitcrane and save it.");
    }

    #[test]
    fn a_jump_server_pointing_at_itself_is_ignored() {
        let looped = [json!({ "id": "x", "name": "Loop", "host": "loop.example", "jumpServerId": "x" })];
        assert!(ssh_params(&looped, &looped[0], 0, &no_secrets).unwrap().jump.is_none());
    }

    #[test]
    fn ftp_dav_s3_and_smb_parameters_follow_the_saved_entry() {
        let all = servers();
        let ftp = ftp_params(&all[2], &secrets).unwrap();
        assert_eq!(
            (ftp.host.as_str(), ftp.port, ftp.tls, ftp.encoding),
            ("ftp.example", 0, FtpTls::Implicit, FtpEncoding::Latin1)
        );
        assert_eq!(ftp.password.as_deref(), Some("secret for password:shop@ftp.example:0"));

        let dav = dav_params(&all[3], &secrets);
        assert_eq!(dav.url, "https://dav.example:8443/remote.php/dav");
        let dav_default_port = dav_params(&json!({ "host": "dav.example", "port": 443 }), &no_secrets);
        assert_eq!(dav_default_port.url, "https://dav.example/");

        let s3 = s3_params(&all[4], &secrets);
        assert_eq!(
            (s3.endpoint.as_str(), s3.bucket.as_str(), s3.access_key.as_str()),
            ("https://s3.example", "fotos", "AKIDEXAMPLE")
        );

        let smb = smb_params(&all[5], &no_secrets);
        assert_eq!((smb.port, smb.share.as_str(), smb.password), (445, "daten", None));
    }

    #[test]
    fn an_unknown_setting_value_is_refused() {
        let e = ftp_params(&json!({ "protocol": "ftp", "ftpMode": "sideways" }), &no_secrets).err().expect("refused");
        assert!(e.message.english().starts_with("Invalid ftpMode: "), "{}", e.message.english());
    }

    #[test]
    fn the_start_folder_is_the_path_the_saved_start_or_home() {
        let s = json!({ "remoteStart": "/srv/www" });
        assert_eq!(start_dir("/home/anna", &s, Some("/tmp".into())), "/tmp");
        assert_eq!(start_dir("/home/anna", &s, Some("logs".into())), "/home/anna/logs");
        assert_eq!(start_dir("/home/anna", &s, None), "/srv/www");
        assert_eq!(start_dir("/home/anna", &json!({}), None), "/home/anna");
    }
}
