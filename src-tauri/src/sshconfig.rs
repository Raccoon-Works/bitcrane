//! Reads host entries from the user's OpenSSH configuration (`~/.ssh/config`)
//! so the welcome screen can offer them as servers.
//!
//! Only plain `Host` blocks are taken over; patterns with wildcards are
//! skipped because they are defaults for many hosts, not one server. Their
//! `User`, `Port` and `IdentityFile` still apply to hosts that do not set
//! them (as in OpenSSH, where `Host *` usually holds such defaults).
//! `Include` lines are followed (relative paths from ~/.ssh, wildcards in the
//! file name, at most a few levels deep); `Match` blocks are skipped.

use serde::Serialize;
use std::path::Path;

use crate::paths::{home, to_ui};

/// One server from the SSH configuration.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    /// Alias or host of the jump server ("ProxyJump"), first hop only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_jump: Option<String>,
}

/// Reads `~/.ssh/config`; a missing file yields an empty list.
pub fn read_hosts() -> Vec<SshConfigHost> {
    let path = home().join(".ssh").join("config");
    match std::fs::read_to_string(&path) {
        Ok(text) => parse(&expand_includes(&text, &home(), 0), &default_user(), &home()),
        Err(_) => Vec::new(),
    }
}

/// Replaces `Include` lines by the text of the files they name.
fn expand_includes(text: &str, home_dir: &Path, depth: u8) -> String {
    let mut out = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        let lower = line.to_ascii_lowercase();
        if depth < 4 && (lower.starts_with("include ") || lower.starts_with("include=") || lower.starts_with("include\t")) {
            for pattern in line[7..].trim_start_matches(|c: char| c.is_whitespace() || c == '=').split_whitespace() {
                let pattern = pattern.trim_matches('"');
                let full = match pattern.strip_prefix("~/") {
                    Some(rest) => home_dir.join(rest),
                    None if Path::new(pattern).is_absolute() => Path::new(pattern).to_path_buf(),
                    None => home_dir.join(".ssh").join(pattern),
                };
                for file in matching_files(&full) {
                    if let Ok(t) = std::fs::read_to_string(&file) {
                        out.push_str(&expand_includes(&t, home_dir, depth + 1));
                        out.push('\n');
                    }
                }
            }
            continue;
        }
        out.push_str(raw);
        out.push('\n');
    }
    out
}

/// The file itself, or the files matching a wildcard in its last part ("config.d/*").
fn matching_files(path: &Path) -> Vec<std::path::PathBuf> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !name.contains('*') && !name.contains('?') {
        return vec![path.to_path_buf()];
    }
    let Some(dir) = path.parent() else { return vec![] };
    let Ok(glob) = globset::Glob::new(&name).map(|g| g.compile_matcher()) else { return vec![] };
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_file() && p.file_name().map(|n| glob.is_match(n)).unwrap_or(false)).collect())
        .unwrap_or_default();
    files.sort();
    files
}

fn default_user() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

