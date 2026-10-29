//! SSH connections, host key verification and SFTP operations.
//!
//! One `Connection` per server holds the SSH session and an SFTP subsystem.
//! Host keys are verified against Bitcrane's own store of trusted
//! fingerprints (`known_hosts.json` in the app config folder). An unknown or
//! changed key aborts the connection; the user confirms the fingerprint in
//! the UI and the frontend reconnects with `trust` set to that fingerprint.

use crate::error::{AppError, AppResult, ErrorKind, HostKeyInfo};
use crate::model::{perms_string, FileEntry, WalkItem};
use crate::paths::{remote_join, remote_name};
use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/* ----------------------------------------------------------------- Known hosts */

/// Trusted host key fingerprints, keyed by "host:port".
#[derive(Debug)]
pub struct KnownHosts {
    path: PathBuf,
    map: Mutex<HashMap<String, String>>,
}

impl KnownHosts {
    pub fn load(path: PathBuf) -> Self {
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, map: Mutex::new(map) }
    }

    pub fn get(&self, id: &str) -> Option<String> {
        self.map.lock().unwrap().get(id).cloned()
    }

    pub fn set(&self, id: &str, fingerprint: &str) {
        let mut map = self.map.lock().unwrap();
        map.insert(id.to_string(), fingerprint.to_string());
        self.save(&map);
    }

    fn save(&self, map: &HashMap<String, String>) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.path, serde_json::to_string_pretty(map).unwrap_or_default());
    }

    pub fn count(&self) -> usize {
        self.map.lock().unwrap().len()
    }

    /// All stored fingerprints as ("host:port", fingerprint), sorted by host.
    pub fn list(&self) -> Vec<(String, String)> {
        let mut v: Vec<_> = self.map.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        v.sort();
        v
    }

    /// Forgets a fingerprint; the next connection asks again.
    pub fn remove(&self, id: &str) {
        let mut map = self.map.lock().unwrap();
        map.remove(id);
        self.save(&map);
    }
}

/* ----------------------------------------------------------------- Parameters */

/// How to authenticate. Secrets are passed in by the frontend, which reads
/// them from the system keychain (never stored in Bitcrane's own files).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AuthParams {
    Key {
        path: String,
        #[serde(default)]
        passphrase: Option<String>,
    },
    Agent,
    Password {
        password: String,
    },
    /// "Automatisch": SSH agent, then the given or the default keys
    /// (~/.ssh/id_ed25519, id_ecdsa, id_rsa), then the password.
    Auto {
        #[serde(default)]
        key_path: Option<String>,
        #[serde(default)]
        passphrase: Option<String>,
        #[serde(default)]
        password: Option<String>,
    },
}

/// Questions of the server during login (one-time code, password prompt).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    pub host: String,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<PromptItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptItem {
    pub text: String,
    /// False for secret answers (shown as dots).
    pub echo: bool,
}

/// Asks the user (in the interface) and returns the answers, or `None` when cancelled.
pub type Prompter = Arc<dyn Fn(PromptRequest) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<String>>> + Send>> + Send + Sync>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthParams,
    /// Fingerprint the user has just confirmed in the host key dialog.
    #[serde(default)]
    pub trust: Option<String>,
    /// Send a keepalive every 30 seconds (setting "Verbindung offen halten").
    #[serde(default = "default_true")]
    pub keepalive: bool,
    /// Reach this server through another one ("Sprungserver", like ProxyJump).
    #[serde(default)]
    pub jump: Option<Box<ConnectParams>>,
    /// SOCKS5 or HTTP proxy for the TCP connection.
    #[serde(default)]
    pub proxy: Option<crate::proxy::ProxyParams>,
}

fn default_true() -> bool {
    true
}

/* ----------------------------------------------------------------- Handler */

/// What the server presented during the key exchange.
#[derive(Default, Clone)]
struct SeenKey {
    algorithm: String,
    fingerprint: String,
}

struct Handler {
    host_id: String,
    known: Arc<KnownHosts>,
    trust: Option<String>,
    seen: Arc<Mutex<Option<SeenKey>>>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let public = match key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            russh::keys::PublicKeyOrCertificate::Certificate(cert) => russh::keys::PublicKey::new(cert.public_key().clone(), ""),
        };
        let fingerprint = public.fingerprint(HashAlg::Sha256).to_string();
        let algorithm = public.algorithm().as_str().to_string();
        *self.seen.lock().unwrap() = Some(SeenKey { algorithm, fingerprint: fingerprint.clone() });

        let trusted_now = self.trust.as_deref() == Some(fingerprint.as_str());
        match self.known.get(&self.host_id) {
            Some(stored) if stored == fingerprint => Ok(true),
            _ if trusted_now => {
                self.known.set(&self.host_id, &fingerprint);
                Ok(true)
            }
            _ => Ok(false),
        }
    }
}

/* ----------------------------------------------------------------- Connection */

/// An open SSH session with its SFTP subsystem.
pub struct Connection {
    handle: client::Handle<Handler>,
    pub sftp: SftpSession,
    pub home: String,
    /// Session to the jump server, kept open while this connection lives.
    jump: Option<client::Handle<Handler>>,
}

fn agent_error(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::AuthFailed, "Der SSH-Agent ist nicht erreichbar oder hat keinen passenden Schlüssel.").with_detail(e.to_string())
}

/// Opens a connection, verifies the host key and authenticates.
/// Loads a private key in OpenSSH, PEM or PuTTY (.ppk) format.
pub fn load_private_key(path: &str, passphrase: Option<&str>) -> AppResult<russh::keys::PrivateKey> {
    let native = crate::paths::to_native(path);
    let text = std::fs::read_to_string(&native).map_err(|e| AppError::new(ErrorKind::AuthFailed, "Der Schlüssel konnte nicht gelesen werden.").with_detail(format!("{}: {e}", native.display())))?;
    if text.starts_with("PuTTY-User-Key-File") {
        // PuTTY keys (from WinSCP / Pageant). Encrypted ones say so in their header.
        let encrypted = text.lines().find(|l| l.starts_with("Encryption:")).map(|l| !l.contains("none")).unwrap_or(false);
        if encrypted && passphrase.is_none() {
            return Err(AppError::new(ErrorKind::PassphraseRequired, "Der Schlüssel ist mit einer Passphrase geschützt."));
        }
        return russh::keys::PrivateKey::from_ppk(&text, passphrase.map(str::to_string)).map_err(|e| {
            if encrypted {
                AppError::new(ErrorKind::PassphraseRequired, "Die Passphrase stimmt nicht.").with_detail(e.to_string())
            } else {
                AppError::new(ErrorKind::AuthFailed, "Der PuTTY-Schlüssel konnte nicht gelesen werden.").with_detail(e.to_string())
            }
        });
    }
    // Keys on a hardware token (YubiKey and other FIDO2 keys, "sk-…") cannot sign from the file:
    // the token has to be touched, which the SSH agent does.
    if text.contains("sk-ssh-ed25519@openssh.com") || text.contains("sk-ecdsa-sha2-nistp256@openssh.com") || std::fs::read_to_string(format!("{}.pub", native.display())).map(|p| p.starts_with("sk-")).unwrap_or(false) {
        return Err(AppError::new(
            ErrorKind::AuthFailed,
            "Das ist ein Hardware-Schlüssel (FIDO2, z. B. YubiKey). Bitte über den SSH-Agent nutzen: einmal „ssh-add“ mit dem Schlüssel ausführen und bei Anmeldung „SSH-Agent“ wählen.",
        ));
    }
    match russh::keys::decode_secret_key(&text, passphrase) {
        Ok(k) => Ok(k),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(AppError::new(ErrorKind::PassphraseRequired, "Der Schlüssel ist mit einer Passphrase geschützt.")),
        // A wrong passphrase surfaces as a decoding error of the key, not as a dedicated kind.
        Err(e) if passphrase.is_some() => Err(AppError::new(ErrorKind::PassphraseRequired, "Die Passphrase stimmt nicht.").with_detail(e.to_string())),
        Err(e) => Err(AppError::new(ErrorKind::AuthFailed, "Der Schlüssel konnte nicht gelesen werden.").with_detail(format!("{}: {e}", native.display()))),
    }
}

