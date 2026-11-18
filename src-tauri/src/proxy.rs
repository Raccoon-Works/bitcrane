//! Outgoing connections through a SOCKS5 or HTTP proxy (per server setting).

use crate::error::{AppError, AppResult, ErrorKind};
use base64::Engine;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

// Deliberately without Debug: it holds secrets that must never end up in a log.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyParams {
    /// "socks5" or "http".
    pub kind: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

fn proxy_error(text: &str) -> AppError {
    AppError::new(ErrorKind::Unreachable, format!("Proxy: {text}"))
}

/// Opens a TCP connection to `host:port` through the proxy.
pub async fn connect(p: &ProxyParams, host: &str, port: u16) -> AppResult<TcpStream> {
    let mut stream = TcpStream::connect((p.host.as_str(), p.port))
        .await
        .map_err(|e| proxy_error(&format!("{}:{} nicht erreichbar.", p.host, p.port)).with_detail(e.to_string()))?;
    match p.kind.as_str() {
        "http" => http_connect(&mut stream, p, host, port).await?,
        _ => socks5_connect(&mut stream, p, host, port).await?,
    }
    Ok(stream)
}

async fn socks5_connect(s: &mut TcpStream, p: &ProxyParams, host: &str, port: u16) -> AppResult<()> {
    let io = |e: std::io::Error| proxy_error("Verbindung abgebrochen.").with_detail(e.to_string());
    s.write_all(&socks5_greeting(p)).await.map_err(io)?;
    let mut answer = [0u8; 2];
    s.read_exact(&mut answer).await.map_err(io)?;
    if answer[0] != 0x05 {
        return Err(proxy_error("Das ist kein SOCKS5-Proxy."));
    }
    match answer[1] {
        0x00 => {}
        0x02 => {
            s.write_all(&socks5_login(p)).await.map_err(io)?;
            let mut status = [0u8; 2];
            s.read_exact(&mut status).await.map_err(io)?;
            if status[1] != 0 {
                return Err(AppError::new(ErrorKind::AuthFailed, "Proxy: Benutzer oder Passwort falsch."));
            }
        }
        _ => return Err(proxy_error("Der Proxy verlangt eine Anmeldung, die Bitcrane nicht kennt.")),
    }
    s.write_all(&socks5_connect_request(host, port)).await.map_err(io)?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).await.map_err(io)?;
    if head[1] != 0 {
        return Err(proxy_error(socks5_refusal(head[1])));
    }
    // Skip the bound address.
    let skip = match head[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await.map_err(io)?;
            len[0] as usize
        }
        _ => 0,
    };
    let mut rest = vec![0u8; skip + 2];
    s.read_exact(&mut rest).await.map_err(io)?;
    Ok(())
}

/// SOCKS5 greeting: no authentication, plus user name and password when the server has a user.
fn socks5_greeting(p: &ProxyParams) -> Vec<u8> {
    let with_login = p.user.as_deref().is_some_and(|u| !u.is_empty());
    let methods: &[u8] = if with_login { &[0x00, 0x02] } else { &[0x00] };
    let mut hello = vec![0x05, methods.len() as u8];
    hello.extend_from_slice(methods);
    hello
}

/// SOCKS5 user name and password sub-negotiation (RFC 1929).
fn socks5_login(p: &ProxyParams) -> Vec<u8> {
    let user = p.user.clone().unwrap_or_default();
    let pass = p.password.clone().unwrap_or_default();
    let mut auth = vec![0x01, user.len() as u8];
    auth.extend_from_slice(user.as_bytes());
    auth.push(pass.len() as u8);
    auth.extend_from_slice(pass.as_bytes());
    auth
}

/// SOCKS5 CONNECT by host name, so the proxy resolves it (works for names only it can see).
fn socks5_connect_request(host: &str, port: u16) -> Vec<u8> {
    let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    req
}

/// Text for a SOCKS5 reply code other than success.
fn socks5_refusal(code: u8) -> &'static str {
    match code {
        0x02 => "Verbindung vom Proxy nicht erlaubt.",
        0x03 => "Netz nicht erreichbar.",
        0x04 => "Server nicht erreichbar.",
        0x05 => "Verbindung abgelehnt.",
        _ => "Verbindung über den Proxy fehlgeschlagen.",
    }
}

