//! Reads host entries from the user's OpenSSH configuration (`~/.ssh/config`)
//! so the welcome screen can offer them as servers.
//!
//! Only plain `Host` blocks are taken over; patterns with wildcards are
//! skipped because they are defaults for many hosts, not one server.

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
        Ok(text) => parse(&text, &default_user(), &home()),
        Err(_) => Vec::new(),
    }
}

fn default_user() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

/// Parses the text of an OpenSSH client configuration.
pub fn parse(text: &str, default_user: &str, home_dir: &Path) -> Vec<SshConfigHost> {
    let mut out: Vec<SshConfigHost> = Vec::new();
    // Hosts of the current block (a block can name several aliases).
    let mut current: Vec<usize> = Vec::new();
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
                for alias in value.split_whitespace() {
                    if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                        continue;
                    }
                    out.push(SshConfigHost { alias: alias.to_string(), host: alias.to_string(), port: 22, user: default_user.to_string(), identity_file: None, proxy_jump: None });
                    current.push(out.len() - 1);
                }
            }
            "match" => current.clear(),
            "hostname" => current.iter().for_each(|&i| out[i].host = value.to_string()),
            "user" => current.iter().for_each(|&i| out[i].user = value.to_string()),
            "port" => {
                if let Ok(p) = value.parse() {
                    current.iter().for_each(|&i| out[i].port = p);
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
                // The first IdentityFile wins, as in OpenSSH.
                current.iter().for_each(|&i| {
                    if out[i].identity_file.is_none() {
                        out[i].identity_file = Some(ui.clone());
                    }
                });
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
