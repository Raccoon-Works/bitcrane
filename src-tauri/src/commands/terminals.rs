//! Terminals: the built-in terminal sessions, SSH tunnels and opening the system terminal.

use crate::error::{AppError, AppResult};
use crate::{forward, paths, terminal, AppState};
use serde::Deserialize;
use tauri::State;

/// What "Terminal öffnen" connects to.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalTarget {
    /// Local folder (UI path) when no server is given.
    local_path: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    key_path: Option<String>,
    remote_path: Option<String>,
    /// Terminal program: Mac "terminal" (default), "iterm", "ghostty"; Windows
    /// "wt" (default, Windows Terminal), "powershell", "cmd".
    #[serde(default)]
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
    app: Option<String>,
}

/// Single-quotes a value for a POSIX shell.
fn sh_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', "'\\''"))
}

/// Characters cmd.exe interprets even inside double quotes (or that end them).
#[cfg(windows)]
const CMD_UNSAFE: &[char] = &['"', '%', '!', '\r', '\n'];

/// Builds the `ssh` command line for "Terminal öffnen". Every value is quoted
/// for the local shell, and the folder once more for the shell on the server,
/// so names from a server listing can never run as commands on this computer.
fn terminal_ssh_command(host: &str, target: &TerminalTarget) -> AppResult<String> {
    let user = target.user.clone().unwrap_or_default();
    let plain = |v: &str| v.chars().all(|c| c.is_ascii_alphanumeric() || "._-:[]".contains(c));
    if !plain(host) || !(user.is_empty() || user.chars().all(|c| c.is_ascii_alphanumeric() || "._-@+".contains(c))) {
        return Err(AppError::other("Für diesen Server kann kein Terminal geöffnet werden (ungewöhnliche Zeichen im Namen oder in der Adresse)."));
    }
    let dir = target.remote_path.clone().unwrap_or_else(|| "~".into());
    let key = target.key_path.as_ref().filter(|k| !k.is_empty()).map(|k| paths::to_native(k).display().to_string());
    #[cfg(windows)]
    if dir.contains(CMD_UNSAFE) || key.as_deref().is_some_and(|k| k.contains(CMD_UNSAFE)) {
        return Err(AppError::other(
            "Dieser Ordner kann nicht im Terminal geöffnet werden (ungewöhnliche Zeichen im Namen).",
        ));
    }
    // "~" stays unquoted so the server shell expands it.
    let cd = if dir == "~" { "cd".to_string() } else { format!("cd {}", sh_quote(&dir)) };
    let remote = format!("{cd} && exec $SHELL -l");
    // POSIX shells (macOS Terminal, Linux) get single quotes; cmd.exe double quotes.
    let q = |v: &str| if cfg!(windows) { format!("\"{v}\"") } else { sh_quote(v) };
    let mut parts = vec!["ssh".to_string(), "-t".to_string()];
    if let Some(p) = target.port.filter(|p| *p != 22) {
        parts.push("-p".into());
        parts.push(p.to_string());
    }
    if let Some(k) = key {
        parts.push("-i".into());
        parts.push(q(&k));
    }
    parts.push(if user.is_empty() { host.to_string() } else { format!("{user}@{host}") });
    parts.push(q(&remote));
    Ok(parts.join(" "))
}

/// The `ssh` call for PowerShell: every value in single quotes ('' inside), so
/// nothing in a name or folder can run as a command on this computer.
#[cfg(windows)]
fn powershell_ssh_command(host: &str, target: &TerminalTarget) -> AppResult<String> {
    // Same checks and remote command as for cmd.exe; only the local quoting differs.
    terminal_ssh_command(host, target)?;
    let q = |v: &str| format!("'{}'", v.replace('\'', "''"));
    let dir = target.remote_path.clone().unwrap_or_else(|| "~".into());
    let cd = if dir == "~" { "cd".to_string() } else { format!("cd {}", sh_quote(&dir)) };
    let user = target.user.clone().unwrap_or_default();
    let mut parts = vec!["ssh".to_string(), "-t".to_string()];
    if let Some(p) = target.port.filter(|p| *p != 22) {
        parts.push("-p".into());
        parts.push(p.to_string());
    }
    if let Some(k) = target.key_path.as_ref().filter(|k| !k.is_empty()) {
        parts.push("-i".into());
        parts.push(q(&paths::to_native(k).display().to_string()));
    }
    parts.push(if user.is_empty() { host.to_string() } else { format!("{user}@{host}") });
    parts.push(q(&format!("{cd} && exec $SHELL -l")));
    Ok(parts.join(" "))
}

