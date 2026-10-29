//! Sign-in to cloud services (Dropbox, OneDrive, Google Drive) with OAuth 2
//! "authorization code + PKCE" for desktop apps:
//!
//! 1. Bitcrane opens the service's sign-in page in the browser.
//! 2. The user signs in there and allows access. Bitcrane never sees the password.
//! 3. The service sends the browser back to a small web server Bitcrane runs
//!    on this computer only (127.0.0.1), which receives the one-time code.
//! 4. Bitcrane exchanges the code for a refresh token, which the interface keeps
//!    in the macOS Keychain or the Windows Credential Manager.
//!
//! The app keys (client ids) are public by design for desktop apps; PKCE
//! protects the exchange instead of a secret.

use crate::error::{AppError, AppResult, ErrorKind};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Port of the local web server for the sign-in answer. It must match the
/// redirect address registered with each service ("http://127.0.0.1:53682/").
pub const REDIRECT_PORT: u16 = 53682;

pub fn redirect_uri() -> String {
    format!("http://127.0.0.1:{REDIRECT_PORT}/")
}

/// The services and their app keys. The keys are put in at build time
/// (GitHub Actions variables); a build without a key reports the service as
/// not set up instead of failing.
pub fn app_key(service: &str) -> Option<&'static str> {
    let key = match service {
        "dropbox" => option_env!("BITCRANE_DROPBOX_KEY"),
        "onedrive" => option_env!("BITCRANE_ONEDRIVE_KEY"),
        _ => None,
    };
    key.filter(|k| !k.trim().is_empty())
}

/// Which cloud services this build can connect to without the user's own key.
#[derive(Serialize)]
pub struct CloudServices {
    pub dropbox: bool,
    pub onedrive: bool,
}

pub fn services() -> CloudServices {
    CloudServices { dropbox: app_key("dropbox").is_some(), onedrive: app_key("onedrive").is_some() }
}

/// Random text for the PKCE verifier and the state check (hex from random UUIDs).
fn random_token(len: usize) -> String {
    let mut out = String::new();
    while out.len() < len {
        out.push_str(&uuid::Uuid::new_v4().simple().to_string());
    }
    out.truncate(len);
    out
}

/// PKCE pair: the verifier stays here, the challenge goes into the sign-in address.
/// Random value for the "state" check of the sign-in answer.
pub fn state_token() -> String {
    random_token(32)
}

pub fn pkce() -> (String, String) {
    let verifier = random_token(64);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// A sign-in that is waiting for the browser can be cancelled from the interface.
static CANCEL: Mutex<Option<tokio::sync::oneshot::Sender<()>>> = Mutex::new(None);

pub fn cancel() {
    if let Some(tx) = CANCEL.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>Bitcrane</title><body style=\"font:16px system-ui;margin:4em;text-align:center\"><h2>Angemeldet</h2><p>Du kannst dieses Fenster schließen und zu Bitcrane zurückkehren.</p><p style=\"color:#888\">Signed in. You can close this window and return to Bitcrane.</p>";
const PAGE_ERR: &str = "<!doctype html><meta charset=utf-8><title>Bitcrane</title><body style=\"font:16px system-ui;margin:4em;text-align:center\"><h2>Anmeldung abgebrochen</h2><p>Bitte in Bitcrane noch einmal versuchen.</p>";

/// Opens `auth_url` in the browser and waits (up to 5 minutes) for the
/// service to send back the code. `state` must come back unchanged.
pub async fn wait_for_code(auth_url: &str, state: &str, open: impl FnOnce(&str) -> AppResult<()>) -> AppResult<String> {
    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT)).await.map_err(|e| {
        AppError::other("Die Anmeldung konnte nicht starten: ein anderes Programm benutzt gerade den Anschluss für die Rückmeldung (Port 53682).").with_detail(e.to_string())
    })?;
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    *CANCEL.lock().unwrap() = Some(tx);
    open(auth_url)?;
    let deadline = tokio::time::sleep(Duration::from_secs(300));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return Err(AppError::new(ErrorKind::Cancelled, "Die Anmeldung hat zu lange gedauert. Bitte noch einmal versuchen.")),
            _ = &mut rx => return Err(AppError::new(ErrorKind::Cancelled, "Anmeldung abgebrochen.")),
            accepted = listener.accept() => {
                let Ok((mut sock, _)) = accepted else { continue };
                let mut buf = vec![0u8; 8192];
                let n = tokio::time::timeout(Duration::from_secs(10), sock.read(&mut buf)).await.ok().and_then(|r| r.ok()).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                // "GET /?code=…&state=… HTTP/1.1"
                let target = head.split_whitespace().nth(1).unwrap_or("").to_string();
                let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
                let params: std::collections::HashMap<String, String> = reqwest::Url::parse(&format!("http://127.0.0.1/?{query}"))
                    .map(|u| u.query_pairs().into_owned().collect())
                    .unwrap_or_default();
                // Browsers also ask for /favicon.ico; answer and keep waiting.
                if params.is_empty() {
                    let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    continue;
                }
                let ok = params.get("state").map(|s| s == state).unwrap_or(false) && params.contains_key("code");
                let page = if ok { PAGE_OK } else { PAGE_ERR };
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len());
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
                CANCEL.lock().unwrap().take();
                if let Some(err) = params.get("error") {
                    let text = params.get("error_description").cloned().unwrap_or_else(|| err.clone());
                    return Err(AppError::new(if err == "access_denied" { ErrorKind::Cancelled } else { ErrorKind::AuthFailed }, "Der Dienst hat die Anmeldung nicht erlaubt.").with_detail(text));
                }
                if !ok {
                    return Err(AppError::new(ErrorKind::AuthFailed, "Die Antwort der Anmeldung passt nicht zu dieser Anfrage.").with_detail(query.to_string()));
                }
                return Ok(params["code"].clone());
            }
        }
    }
}