/// Result of one login step.
enum Step {
    Done,
    /// Accepted, but the server wants another method too (e.g. key plus one-time code).
    Partial,
    Rejected,
}

fn step(r: russh::client::AuthResult) -> (Step, Vec<russh::MethodKind>) {
    match r {
        russh::client::AuthResult::Success => (Step::Done, Vec::new()),
        russh::client::AuthResult::Failure { remaining_methods, partial_success } => {
            (if partial_success { Step::Partial } else { Step::Rejected }, remaining_methods.to_vec())
        }
    }
}

/// Logs in with a private key; uses an OpenSSH certificate ("<key>-cert.pub") when one lies next to it.
async fn key_login(handle: &mut client::Handle<Handler>, user: &str, path: &str, passphrase: Option<&str>) -> AppResult<(Step, Vec<russh::MethodKind>)> {
    let key = load_private_key(path, passphrase)?;
    let cert_path = crate::paths::to_native(&format!("{path}-cert.pub"));
    if let Ok(text) = std::fs::read_to_string(&cert_path) {
        if let Ok(cert) = russh::keys::Certificate::from_openssh(text.trim()) {
            return Ok(step(handle.authenticate_openssh_cert(user, Arc::new(key), cert).await?));
        }
    }
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    Ok(step(handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await?))
}

