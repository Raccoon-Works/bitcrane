//! The saved servers as the core reads them: one typed model for the app's login commands, the
//! export and sync of secrets, and the command line.
//!
//! The interface owns the configuration file (`config.json`, see `config.rs`) and writes servers
//! in the shape of its `Server` type (`src/backend/types.ts`). This model reads the part the core
//! needs and ignores the rest (colours, places, tunnels …). Every field has the default the
//! interface assumes when it is missing, so every file an earlier version wrote still loads. A
//! server entry that still does not fit (a hand-edited port above 65535, an FTP encoding no version
//! writes) is set aside on its own (see [`read_servers`]), so it cannot break the others.

use crate::error::AppResult;
use crate::ftp::{FtpEncoding, TransferMode};
use crate::secrets::SecretRef;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

/// A saved server (or a temporary one from "Schnell verbinden", or a draft being tested).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    /// Host name; for a Cryptomator vault the vault's folder.
    pub host: String,
    /// The interface always writes one; 0 (missing) means the protocol's default where a protocol
    /// has one (WebDAV, S3, SMB).
    pub port: u16,
    pub user: String,
    pub auth: Auth,
    pub key_path: String,
    /// Start folder on the server; empty is the home folder.
    pub remote_start: String,
    /// Reach this server through another saved server ("Sprungserver", SFTP only).
    pub jump_server_id: Option<String>,
    pub proxy: Option<ServerProxy>,
    /// Seconds to wait for the server when connecting; missing is the default of 15.
    pub connect_timeout: Option<u64>,
    /// SFTP: always use shell commands instead of SFTP.
    pub scp: bool,
    /// SFTP: pass the local SSH agent on for the terminal (ssh -A).
    pub forward_agent: bool,
    /// SFTP: own command for the SFTP server instead of the subsystem.
    pub sftp_command: Option<String>,
    /// FTPS: implicit TLS instead of explicit TLS.
    pub implicit_tls: bool,
    /// FTPS, WebDAV over HTTPS, S3: only TLS 1.3.
    pub tls13_only: bool,
    pub ftp_encoding: FtpEncoding,
    /// FTP: server time zone in minutes east of UTC.
    pub ftp_timezone: i32,
    pub ftp_mode: TransferMode,
    pub dav_path: String,
    #[serde(default = "https_by_default")]
    pub dav_https: bool,
    pub smb_share: String,
    pub smb_encrypt: bool,
    pub s3_region: String,
    pub s3_bucket: String,
    pub s3_http: bool,
    pub s3_path_style: bool,
    /// Cryptomator vault: the server it lies on; none is this computer.
    pub vault_storage_id: Option<String>,
    pub gdoc_export: GdocExport,
}

fn https_by_default() -> bool {
    true
}

/// Transfer protocol of a server.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Ftp,
    Ftps,
    Webdav,
    Smb,
    S3,
    Vault,
    Dropbox,
    Gdrive,
    Onedrive,
    /// Also what the interface does with a value it does not know: it connects with SSH.
    #[default]
    #[serde(other)]
    Sftp,
}

impl Protocol {
    /// The name the configuration file uses.
    pub fn name(self) -> &'static str {
        match self {
            Protocol::Sftp => "sftp",
            Protocol::Ftp => "ftp",
            Protocol::Ftps => "ftps",
            Protocol::Webdav => "webdav",
            Protocol::Smb => "smb",
            Protocol::S3 => "s3",
            Protocol::Vault => "vault",
            Protocol::Dropbox => "dropbox",
            Protocol::Gdrive => "gdrive",
            Protocol::Onedrive => "onedrive",
        }
    }

    /// Cloud services, signed in through the browser instead of with a password.
    pub fn is_cloud(self) -> bool {
        matches!(self, Protocol::Dropbox | Protocol::Gdrive | Protocol::Onedrive)
    }
}

