//! Logging into a saved server: its typed configuration plus the secrets from the keychain become
//! the connection parameters of its protocol. The app's login commands and the command line use
//! the same functions, so both log in the same way.
//!
//! A password or passphrase the user has just typed into the prompt comes with the [`Login`] and
//! takes the place of the stored one; everything else is read from the keychain here.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::ftp::FtpTls;
use crate::remote::Remote;
use crate::secrets::{saved, SecretRef, SecretStore};
use crate::serverconfig::{Auth, GdocExport, Protocol, Server};
use crate::ssh::{AuthParams, KnownHosts, Prompter};
use serde::Deserialize;
use std::sync::Arc;

/// What one login adds to the saved server.
// Deliberately without Debug: it holds secrets that must never end up in a log.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Login {
    /// Typed into the password prompt just now.
    pub password: Option<String>,
    /// Typed into the passphrase prompt just now.
    pub passphrase: Option<String>,
    /// Fingerprint or certificate the user has just confirmed.
    pub trust: Option<String>,
    /// Keep SSH connections open with keepalive messages (setting "Verbindung offen halten").
    pub keepalive: bool,
    /// Google Drive: the client id of the user's own app key (from the settings).
    pub google_client_id: String,
}

/// What opening a connection needs besides the server and the login.
pub struct Env<'a> {
    pub known: Arc<KnownHosts>,
    /// Answers the server's questions during an SSH login; `None` where nobody can answer.
    pub prompter: Option<Prompter>,
    pub secrets: &'a dyn SecretStore,
    /// The open connections, where a vault on a server reads its files.
    pub connections: crate::vault::Connections,
}

fn missing_password(server: &Server) -> AppError {
    AppError::new(
        ErrorKind::PasswordRequired,
        "Für {0} ist kein Passwort gespeichert. Einmal normal verbinden und das Passwort sichern.",
    )
    .param(&server.name)
}

/// The password of a login: the typed one, else the stored one for the methods that send one.
fn password(server: &Server, login: &Login, secrets: &dyn SecretStore) -> Option<String> {
    login.password.clone().or_else(|| server.uses_password().then(|| saved(secrets, &server.password_ref())).flatten())
}

fn passphrase(server: &Server, login: &Login, secrets: &dyn SecretStore) -> Option<String> {
    login
        .passphrase
        .clone()
        .or_else(|| server.uses_passphrase().then(|| saved(secrets, &server.passphrase_ref())).flatten())
}

fn proxy(server: &Server, secrets: &dyn SecretStore) -> Option<crate::proxy::ProxyParams> {
    let p = server.proxy()?;
    Some(crate::proxy::ProxyParams {
        kind: p.kind.clone(),
        host: p.host.clone(),
        port: p.port,
        user: p.user.clone().filter(|u| !u.is_empty()),
        password: server.proxy_ref().and_then(|r| saved(secrets, &r)),
    })
}

fn ssh_auth(server: &Server, login: &Login, secrets: &dyn SecretStore) -> AppResult<AuthParams> {
    let passphrase = passphrase(server, login, secrets);
    let password = password(server, login, secrets);
    Ok(match server.auth {
        Auth::Key => AuthParams::Key { path: server.key_path.clone(), passphrase },
        Auth::Agent => AuthParams::Agent,
        Auth::Password => AuthParams::Password { password: password.ok_or_else(|| missing_password(server))? },
        Auth::Auto => {
            AuthParams::Auto { key_path: Some(server.key_path.clone()).filter(|p| !p.is_empty()), passphrase, password }
        }
    })
}

