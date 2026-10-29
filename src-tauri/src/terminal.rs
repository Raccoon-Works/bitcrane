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

#[cfg(test)]
mod tests {
    #[test]
    fn starts_in_the_folder() {
        assert_eq!(super::start_command(Some("/var/www/it's")), r#"cd -- '/var/www/it'\''s' 2>/dev/null; exec "${SHELL:-/bin/sh}" -l"#);
        assert_eq!(super::start_command(Some("~")), "");
        assert_eq!(super::start_command(None), "");
    }
}