/// How an SFTP server is logged into. The other protocols use `Password` (or `Auto` after an
/// import); a password is read for them under the same rule as for SFTP.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Auth {
    Key,
    Agent,
    Password,
    /// "Automatisch": SSH agent, then the key file or the default keys, then the password. Also
    /// what the interface does with a value it does not know.
    #[default]
    #[serde(other)]
    Auto,
}

impl Auth {
    fn uses_password(self) -> bool {
        matches!(self, Auth::Password | Auth::Auto)
    }

    fn uses_passphrase(self) -> bool {
        matches!(self, Auth::Key | Auth::Auto)
    }
}

/// SOCKS5 or HTTP proxy in front of a server.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProxy {
    /// "socks5" or "http".
    pub kind: String,
    pub host: String,
    pub port: u16,
    /// Login at the proxy; its password is in the keychain.
    #[serde(default)]
    pub user: Option<String>,
}

/// Google Drive: what Docs, Sheets and Slides are downloaded as.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GdocExport {
    #[default]
    Office,
    Pdf,
}

impl Server {
    /// The jump server's id, if one is set (the interface writes "" for none).
    pub fn jump_id(&self) -> Option<&str> {
        self.jump_server_id.as_deref().filter(|id| !id.is_empty() && *id != self.id)
    }

    /// The vault's storage server, if it does not lie on this computer.
    pub fn vault_storage(&self) -> Option<&str> {
        self.vault_storage_id.as_deref().filter(|id| !id.is_empty())
    }

    /// The proxy, if one is set.
    pub fn proxy(&self) -> Option<&ServerProxy> {
        self.proxy.as_ref().filter(|p| !p.host.is_empty())
    }

    pub fn password_ref(&self) -> SecretRef {
        SecretRef::Password { user: self.user.clone(), host: self.host.clone(), port: self.port }
    }

    pub fn passphrase_ref(&self) -> SecretRef {
        SecretRef::Passphrase { key_path: self.key_path.clone() }
    }

    /// The proxy password's entry; only a proxy with a user name has one.
    pub fn proxy_ref(&self) -> Option<SecretRef> {
        let p = self.proxy()?;
        let user = p.user.as_ref().filter(|u| !u.is_empty())?;
        Some(SecretRef::Proxy { user: user.clone(), host: p.host.clone(), port: p.port })
    }

    pub fn cloud_ref(&self) -> SecretRef {
        SecretRef::Cloud { server_id: self.id.clone() }
    }

    /// Whether `other` logs into the same account the same way: protocol, address, user,
    /// encryption and proxy are equal. A login may use this server's stored secrets only then, so
    /// a request that changes any of them (plain FTP or HTTP instead of TLS, another proxy) cannot
    /// make the core send a stored password somewhere it was not saved for.
    pub fn same_login(&self, other: &Server) -> bool {
        fn route(s: &Server) -> (Protocol, &str, u16, &str, Option<&ServerProxy>) {
            (s.protocol, &s.host, s.port, &s.user, s.proxy())
        }
        fn encryption(s: &Server) -> [bool; 5] {
            [s.implicit_tls, s.tls13_only, s.dav_https, s.s3_http, s.smb_encrypt]
        }
        route(self) == route(other) && encryption(self) == encryption(other)
    }

    /// The stored password a login uses: only for the methods that send one.
    pub fn uses_password(&self) -> bool {
        self.auth.uses_password()
    }

    /// The stored key passphrase a login uses: only for the methods that read a key file.
    pub fn uses_passphrase(&self) -> bool {
        self.auth.uses_passphrase()
    }

    /// The secrets an export file and the sync file carry for this server: the password, the
    /// passphrase of its key file and the proxy password. `cloud` adds a cloud sign-in, which the
    /// sync carries and an export does not.
    pub fn transferable_secrets(&self, cloud: bool) -> Vec<SecretRef> {
        let mut out = vec![self.password_ref()];
        if !self.key_path.is_empty() {
            out.push(self.passphrase_ref());
        }
        out.extend(self.proxy_ref());
        if cloud && self.protocol.is_cloud() {
            out.push(self.cloud_ref());
        }
        out
    }