/// Keyboard-interactive login: password prompts get `password`, everything
/// else (one-time codes) is asked through `prompter`.
async fn keyboard_interactive(handle: &mut client::Handle<Handler>, params: &ConnectParams, password: Option<&str>, prompter: &Option<Prompter>) -> AppResult<(Step, Vec<russh::MethodKind>)> {
    use russh::client::KeyboardInteractiveAuthResponse as R;
    let mut resp = handle.authenticate_keyboard_interactive_start(params.user.clone(), None::<String>).await?;
    let mut password_used = false;
    for _ in 0..10 {
        match resp {
            R::Success => return Ok((Step::Done, Vec::new())),
            R::Failure { remaining_methods, partial_success } => {
                return Ok((if partial_success { Step::Partial } else { Step::Rejected }, remaining_methods.to_vec()));
            }
            R::InfoRequest { name, instructions, prompts } => {
                let is_password = |t: &str| t.to_lowercase().contains("passw") || t.to_lowercase().contains("kennwort");
                let answers = if prompts.is_empty() {
                    Vec::new()
                } else if let (Some(pw), false, true) = (password, password_used, prompts.len() == 1 && is_password(&prompts[0].prompt)) {
                    password_used = true;
                    vec![pw.to_string()]
                } else {
                    let Some(ask) = prompter else {
                        return Err(AppError::new(ErrorKind::AuthFailed, "Der Server stellt eine Rückfrage (z. B. Einmalcode), die hier nicht beantwortet werden kann."));
                    };
                    let req = PromptRequest {
                        host: params.host.clone(),
                        name,
                        instructions,
                        prompts: prompts.iter().map(|p| PromptItem { text: p.prompt.clone(), echo: p.echo }).collect(),
                    };
                    match ask(req).await {
                        Some(a) => a,
                        None => return Err(AppError::new(ErrorKind::Cancelled, "Anmeldung abgebrochen.")),
                    }
                };
                resp = handle.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    Err(AppError::new(ErrorKind::AuthFailed, "Der Server hat zu viele Rückfragen gestellt."))
}

/// Password login; servers that only allow keyboard-interactive get the password there.
async fn password_login(handle: &mut client::Handle<Handler>, params: &ConnectParams, password: &str, prompter: &Option<Prompter>) -> AppResult<(Step, Vec<russh::MethodKind>)> {
    let (st, methods) = step(handle.authenticate_password(params.user.clone(), password).await?);
    if matches!(st, Step::Rejected) && methods.contains(&russh::MethodKind::KeyboardInteractive) {
        return keyboard_interactive(handle, params, Some(password), prompter).await;
    }
    Ok((st, methods))
}

/// Default private keys tried by "Automatisch", like the ssh command does.
fn default_keys() -> Vec<String> {
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|n| crate::paths::home().join(".ssh").join(n))
        .filter(|p| p.is_file())
        .map(|p| crate::paths::to_ui(&p))
        .collect()
}

/// Runs the login of `params.auth`, including a second step (one-time code)
/// when the server asks for it after the first method.
async fn authenticate(handle: &mut client::Handle<Handler>, params: &ConnectParams, prompter: Option<Prompter>) -> AppResult<()> {
    let user = params.user.clone();
    let (mut st, mut methods) = match &params.auth {
        AuthParams::Password { password } => password_login(handle, params, password, &prompter).await?,
        AuthParams::Key { path, passphrase } => key_login(handle, &user, path, passphrase.as_deref()).await?,
        AuthParams::Agent => {
            if authenticate_with_agent(handle, &user).await? { (Step::Done, Vec::new()) } else { (Step::Rejected, Vec::new()) }
        }
        AuthParams::Auto { key_path, passphrase, password } => {
            let mut result = (Step::Rejected, Vec::new());
            // 1. SSH agent (silently skipped when there is none).
            if let Ok(true) = authenticate_with_agent(handle, &user).await {
                result = (Step::Done, Vec::new());
            }
            // 2. The chosen key, then the default keys; encrypted keys need their passphrase.
            if matches!(result.0, Step::Rejected) {
                let mut keys: Vec<String> = key_path.iter().cloned().collect();
                keys.extend(default_keys().into_iter().filter(|k| Some(k) != key_path.as_ref()));
                let mut needs_passphrase = false;
                for k in keys {
                    let pass = if Some(&k) == key_path.as_ref() { passphrase.as_deref() } else { None };
                    match key_login(handle, &user, &k, pass).await {
                        Ok(r) if !matches!(r.0, Step::Rejected) => { result = r; break; }
                        Ok(r) => result.1 = r.1,
                        Err(e) if e.kind == ErrorKind::PassphraseRequired && Some(&k) == key_path.as_ref() => needs_passphrase = true,
                        Err(_) => {}
                    }
                }
                // 3. Password (or keyboard-interactive), asked for if not given.
                if matches!(result.0, Step::Rejected) {
                    match password {
                        Some(pw) => result = password_login(handle, params, pw, &prompter).await?,
                        None if needs_passphrase => return Err(AppError::new(ErrorKind::PassphraseRequired, "Der Schlüssel ist mit einer Passphrase geschützt.")),
                        None => return Err(AppError::new(ErrorKind::PasswordRequired, "Der Server möchte ein Passwort.")),
                    }
                }
            }
            result
        }
    };
    // Second factor: the first method was accepted, the server asks for more.
    for _ in 0..3 {
        if !matches!(st, Step::Partial) {
            break;
        }
        let (s2, m2) = if methods.contains(&russh::MethodKind::KeyboardInteractive) {
            keyboard_interactive(handle, params, None, &prompter).await?
        } else if let (true, AuthParams::Password { password } | AuthParams::Auto { password: Some(password), .. }) = (methods.contains(&russh::MethodKind::Password), &params.auth) {
            step(handle.authenticate_password(user.clone(), password.clone()).await?)
        } else {
            return Err(AppError::new(ErrorKind::AuthFailed, "Der Server verlangt eine weitere Anmeldung, die Bitcrane nicht kennt."));
        };
        st = s2;
        methods = m2;
    }
    match st {
        Step::Done => Ok(()),
        _ => Err(AppError::new(ErrorKind::AuthFailed, "Anmeldung abgelehnt. Benutzer, Schlüssel oder Passwort prüfen.")),
    }
}

/// How the SSH transport is set up: directly over TCP, or through a channel
/// of an already open session (jump server).
enum Transport {
    Direct,
    Through(russh::ChannelStream<client::Msg>),
}

/// Handshake (with host key check) and login for one hop.
async fn open_session(params: &ConnectParams, known: Arc<KnownHosts>, transport: Transport, prompter: Option<Prompter>) -> AppResult<client::Handle<Handler>> {
    let host_id = format!("{}:{}", params.host, params.port);
    let seen = Arc::new(Mutex::new(None));
    let handler = Handler { host_id: host_id.clone(), known: known.clone(), trust: params.trust.clone(), seen: seen.clone() };

    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: params.keepalive.then(|| Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    let connected = match transport {
        Transport::Direct => match &params.proxy {
            None => tokio::time::timeout(Duration::from_secs(15), client::connect(config, (params.host.as_str(), params.port), handler)).await,
            Some(proxy) => {
                let stream = tokio::time::timeout(Duration::from_secs(15), crate::proxy::connect(proxy, &params.host, params.port))
                    .await
                    .map_err(|_| AppError::new(ErrorKind::Unreachable, "Der Proxy antwortet nicht (Zeitüberschreitung)."))??;
                tokio::time::timeout(Duration::from_secs(15), client::connect_stream(config, stream, handler)).await
            }
        },
        Transport::Through(stream) => tokio::time::timeout(Duration::from_secs(15), client::connect_stream(config, stream, handler)).await,
    };
    let mut handle = match connected {
        Err(_) => return Err(AppError::new(ErrorKind::Unreachable, "Der Server antwortet nicht (Zeitüberschreitung).")),
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            // A rejected host key ends the handshake; report which case it was.
            if let Some(key) = seen.lock().unwrap().clone() {
                let stored = known.get(&host_id);
                if stored.as_deref() != Some(key.fingerprint.as_str()) {
                    let changed = stored.is_some();
                    let mut err = AppError::new(
                        if changed { ErrorKind::HostKeyChanged } else { ErrorKind::HostKeyUnknown },
                        if changed { "Der Fingerabdruck des Servers hat sich geändert." } else { "Dieser Server ist noch nicht bekannt." },
                    );
                    err.host_key = Some(HostKeyInfo { host: params.host.clone(), algorithm: key.algorithm, fingerprint: key.fingerprint, previous: stored });
                    return Err(err);
                }
            }
            return Err(match e {
                russh::Error::IO(io) => AppError::from(io),
                other => AppError::new(ErrorKind::Unreachable, "Verbindung zum Server fehlgeschlagen.").with_detail(other.to_string()),
            });
        }
    };

    authenticate(&mut handle, params, prompter).await?;
    Ok(handle)
}

/// Opens an SFTP session, directly or through a jump server.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn connect(params: &ConnectParams, known: Arc<KnownHosts>) -> AppResult<Connection> {
    connect_with(params, known, None).await
}

/// Like `connect`, with a way to answer questions of the server (one-time codes).
pub async fn connect_with(params: &ConnectParams, known: Arc<KnownHosts>, prompter: Option<Prompter>) -> AppResult<Connection> {
    let (handle, jump) = match &params.jump {
        None => (open_session(params, known.clone(), Transport::Direct, prompter.clone()).await?, None),
        Some(jump_params) => {
            let jump = open_session(jump_params, known.clone(), Transport::Direct, prompter.clone()).await.map_err(|mut e| {
                e.message = format!("Sprungserver {}: {}", jump_params.host, e.message);
                e
            })?;
            let channel = jump
                .channel_open_direct_tcpip(params.host.clone(), params.port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| AppError::new(ErrorKind::Unreachable, "Der Sprungserver erreicht das Ziel nicht.").with_detail(e.to_string()))?;
            let target = open_session(params, known.clone(), Transport::Through(channel.into_stream()), prompter).await?;
            (target, Some(jump))
        }
    };

    let channel = handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| AppError::other("Der Server bietet kein SFTP an.").with_detail(e.to_string()))?;
    sftp.set_timeout(30);
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".to_string());
    Ok(Connection { handle, sftp, home, jump })
}

