//! Import of saved servers from other programs: FileZilla (sitemanager.xml),
//! WinSCP (Windows registry or WinSCP.ini) and the OpenSSH configuration.
//! Passwords are never taken over; they are asked for on the first connection.

use crate::paths::{home, to_ui};
use crate::sshconfig;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// One server found in another program.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedServer {
    /// "FileZilla", "WinSCP" or "SSH-Konfiguration".
    pub source: String,
    pub name: String,
    /// Folder in the other program, used as group.
    pub group: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// "sftp", "ftp", "ftps" or "webdav".
    pub protocol: String,
    /// FTPS: implicit TLS on its own port instead of explicit (STARTTLS).
    pub implicit_tls: bool,
    /// Login: "key", "agent" or "password".
    pub auth: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_dir: Option<String>,
    /// Name of the jump server (SSH configuration "ProxyJump").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump: Option<String>,
}

/// Everything found, plus which sources were looked at.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub servers: Vec<ImportedServer>,
    /// Sources that exist on this computer (even if they contain no servers).
    pub sources: Vec<String>,
}

pub fn find_all() -> ImportResult {
    let mut servers = Vec::new();
    let mut sources = Vec::new();

    let ssh = sshconfig::read_hosts();
    if home().join(".ssh").join("config").is_file() {
        sources.push("SSH-Konfiguration".to_string());
    }
    for h in ssh {
        servers.push(ImportedServer {
            source: "SSH-Konfiguration".into(),
            name: h.alias.clone(),
            group: String::new(),
            host: h.host,
            port: h.port,
            user: h.user,
            protocol: "sftp".into(),
            implicit_tls: false,
            auth: if h.identity_file.is_some() { "key".into() } else { "agent".into() },
            key_path: h.identity_file,
            remote_dir: None,
            local_dir: None,
            jump: h.proxy_jump,
        });
    }

    for path in filezilla_paths() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            sources.push("FileZilla".into());
            servers.extend(parse_filezilla(&text));
            break;
        }
    }

    let winscp = read_winscp();
    if let Some(list) = winscp {
        sources.push("WinSCP".into());
        servers.extend(list);
    }
    ImportResult { servers, sources }
}

/* ---------------------------------------------------------------------- Tabby */

/// Where Tabby keeps its config.yaml (the Quick Commands plugin stores its
/// commands there under `qc`).
fn tabby_config_paths() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        v.push(Path::new(&appdata).join("tabby").join("config.yaml"));
    }
    v.push(home().join("Library").join("Application Support").join("tabby").join("config.yaml"));
    v.push(home().join(".config").join("tabby").join("config.yaml"));
    v
}

/// Text of Tabby's config.yaml, if Tabby is installed. The frontend parses it
/// and takes over only the quick commands.
pub fn tabby_config() -> Option<String> {
    tabby_config_paths().into_iter().find_map(|p| std::fs::read_to_string(p).ok())
}

/* ------------------------------------------------------------------ FileZilla */

fn filezilla_paths() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        v.push(Path::new(&appdata).join("FileZilla").join("sitemanager.xml"));
    }
    v.push(home().join(".config").join("filezilla").join("sitemanager.xml"));
    v.push(home().join(".filezilla").join("sitemanager.xml"));
    v
}

/// FileZilla stores remote folders as "1 0 4 home 6 ubuntu": type, prefix
/// length, then length-prefixed segments.
fn decode_filezilla_dir(s: &str) -> Option<String> {
    let mut rest = s.trim();
    let take_num = |r: &mut &str| -> Option<usize> {
        let end = r.find(' ').unwrap_or(r.len());
        let n = r[..end].parse().ok()?;
        *r = r[end..].trim_start_matches(' ');
        Some(n)
    };
    let _kind = take_num(&mut rest)?;
    let _prefix = take_num(&mut rest)?;
    let mut segs = Vec::new();
    while !rest.is_empty() {
        let len = take_num(&mut rest)?;
        let seg: String = rest.chars().take(len).collect();
        rest = &rest[seg.len()..];
        rest = rest.strip_prefix(' ').unwrap_or(rest);
        segs.push(seg);
    }
    Some(format!("/{}", segs.join("/")))
}

