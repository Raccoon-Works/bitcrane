//! The built-in SSH terminal: a shell with a pseudo terminal on the server's
//! SSH session, shown by xterm.js in the interface.
//!
//! Each terminal is a task that owns its SSH channel. Output goes to the
//! interface as `term-data` events (Base64, as it may be any bytes), input,
//! size changes and closing arrive through a channel. When the shell ends,
//! `term-exit` tells the interface.

use crate::error::{AppError, AppResult};
use crate::remote::Remote;
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

enum Command {
    Input(Vec<u8>),
    Resize(u32, u32),
    Close,
}

#[derive(Default)]
pub struct Terminals(Mutex<HashMap<String, mpsc::UnboundedSender<Command>>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TermData {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TermExit {
    id: String,
    code: Option<u32>,
}

/// The shell command for a start folder: change into it, then the user's
/// login shell. Without a folder the server's normal shell starts.
pub fn start_command(cwd: Option<&str>) -> String {
    match cwd.filter(|c| !c.is_empty() && *c != "~") {
        Some(dir) => format!("cd -- {} 2>/dev/null; exec \"${{SHELL:-/bin/sh}}\" -l", crate::scp::quote(dir)),
        None => String::new(),
    }
}

impl Terminals {
    #[allow(clippy::too_many_arguments)]
    pub async fn open(&self, app: AppHandle, remote: Arc<Remote>, id: String, cols: u32, rows: u32, cwd: Option<String>, startup: Option<String>) -> AppResult<()> {
        let mut channel = remote.open_shell(cols, rows, &start_command(cwd.as_deref())).await?;
        let (tx, mut rx) = mpsc::unbounded_channel();
        if let Some(cmd) = startup.filter(|c| !c.trim().is_empty()) {
            // The server profile's start command, typed in like the user would.
            let _ = tx.send(Command::Input(format!("{}\n", cmd.trim_end()).into_bytes()));
        }
        self.0.lock().unwrap().insert(id.clone(), tx);
        let b64 = base64::engine::general_purpose::STANDARD;
        tokio::spawn(async move {
            let mut code = None;
            loop {
                tokio::select! {
                    msg = channel.wait() => match msg {
                        Some(russh::ChannelMsg::Data { data }) | Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                            let _ = app.emit("term-data", TermData { id: id.clone(), data: b64.encode(&data) });
                        }
                        Some(russh::ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                        Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => break,
                        _ => {}
                    },
                    cmd = rx.recv() => match cmd {
                        Some(Command::Input(bytes)) => {
                            if channel.data(&bytes[..]).await.is_err() {
                                break;
                            }
                        }
                        Some(Command::Resize(c, r)) => {
                            let _ = channel.window_change(c.max(10), r.max(2), 0, 0).await;
                        }
                        Some(Command::Close) | None => {
                            let _ = channel.close().await;
                            break;
                        }
                    },
                }
            }
            let _ = app.emit("term-exit", TermExit { id, code });
        });
        Ok(())
    }

    /// A shell on this computer (zsh/bash on the Mac, PowerShell on Windows)
    /// in a pseudo terminal, starting in `cwd`.
    pub fn open_local(&self, app: AppHandle, id: String, cols: u32, rows: u32, cwd: Option<String>, shell: Option<String>) -> AppResult<()> {
        use portable_pty::{native_pty_system, PtySize};
        use std::io::{Read, Write};
        let fail = |e: &dyn std::fmt::Display| AppError::other("Das Terminal konnte nicht gestartet werden.").with_detail(e.to_string());
        let size = PtySize { rows: rows.max(2) as u16, cols: cols.max(10) as u16, pixel_width: 0, pixel_height: 0 };
        let pair = native_pty_system().openpty(size).map_err(|e| fail(&e))?;
        let mut cmd = shell.as_deref().and_then(shell_command).unwrap_or_else(local_shell);
        if let Some(dir) = cwd.map(|c| crate::paths::to_native(&c)).filter(|d| d.is_dir()) {
            cmd.cwd(dir);
        } else {
            cmd.cwd(crate::paths::home());
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| fail(&e))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| fail(&e))?;
        let mut writer = pair.master.take_writer().map_err(|e| fail(&e))?;
        let (tx, mut rx) = mpsc::unbounded_channel();
        self.0.lock().unwrap().insert(id.clone(), tx);
        // Output: a thread of its own, the reader blocks.
        let out_app = app.clone();
        let out_id = id.clone();
        std::thread::spawn(move || {
            let b64 = base64::engine::general_purpose::STANDARD;
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = out_app.emit("term-data", TermData { id: out_id.clone(), data: b64.encode(&buf[..n]) });
                    }
                }
            }
            let _ = out_app.emit("term-exit", TermExit { id: out_id, code: None });
        });
        // Input, size and closing.
        let master = pair.master;
        tokio::task::spawn_blocking(move || {
            while let Some(cmd) = rx.blocking_recv() {
                match cmd {
                    Command::Input(bytes) => {
                        if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                            break;
                        }
                    }
                    Command::Resize(c, r) => {
                        let _ = master.resize(PtySize { rows: r.max(2) as u16, cols: c.max(10) as u16, pixel_width: 0, pixel_height: 0 });
                    }
                    Command::Close => break,
                }
            }
            let _ = child.kill();
        });
        Ok(())
    }

    fn send(&self, id: &str, cmd: Command) -> AppResult<()> {
        let map = self.0.lock().unwrap();
        let tx = map.get(id).ok_or_else(|| AppError::other("Das Terminal ist beendet."))?;
        tx.send(cmd).map_err(|_| AppError::other("Das Terminal ist beendet."))
    }

    pub fn write(&self, id: &str, data: &str) -> AppResult<()> {
        self.send(id, Command::Input(data.as_bytes().to_vec()))
    }

    pub fn resize(&self, id: &str, cols: u32, rows: u32) -> AppResult<()> {
        self.send(id, Command::Resize(cols, rows))
    }

    pub fn close(&self, id: &str) {
        let tx = self.0.lock().unwrap().remove(id);
        if let Some(tx) = tx {
            let _ = tx.send(Command::Close);
        }
    }
}