/// SSH parameters. `jump` is the server named as the jump server; its proxy is used and the
/// target's own is not, as the jump server is the one connected to directly.
pub fn ssh_params(
    server: &Server,
    jump: Option<&Server>,
    login: &Login,
    secrets: &dyn SecretStore,
) -> AppResult<crate::ssh::ConnectParams> {
    let jump = match jump {
        Some(j) => {
            // Only the login of the jump server itself: what was typed belongs to the target.
            let auth = ssh_auth(j, &Login::default(), secrets)?;
            Some(Box::new(crate::ssh::ConnectParams {
                host: j.host.clone(),
                port: j.port,
                user: j.user.clone(),
                auth,
                trust: login.trust.clone(),
                keepalive: login.keepalive,
                scp: false,
                jump: None,
                proxy: proxy(j, secrets),
                forward_agent: false,
                timeout: None,
                sftp_command: None,
            }))
        }
        None => None,
    };
    Ok(crate::ssh::ConnectParams {
        host: server.host.clone(),
        port: server.port,
        user: server.user.clone(),
        auth: ssh_auth(server, login, secrets)?,
        trust: login.trust.clone(),
        keepalive: login.keepalive,
        scp: server.scp,
        proxy: if jump.is_some() { None } else { proxy(server, secrets) },
        jump,
        forward_agent: server.forward_agent,
        timeout: server.connect_timeout,
        sftp_command: server.sftp_command.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(str::to_string),
    })
}

/// ":port" for a URL, empty for the default port of the scheme or none.
fn port_part(port: u16, default: u16) -> String {
    if port == 0 || port == default {
        String::new()
    } else {
        format!(":{port}")
    }
}

pub fn ftp_params(server: &Server, login: &Login, secrets: &dyn SecretStore) -> crate::ftp::FtpParams {
    crate::ftp::FtpParams {
        host: server.host.clone(),
        port: server.port,
        user: server.user.clone(),
        password: password(server, login, secrets),
        tls: match (server.protocol, server.implicit_tls) {
            (Protocol::Ftp, _) => FtpTls::None,
            (_, true) => FtpTls::Implicit,
            (_, false) => FtpTls::Explicit,
        },
        tls13_only: server.tls13_only,
        encoding: server.ftp_encoding,
        tz_offset_min: server.ftp_timezone,
        mode: server.ftp_mode,
        trust: login.trust.clone(),
        proxy: proxy(server, secrets),
        timeout: server.connect_timeout,
    }
}

pub fn dav_params(server: &Server, login: &Login, secrets: &dyn SecretStore) -> crate::dav::DavParams {
    let (scheme, default_port) = if server.dav_https { ("https", 443) } else { ("http", 80) };
    let path = match server.dav_path.as_str() {
        "" => "/".to_string(),
        p if p.starts_with('/') => p.to_string(),
        p => format!("/{p}"),
    };
    crate::dav::DavParams {
        url: format!("{scheme}://{}{}{path}", server.host, port_part(server.port, default_port)),
        user: server.user.clone(),
        password: password(server, login, secrets),
        tls13_only: server.tls13_only,
        trust: login.trust.clone(),
        proxy: proxy(server, secrets),
        timeout: server.connect_timeout,
    }
}

pub fn s3_params(server: &Server, login: &Login, secrets: &dyn SecretStore) -> crate::s3::S3Params {
    let (scheme, default_port) = if server.s3_http { ("http", 80) } else { ("https", 443) };
    crate::s3::S3Params {
        endpoint: format!("{scheme}://{}{}", server.host, port_part(server.port, default_port)),
        region: server.s3_region.clone(),
        bucket: server.s3_bucket.clone(),
        access_key: server.user.clone(),
        secret: password(server, login, secrets),
        path_style: server.s3_path_style,
        tls13_only: server.tls13_only,
        trust: login.trust.clone(),
        proxy: proxy(server, secrets),
        timeout: server.connect_timeout,
    }
}

pub fn smb_params(server: &Server, login: &Login, secrets: &dyn SecretStore) -> crate::smb::SmbParams {
    crate::smb::SmbParams {
        host: server.host.clone(),
        port: if server.port == 0 { 445 } else { server.port },
        user: server.user.clone(),
        password: password(server, login, secrets),
        share: server.smb_share.clone(),
        encrypt: server.smb_encrypt,
        timeout: server.connect_timeout,
    }
}

/// The refresh token of a cloud service's sign-in.
fn cloud_token(server: &Server, secrets: &dyn SecretStore) -> AppResult<String> {
    saved(secrets, &server.cloud_ref()).ok_or_else(|| {
        AppError::new(ErrorKind::AuthFailed, "Für {0} fehlt die Anmeldung. Bitte neu anmelden.").param(&server.name)
    })
}