pub fn parse_filezilla(text: &str) -> Vec<ImportedServer> {
    let Ok(doc) = roxmltree::Document::parse(text) else { return Vec::new() };
    let mut out = Vec::new();
    for server in doc.descendants().filter(|n| n.has_tag_name("Server")) {
        let child = |name: &str| server.children().find(|c| c.has_tag_name(name)).and_then(|c| c.text()).unwrap_or("").trim().to_string();
        let host = child("Host");
        if host.is_empty() {
            continue;
        }
        // 1 = SFTP; 3 = FTPS implicit; 4 = FTPS explicit; 0/6 = FTP.
        let (protocol, implicit_tls) = match child("Protocol").as_str() {
            "1" => ("sftp", false),
            "3" => ("ftps", true),
            "4" => ("ftps", false),
            _ => ("ftp", false),
        };
        let key = child("Keyfile");
        let groups: Vec<String> = server
            .ancestors()
            .filter(|a| a.has_tag_name("Folder"))
            .filter_map(|f| f.children().find(|c| c.is_text()).and_then(|t| t.text()).map(|t| t.trim().to_string()))
            .filter(|t| !t.is_empty())
            .collect();
        let name = server.children().find(|c| c.has_tag_name("Name")).and_then(|c| c.text()).map(str::to_string)
            .or_else(|| server.children().find(|c| c.is_text()).and_then(|c| c.text()).map(|t| t.trim().to_string()))
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| host.clone());
        out.push(ImportedServer {
            source: "FileZilla".into(),
            name,
            group: groups.into_iter().rev().collect::<Vec<_>>().join(" / "),
            port: child("Port").parse().unwrap_or(if protocol == "sftp" { 22 } else if implicit_tls { 990 } else { 21 }),
            host,
            user: child("User"),
            protocol: protocol.into(),
            implicit_tls,
            auth: if !key.is_empty() { "key".into() } else if child("Logontype") == "5" { "agent".into() } else { "password".into() },
            key_path: (!key.is_empty()).then(|| to_ui(Path::new(&key))),
            remote_dir: decode_filezilla_dir(&child("RemoteDir")).filter(|d| d != "/"),
            local_dir: Some(child("LocalDir")).filter(|d| !d.is_empty()).map(|d| to_ui(Path::new(&d))),
            jump: None,
        });
    }
    out
}

/* ------------------------------------------------------------------ WinSCP */