/// Agent sockets to try on macOS and Linux, in this order. Apps started from
/// the Finder do not see `SSH_AUTH_SOCK` from a shell profile, so the usual
/// places of the Bitwarden and 1Password agents are checked as well.
#[cfg(unix)]
fn agent_sockets() -> Vec<std::path::PathBuf> {
    let home = crate::paths::home();
    let mut out = Vec::new();
    if let Some(sock) = std::env::var_os("SSH_AUTH_SOCK") {
        out.push(std::path::PathBuf::from(sock));
    }
    for rel in [
        ".bitwarden-ssh-agent.sock",
        "Library/Containers/com.bitwarden.desktop/Data/.bitwarden-ssh-agent.sock",
        "snap/bitwarden/current/.bitwarden-ssh-agent.sock",
        "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
        ".1password/agent.sock",
    ] {
        let p = home.join(rel);
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out.into_iter().filter(|p| p.exists()).collect()
}

#[cfg(unix)]
async fn authenticate_with_agent(handle: &mut client::Handle<Handler>, user: &str) -> AppResult<bool> {
    let sockets = agent_sockets();
    if sockets.is_empty() {
        return Err(AppError::new(ErrorKind::AuthFailed, "Kein SSH-Agent gefunden. Läuft der Agent (z. B. in Bitwarden aktiviert)?"));
    }
    let mut any_keys = false;
    for sock in sockets {
        let Ok(mut agent) = russh::keys::agent::client::AgentClient::connect_uds(&sock).await else { continue };
        match try_agent_identities(handle, user, &mut agent).await {
            Ok(AgentOutcome::Accepted) => return Ok(true),
            Ok(AgentOutcome::Rejected) => any_keys = true,
            Ok(AgentOutcome::NoKeys) | Err(_) => {}
        }
    }
    if any_keys {
        Ok(false)
    } else {
        Err(AppError::new(ErrorKind::AuthFailed, "Im SSH-Agent ist kein Schlüssel geladen."))
    }
}

#[cfg(windows)]
async fn authenticate_with_agent(handle: &mut client::Handle<Handler>, user: &str) -> AppResult<bool> {
    // Windows' OpenSSH agent pipe (also used by 1Password and Bitwarden), then Pageant.
    let mut any_keys = false;
    if let Ok(mut agent) = russh::keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        match try_agent_identities(handle, user, &mut agent).await {
            Ok(AgentOutcome::Accepted) => return Ok(true),
            Ok(AgentOutcome::Rejected) => any_keys = true,
            _ => {}
        }
    }
    if let Ok(mut agent) = russh::keys::agent::client::AgentClient::connect_pageant().await {
        match try_agent_identities(handle, user, &mut agent).await {
            Ok(AgentOutcome::Accepted) => return Ok(true),
            Ok(AgentOutcome::Rejected) => any_keys = true,
            _ => {}
        }
    }
    if any_keys {
        Ok(false)
    } else {
        Err(AppError::new(ErrorKind::AuthFailed, "Kein SSH-Agent mit Schlüssel gefunden. Läuft der Agent (Windows-Dienst „OpenSSH Authentication Agent“, Bitwarden oder Pageant)?"))
    }
}

/// Result of trying all keys of one agent.
enum AgentOutcome {
    Accepted,
    Rejected,
    NoKeys,
}

async fn try_agent_identities<S>(handle: &mut client::Handle<Handler>, user: &str, agent: &mut russh::keys::agent::client::AgentClient<S>) -> AppResult<AgentOutcome>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent.request_identities().await.map_err(agent_error)?;
    if identities.is_empty() {
        return Ok(AgentOutcome::NoKeys);
    }
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    for id in identities {
        // Certificates in the agent (company SSH CAs) are offered as certificates;
        // keys on hardware tokens (FIDO2, "sk-" keys) sign inside the agent like any other key.
        let result = match &id {
            russh::keys::agent::AgentIdentity::Certificate { certificate, .. } => handle.authenticate_certificate_with(user, certificate.clone(), hash, agent).await,
            _ => handle.authenticate_publickey_with(user, id.public_key().into_owned(), hash, agent).await,
        };
        match result {
            Ok(r) if r.success() => return Ok(AgentOutcome::Accepted),
            _ => continue,
        }
    }
    Ok(AgentOutcome::Rejected)
}

impl Connection {
    pub async fn close(&self) {
        let _ = self.sftp.close().await;
        let _ = self.handle.disconnect(russh::Disconnect::ByApplication, "", "de").await;
        if let Some(j) = &self.jump {
            let _ = j.disconnect(russh::Disconnect::ByApplication, "", "de").await;
        }
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed() || self.jump.as_ref().map(|j| j.is_closed()).unwrap_or(false)
    }

    fn entry(name: String, attrs: &russh_sftp::protocol::FileAttributes) -> FileEntry {
        FileEntry {
            name,
            kind: if attrs.is_dir() { "dir".into() } else { "file".into() },
            size: if attrs.is_dir() { 0 } else { attrs.size.unwrap_or(0) },
            mtime: attrs.mtime.map(|t| t as i64 * 1000).unwrap_or(0),
            perms: attrs.permissions.map(perms_string).unwrap_or_else(|| "644".into()),
            owner: attrs.user.clone().unwrap_or_else(|| attrs.uid.map(|u| u.to_string()).unwrap_or_default()),
            group: attrs.group.clone().unwrap_or_else(|| attrs.gid.map(|g| g.to_string()).unwrap_or_default()),
            link: None,
            hidden: 0,
        }
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        let mut out: Vec<FileEntry> = Vec::new();
        for item in self.sftp.read_dir(path).await? {
            let name = item.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let mut attrs = item.metadata();
            let mut link = None;
            // Resolve symlinks so linked folders open like folders.
            if attrs.is_symlink() {
                let full = remote_join(path, &name);
                link = Some(self.sftp.read_link(full.clone()).await.unwrap_or_default());
                if let Ok(target) = self.sftp.metadata(full).await {
                    attrs = target;
                }
            }
            let mut entry = Self::entry(name, &attrs);
            entry.link = link;
            out.push(entry);
        }
        out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
            ("dir", "file") => std::cmp::Ordering::Less,
            ("file", "dir") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        let attrs = self.sftp.metadata(path).await?;
        Ok(Self::entry(remote_name(path), &attrs))
    }

    /// Difference between the server's clock and this computer's in
    /// milliseconds (positive: the server is ahead). Measured by creating a
    /// tiny file in the home folder and reading its modification time; SFTP
    /// has whole seconds, so the result is accurate to about a second.
    /// `None` when the home folder is not writable.
    pub async fn clock_offset_ms(&self) -> Option<i64> {
        use tokio::io::AsyncWriteExt;
        let probe = remote_join(&self.home, &format!(".bitcrane-clock-{}", uuid::Uuid::new_v4().simple()));
        let before = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
        let mut f = self.sftp.open_with_flags(probe.clone(), russh_sftp::protocol::OpenFlags::CREATE | russh_sftp::protocol::OpenFlags::WRITE | russh_sftp::protocol::OpenFlags::TRUNCATE).await.ok()?;
        let _ = f.write_all(b"x").await;
        let _ = f.shutdown().await;
        let after = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
        let mtime = self.sftp.metadata(probe.clone()).await.ok().and_then(|a| a.mtime);
        let _ = self.sftp.remove_file(probe).await;
        let server_ms = mtime? as i64 * 1000;
        // The server rounds down to the second; compare with the middle of our window.
        Some(server_ms + 500 - (before + after) / 2)
    }

    /// Reads at most `max` bytes from the start of a file.
    pub async fn read_head(&self, path: &str, max: usize) -> AppResult<Vec<u8>> {
        use tokio::io::AsyncReadExt;
        let file = self.sftp.open(path).await?;
        let mut buf = Vec::new();
        file.take(max as u64).read_to_end(&mut buf).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Lesen vom Server fehlgeschlagen.").with_detail(e.to_string()))?;
        Ok(buf)
    }