/// Opens the system terminal: in a local folder, or with an SSH session that
/// starts in the server folder shown in Bitcrane.
#[tauri::command]
pub(crate) fn open_terminal(target: TerminalTarget) -> AppResult<()> {
    let ssh_cmd = match target.host.as_ref() {
        Some(host) => Some(terminal_ssh_command(host, &target)?),
        None => None,
    };
    let local = target.local_path.as_deref().map(paths::to_native).unwrap_or_else(paths::home);

    #[cfg(target_os = "macos")]
    {
        // Quoted for an AppleScript string.
        let apple = |cmd: &str| cmd.replace('\\', "\\\\").replace('"', "\\\"");
        let status = match (target.app.as_deref().unwrap_or("terminal"), &ssh_cmd) {
            ("iterm", Some(cmd)) => std::process::Command::new("osascript")
                .arg("-e")
                .arg("tell application \"iTerm\"")
                .arg("-e")
                .arg(format!("create window with default profile command \"{}\"", apple(cmd)))
                .arg("-e")
                .arg("activate")
                .arg("-e")
                .arg("end tell")
                .spawn(),
            ("iterm", None) => std::process::Command::new("open").arg("-a").arg("iTerm").arg(&local).spawn(),
            // Ghostty takes its options after --args (it cannot be started from its own CLI on the Mac).
            ("ghostty", Some(cmd)) => std::process::Command::new("open")
                .args(["-na", "Ghostty", "--args"])
                .arg(format!("--working-directory={}", local.display()))
                .arg("-e")
                .arg("/bin/sh")
                .arg("-c")
                .arg(cmd)
                .spawn(),
            ("ghostty", None) => std::process::Command::new("open")
                .args(["-na", "Ghostty", "--args"])
                .arg(format!("--working-directory={}", local.display()))
                .spawn(),
            (_, Some(cmd)) => std::process::Command::new("osascript")
                .arg("-e")
                .arg(format!("tell application \"Terminal\" to do script \"{}\"", apple(cmd)))
                .arg("-e")
                .arg("tell application \"Terminal\" to activate")
                .spawn(),
            (_, None) => std::process::Command::new("open").arg("-a").arg("Terminal").arg(&local).spawn(),
        };
        status.map(|_| ()).map_err(AppError::from)
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let app = target.app.as_deref().unwrap_or("wt");
        if app == "powershell" {
            let mut c = std::process::Command::new("cmd");
            c.current_dir(&local);
            match target.host.as_ref() {
                // Handed over encoded, so neither cmd.exe nor PowerShell reinterprets quotes or "$".
                Some(host) => {
                    let ps = powershell_ssh_command(host, &target)?;
                    let wide: Vec<u8> = ps.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
                    use base64::Engine;
                    let encoded = base64::engine::general_purpose::STANDARD.encode(wide);
                    c.raw_arg(format!("/c start \"Bitcrane\" powershell -NoExit -EncodedCommand {encoded}"))
                }
                None => c.raw_arg("/c start \"Bitcrane\" powershell -NoExit"),
            };
            return c.spawn().map(|_| ()).map_err(AppError::from);
        }
        // Windows Terminal when installed (and chosen), otherwise a classic console window.
        if app == "wt" {
            let wt = std::process::Command::new("wt.exe")
                .arg("-d")
                .arg(&local)
                .args(
                    ssh_cmd.as_ref().map(|c| vec!["cmd".to_string(), "/k".to_string(), c.clone()]).unwrap_or_default(),
                )
                .spawn();
            if wt.is_ok() {
                return Ok(());
            }
        }
        let mut c = std::process::Command::new("cmd");
        c.current_dir(&local);
        match &ssh_cmd {
            Some(cmd) => c.raw_arg(format!("/c start \"Bitcrane\" cmd /k {cmd}")),
            None => c.raw_arg("/c start \"Bitcrane\" cmd"),
        };
        c.spawn().map(|_| ()).map_err(AppError::from)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut c = std::process::Command::new("x-terminal-emulator");
        c.current_dir(&local);
        if let Some(cmd) = &ssh_cmd {
            c.arg("-e").arg("sh").arg("-c").arg(cmd);
        }
        c.spawn().map(|_| ()).map_err(AppError::from)
    }
}

