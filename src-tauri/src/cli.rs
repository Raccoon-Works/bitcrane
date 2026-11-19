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
use crate::login::{Env, Login};
use crate::model::EntryKind;
use crate::paths::{remote_join, remote_name, to_ui};
use crate::remote::Remote;
use crate::secrets::Keychain;
use crate::serverconfig::{Config, Server};
use crate::ssh::KnownHosts;
use crate::transfer::TransferOptions;
use std::path::PathBuf;
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
    config: Config,
    known: Arc<KnownHosts>,
    quiet: bool,
}

async fn run(mut args: Vec<String>) -> i32 {
    let quiet = take_flag(&mut args, "--quiet");
    let dir = config_dir();
    let config = match Config::read(&dir) {
        Ok(c) => c,
        Err(e) => {
            match &e.detail {
                Some(d) => eprintln!("bitcrane: {} ({d})", e.message.english()),
                None => eprintln!("bitcrane: {}", e.message.english()),
            }
            return 1;
        }
    };
    let ctx = Ctx { config, known: Arc::new(KnownHosts::load(dir.join("known_hosts.json"))), quiet };
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

/// The readable servers on standard output; entries the core cannot read are named on standard
/// error, so scripts that read the list are not disturbed.
fn servers(ctx: &Ctx) {
    for s in &ctx.config.servers {
        println!("{}\t{}\t{}@{}:{}", s.name, s.protocol.name(), s.user, s.host, s.port);
    }
    for u in &ctx.config.unreadable {
        eprintln!("skipped {}: the saved entry is not readable ({})", u.name, u.reason);
    }
}

/// "name:path" -> (server, path). A Windows drive ("C:\x") is not a server. A saved entry the core
/// cannot read fails here with its name, while all other servers stay usable.
fn find_target<'a>(config: &'a Config, spec: &str) -> AppResult<(&'a Server, Option<String>)> {
    let (name, path) = match spec.split_once(':') {
        Some((n, p)) => (n, Some(p.to_string()).filter(|p| !p.is_empty())),
        None => (spec, None),
    };
    let servers = &config.servers;
    let found =
        servers.iter().find(|s| s.id == name).or_else(|| servers.iter().find(|s| s.name.eq_ignore_ascii_case(name)));
    if let Some(s) = found {
        return Ok((s, path));
    }
    let unreadable = config.unreadable.iter().find(|u| u.id == name || u.name.eq_ignore_ascii_case(name));
    Err(match unreadable {
        Some(u) => AppError::other("The saved server \"{0}\" is not readable.").param(&u.name).with_detail(&u.reason),
        None => {
            AppError::new(ErrorKind::NotFound, "No saved server called \"{0}\" (see: bitcrane servers).").param(name)
        }
    })
}

/// Connects to a saved server with any protocol, logging in like the app does (`login.rs`) with
/// what the keychain holds. Like the app, it follows one jump server.
async fn connect(ctx: &Ctx, s: &Server) -> AppResult<Remote> {
    if !ctx.quiet {
        eprintln!("Connecting to {} ...", s.name);
    }
    let jump = s.jump_id().and_then(|id| ctx.config.server(id)).cloned();
    // The servers come straight from the saved configuration, so their stored secrets apply.
    let login = Login {
        keepalive: true,
        google_client_id: ctx.config.settings.google_client_id.clone(),
        stored_secrets: true,
        ..Login::default()
    };
    // No other connections exist here, so a vault on a server reports that it is not connected.
    let env = Env { known: ctx.known.clone(), prompter: None, secrets: &Keychain, connections: Default::default() };
    let opened = crate::login::open(s.clone(), jump, login, &env).await.map_err(|e| match e.kind {
        ErrorKind::HostKeyUnknown | ErrorKind::HostKeyChanged => {
            AppError::new(e.kind, "The host key of {0} is not confirmed. Connect once in Bitcrane.").param(&s.name)
        }
        _ => e,
    })?;
    if let Some(w) = opened.warning {
        eprintln!("warning: {}", w.message.english());
    }
    Ok(opened.remote)
}