    /// Every entry that may hold a secret of this server, for removing them with the server.
    pub fn all_secrets(&self) -> Vec<SecretRef> {
        let mut out = vec![self.password_ref(), self.passphrase_ref()];
        out.extend(self.proxy_ref());
        if self.protocol.is_cloud() {
            out.push(self.cloud_ref());
        }
        out
    }
}

/// A saved server entry this model cannot read, kept by name for messages.
#[derive(Debug)]
pub struct Unreadable {
    pub id: String,
    pub name: String,
    /// What did not fit, for the log.
    pub reason: String,
}

/// Reads server entries one by one: an entry that does not fit is logged and set aside, and the
/// others are still read.
pub fn read_servers(entries: Vec<Value>) -> (Vec<Server>, Vec<Unreadable>) {
    let mut servers = Vec::new();
    let mut unreadable = Vec::new();
    for entry in entries {
        let text = |key: &str| entry.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let (id, name) = (text("id"), text("name"));
        match serde_json::from_value::<Server>(entry) {
            Ok(server) => servers.push(server),
            Err(e) => {
                log::warn!("skipped the saved server {name} ({id}), it is not readable: {e}");
                unreadable.push(Unreadable { id, name, reason: e.to_string() });
            }
        }
    }
    (servers, unreadable)
}

/// The parts of the configuration file the core reads.
#[derive(Debug, Default)]
pub struct Config {
    pub servers: Vec<Server>,
    /// Entries left out of `servers` (see [`read_servers`]).
    pub unreadable: Vec<Unreadable>,
    pub settings: Settings,
}

/// The file's shape before the servers are read one by one.
#[derive(Default, Deserialize)]
#[serde(default)]
struct RawConfig {
    servers: Vec<Value>,
    settings: Settings,
}

/// Settings the command line follows (the interface writes many more).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub google_client_id: String,
    pub upload_temp_name: bool,
    pub keep_mtime: bool,
}

impl Default for Settings {
    /// The interface's defaults (`src/state/defaults.ts`).
    fn default() -> Self {
        Settings { google_client_id: String::new(), upload_temp_name: true, keep_mtime: true }
    }
}

impl Config {
    /// Reads the configuration the interface stored; `null` (first start) is an empty one.
    pub fn from_value(value: Value) -> serde_json::Result<Config> {
        if value.is_null() {
            return Ok(Config::default());
        }
        let raw: RawConfig = serde_json::from_value(value)?;
        let (servers, unreadable) = read_servers(raw.servers);
        Ok(Config { servers, unreadable, settings: raw.settings })
    }

    /// Reads the configuration file in `dir` as it is now.
    pub fn read(dir: &Path) -> AppResult<Config> {
        Config::from_value(crate::config::load(dir)?).map_err(|e| {
            crate::error::AppError::other("Die Einstellungen sind nicht lesbar.").with_detail(e.to_string())
        })
    }