    pub async fn exists(&self, path: &str) -> bool {
        self.sftp.try_exists(path).await.unwrap_or(false)
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        self.sftp.create_dir(path).await?;
        Ok(())
    }

    /// Creates a folder and all missing parents.
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        self.mkdir_all_with(path, None).await
    }

    /// Creates all missing folders of `path`, optionally with the given permissions.
    pub async fn mkdir_all_with(&self, path: &str, perms: Option<u32>) -> AppResult<()> {
        let mut current = String::new();
        for seg in path.split('/').filter(|s| !s.is_empty()) {
            current.push('/');
            current.push_str(seg);
            if !self.exists(&current).await {
                if let Err(e) = self.sftp.create_dir(current.clone()).await {
                    // A parallel transfer may have created it in the meantime.
                    if !self.exists(&current).await {
                        return Err(e.into());
                    }
                } else if let Some(p) = perms {
                    let attrs = russh_sftp::protocol::FileAttributes { permissions: Some(p), ..Default::default() };
                    let _ = self.sftp.set_metadata(current.clone(), attrs).await;
                }
            }
        }
        Ok(())
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        if self.exists(to).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("„{}“ gibt es hier schon.", remote_name(to))));
        }
        self.sftp.rename(from, to).await?;
        Ok(())
    }

    /// Replaces `to` with `from` (used after uploading under a temporary name).
    /// Deletes a file or a folder with all its contents.
    pub async fn remove(&self, path: &str) -> AppResult<()> {
        let attrs = self.sftp.symlink_metadata(path).await?;
        if attrs.is_dir() {
            let children = self.list(path).await?;
            for c in children {
                Box::pin(self.remove(&remote_join(path, &c.name))).await?;
            }
            self.sftp.remove_dir(path).await?;
        } else {
            self.sftp.remove_file(path).await?;
        }
        Ok(())
    }

    /// Sets permission bits. Recursively, files lose the execute bits.
    pub async fn chmod(&self, path: &str, mode: u32, recursive: bool) -> AppResult<()> {
        let mut attrs = self.sftp.metadata(path).await?;
        let is_dir = attrs.is_dir();
        let file_type_bits = attrs.permissions.unwrap_or(0) & !0o7777;
        let own_mode = if recursive && !is_dir { mode & 0o666 } else { mode };
        attrs = russh_sftp::protocol::FileAttributes { permissions: Some(file_type_bits | own_mode), ..Default::default() };
        self.sftp.set_metadata(path, attrs).await?;
        if recursive && is_dir {
            // Linked entries are left alone: they may point outside the folder (or back into it).
            for c in self.list(path).await?.into_iter().filter(|c| c.link.is_none()) {
                Box::pin(self.chmod(&remote_join(path, &c.name), mode, true)).await?;
            }
        }
        Ok(())
    }

    /// Recursively lists all files below a remote path.
    pub async fn walk(&self, path: &str) -> AppResult<Vec<WalkItem>> {
        let base = crate::paths::remote_parent(path);
        let rel = |p: &str| p.strip_prefix(&base).unwrap_or(p).trim_start_matches('/').to_string();
        let root = self.stat(path).await?;
        if root.kind != "dir" {
            return Ok(vec![WalkItem { path: path.to_string(), relative: rel(path), size: root.size, mtime: root.mtime }]);
        }
        let mut out = Vec::new();
        let mut stack = vec![path.to_string()];
        while let Some(dir) = stack.pop() {
            for e in self.list(&dir).await? {
                let p = remote_join(&dir, &e.name);
                if e.kind == "dir" {
                    // Linked folders are not entered: a link back up would never end.
                    if e.link.is_none() {
                        stack.push(p);
                    }
                } else {
                    out.push(WalkItem { relative: rel(&p), path: p, size: e.size, mtime: e.mtime });
                }
            }
        }
        Ok(out)
    }

    /// Creates a symbolic link `link` that points to `target`.
    pub async fn symlink(&self, link: &str, target: &str) -> AppResult<()> {
        if self.exists(link).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("„{}“ gibt es hier schon.", remote_name(link))));
        }
        // OpenSSH's sftp-server reads the two paths in swapped order (a known quirk);
        // russh-sftp sends (link, target), so pass them swapped for OpenSSH.
        let swapped = self.sftp.symlink(target, link).await;
        if swapped.is_err() || self.sftp.read_link(link).await.ok().as_deref() != Some(target) {
            let _ = self.sftp.remove_file(link).await;
            self.sftp.symlink(link, target).await?;
        }
        Ok(())
    }

    /// SHA-256 of a server file as hex: `sha256sum` on the server when
    /// commands are allowed, otherwise read through this connection.
    pub async fn checksum(&self, path: &str) -> AppResult<String> {
        let quoted = format!("'{}'", path.replace('\'', "'\\''"));
        for cmd in [format!("sha256sum -- {quoted}"), format!("shasum -a 256 -- {quoted}")] {
            if let Ok((0, out)) = self.exec(&cmd).await {
                if let Some(hex) = out.split_whitespace().next().filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())) {
                    return Ok(hex.to_lowercase());
                }
            }
        }
        use sha2::{Digest, Sha256};
        use tokio::io::AsyncReadExt;
        let mut f = self.sftp.open(path).await?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = f.read(&mut buf).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Lesen vom Server fehlgeschlagen.").with_detail(e.to_string()))?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        Ok(format!("{:x}", h.finalize()))
    }

    /// Copies files or folders into `dest_dir` on the same server. Uses `cp`
    /// when the server allows commands (fast, the data stays on the server),
    /// otherwise copies through this connection. Returns the new names.
    pub async fn copy_within(&self, paths: &[String], dest_dir: &str) -> AppResult<Vec<String>> {
        let mut taken: std::collections::HashSet<String> = self.list(dest_dir).await?.into_iter().map(|e| e.name).collect();
        let mut out = Vec::new();
        for from in paths {
            if dest_dir == from.as_str() || dest_dir.starts_with(&format!("{from}/")) {
                return Err(AppError::other("Ein Ordner kann nicht in sich selbst kopiert werden."));
            }
            let name = crate::local::copy_name(|n| taken.contains(n), &remote_name(from));
            let to = remote_join(dest_dir, &name);
            let quoted = |p: &str| format!("'{}'", p.replace('\'', "'\\''"));
            let via_cp = match self.exec(&format!("cp -Rp -- {} {}", quoted(from), quoted(&to))).await {
                Ok((0, _)) => true,
                // A real cp error (no space, no permission); other failures mean commands are not allowed.
                Ok((_, output)) if output.trim_start().starts_with("cp:") => {
                    return Err(AppError::other("Kopieren auf dem Server fehlgeschlagen.").with_detail(output.trim().to_string()));
                }
                _ => false,
            };
            if !via_cp {
                Box::pin(self.copy_stream(from, &to)).await?;
            }
            taken.insert(name.clone());
            out.push(name);
        }
        Ok(out)
    }

    /// Copies through this connection (servers that only allow SFTP).
    async fn copy_stream(&self, from: &str, to: &str) -> AppResult<()> {
        let attrs = self.sftp.metadata(from).await?;
        if attrs.is_dir() {
            if !self.exists(to).await {
                self.sftp.create_dir(to).await?;
            }
            for c in self.list(from).await? {
                Box::pin(self.copy_stream(&remote_join(from, &c.name), &remote_join(to, &c.name))).await?;
            }
        } else {
            let mut src = self.sftp.open(from).await?;
            let mut dst = self.sftp.create(to).await?;
            tokio::io::copy(&mut src, &mut dst).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Kopieren auf dem Server fehlgeschlagen.").with_detail(e.to_string()))?;
            use tokio::io::AsyncWriteExt;
            let _ = dst.shutdown().await;
        }
        let keep = russh_sftp::protocol::FileAttributes { permissions: attrs.permissions.map(|p| p & 0o7777), atime: attrs.atime, mtime: attrs.mtime, ..Default::default() };
        let _ = self.sftp.set_metadata(to, keep).await;
        Ok(())
    }

    /// Runs a command on the server and returns exit code and combined output.
    pub async fn exec(&self, command: &str) -> AppResult<(u32, String)> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        let mut output = Vec::new();
        let mut code = 0u32;
        let read = async {
            while let Some(msg) = channel.wait().await {
                match msg {
                    russh::ChannelMsg::Data { data } => output.extend_from_slice(&data),
                    russh::ChannelMsg::ExtendedData { data, .. } => output.extend_from_slice(&data),
                    russh::ChannelMsg::ExitStatus { exit_status } => code = exit_status,
                    // Ended by a signal (killed): no exit code, but certainly not success.
                    russh::ChannelMsg::ExitSignal { .. } => code = 128,
                    _ => {}
                }
            }
        };
        if tokio::time::timeout(Duration::from_secs(120), read).await.is_err() {
            return Err(AppError::other("Der Befehl läuft länger als 2 Minuten und wurde abgebrochen."));
        }
        Ok((code, String::from_utf8_lossy(&output).into_owned()))
    }
}

