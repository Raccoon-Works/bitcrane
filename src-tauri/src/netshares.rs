//! Computers in the local network that offer file shares (SMB), found through
//! multicast DNS (Bonjour) like the Finder's "Freigaben" / ForkLift's "Shared".
//! Macs and most NAS devices announce `_smb._tcp`; the sidebar lists them and a
//! click opens the share in Bitcrane's own SMB connection.

use serde::Serialize;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct NetHost {
    /// Name the computer announces ("iMac von Elna").
    pub name: String,
    /// Host name to connect to ("iMac-von-Elna.local").
    pub host: String,
}

/// Instance name from a full service name ("iMac von Elna._smb._tcp.local." → "iMac von Elna").
fn instance_name(fullname: &str, ty: &str) -> String {
    let name = fullname.strip_suffix(ty).unwrap_or(fullname).trim_end_matches('.');
    // DNS-SD escapes spaces and dots as "\032" / "\." in some responders.
    name.replace("\\032", " ").replace("\\.", ".")
}

/// Names of this computer (to leave it out of its own list of shares).
fn own_names() -> Vec<String> {
    let mut names = Vec::new();
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(v) = std::env::var(var) {
            names.push(v);
        }
    }
    #[cfg(target_os = "macos")]
    for key in ["LocalHostName", "ComputerName"] {
        if let Ok(o) = std::process::Command::new("/usr/sbin/scutil").args(["--get", key]).output() {
            names.push(String::from_utf8_lossy(&o.stdout).trim().to_string());
        }
    }
    #[cfg(unix)]
    if let Ok(o) = std::process::Command::new("hostname").output() {
        names.push(String::from_utf8_lossy(&o.stdout).trim().to_string());
    }
    names.into_iter().filter(|n| !n.is_empty()).map(|n| n.trim_end_matches(".local").to_lowercase()).collect()
}

/// Searches the network for `wait` and returns the SMB hosts found (without this computer), sorted by name.
pub fn discover(wait: Duration) -> Vec<NetHost> {
    const TY: &str = "_smb._tcp.local.";
    let Ok(daemon) = mdns_sd::ServiceDaemon::new() else { return Vec::new() };
    let Ok(events) = daemon.browse(TY) else {
        let _ = daemon.shutdown();
        return Vec::new();
    };
    let own = own_names();
    let mut found: BTreeMap<String, NetHost> = BTreeMap::new();
    let end = Instant::now() + wait;
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match events.recv_timeout(left) {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                let name = instance_name(&info.fullname, TY);
                let host = info.host.trim_end_matches('.').to_string();
                let short = host.trim_end_matches(".local").to_lowercase();
                let mine = own.iter().any(|n| *n == short || *n == name.to_lowercase());
                if !name.is_empty() && !host.is_empty() && !mine {
                    found.insert(name.to_lowercase(), NetHost { name, host });
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.stop_browse(TY);
    let _ = daemon.shutdown();
    found.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_names() {
        assert_eq!(instance_name("iMac von Elna._smb._tcp.local.", "_smb._tcp.local."), "iMac von Elna");
        assert_eq!(instance_name("NAS\\032Keller._smb._tcp.local.", "_smb._tcp.local."), "NAS Keller");
    }
}