/// WinSCP encodes names and paths with %XX escapes.
fn unescape(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Builds a server from WinSCP's session values (registry or INI).
fn winscp_session(key: &str, get: &dyn Fn(&str) -> Option<String>) -> Option<ImportedServer> {
    let full = unescape(key);
    if full == "Default Settings" {
        return None;
    }
    let host = get("HostName")?;
    if host.is_empty() {
        return None;
    }
    let mut parts: Vec<&str> = full.split('/').collect();
    let name = parts.pop().unwrap_or(&full).to_string();
    // FSProtocol: 0 SCP, 1 SFTP with SCP fallback, 2 SFTP, 5 FTP, 6 WebDAV, 7 S3.
    let fs = get("FSProtocol").and_then(|v| v.parse::<u32>().ok()).unwrap_or(2);
    let ftps = get("Ftps").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
    let (protocol, implicit_tls) = match fs {
        5 => (if ftps == 0 { "ftp" } else { "ftps" }, ftps == 1),
        6 => ("webdav", false),
        7 => return None,
        _ => ("sftp", false),
    };
    let key_file = get("PublicKeyFile").map(|v| unescape(&v)).filter(|v| !v.is_empty());
    let default_port = match protocol { "sftp" => 22, "webdav" => if ftps > 0 { 443 } else { 80 }, _ => if implicit_tls { 990 } else { 21 } };
    Some(ImportedServer {
        source: "WinSCP".into(),
        name,
        group: parts.join(" / "),
        port: get("PortNumber").and_then(|v| v.parse().ok()).unwrap_or(default_port),
        host,
        user: get("UserName").map(|v| unescape(&v)).unwrap_or_default(),
        protocol: protocol.into(),
        implicit_tls,
        auth: if key_file.is_some() { "key".into() } else if protocol == "sftp" { "agent".into() } else { "password".into() },
        key_path: key_file.map(|k| to_ui(Path::new(&k))),
        remote_dir: get("RemoteDirectory").map(|v| unescape(&v)).filter(|v| !v.is_empty()),
        local_dir: get("LocalDirectory").map(|v| to_ui(Path::new(&unescape(&v)))).filter(|v| !v.is_empty()),
        jump: None,
    })
}

/// Parses WinSCP.ini ([Sessions\Name] sections with Key=Value lines).
pub fn parse_winscp_ini(text: &str) -> Vec<ImportedServer> {
    let mut out = Vec::new();
    let mut current: Option<(String, Vec<(String, String)>)> = None;
    let flush = |cur: Option<(String, Vec<(String, String)>)>, out: &mut Vec<ImportedServer>| {
        if let Some((name, values)) = cur {
            let get = |k: &str| values.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
            if let Some(s) = winscp_session(&name, &get) {
                out.push(s);
            }
        }
    };
    for line in text.lines() {
        let line = line.trim();
        if let Some(section) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            flush(current.take(), &mut out);
            current = section.strip_prefix("Sessions\\").map(|n| (n.to_string(), Vec::new()));
        } else if let (Some(cur), Some((k, v))) = (current.as_mut(), line.split_once('=')) {
            cur.1.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    flush(current.take(), &mut out);
    out
}

fn read_winscp() -> Option<Vec<ImportedServer>> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        if let Ok(sessions) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Martin Prikryl\WinSCP 2\Sessions") {
            let mut out = Vec::new();
            for name in sessions.enum_keys().flatten() {
                let Ok(key) = sessions.open_subkey(&name) else { continue };
                let get = |v: &str| -> Option<String> {
                    key.get_value::<String, _>(v).ok().or_else(|| key.get_value::<u32, _>(v).ok().map(|n| n.to_string()))
                };
                if let Some(s) = winscp_session(&name, &get) {
                    out.push(s);
                }
            }
            return Some(out);
        }
    }
    // Portable WinSCP keeps its settings in WinSCP.ini.
    let mut candidates = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        candidates.push(Path::new(&appdata).join("WinSCP.ini"));
    }
    candidates.push(home().join("WinSCP.ini"));
    for c in candidates {
        if let Ok(text) = std::fs::read_to_string(&c) {
            return Some(parse_winscp_ini(&text));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filezilla_sites() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<FileZilla3><Servers>
  <Server><Host>bots.example</Host><Port>22</Port><Protocol>1</Protocol><User>ubuntu</User><Logontype>5</Logontype><Name>Cloud Bots</Name><RemoteDir>1 0 4 home 6 ubuntu 4 bots</RemoteDir></Server>
  <Folder expanded="1">Community
    <Server><Host>web.example</Host><Port>21</Port><Protocol>4</Protocol><User>web</User><Logontype>1</Logontype><Name>Webseite</Name></Server>
  </Folder>
</Servers></FileZilla3>"#;
        let s = parse_filezilla(xml);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "Cloud Bots");
        assert_eq!(s[0].protocol, "sftp");
        assert_eq!(s[0].auth, "agent");
        assert_eq!(s[0].remote_dir.as_deref(), Some("/home/ubuntu/bots"));
        assert_eq!(s[1].protocol, "ftps");
        assert!(!s[1].implicit_tls);
        assert_eq!(s[1].group, "Community");
        assert_eq!(s[1].auth, "password");
    }

    #[test]
    fn winscp_ini_sessions() {
        let ini = "[Sessions\\Bots%2FCloud]\nHostName=bots.example\nUserName=ubuntu\nPortNumber=2222\nPublicKeyFile=C:%5CKeys%5Ccloud.ppk\nRemoteDirectory=/home/ubuntu\n\n[Sessions\\Web]\nHostName=web.example\nFSProtocol=5\nFtps=1\n\n[Sessions\\Default%20Settings]\nHostName=x\n";
        let s = parse_winscp_ini(ini);
        assert_eq!(s.len(), 2, "{s:?}");
        assert_eq!(s[0].name, "Cloud");
        assert_eq!(s[0].group, "Bots");
        assert_eq!(s[0].port, 2222);
        assert_eq!(s[0].auth, "key");
        assert_eq!(s[1].protocol, "ftps");
        assert!(s[1].implicit_tls);
        assert_eq!(s[1].port, 990);
    }
}