/// The user's own Google app key: the client id from the settings and the secret from the keychain.
pub fn google_key(client_id: &str, secrets: &dyn SecretStore) -> AppResult<(String, String)> {
    let client_id = client_id.trim();
    match saved(secrets, &SecretRef::GoogleClient) {
        Some(secret) if !client_id.is_empty() && !secret.is_empty() => Ok((client_id.to_string(), secret)),
        _ => Err(AppError::other(
            "Für Google Drive fehlt dein eigener App-Schlüssel (Client-ID und Client-Schlüssel). Die Anleitung zeigt, wie du ihn bekommst.",
        )),
    }
}

/// Opens a connection to a server with its protocol. `jump` is its jump server (SFTP only).
pub async fn open(server: &Server, jump: Option<&Server>, login: &Login, env: &Env<'_>) -> AppResult<Remote> {
    let secrets = env.secrets;
    let known = env.known.clone();
    Ok(match server.protocol {
        Protocol::Sftp => {
            crate::remote::connect_ssh(&ssh_params(server, jump, login, secrets)?, known, env.prompter.clone()).await?
        }
        Protocol::Ftp | Protocol::Ftps => {
            Remote::Ftp(Arc::new(crate::ftp::FtpConn::connect(ftp_params(server, login, secrets), known).await?))
        }
        Protocol::Webdav => Remote::Dav(crate::dav::DavConn::connect(dav_params(server, login, secrets), known).await?),
        Protocol::S3 => {
            Remote::S3(Arc::new(crate::s3::S3Conn::connect(s3_params(server, login, secrets), known).await?))
        }
        Protocol::Smb => Remote::Smb(Arc::new(crate::smb::SmbConn::connect(smb_params(server, login, secrets)).await?)),
        Protocol::Vault => {
            let password = password(server, login, secrets).ok_or_else(|| missing_password(server))?;
            let store = match server.vault_storage() {
                Some(id) => crate::vault::Store::Remote { connections: env.connections.clone(), id: id.to_string() },
                None => crate::vault::Store::Local,
            };
            Remote::Vault(Arc::new(crate::vault::VaultConn::open(store, &server.host, &password).await?))
        }
        Protocol::Dropbox => Remote::Dropbox(Arc::new(
            crate::dropbox::DropboxConn::connect(crate::dropbox::DropboxParams {
                refresh_token: cloud_token(server, secrets)?,
            })
            .await?,
        )),
        Protocol::Onedrive => {
            let refresh_token = cloud_token(server, secrets)?;
            let conn = Arc::new(
                crate::onedrive::OneDriveConn::connect(crate::onedrive::OneDriveParams {
                    refresh_token: refresh_token.clone(),
                })
                .await?,
            );
            // Microsoft renews the sign-in with each use; keep the newest one. Should the keychain
            // refuse, this connection still works and the old sign-in stays usable for a while.
            let renewed = conn.refresh_token().await;
            if renewed != refresh_token {
                if let Err(e) = secrets.set(&server.cloud_ref(), &renewed) {
                    log::warn!("could not keep the renewed OneDrive sign-in of {}: {e}", server.name);
                }
            }
            Remote::OneDrive(conn)
        }
        Protocol::Gdrive => {
            let (client_id, client_secret) = google_key(&login.google_client_id, secrets)?;
            Remote::GDrive(Arc::new(
                crate::gdrive::GDriveConn::connect(crate::gdrive::GDriveParams {
                    refresh_token: cloud_token(server, secrets)?,
                    client_id,
                    client_secret,
                    pdf_export: server.gdoc_export == GdocExport::Pdf,
                })
                .await?,
            ))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ftp::{FtpEncoding, TransferMode};
    use crate::secrets::tests::MemoryStore;
    use serde_json::json;

    fn server(v: serde_json::Value) -> Server {
        serde_json::from_value(v).unwrap()
    }

    fn web() -> Server {
        server(json!({ "id": "s1", "name": "Webserver", "host": "web.example", "port": 2222, "user": "anna",
                       "auth": "password", "jumpServerId": "s2", "scp": true, "connectTimeout": 30,
                       "sftpCommand": "  ", "proxy": { "kind": "http", "host": "own-proxy.example", "port": 8080 } }))
    }

    fn bastion() -> Server {
        server(json!({ "id": "s2", "name": "Bastion", "host": "jump.example", "port": 22, "user": "ops", "auth": "key",
                       "keyPath": "~/.ssh/id_ed25519",
                       "proxy": { "kind": "socks5", "host": "proxy.example", "port": 1080, "user": "pu" } }))
    }

    /// A keychain where every entry these servers use is stored, with its account as the value.
    fn keychain() -> MemoryStore {
        let store = MemoryStore::default();
        for account in [
            "password:anna@web.example:2222",
            "passphrase:~/.ssh/id_ed25519",
            "proxy:pu@proxy.example:1080",
            "password:shop@ftp.example:990",
            "password:ben@dav.example:8443",
            "password:AKIDEXAMPLE@s3.example:443",
        ] {
            store.0.lock().unwrap().insert(account.into(), format!("secret of {account}"));
        }
        store
    }

    #[test]
    fn ssh_login_comes_from_the_server_the_keychain_and_the_jump_server() {
        let login = Login { trust: Some("SHA256:x".into()), keepalive: true, ..Login::default() };
        let p = ssh_params(&web(), Some(&bastion()), &login, &keychain()).unwrap();
        assert_eq!((p.host.as_str(), p.port, p.user.as_str()), ("web.example", 2222, "anna"));
        assert!(
            matches!(&p.auth, AuthParams::Password { password } if password == "secret of password:anna@web.example:2222")
        );
        assert_eq!((p.scp, p.timeout, p.sftp_command.as_deref(), p.keepalive), (true, Some(30), None, true));
        // Through a jump server the target's own proxy is not used, the jump server's is.
        assert!(p.proxy.is_none());
        let jump = p.jump.expect("jump server");
        assert_eq!((jump.host.as_str(), jump.port, jump.trust.as_deref()), ("jump.example", 22, Some("SHA256:x")));
        assert!(matches!(&jump.auth, AuthParams::Key { path, passphrase: Some(p) }
            if path == "~/.ssh/id_ed25519" && p == "secret of passphrase:~/.ssh/id_ed25519"));
        let proxy = jump.proxy.expect("proxy");
        assert_eq!((proxy.kind.as_str(), proxy.port, proxy.user.as_deref()), ("socks5", 1080, Some("pu")));
        assert_eq!(proxy.password.as_deref(), Some("secret of proxy:pu@proxy.example:1080"));

        let direct = ssh_params(&web(), None, &login, &keychain()).unwrap();
        assert_eq!(direct.proxy.map(|p| p.host), Some("own-proxy.example".to_string()));
    }

    #[test]
    fn a_typed_secret_takes_the_place_of_the_stored_one() {
        let login = Login { password: Some("typed".into()), ..Login::default() };
        let p = ssh_params(&web(), None, &login, &keychain()).unwrap();
        assert!(matches!(&p.auth, AuthParams::Password { password } if password == "typed"));
        // "Automatisch" sends what is stored of both, the typed passphrase in place of the stored one.
        let auto = server(json!({ "id": "a", "host": "auto.example", "port": 22, "user": "anna",
                                  "keyPath": "~/.ssh/id_ed25519" }));
        let store = keychain();
        store.0.lock().unwrap().insert("password:anna@auto.example:22".into(), "pw".into());
        let login = Login { passphrase: Some("typed".into()), ..Login::default() };
        let p = ssh_params(&auto, None, &login, &store).unwrap();
        assert!(matches!(&p.auth, AuthParams::Auto { key_path: Some(k), passphrase: Some(pp), password: Some(pw) }
            if k == "~/.ssh/id_ed25519" && pp == "typed" && pw == "pw"));
        // A key login does not send a stored password, an agent login nothing at all.
        let key = server(json!({ "id": "k", "host": "auto.example", "port": 22, "user": "anna", "auth": "key" }));
        assert!(matches!(ssh_params(&key, None, &Login::default(), &store).unwrap().auth, AuthParams::Key { .. }));
    }

    #[test]
    fn ssh_with_password_needs_a_saved_or_typed_one() {
        let e = ssh_params(&web(), None, &Login::default(), &MemoryStore::default()).err().expect("no password");
        assert_eq!(e.kind, ErrorKind::PasswordRequired);
        assert_eq!(
            e.message.english(),
            "No password is saved for Webserver. Connect normally once and save the password."
        );
    }

    #[test]
    fn ftp_dav_s3_and_smb_parameters_follow_the_saved_server() {
        let store = keychain();
        let login = Login { trust: Some("cert".into()), ..Login::default() };
        let ftp = ftp_params(
            &server(json!({ "id": "f", "protocol": "ftps", "host": "ftp.example", "port": 990, "user": "shop",
                            "auth": "password", "implicitTls": true, "ftpEncoding": "latin1", "ftpMode": "auto",
                            "ftpTimezone": 60 })),
            &login,
            &store,
        );
        assert_eq!(
            (ftp.port, ftp.tls, ftp.encoding, ftp.mode, ftp.tz_offset_min),
            (990, FtpTls::Implicit, FtpEncoding::Latin1, TransferMode::Auto, 60)
        );
        assert_eq!(
            (ftp.password.as_deref(), ftp.trust.as_deref()),
            (Some("secret of password:shop@ftp.example:990"), Some("cert"))
        );
        let plain = ftp_params(&server(json!({ "id": "f", "protocol": "ftp", "implicitTls": true })), &login, &store);
        assert_eq!(plain.tls, FtpTls::None);

        let dav = |v| dav_params(&server(v), &login, &store);
        let d = dav(json!({ "id": "d", "protocol": "webdav", "host": "dav.example", "port": 8443, "user": "ben",
                            "auth": "password", "davPath": "remote.php/dav" }));
        assert_eq!(
            (d.url.as_str(), d.password.as_deref()),
            ("https://dav.example:8443/remote.php/dav", Some("secret of password:ben@dav.example:8443"))
        );
        assert_eq!(dav(json!({ "id": "d", "host": "dav.example", "port": 443 })).url, "https://dav.example/");
        assert_eq!(
            dav(json!({ "id": "d", "host": "dav.example", "port": 80, "davHttps": false, "davPath": "/x" })).url,
            "http://dav.example/x"
        );

        let s3 = s3_params(
            &server(json!({ "id": "b", "protocol": "s3", "host": "s3.example", "port": 443, "user": "AKIDEXAMPLE",
                            "auth": "password", "s3Region": "eu-central-1", "s3Bucket": "fotos", "s3PathStyle": true })),
            &login,
            &store,
        );
        assert_eq!((s3.endpoint.as_str(), s3.bucket.as_str(), s3.path_style), ("https://s3.example", "fotos", true));
        assert_eq!(s3.secret.as_deref(), Some("secret of password:AKIDEXAMPLE@s3.example:443"));

        let smb = smb_params(
            &server(json!({ "id": "n", "protocol": "smb", "host": "nas.example", "port": 0,
                                              "smbShare": "daten", "auth": "password" })),
            &login,
            &store,
        );
        assert_eq!((smb.port, smb.share.as_str(), smb.password), (445, "daten", None));
    }

    #[test]
    fn cloud_logins_need_their_sign_in_and_the_google_key() {
        let drive = server(json!({ "id": "c2", "name": "Google Drive", "protocol": "gdrive" }));
        let e = cloud_token(&drive, &MemoryStore::default()).unwrap_err();
        assert_eq!(
            (e.kind, e.message.english()),
            (ErrorKind::AuthFailed, "Sign-in for Google Drive is missing. Please sign in again.".into())
        );
        let store = MemoryStore::with(&[(SecretRef::GoogleClient, "geheim")]);
        assert_eq!(google_key(" id ", &store).unwrap(), ("id".to_string(), "geheim".to_string()));
        assert!(google_key("", &store).is_err());
        assert!(google_key("id", &MemoryStore::default()).is_err());
    }
}