    pub fn server(&self, id: &str) -> Option<&Server> {
        self.servers.iter().find(|s| s.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A configuration as the interface writes it: one server of every protocol and every field
    /// of its `Server` type (src/backend/types.ts), the ones the core ignores included, with
    /// invented values (in the style of the demo data, src/state/demoData.ts).
    fn stored_config() -> serde_json::Value {
        serde_json::from_str(
            r#"{
  "version": 1,
  "servers": [
    {"id": "ob", "name": "Webshop · Live", "ruleId": "rule-app", "mono": "WL", "color": "gray", "image": "data:image/png;base64,iVBORw0KGgo=", "host": "shop.example", "port": 22, "user": "deploy", "auth": "key", "keyPath": "~/.ssh/shop_ed25519", "group": "Webshop", "localStart": "~/Projekte/webshop/live", "remoteStart": "/home/deploy/apps/webshop", "online": false, "temporary": false, "bookmarks": [{"name": "alt", "remotePath": "/srv"}], "places": [{"name": "deploy", "path": "/home/deploy"}], "jumpServerId": "nas", "protocol": "sftp", "lastUsed": 1700000000000, "proxy": {"kind": "socks5", "host": "proxy.example", "port": 1080, "user": "pu"}, "webUrl": "https://shop.example", "webRoot": "/var/www", "note": "Live-System", "scp": true, "termScheme": "red", "openAs": "terminal", "termStart": "htop", "forwardAgent": true, "sftpCommand": "sudo -n /usr/lib/openssh/sftp-server", "trashDir": ".papierkorb", "mountExplorer": true, "forwards": [{"id": "f1", "kind": "local", "localPort": 8080, "remoteHost": "localhost", "remotePort": 80, "auto": true}], "maxTransfers": 2, "connectTimeout": 30, "keepNameForm": true, "syncBrowseOnOpen": true},
    {"id": "nas", "name": "Backup NAS", "mono": "NA", "color": "blue", "host": "nas.example", "port": 2222, "user": "backup", "auth": "auto", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "", "online": false, "jumpServerId": ""},
    {"id": "pw", "name": "Altserver", "mono": "AS", "color": "gray", "host": "alt.example", "port": 22, "user": "root", "auth": "password", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "", "online": false},
    {"id": "ag", "name": "Agent", "mono": "AG", "color": "gray", "host": "agent.example", "port": 22, "user": "ops", "auth": "agent", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "", "online": false},
    {"id": "f1", "name": "Shop FTP", "mono": "SF", "color": "gray", "protocol": "ftps", "host": "ftp.example", "port": 990, "user": "shop@example.com", "auth": "password", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "/", "online": false, "implicitTls": true, "tls13Only": true, "ftpEncoding": "latin1", "ftpTimezone": -300, "ftpMode": "auto"},
    {"id": "f2", "name": "Altes FTP", "mono": "AF", "color": "gray", "protocol": "ftp", "host": "old.example", "port": 21, "user": "", "auth": "password", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "", "online": false, "ftpMode": "ascii", "ftpEncoding": "utf8"},
    {"id": "d1", "name": "Cloud", "mono": "CL", "color": "gray", "protocol": "webdav", "host": "dav.example", "port": 8443, "user": "ben", "auth": "password", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "", "online": false, "davPath": "remote.php/dav", "davHttps": false},
    {"id": "b1", "name": "Bucket", "mono": "BU", "color": "gray", "protocol": "s3", "host": "s3.example", "port": 443, "user": "AKIDEXAMPLE", "auth": "password", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "", "online": false, "s3Provider": "aws", "s3Region": "eu-central-1", "s3Bucket": "fotos", "s3Http": true, "s3PathStyle": true},
    {"id": "n1", "name": "NAS", "mono": "NS", "color": "gray", "protocol": "smb", "host": "nas.example", "port": 445, "user": "ben", "auth": "password", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "", "online": false, "smbShare": "daten", "smbEncrypt": true},
    {"id": "v1", "name": "Tresor", "mono": "TR", "color": "gray", "protocol": "vault", "host": "/Tresore/privat", "port": 0, "user": "n1", "auth": "password", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "/", "online": false, "vaultStorageId": "n1"},
    {"id": "c1", "name": "Dropbox", "mono": "DB", "color": "gray", "protocol": "dropbox", "host": "dropbox.com", "port": 443, "user": "alex@example.com", "auth": "agent", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "/", "online": false},
    {"id": "c2", "name": "Google Drive", "mono": "GD", "color": "gray", "protocol": "gdrive", "host": "drive.google.com", "port": 443, "user": "alex@example.com", "auth": "agent", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "/", "online": false, "gdocExport": "pdf"},
    {"id": "c3", "name": "OneDrive", "mono": "OD", "color": "gray", "protocol": "onedrive", "host": "onedrive.live.com", "port": 443, "user": "alex@example.com", "auth": "agent", "keyPath": "", "group": "", "localStart": "~", "remoteStart": "/", "online": false}
  ],
  "watches": [],
  "settings": {"googleClientId": "123.apps.googleusercontent.com", "uploadTempName": false, "keepAlive": true, "serverGroups": ["Webshop"]},
  "toolbar": [],
  "toolbarLabels": true
}
"#,
        )
        .expect("valid JSON")
    }

    #[test]
    fn a_stored_configuration_with_every_protocol_and_field_loads() {
        let config = Config::from_value(stored_config()).unwrap();
        let s = |id: &str| config.servers.iter().find(|x| x.id == id).unwrap();
        assert_eq!(config.servers.len(), 13);

        let shop = s("ob");
        assert_eq!((shop.protocol, shop.auth, shop.port), (Protocol::Sftp, Auth::Key, 22));
        assert_eq!((shop.jump_id(), shop.scp, shop.forward_agent), (Some("nas"), true, true));
        assert_eq!(shop.sftp_command.as_deref(), Some("sudo -n /usr/lib/openssh/sftp-server"));
        assert_eq!(shop.connect_timeout, Some(30));
        assert_eq!(
            shop.proxy_ref(),
            Some(SecretRef::Proxy { user: "pu".into(), host: "proxy.example".into(), port: 1080 })
        );
        assert_eq!(s("nas").jump_id(), None);
        assert_eq!(s("pw").auth, Auth::Password);
        assert_eq!(s("ag").auth, Auth::Agent);

        let ftp = s("f1");
        assert_eq!((ftp.protocol, ftp.implicit_tls, ftp.tls13_only), (Protocol::Ftps, true, true));
        assert_eq!((ftp.ftp_encoding, ftp.ftp_timezone, ftp.ftp_mode), (FtpEncoding::Latin1, -300, TransferMode::Auto));
        assert_eq!(s("f2").ftp_mode, TransferMode::Ascii);

        let dav = s("d1");
        assert_eq!((dav.dav_path.as_str(), dav.dav_https), ("remote.php/dav", false));
        let s3 = s("b1");
        assert_eq!(
            (s3.s3_region.as_str(), s3.s3_bucket.as_str(), s3.s3_http, s3.s3_path_style),
            ("eu-central-1", "fotos", true, true)
        );
        let smb = s("n1");
        assert_eq!((smb.smb_share.as_str(), smb.smb_encrypt), ("daten", true));
        assert_eq!((s("v1").protocol, s("v1").vault_storage()), (Protocol::Vault, Some("n1")));
        assert_eq!(s("c2").gdoc_export, GdocExport::Pdf);
        assert!([s("c1"), s("c2"), s("c3")].iter().all(|x| x.protocol.is_cloud()));
        // Every protocol, and each name read back is the one the file holds.
        let stored = stored_config();
        for (server, raw) in config.servers.iter().zip(stored["servers"].as_array().unwrap()) {
            assert_eq!(server.protocol.name(), raw["protocol"].as_str().unwrap_or("sftp"));
        }

        assert_eq!(config.settings.google_client_id, "123.apps.googleusercontent.com");
        assert!(!config.settings.upload_temp_name);
        assert!(config.settings.keep_mtime);
    }

    #[test]
    fn missing_fields_take_the_interfaces_defaults() {
        let s: Server = serde_json::from_value(json!({ "id": "x" })).unwrap();
        assert_eq!((s.protocol, s.auth, s.port, s.dav_https), (Protocol::Sftp, Auth::Auto, 0, true));
        assert_eq!(
            (s.ftp_encoding, s.ftp_mode, s.gdoc_export),
            (FtpEncoding::Utf8, TransferMode::Binary, GdocExport::Office)
        );
        assert!(s.proxy().is_none() && s.jump_id().is_none());
        assert!(Config::from_value(serde_json::Value::Null).unwrap().servers.is_empty());
        // Values a later version may add are read the way the interface reads them.
        let later: Server = serde_json::from_value(json!({ "id": "y", "protocol": "nfs", "auth": "fido" })).unwrap();
        assert_eq!((later.protocol, later.auth), (Protocol::Sftp, Auth::Auto));
        // FTP settings with a value no version writes are refused rather than guessed: a wrong
        // encoding or mode would damage file names or contents.
        for (key, value) in [("ftpEncoding", "utf-8"), ("ftpMode", "text")] {
            let entry = json!({ "id": "f", "protocol": "ftp", key: value });
            assert!(serde_json::from_value::<Server>(entry).is_err(), "{key}={value} must be refused");
        }
    }

    #[test]
    fn an_entry_that_does_not_fit_is_set_aside_and_the_others_load() {
        let mut stored = stored_config();
        stored["servers"][1]["port"] = json!(70000);
        stored["servers"][4]["ftpEncoding"] = json!("utf-16");
        let config = Config::from_value(stored).unwrap();
        assert_eq!(config.servers.len(), 11);
        let skipped: Vec<(&str, &str)> = config.unreadable.iter().map(|u| (u.id.as_str(), u.name.as_str())).collect();
        assert_eq!(skipped, [("nas", "Backup NAS"), ("f1", "Shop FTP")]);
        assert!(config.server("ob").is_some() && config.server("nas").is_none());
    }

    #[test]
    fn the_same_login_needs_the_same_address_encryption_and_proxy() {
        let config = Config::from_value(stored_config()).unwrap();
        for saved in &config.servers {
            assert!(saved.same_login(&saved.clone()), "{}", saved.id);
            // Name, colour, start folder and the like do not matter.
            let renamed = Server { name: "x".into(), remote_start: "/tmp".into(), ..saved.clone() };
            assert!(saved.same_login(&renamed));
        }
        let ftp = config.server("f1").unwrap();
        let changed = [
            Server { protocol: Protocol::Ftp, ..ftp.clone() },
            Server { host: "other.example".into(), ..ftp.clone() },
            Server { port: 21, ..ftp.clone() },
            Server { user: "other".into(), ..ftp.clone() },
            Server { implicit_tls: false, ..ftp.clone() },
            Server { tls13_only: false, ..ftp.clone() },
            Server { dav_https: false, ..ftp.clone() },
            Server { s3_http: true, ..ftp.clone() },
            Server { smb_encrypt: true, ..ftp.clone() },
            Server {
                proxy: Some(ServerProxy { kind: "http".into(), host: "proxy.example".into(), port: 8080, user: None }),
                ..ftp.clone()
            },
        ];
        for other in &changed {
            assert!(!ftp.same_login(other), "{other:?}");
        }
        let shop = config.server("ob").unwrap();
        assert!(!shop.same_login(&Server { proxy: None, ..shop.clone() }));
    }

    #[test]
    fn a_server_names_its_secrets_like_earlier_versions() {
        let config = Config::from_value(stored_config()).unwrap();
        let accounts = |id: &str, cloud: bool| -> Vec<String> {
            config
                .servers
                .iter()
                .find(|x| x.id == id)
                .unwrap()
                .transferable_secrets(cloud)
                .iter()
                .map(SecretRef::account)
                .collect()
        };
        assert_eq!(
            accounts("ob", true),
            ["password:deploy@shop.example:22", "passphrase:~/.ssh/shop_ed25519", "proxy:pu@proxy.example:1080"]
        );
        assert_eq!(accounts("f1", false), ["password:shop@example.com@ftp.example:990"]);
        assert_eq!(accounts("v1", false), ["password:n1@/Tresore/privat:0"]);
        assert_eq!(accounts("c1", false), ["password:alex@example.com@dropbox.com:443"]);
        assert_eq!(accounts("c1", true), ["password:alex@example.com@dropbox.com:443", "cloud:c1"]);
        let all: Vec<String> = config.servers[1].all_secrets().iter().map(SecretRef::account).collect();
        assert_eq!(all, ["password:backup@nas.example:2222", "passphrase:"]);
    }
}