/// Answer of a token endpoint.
#[derive(Deserialize, Debug)]
pub struct TokenAnswer {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
}

/// Posts a form to a token endpoint and reads the answer.
pub async fn token_request(client: &reqwest::Client, url: &str, form: &[(&str, &str)]) -> AppResult<TokenAnswer> {
    let resp = client.post(url).form(form).send().await.map_err(|e| AppError::new(ErrorKind::Unreachable, "Der Anmeldedienst ist nicht erreichbar.").with_detail(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // invalid_grant: the stored sign-in was revoked or has expired.
        let kind = if text.contains("invalid_grant") { ErrorKind::AuthFailed } else { ErrorKind::Other };
        return Err(AppError::new(kind, "Die Anmeldung beim Dienst ist nicht mehr gültig. Bitte neu anmelden.").with_detail(format!("{status}: {text}")));
    }
    serde_json::from_str(&text).map_err(|e| AppError::other("Unerwartete Antwort des Anmeldedienstes.").with_detail(format!("{e}: {text}")))
}

/// HTTP client for the cloud services (public certificates only).
pub fn http_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .use_preconfigured_tls((*crate::tls::public_client_config()).clone())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(120))
        .user_agent(concat!("Bitcrane/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| AppError::other("Die Verbindung konnte nicht vorbereitet werden.").with_detail(e.to_string()))
}

/// Result of a sign-in, handed to the interface.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    pub refresh_token: String,
    /// E-mail address or name of the account, shown in the server list.
    pub account: String,
}

/// JSON for HTTP headers: everything outside ASCII written as \uXXXX
/// (Dropbox expects its "Dropbox-API-Arg" header that way).
pub fn ascii_json(v: &serde_json::Value) -> String {
    let s = v.to_string();
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            for u in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{:04x}", u));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_json_is_ascii() {
        let v = serde_json::json!({ "path": "/Fotos/Übersicht 🐻.txt" });
        let s = ascii_json(&v);
        assert!(s.is_ascii());
        let back: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(back, v);
    }

    #[tokio::test]
    async fn receives_the_code_from_the_browser() {
        let state = state_token();
        let st = state.clone();
        // The "browser": first asks for the favicon, then comes back with the code.
        let browser = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            for target in ["/favicon.ico".to_string(), format!("/?code=abc123&state={st}")] {
                let mut s = tokio::net::TcpStream::connect(("127.0.0.1", REDIRECT_PORT)).await.unwrap();
                s.write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).await.unwrap();
                let mut answer = String::new();
                let _ = s.read_to_string(&mut answer).await;
            }
        });
        let code = wait_for_code("https://example.invalid/auth", &state, |_| Ok(())).await.unwrap();
        browser.await.unwrap();
        assert_eq!(code, "abc123");
    }

    #[test]
    fn pkce_challenge_is_url_safe() {
        let (v, c) = pkce();
        assert_eq!(v.len(), 64);
        assert!(!c.contains('=') && !c.contains('+') && !c.contains('/'));
    }
}