/// Parses the text of an OpenSSH client configuration.
pub fn parse(text: &str, default_user: &str, home_dir: &Path) -> Vec<SshConfigHost> {
    let mut out: Vec<SshConfigHost> = Vec::new();
    // Hosts of the current block (a block can name several aliases).
    let mut current: Vec<usize> = Vec::new();
    // Inside a "Host *" block: its User/Port/IdentityFile are defaults for all hosts.
    let mut in_defaults = false;
    let (mut def_user, mut def_port, mut def_identity): (Option<String>, Option<u16>, Option<String>) = (None, None, None);
    // Which values a host set itself (those win over the defaults).
    let mut explicit: Vec<[bool; 3]> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // "Key Value" or "Key=Value".
        let (key, value) = match line.find(|c: char| c.is_whitespace() || c == '=') {
            Some(i) => (&line[..i], line[i + 1..].trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim()),
            None => continue,
        };
        let value = value.trim_matches('"');
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                current.clear();
                in_defaults = value.split_whitespace().any(|a| a == "*");
                for alias in value.split_whitespace() {
                    if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                        continue;
                    }
                    out.push(SshConfigHost { alias: alias.to_string(), host: alias.to_string(), port: 22, user: default_user.to_string(), identity_file: None, proxy_jump: None });
                    explicit.push([false; 3]);
                    current.push(out.len() - 1);
                }
            }
            "match" => {
                current.clear();
                in_defaults = false;
            }
            "hostname" => current.iter().for_each(|&i| out[i].host = value.to_string()),
            "user" => {
                if in_defaults && def_user.is_none() {
                    def_user = Some(value.to_string());
                }
                current.iter().for_each(|&i| {
                    out[i].user = value.to_string();
                    explicit[i][0] = true;
                });
            }
            "port" => {
                if let Ok(p) = value.parse() {
                    if in_defaults && def_port.is_none() {
                        def_port = Some(p);
                    }
                    current.iter().for_each(|&i| {
                        out[i].port = p;
                        explicit[i][1] = true;
                    });
                }
            }
            "proxyjump" => {
                // "user@host:port,next" -> first hop; "none" switches it off.
                let first = value.split(',').next().unwrap_or("").trim();
                let host = first.rsplit('@').next().unwrap_or(first).split(':').next().unwrap_or("").to_string();
                if !host.is_empty() && host != "none" {
                    current.iter().for_each(|&i| out[i].proxy_jump = Some(host.clone()));
                }
            }
            "identityfile" => {
                let native = match value.strip_prefix("~/") {
                    Some(rest) => home_dir.join(rest),
                    None => Path::new(value).to_path_buf(),
                };
                let ui = to_ui(&native);
                if in_defaults && def_identity.is_none() {
                    def_identity = Some(ui.clone());
                }
                // The first IdentityFile wins, as in OpenSSH.
                current.iter().for_each(|&i| {
                    if out[i].identity_file.is_none() {
                        out[i].identity_file = Some(ui.clone());
                        explicit[i][2] = true;
                    }
                });
            }
            _ => {}
        }
    }
    for (h, set) in out.iter_mut().zip(explicit) {
        if !set[0] {
            if let Some(u) = &def_user {
                h.user = u.clone();
            }
        }
        if !set[1] {
            if let Some(p) = def_port {
                h.port = p;
            }
        }
        if !set[2] && h.identity_file.is_none() {
            h.identity_file = def_identity.clone();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_includes_and_applies_defaults() {
        let home = std::env::temp_dir().join(format!("bitcrane-sshcfg-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".ssh/config.d")).unwrap();
        std::fs::write(home.join(".ssh/config.d/work"), "Host work\n  HostName work.example.org\n").unwrap();
        let text = expand_includes("Include config.d/*\nHost home\n  Port 2200\nHost *\n  User admin\n  Port 2222\n", &home, 0);
        let hosts = parse(&text, "alex", &home);
        let work = hosts.iter().find(|h| h.alias == "work").unwrap();
        assert_eq!((work.host.as_str(), work.user.as_str(), work.port), ("work.example.org", "admin", 2222));
        let h = hosts.iter().find(|h| h.alias == "home").unwrap();
        assert_eq!((h.user.as_str(), h.port), ("admin", 2200));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn parses_blocks_and_skips_patterns() {
        let text = "\
# comment
Host *
  ServerAliveInterval 30

Host bots cloud
  HostName 10.0.0.5
  User ubuntu
  Port 2222
  IdentityFile ~/.ssh/cloud_ed25519
  IdentityFile ~/.ssh/other

Host web
  HostName=web.example.org
  ProxyJump admin@bots:22
";
        let home = crate::paths::home();
        let hosts = parse(text, "alex", &home);
        assert_eq!(hosts.len(), 3);
        assert_eq!(hosts[0].alias, "bots");
        assert_eq!(hosts[1].alias, "cloud");
        assert_eq!(hosts[0].host, "10.0.0.5");
        assert_eq!(hosts[1].port, 2222);
        assert_eq!(hosts[0].user, "ubuntu");
        assert_eq!(hosts[0].identity_file.as_deref(), Some("~/.ssh/cloud_ed25519"));
        assert_eq!(hosts[2].host, "web.example.org");
        assert_eq!(hosts[2].user, "alex");
        assert_eq!(hosts[2].port, 22);
        assert_eq!(hosts[2].proxy_jump.as_deref(), Some("bots"));
    }
}