/// Built-in terminal: a shell on the server's SSH session, optionally in `cwd`.
#[tauri::command]
#[allow(clippy::too_many_arguments, reason = "Tauri passes the arguments of the interface one by one")]
pub(crate) async fn term_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    server_id: String,
    cols: u32,
    rows: u32,
    cwd: Option<String>,
    startup: Option<String>,
    shell: Option<String>,
) -> AppResult<()> {
    // An empty server id is a terminal on this computer.
    if server_id.is_empty() {
        return state.terminals.open_local(app, id, cols, rows, cwd, shell);
    }
    let conn = state.conn(&server_id).await?;
    state.terminals.open(app, conn, id, cols, rows, cwd, startup).await
}

/// Starts an SSH tunnel (port forwarding) on a connected server.
#[tauri::command]
pub(crate) async fn forward_start(
    state: State<'_, AppState>,
    server_id: String,
    spec: forward::ForwardSpec,
) -> AppResult<()> {
    let conn = state.conn(&server_id).await?;
    state.forwards.start(&server_id, conn, spec).await
}

#[tauri::command]
pub(crate) async fn forward_stop(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.forwards.stop(&id).await;
    Ok(())
}

/// Ids of the tunnels that are running.
#[tauri::command]
pub(crate) fn forward_active(state: State<'_, AppState>) -> Vec<String> {
    state.forwards.active()
}

/// Shells installed on this computer for the local terminal.
#[tauri::command]
pub(crate) fn term_shells() -> Vec<terminal::LocalShell> {
    terminal::local_shells()
}

#[tauri::command]
pub(crate) fn term_write(state: State<'_, AppState>, id: String, data: String) -> AppResult<()> {
    state.terminals.write(&id, &data)
}

#[tauri::command]
pub(crate) fn term_resize(state: State<'_, AppState>, id: String, cols: u32, rows: u32) -> AppResult<()> {
    state.terminals.resize(&id, cols, rows)
}

#[tauri::command]
pub(crate) fn term_close(state: State<'_, AppState>, id: String) {
    state.terminals.close(&id);
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn target(dir: &str, user: &str) -> TerminalTarget {
        TerminalTarget {
            app: None,
            local_path: None,
            host: Some("example.com".into()),
            port: Some(2222),
            user: Some(user.into()),
            key_path: None,
            remote_path: Some(dir.into()),
        }
    }

    #[test]
    fn server_folder_names_stay_quoted() {
        let cmd = terminal_ssh_command("example.com", &target("/srv/$(touch pwned)", "deploy")).unwrap();
        assert_eq!(cmd, "ssh -t -p 2222 deploy@example.com 'cd '\\''/srv/$(touch pwned)'\\'' && exec $SHELL -l'");
        // The local shell must see exactly four plain words plus one quoted argument.
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("printf '%s\\n' {}", cmd.trim_start_matches("ssh ")))
            .output()
            .unwrap();
        let args: Vec<_> = String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect();
        assert_eq!(args.last().unwrap(), "cd '/srv/$(touch pwned)' && exec $SHELL -l");
        assert!(terminal_ssh_command("example.com", &target("/x", "a;b")).is_err());
        assert!(terminal_ssh_command("ex$(x)", &target("/x", "a")).is_err());
    }
}