/// A shell on this computer the user can choose for the local terminal.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LocalShell {
    pub id: String,
    pub name: String,
}

/// Program and arguments of a known shell, if it is installed here.
fn shell_program(id: &str) -> Option<(std::path::PathBuf, Vec<&'static str>)> {
    use std::path::PathBuf;
    let in_path = |exe: &str| -> Option<PathBuf> {
        std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(exe)).find(|f| f.is_file()))
    };
    let first = |list: &[&str]| list.iter().map(PathBuf::from).find(|p| p.is_file());
    #[cfg(windows)]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        match id {
            "pwsh" => in_path("pwsh.exe").or_else(|| first(&[&format!(r"{pf}\PowerShell\7\pwsh.exe")])).map(|p| (p, vec!["-NoLogo"])),
            "powershell" => first(&[&format!(r"{sys}\System32\WindowsPowerShell\v1.0\powershell.exe")]).or_else(|| in_path("powershell.exe")).map(|p| (p, vec!["-NoLogo"])),
            "cmd" => first(&[&format!(r"{sys}\System32\cmd.exe")]).or_else(|| in_path("cmd.exe")).map(|p| (p, vec![])),
            "gitbash" => first(&[&format!(r"{pf}\Git\bin\bash.exe"), &format!(r"{pf86}\Git\bin\bash.exe")]).map(|p| (p, vec!["--login", "-i"])),
            "wsl" => first(&[&format!(r"{sys}\System32\wsl.exe")]).map(|p| (p, vec![])),
            _ => None,
        }
    }
    #[cfg(not(windows))]
    {
        match id {
            "zsh" => first(&["/bin/zsh", "/usr/bin/zsh", "/opt/homebrew/bin/zsh"]).map(|p| (p, vec!["-l"])),
            "bash" => first(&["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash", "/usr/bin/bash"]).map(|p| (p, vec!["-l"])),
            "fish" => first(&["/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"]).or_else(|| in_path("fish")).map(|p| (p, vec!["-l"])),
            _ => None,
        }
    }
}

const SHELLS: &[(&str, &str)] = if cfg!(windows) {
    &[("pwsh", "PowerShell 7"), ("powershell", "Windows PowerShell"), ("cmd", "Eingabeaufforderung (cmd)"), ("gitbash", "Git Bash"), ("wsl", "WSL (Linux)")]
} else {
    &[("zsh", "zsh"), ("bash", "bash"), ("fish", "fish")]
};

/// The shells installed here (for the choice in Settings › Terminal).
pub fn local_shells() -> Vec<LocalShell> {
    SHELLS.iter().filter(|(id, _)| shell_program(id).is_some()).map(|(id, name)| LocalShell { id: id.to_string(), name: name.to_string() }).collect()
}

/// Command for a chosen shell; None (unknown or not installed) means the default.
fn shell_command(id: &str) -> Option<portable_pty::CommandBuilder> {
    let (program, args) = shell_program(id)?;
    let mut cmd = portable_pty::CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    Some(cmd)
}

/// The user's shell: on Windows PowerShell 7 if installed, else Windows
/// PowerShell; elsewhere the login shell.
fn local_shell() -> portable_pty::CommandBuilder {
    #[cfg(windows)]
    {
        let pwsh = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|d| d.join("pwsh.exe").is_file())).unwrap_or(false);
        let mut cmd = portable_pty::CommandBuilder::new(if pwsh { "pwsh.exe" } else { "powershell.exe" });
        cmd.arg("-NoLogo");
        cmd
    }
    #[cfg(not(windows))]
    {
        portable_pty::CommandBuilder::new_default_prog()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn starts_in_the_folder() {
        assert_eq!(super::start_command(Some("/var/www/it's")), r#"cd -- '/var/www/it'\''s' 2>/dev/null; exec "${SHELL:-/bin/sh}" -l"#);
        assert_eq!(super::start_command(Some("~")), "");
        assert_eq!(super::start_command(None), "");
    }
}