/// Integration tests against a real SSH server. They run only when
/// `BITCRANE_TEST_SSH=host:port` is set (plus the user and key variables
/// below), so a normal `cargo test` stays offline.
#[cfg(test)]
mod integration {
    use super::*;
    use crate::error::ErrorKind;
    use crate::transfer::{TransferOptions, PAUSE, RUN};
    use std::sync::atomic::AtomicU8;

    struct Env {
        host: String,
        port: u16,
        user: String,
        key: String,
        key_pass: String,
        passphrase: String,
        password: String,
    }

    fn env() -> Option<Env> {
        let target = std::env::var("BITCRANE_TEST_SSH").ok()?;
        let (host, port) = target.split_once(':')?;
        Some(Env {
            host: host.into(),
            port: port.parse().ok()?,
            user: std::env::var("BITCRANE_TEST_USER").unwrap_or_else(|_| "test".into()),
            key: std::env::var("BITCRANE_TEST_KEY").ok()?,
            key_pass: std::env::var("BITCRANE_TEST_KEY_PASS").ok()?,
            passphrase: std::env::var("BITCRANE_TEST_PASSPHRASE").ok()?,
            password: std::env::var("BITCRANE_TEST_PASSWORD").ok()?,
        })
    }

    fn params(e: &Env, auth: AuthParams, trust: Option<String>) -> ConnectParams {
        ConnectParams { host: e.host.clone(), port: e.port, user: e.user.clone(), auth, trust, keepalive: true, jump: None, proxy: None }
    }