/// HTTP CONNECT request; an IPv6 address is written in brackets.
fn http_connect_request(p: &ProxyParams, host: &str, port: u16) -> String {
    let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some(user) = p.user.as_deref().filter(|u| !u.is_empty()) {
        let token = base64::engine::general_purpose::STANDARD
            .encode(format!("{user}:{}", p.password.clone().unwrap_or_default()));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    req
}

/// Outcome of the proxy's answer header to CONNECT.
fn http_connect_status(head: &str) -> AppResult<()> {
    match head.split_whitespace().nth(1).unwrap_or("") {
        "200" => Ok(()),
        "407" => Err(AppError::new(ErrorKind::AuthFailed, "Proxy: Anmeldung erforderlich oder falsch.")),
        _ => Err(proxy_error(&format!("Antwort {}", head.lines().next().unwrap_or("").trim()))),
    }
}

async fn http_connect(s: &mut TcpStream, p: &ProxyParams, host: &str, port: u16) -> AppResult<()> {
    let io = |e: std::io::Error| proxy_error("Verbindung abgebrochen.").with_detail(e.to_string());
    s.write_all(http_connect_request(p, host, port).as_bytes()).await.map_err(io)?;
    // Read the answer header byte by byte, so nothing of the SSH stream is consumed.
    let mut head = Vec::new();
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 {
            return Err(proxy_error("Unerwartete Antwort."));
        }
        s.read_exact(&mut b).await.map_err(io)?;
        head.push(b[0]);
    }
    http_connect_status(&String::from_utf8_lossy(&head))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(user: Option<&str>, password: Option<&str>) -> ProxyParams {
        ProxyParams {
            kind: "socks5".into(),
            host: "proxy.example".into(),
            port: 1080,
            user: user.map(Into::into),
            password: password.map(Into::into),
        }
    }

    #[test]
    fn socks5_offers_login_only_with_a_user() {
        assert_eq!(socks5_greeting(&params(None, None)), [0x05, 1, 0x00]);
        assert_eq!(socks5_greeting(&params(Some(""), Some("x"))), [0x05, 1, 0x00]);
        assert_eq!(socks5_greeting(&params(Some("anna"), None)), [0x05, 2, 0x00, 0x02]);
        assert_eq!(socks5_login(&params(Some("anna"), Some("pw"))), b"\x01\x04anna\x02pw");
        assert_eq!(socks5_login(&params(Some("anna"), None)), b"\x01\x04anna\x00");
    }

    #[test]
    fn socks5_connects_by_host_name() {
        assert_eq!(socks5_connect_request("files.example", 22), b"\x05\x01\x00\x03\x0dfiles.example\x00\x16");
        assert_eq!(socks5_refusal(0x05), "Verbindung abgelehnt.");
        assert_eq!(socks5_refusal(0x7f), "Verbindung über den Proxy fehlgeschlagen.");
    }

    #[test]
    fn http_connect_request_brackets_ipv6_and_sends_basic_auth() {
        assert_eq!(
            http_connect_request(&params(None, None), "files.example", 22),
            "CONNECT files.example:22 HTTP/1.1\r\nHost: files.example:22\r\n\r\n"
        );
        assert!(http_connect_request(&params(None, None), "2001:db8::1", 22).starts_with("CONNECT [2001:db8::1]:22 "));
        // "anna:pw" in Base64.
        assert!(http_connect_request(&params(Some("anna"), Some("pw")), "h", 1)
            .contains("Proxy-Authorization: Basic YW5uYTpwdw==\r\n"));
    }

    #[test]
    fn http_connect_status_tells_login_from_other_refusals() {
        assert!(http_connect_status("HTTP/1.1 200 Connection established\r\n\r\n").is_ok());
        let login = http_connect_status("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n").unwrap_err();
        assert_eq!(login.kind, ErrorKind::AuthFailed);
        let other = http_connect_status("HTTP/1.1 403 Forbidden\r\n\r\n").unwrap_err();
        assert_eq!(
            (other.kind, other.message.as_str()),
            (ErrorKind::Unreachable, "Proxy: Antwort HTTP/1.1 403 Forbidden")
        );
    }
}