/// The folder a command works in: the given path, else the server's start folder.
fn start_dir(home: &str, s: &Server, path: Option<String>) -> String {
    match path {
        Some(p) if p.starts_with('/') => p,
        Some(p) => remote_join(home, &p),
        None if s.remote_start.starts_with('/') => s.remote_start.clone(),
        None => home.to_string(),
    }
}

async fn ls(ctx: &Ctx, args: &[String]) -> AppResult<()> {
    let [spec] = args else { return Err(usage("ls needs exactly one <server>[:<path>]")) };
    let (s, path) = find_target(&ctx.config, spec)?;
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
    let st = &ctx.config.settings;
    TransferOptions { temp_name: st.upload_temp_name, keep_mtime: st.keep_mtime, ..Default::default() }
}

async fn upload(ctx: &Ctx, mut args: Vec<String>) -> AppResult<()> {
    let to = take_option(&mut args, "--to")?.ok_or_else(|| usage("upload needs --to <server>[:<folder>]"))?;
    if args.is_empty() {
        return Err(usage("upload needs at least one local file or folder"));
    }
    let (s, path) = find_target(&ctx.config, &to)?;
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
            match crate::transfer::upload(
                &conn,
                &item.path,
                &target,
                &opts,
                &|_, _| {},
                crate::transfer::Control::new(),
            )
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
        let (s, path) = find_target(&ctx.config, spec)?;
        let Some(path) = path else { return Err(usage("download needs <server>:<path>")) };
        let id = s.id.clone();
        if !open.iter().any(|(i, _)| *i == id) {
            open.push((id.clone(), connect(ctx, s).await?));
        }
        let conn =
            &open.iter().find(|(i, _)| *i == id).expect("the connection is opened just above when it is missing").1;
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
                crate::transfer::Control::new(),
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
    use serde_json::json;

    /// Invented servers as the app stores them in its settings file, one of them edited by hand
    /// into an entry the core cannot read.
    fn config() -> Config {
        Config::from_value(json!({ "servers": [
            { "id": "s1", "name": "Webserver", "host": "web.example", "port": 2222, "user": "anna" },
            { "id": "f1", "name": "Shop FTP", "protocol": "ftps", "host": "ftp.example", "port": 21, "user": "shop" },
            { "id": "b1", "name": "Kaputt", "host": "bad.example", "port": 70000 },
            { "id": "n1", "name": "NAS", "protocol": "smb", "host": "nas.example", "port": 445, "user": "ben" },
        ]}))
        .unwrap()
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
        let all = config();
        let listed: Vec<&str> = all.servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(listed, ["Webserver", "Shop FTP", "NAS"]);
        let (s, path) = find_target(&all, "webserver:/var/www").unwrap();
        assert_eq!((s.id.as_str(), path.as_deref()), ("s1", Some("/var/www")));
        let (s, path) = find_target(&all, "f1").unwrap();
        assert_eq!((s.name.as_str(), path), ("Shop FTP", None));
        // "name:" without a path means the start folder.
        assert_eq!(find_target(&all, "NAS:").unwrap().1, None);
        let unknown = find_target(&all, "C:\\Users").unwrap_err();
        assert_eq!(unknown.kind, ErrorKind::NotFound);
        assert_eq!(unknown.message.english(), "No saved server called \"C\" (see: bitcrane servers).");
        // Only the unreadable entry fails, by its name.
        let bad = find_target(&all, "kaputt:/srv").unwrap_err();
        assert_eq!(bad.message.english(), "The saved server \"Kaputt\" is not readable.");
        assert!(bad.detail.is_some_and(|d| d.contains("70000")));
    }

    #[test]
    fn the_start_folder_is_the_path_the_saved_start_or_home() {
        let s: Server = serde_json::from_value(json!({ "id": "x", "remoteStart": "/srv/www" })).unwrap();
        assert_eq!(start_dir("/home/anna", &s, Some("/tmp".into())), "/tmp");
        assert_eq!(start_dir("/home/anna", &s, Some("logs".into())), "/home/anna/logs");
        assert_eq!(start_dir("/home/anna", &s, None), "/srv/www");
        assert_eq!(start_dir("/home/anna", &config().servers[0], None), "/home/anna");
    }
}
