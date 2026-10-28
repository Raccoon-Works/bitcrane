//! Outgoing connections through a SOCKS5 or HTTP proxy (per server setting).

use crate::error::{AppError, AppResult, ErrorKind};
use base64::Engine;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Deserialize, Clone, Debug)]
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
    let with_login = p.user.as_deref().is_some_and(|u| !u.is_empty());
    let methods: &[u8] = if with_login { &[0x00, 0x02] } else { &[0x00] };
    let mut hello = vec![0x05, methods.len() as u8];
    hello.extend_from_slice(methods);
    s.write_all(&hello).await.map_err(io)?;
    let mut answer = [0u8; 2];
    s.read_exact(&mut answer).await.map_err(io)?;
    if answer[0] != 0x05 {
        return Err(proxy_error("Das ist kein SOCKS5-Proxy."));
    }
    match answer[1] {
        0x00 => {}
        0x02 => {
            let user = p.user.clone().unwrap_or_default();
            let pass = p.password.clone().unwrap_or_default();
            let mut auth = vec![0x01, user.len() as u8];
            auth.extend_from_slice(user.as_bytes());
            auth.push(pass.len() as u8);
            auth.extend_from_slice(pass.as_bytes());
            s.write_all(&auth).await.map_err(io)?;
            let mut status = [0u8; 2];
            s.read_exact(&mut status).await.map_err(io)?;
            if status[1] != 0 {
                return Err(AppError::new(ErrorKind::AuthFailed, "Proxy: Benutzer oder Passwort falsch."));
            }
        }
        _ => return Err(proxy_error("Der Proxy verlangt eine Anmeldung, die Bitcrane nicht kennt.")),
    }
    let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await.map_err(io)?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).await.map_err(io)?;
    if head[1] != 0 {
        let why = match head[1] {
            0x02 => "Verbindung vom Proxy nicht erlaubt.",
            0x03 => "Netz nicht erreichbar.",
            0x04 => "Server nicht erreichbar.",
            0x05 => "Verbindung abgelehnt.",
            _ => "Verbindung über den Proxy fehlgeschlagen.",
        };
        return Err(proxy_error(why));
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

async fn http_connect(s: &mut TcpStream, p: &ProxyParams, host: &str, port: u16) -> AppResult<()> {
    let io = |e: std::io::Error| proxy_error("Verbindung abgebrochen.").with_detail(e.to_string());
    let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some(user) = p.user.as_deref().filter(|u| !u.is_empty()) {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{}", p.password.clone().unwrap_or_default()));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.map_err(io)?;
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
    let text = String::from_utf8_lossy(&head);
    let status = text.split_whitespace().nth(1).unwrap_or("");
    match status {
        "200" => Ok(()),
        "407" => Err(AppError::new(ErrorKind::AuthFailed, "Proxy: Anmeldung erforderlich oder falsch.")),
        _ => Err(proxy_error(&format!("Antwort {}", text.lines().next().unwrap_or("").trim()))),
    }
}