    #[tokio::test]
    async fn full_flow() {
        let Some(e) = env() else { return };
        let dir = tempfile::tempdir().unwrap();
        let known = Arc::new(KnownHosts::load(dir.path().join("known_hosts.json")));
        let key = || AuthParams::Key { path: e.key.clone(), passphrase: None };

        // 1. Unknown host key is reported with its fingerprint.
        let err = connect(&params(&e, key(), None), known.clone()).await.err().expect("must ask for trust");
        assert_eq!(err.kind, ErrorKind::HostKeyUnknown);
        let fp = err.host_key.unwrap().fingerprint;
        assert!(fp.starts_with("SHA256:"));

        // 2. Trusting it connects and stores it.
        let conn = connect(&params(&e, key(), Some(fp.clone())), known.clone()).await.expect("connect with trust");
        let conn = crate::remote::Remote::Sftp(conn);
        assert_eq!(known.count(), 1);
        assert!(conn.home().starts_with('/'));
        let offset = conn.clock_offset_ms().await.expect("clock offset");
        assert!(offset.abs() < 2000, "same machine, offset {offset}");

        // 3. File operations.
        let base = remote_join(conn.home(), "bitcrane-test");
        let _ = conn.remove(&base).await;
        conn.mkdir_all(&format!("{base}/a/b")).await.unwrap();
        let local_dir = tempfile::tempdir().unwrap();
        let local_file = local_dir.path().join("bot.py");
        std::fs::write(&local_file, vec![b'x'; 700_000]).unwrap();
        let local_ui = local_file.to_string_lossy().replace('\\', "/");
        let seen = std::sync::Mutex::new(Vec::new());
        let progress = |d: u64, t: u64| seen.lock().unwrap().push((d, t));
        let n = crate::transfer::upload(&conn, &local_ui, &format!("{base}/a/bot.py"), &TransferOptions::default(), &progress, Arc::new(AtomicU8::new(RUN))).await.unwrap();
        assert_eq!(n, 700_000);
        assert_eq!(seen.lock().unwrap().last().copied(), Some((700_000, 700_000)));
        let st = conn.stat(&format!("{base}/a/bot.py")).await.unwrap();
        assert_eq!(st.size, 700_000);
        let names: Vec<_> = conn.list(&format!("{base}/a")).await.unwrap().into_iter().map(|x| x.name).collect();
        assert_eq!(names, vec!["b".to_string(), "bot.py".to_string()], "no temp file left behind");

        conn.chmod(&format!("{base}/a/bot.py"), 0o600, false).await.unwrap();
        assert_eq!(conn.stat(&format!("{base}/a/bot.py")).await.unwrap().perms, "600");
        conn.rename(&format!("{base}/a/bot.py"), &format!("{base}/a/main.py")).await.unwrap();
        let walked = conn.walk(&format!("{base}/a")).await.unwrap();
        assert_eq!(walked.len(), 1);
        assert_eq!(walked[0].relative, "a/main.py");

        let back = local_dir.path().join("back.py").to_string_lossy().replace('\\', "/");
        crate::transfer::download(&conn, &format!("{base}/a/main.py"), &back, &TransferOptions::default(), &|_, _| {}, Arc::new(AtomicU8::new(RUN))).await.unwrap();
        assert_eq!(std::fs::metadata(local_dir.path().join("back.py")).unwrap().len(), 700_000);

        let (code, out) = conn.exec("echo hallo && exit 3").await.unwrap();
        assert_eq!(code, 3);
        assert_eq!(out.trim(), "hallo");

        // 3b. Pause keeps the partial file; the next upload continues from there.
        let big = local_dir.path().join("big.bin");
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&big, &data).unwrap();
        let big_ui = big.to_string_lossy().replace('\\', "/");
        let target = format!("{base}/big.bin");
        let flag = Arc::new(AtomicU8::new(RUN));
        let slow = TransferOptions { limit_kbps: 2048, ..Default::default() };
        let f2 = flag.clone();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            f2.store(PAUSE, std::sync::atomic::Ordering::Relaxed);
        });
        let paused = crate::transfer::upload(&conn, &big_ui, &target, &slow, &|_, _| {}, flag).await;
        stopper.await.unwrap();
        assert_eq!(paused.err().map(|e| e.kind), Some(ErrorKind::Cancelled));
        let part = conn.stat(&crate::transfer::temp_name(&target)).await.expect("partial file kept").size;
        assert!(part > 0 && part < 3_000_000, "partial size {part}");
        let first = std::sync::Mutex::new(None);
        let resumed = |d: u64, _t: u64| { first.lock().unwrap().get_or_insert(d); };
        crate::transfer::upload(&conn, &big_ui, &target, &TransferOptions::default(), &resumed, Arc::new(AtomicU8::new(RUN))).await.unwrap();
        assert_eq!(first.lock().unwrap().unwrap(), part, "continued at the partial size");
        let back_big = local_dir.path().join("big-back.bin");
        crate::transfer::download(&conn, &target, &back_big.to_string_lossy().replace('\\', "/"), &TransferOptions::default(), &|_, _| {}, Arc::new(AtomicU8::new(RUN))).await.unwrap();
        assert_eq!(std::fs::read(&back_big).unwrap(), data, "content identical after resume");

        // 3c. Older versions are kept (at most 2), explicit permissions are applied.
        let keep = TransferOptions { keep_versions: 2, file_perms: Some(0o640), ..Default::default() };
        for i in 0..3 {
            std::fs::write(&local_file, format!("version {i}")).unwrap();
            crate::transfer::upload(&conn, &local_ui, &format!("{base}/v.py"), &keep, &|_, _| {}, Arc::new(AtomicU8::new(RUN))).await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        }
        let versions = conn.list(&format!("{base}/{}", crate::transfer::VERSIONS_DIR)).await.unwrap();
        assert_eq!(versions.len(), 2, "two older versions kept");
        assert_eq!(conn.stat(&format!("{base}/v.py")).await.unwrap().perms, "640");
        assert_eq!(String::from_utf8(conn.read_head(&format!("{base}/v.py"), 100).await.unwrap()).unwrap(), "version 2");

        // 3d. Copies on the server: a clash gets "Kopie", folders are copied with content.
        let made = conn.copy_within(&[format!("{base}/v.py")], &base).await.unwrap();
        assert_eq!(made, vec!["v Kopie.py".to_string()]);
        let made = conn.copy_within(&[format!("{base}/v.py")], &base).await.unwrap();
        assert_eq!(made, vec!["v Kopie 2.py".to_string()]);
        conn.mkdir_all(&format!("{base}/c")).await.unwrap();
        let made = conn.copy_within(&[format!("{base}/a")], &format!("{base}/c")).await.unwrap();
        assert_eq!(made, vec!["a".to_string()]);
        assert_eq!(conn.walk(&format!("{base}/c/a")).await.unwrap().len(), 1);
        assert!(conn.copy_within(&[format!("{base}/c")], &format!("{base}/c/a")).await.is_err(), "not into itself");
        // Without commands on the server the copy goes through the connection.
        match &conn { crate::remote::Remote::Sftp(c) => c, _ => unreachable!() }.copy_stream(&format!("{base}/v.py"), &format!("{base}/stream.py")).await.unwrap();
        assert_eq!(String::from_utf8(conn.read_head(&format!("{base}/stream.py"), 100).await.unwrap()).unwrap(), "version 2");

        // 3e. Symbolic links and checksums.
        conn.symlink(&format!("{base}/link.py"), &format!("{base}/v.py")).await.unwrap();
        let entries = conn.list(&base).await.unwrap();
        let link = entries.iter().find(|x| x.name == "link.py").unwrap();
        assert_eq!(link.link.as_deref(), Some(format!("{base}/v.py").as_str()));
        assert_eq!(link.size, 9);
        let sum = conn.checksum(&format!("{base}/v.py")).await.unwrap();
        let local_v = local_dir.path().join("v.txt");
        std::fs::write(&local_v, "version 2").unwrap();
        assert_eq!(sum, crate::local::checksum(&local_v.to_string_lossy()).unwrap());

        // 4. Writing into a root-owned folder fails with a clear error.
        let denied = crate::transfer::upload(&conn, &local_ui, &format!("{}/rootdir/x.py", conn.home()), &TransferOptions::default(), &|_, _| {}, Arc::new(AtomicU8::new(RUN))).await;
        assert_eq!(denied.err().map(|e| e.kind), Some(ErrorKind::PermissionDenied));

        conn.remove(&base).await.unwrap();
        assert!(!conn.exists(&base).await);
        conn.close().await;

        // 5. Encrypted key: without passphrase -> PassphraseRequired, with -> ok.
        let err = connect(&params(&e, AuthParams::Key { path: e.key_pass.clone(), passphrase: None }, None), known.clone()).await.err().unwrap();
        assert_eq!(err.kind, ErrorKind::PassphraseRequired);
        connect(&params(&e, AuthParams::Key { path: e.key_pass.clone(), passphrase: Some(e.passphrase.clone()) }, None), known.clone()).await.expect("passphrase key").close().await;
        let err = connect(&params(&e, AuthParams::Key { path: e.key_pass.clone(), passphrase: Some("falsch".into()) }, None), known.clone()).await.err().unwrap();
        assert_eq!(err.kind, ErrorKind::PassphraseRequired, "wrong passphrase: {err:?}");

        // 5b. Through a jump server (here the same server reaches itself on localhost).
        let mut via = params(&e, AuthParams::Key { path: e.key.clone(), passphrase: None }, None);
        via.jump = Some(Box::new(params(&e, AuthParams::Key { path: e.key.clone(), passphrase: None }, None)));
        let hop = connect(&via, known.clone()).await.expect("connect through jump server");
        assert!(hop.home.starts_with('/'));
        assert!(!hop.list(&hop.home).await.unwrap().is_empty());
        hop.close().await;
        // An unreachable target behind the jump server gives a clear error.
        let mut bad = params(&e, AuthParams::Key { path: e.key.clone(), passphrase: None }, None);
        bad.port = 1;
        bad.jump = via.jump.clone();
        assert_eq!(connect(&bad, known.clone()).await.err().map(|x| x.kind), Some(ErrorKind::Unreachable));

        // 5d. Through a SOCKS5 and an HTTP proxy, if the test provides them.
        for (var, kind) in [("BITCRANE_TEST_SOCKS", "socks5"), ("BITCRANE_TEST_HTTP_PROXY", "http")] {
            if let Ok(addr) = std::env::var(var) {
                let (h, p) = addr.split_once(':').unwrap();
                let mut through = params(&e, AuthParams::Key { path: e.key.clone(), passphrase: None }, None);
                through.proxy = Some(crate::proxy::ProxyParams { kind: kind.into(), host: h.into(), port: p.parse().unwrap(), user: None, password: None });
                let c = connect(&through, known.clone()).await.unwrap_or_else(|err| panic!("{kind} proxy: {err:?}"));
                assert!(!c.list(&c.home).await.unwrap().is_empty());
                c.close().await;
                through.port = 1;
                assert_eq!(connect(&through, known.clone()).await.err().map(|x| x.kind), Some(ErrorKind::Unreachable), "{kind}: closed port");
            }
        }

        // 5c. PuTTY keys (.ppk), plain and with passphrase, if the test provides them.
        if let (Ok(ppk), Ok(ppk_pass)) = (std::env::var("BITCRANE_TEST_PPK"), std::env::var("BITCRANE_TEST_PPK_PASS")) {
            connect(&params(&e, AuthParams::Key { path: ppk, passphrase: None }, None), known.clone()).await.expect("ppk").close().await;
            let err = connect(&params(&e, AuthParams::Key { path: ppk_pass.clone(), passphrase: None }, None), known.clone()).await.err().unwrap();
            assert_eq!(err.kind, ErrorKind::PassphraseRequired);
            let err = connect(&params(&e, AuthParams::Key { path: ppk_pass.clone(), passphrase: Some("falsch".into()) }, None), known.clone()).await.err().unwrap();
            assert_eq!(err.kind, ErrorKind::PassphraseRequired);
            connect(&params(&e, AuthParams::Key { path: ppk_pass, passphrase: Some("pp geheim".into()) }, None), known.clone()).await.expect("ppk with passphrase").close().await;
        }

        // 5d. "Automatisch" with only a password: no agent/key fits, the password does.
        let auto = AuthParams::Auto { key_path: None, passphrase: None, password: Some(e.password.clone()) };
        connect(&params(&e, auto, None), known.clone()).await.expect("auto with password").close().await;
        let auto = AuthParams::Auto { key_path: Some(e.key.clone()), passphrase: None, password: None };
        connect(&params(&e, auto, None), known.clone()).await.expect("auto with key").close().await;
        let auto = AuthParams::Auto { key_path: None, passphrase: None, password: None };
        assert_eq!(connect(&params(&e, auto, None), known.clone()).await.err().map(|x| x.kind), Some(ErrorKind::PasswordRequired));

        // 5e. Keyboard-interactive only (PasswordAuthentication no) and key plus a second step.
        if let (Ok(kbd), Ok(two)) = (std::env::var("BITCRANE_TEST_KBD_PORT"), std::env::var("BITCRANE_TEST_2FA_PORT")) {
            let trust_all = |port: &str| {
                let mut p = params(&e, AuthParams::Password { password: e.password.clone() }, None);
                p.port = port.parse().unwrap();
                p
            };
            // Host keys are the same server; trust them under the new ports first.
            let mut p = trust_all(&kbd);
            p.trust = Some(fp.clone());
            connect(&p, known.clone()).await.expect("password via keyboard-interactive").close().await;
            // Second step answered through the prompter (here with the password, like a code).
            let pw = e.password.clone();
            let asked = Arc::new(Mutex::new(Vec::new()));
            let asked2 = asked.clone();
            let prompter: Prompter = Arc::new(move |req: PromptRequest| {
                asked2.lock().unwrap().push(req.prompts.iter().map(|x| x.text.clone()).collect::<Vec<_>>().join("|"));
                let pw = pw.clone();
                Box::pin(async move { Some(vec![pw]) })
            });
            let mut p = params(&e, AuthParams::Key { path: e.key.clone(), passphrase: None }, Some(fp.clone()));
            p.port = two.parse().unwrap();
            connect_with(&p, known.clone(), Some(prompter)).await.expect("key plus second step").close().await;
            assert_eq!(asked.lock().unwrap().len(), 1, "one question asked");
            // Without a way to answer, the second step fails clearly.
            let mut p = params(&e, AuthParams::Key { path: e.key.clone(), passphrase: None }, None);
            p.port = two.parse().unwrap();
            assert_eq!(connect(&p, known.clone()).await.err().map(|x| x.kind), Some(ErrorKind::AuthFailed));
        }

        // 5f. OpenSSH certificate: the server only trusts the CA, not the key itself.
        if let Ok(port) = std::env::var("BITCRANE_TEST_CERT_PORT") {
            let cert_key = std::env::var("BITCRANE_TEST_CERT_KEY").unwrap();
            let mut p = params(&e, AuthParams::Key { path: cert_key, passphrase: None }, Some(fp.clone()));
            p.port = port.parse().unwrap();
            connect(&p, known.clone()).await.expect("certificate login").close().await;
            let mut p = params(&e, AuthParams::Key { path: e.key.clone(), passphrase: None }, None);
            p.port = port.parse().unwrap();
            assert!(connect(&p, known.clone()).await.is_err(), "plain key is not accepted there");
        }

        // 6. Password authentication, right and wrong.
        connect(&params(&e, AuthParams::Password { password: e.password.clone() }, None), known.clone()).await.expect("password").close().await;
        let err = connect(&params(&e, AuthParams::Password { password: "falsch".into() }, None), known.clone()).await.err().unwrap();
        assert_eq!(err.kind, ErrorKind::AuthFailed);

        // 7. SSH agent (only when an agent is running).
        if std::env::var("SSH_AUTH_SOCK").is_ok() {
            connect(&params(&e, AuthParams::Agent, None), known.clone()).await.expect("agent").close().await;
        }

        // 8. A changed host key is detected.
        known.set(&format!("{}:{}", e.host, e.port), "SHA256:anders");
        let err = connect(&params(&e, key(), None), known.clone()).await.err().unwrap();
        assert_eq!(err.kind, ErrorKind::HostKeyChanged);
        assert_eq!(err.host_key.unwrap().previous.as_deref(), Some("SHA256:anders"));
    }
}

#[cfg(test)]
mod params_tests {
    use super::*;

    #[test]
    fn auth_params_from_the_interface() {
        let p: ConnectParams = serde_json::from_str(r#"{"host":"h","port":22,"user":"u","auth":{"method":"auto","keyPath":"~/.ssh/k","password":"x"},"jump":{"host":"j","port":22,"user":"u","auth":{"method":"agent"}}}"#).unwrap();
        match p.auth {
            AuthParams::Auto { key_path, password, passphrase } => {
                assert_eq!(key_path.as_deref(), Some("~/.ssh/k"));
                assert_eq!(password.as_deref(), Some("x"));
                assert!(passphrase.is_none());
            }
            _ => panic!("wrong variant"),
        }
        assert!(p.keepalive, "keepalive defaults to on");
        assert!(p.jump.is_some());
    }
}
