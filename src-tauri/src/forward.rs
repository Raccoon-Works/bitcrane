//! SSH port forwarding (tunnels) of a server, like `ssh -L`, `-R` and `-D`.
//!
//! - local: a port on this computer leads through the server to a target
//!   (e.g. 127.0.0.1:5433 → the server's database on 127.0.0.1:5432).
//! - remote: a port on the server leads back to a target on this side.
//! - dynamic: a SOCKS5 proxy on this computer; every connection goes out
//!   from the server.
//!
//! The tunnels use the server's open SSH connection and end with it: a new
//! connection to the server stops the old ones (server_connect), a local port
//! closes when it is used after its connection ended, and `active` no longer
//! lists tunnels of a closed connection, so the interface starts them again.
//! Which tunnels a server has is stored in its settings (frontend); this
//! module only runs them.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::remote::Remote;
use crate::LockExt;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSpec {
    pub id: String,
    /// "local", "remote" or "dynamic".
    pub kind: String,
    pub bind_host: String,
    pub bind_port: u16,
    #[serde(default)]
    pub dest_host: String,
    #[serde(default)]
    pub dest_port: u16,
}

struct Running {
    server_id: String,
    /// The connection the tunnel runs on.
    conn: Arc<Remote>,
    task: Option<JoinHandle<()>>,
    /// Remote forward: address and port to cancel on the server.
    remote: Option<(String, u32)>,
}

#[derive(Default)]
pub struct Forwards(Mutex<HashMap<String, Running>>);

fn bind_error(spec: &ForwardSpec, e: std::io::Error) -> AppError {
    let what = format!("{}:{}", spec.bind_host, spec.bind_port);
    if e.kind() == std::io::ErrorKind::AddrInUse {
        AppError::new(ErrorKind::Other, "Der Port {0} ist auf diesem Computer schon belegt.").param(what)
    } else {
        AppError::new(ErrorKind::Other, "Der Port {0} kann nicht geöffnet werden.")
            .param(what)
            .with_detail(e.to_string())
    }
}

/// Opens a channel from the server to `host:port` and passes the data of `tcp` through it.
async fn through(conn: &Remote, mut tcp: TcpStream, host: &str, port: u16) {
    let Ok((handle, _)) = conn.tunnel() else { return };
    let peer = tcp.peer_addr().ok();
    let (orig, orig_port) = peer.map(|p| (p.ip().to_string(), p.port() as u32)).unwrap_or(("127.0.0.1".into(), 0));
    if let Ok(channel) = handle.channel_open_direct_tcpip(host.to_string(), port as u32, orig, orig_port).await {
        let _ = tcp.set_nodelay(true);
        let mut stream = channel.into_stream();
        let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
    }
}

/// Reply codes of SOCKS5 (RFC 1928, section 6), sent with an empty IPv4 address.
const SOCKS_OK: u8 = 0;
const SOCKS_UNREACHABLE: u8 = 4;
const SOCKS_NO_COMMAND: u8 = 7;
const SOCKS_NO_ADDRESS_TYPE: u8 = 8;

async fn socks_reply<S: AsyncWrite + Unpin>(s: &mut S, code: u8) -> std::io::Result<()> {
    s.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

/// The SOCKS5 handshake without login (RFC 1928, CONNECT only): the target host
/// and port, or None after a refusal was sent (other version, login required,
/// another command or address type).
async fn socks5_target<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> std::io::Result<Option<(String, u16)>> {
    let mut head = [0u8; 2];
    s.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Ok(None);
    }
    let mut methods = vec![0u8; head[1] as usize];
    s.read_exact(&mut methods).await?;
    // Only "no login" is offered; a client that requires one is told that nothing fits.
    if !methods.contains(&0) {
        s.write_all(&[5, 0xff]).await?;
        return Ok(None);
    }
    s.write_all(&[5, 0]).await?;
    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            s.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            socks_reply(s, SOCKS_NO_ADDRESS_TYPE).await?;
            return Ok(None);
        }
    };
    let mut port = [0u8; 2];
    s.read_exact(&mut port).await?;
    if req[1] != 1 {
        socks_reply(s, SOCKS_NO_COMMAND).await?;
        return Ok(None);
    }
    Ok(Some((host, u16::from_be_bytes(port))))
}

/// SOCKS5 proxy connection: reads the target, then tunnels to it through the server.
async fn socks5(conn: Arc<Remote>, mut tcp: TcpStream) -> std::io::Result<()> {
    let Some((host, port)) = socks5_target(&mut tcp).await? else { return Ok(()) };
    let Ok((handle, _)) = conn.tunnel() else { return Ok(()) };
    match handle.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0).await {
        Ok(channel) => {
            socks_reply(&mut tcp, SOCKS_OK).await?;
            let _ = tcp.set_nodelay(true);
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
        }
        Err(_) => socks_reply(&mut tcp, SOCKS_UNREACHABLE).await?,
    }
    Ok(())
}

impl Forwards {
    /// Starts a tunnel on the server's connection.
    pub async fn start(&self, server_id: &str, conn: Arc<Remote>, spec: ForwardSpec) -> AppResult<()> {
        conn.tunnel()?;
        self.stop(&spec.id).await;
        let running = match spec.kind.as_str() {
            "local" | "dynamic" => {
                let listener = TcpListener::bind((spec.bind_host.as_str(), spec.bind_port))
                    .await
                    .map_err(|e| bind_error(&spec, e))?;
                let dynamic = spec.kind == "dynamic";
                let (host, port) = (spec.dest_host.clone(), spec.dest_port);
                let c = conn.clone();
                let task = tokio::spawn(async move {
                    while let Ok((tcp, _)) = listener.accept().await {
                        // The connection ended: the port closes instead of taking connections it
                        // can only drop.
                        if c.is_closed() {
                            break;
                        }
                        let c = c.clone();
                        let host = host.clone();
                        tokio::spawn(async move {
                            if dynamic {
                                let _ = socks5(c, tcp).await;
                            } else {
                                through(&c, tcp, &host, port).await;
                            }
                        });
                    }
                });
                Running { server_id: server_id.into(), conn: conn.clone(), task: Some(task), remote: None }
            }
            "remote" => {
                let (handle, map) = conn.tunnel()?;
                let port = handle.tcpip_forward(spec.bind_host.clone(), spec.bind_port as u32).await.map_err(|e| {
                    AppError::other("Der Server lehnt die Weiterleitung von Port {0} ab.")
                        .param(spec.bind_port.to_string())
                        .with_detail(e.to_string())
                })?;
                // Port 0: the server chose one.
                let port = if spec.bind_port == 0 { port } else { spec.bind_port as u32 };
                map.locked().insert(port, (spec.dest_host.clone(), spec.dest_port));
                Running {
                    server_id: server_id.into(),
                    conn: conn.clone(),
                    task: None,
                    remote: Some((spec.bind_host.clone(), port)),
                }
            }
            other => return Err(AppError::other("Unbekannte Art der Weiterleitung: {0}").param(other)),
        };
        self.0.locked().insert(spec.id, running);
        Ok(())
    }

    /// Ends a tunnel (local port closed, remote forward cancelled on the server).
    pub async fn stop(&self, id: &str) {
        let running = self.0.locked().remove(id);
        let Some(r) = running else { return };
        if let Some(t) = r.task {
            t.abort();
        }
        if let Some((host, port)) = r.remote {
            if let Ok((handle, map)) = r.conn.tunnel() {
                map.locked().remove(&port);
                let _ = handle.cancel_tcpip_forward(host, port).await;
            }
        }
    }

    /// Ends every tunnel of a server (on disconnect).
    pub async fn stop_server(&self, server_id: &str) {
        let ids: Vec<String> =
            self.0.locked().iter().filter(|(_, r)| r.server_id == server_id).map(|(id, _)| id.clone()).collect();
        for id in ids {
            self.stop(&id).await;
        }
    }

    /// Ids of the running tunnels (all servers).
    pub fn active(&self) -> Vec<String> {
        let mut map = self.0.locked();
        // A tunnel whose connection is closed, or whose listener ended, is no longer running.
        map.retain(|_, r| !r.conn.is_closed() && r.task.as_ref().map(|t| !t.is_finished()).unwrap_or(true));
        map.keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the handshake against what a client sends; returns the target and what the proxy answered.
    async fn handshake(client: &[u8]) -> (Option<(String, u16)>, Vec<u8>) {
        let (mut ours, mut theirs) = tokio::io::duplex(1024);
        theirs.write_all(client).await.unwrap();
        let target = socks5_target(&mut ours).await.unwrap();
        drop(ours);
        let mut answer = Vec::new();
        theirs.read_to_end(&mut answer).await.unwrap();
        (target, answer)
    }

    #[tokio::test]
    async fn reads_a_connect_to_a_host_name() {
        let mut client = vec![5, 1, 0, 5, 1, 0, 3, 11];
        client.extend_from_slice(b"example.com");
        client.extend_from_slice(&443u16.to_be_bytes());
        assert_eq!(handshake(&client).await, (Some(("example.com".into(), 443)), vec![5, 0]));
    }

    #[tokio::test]
    async fn reads_ipv4_and_ipv6_targets() {
        let v4 = [5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 7, 0, 22];
        assert_eq!(handshake(&v4).await.0, Some(("10.0.0.7".into(), 22)));
        let mut v6 = vec![5, 1, 0, 5, 1, 0, 4];
        v6.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
        v6.extend_from_slice(&80u16.to_be_bytes());
        assert_eq!(handshake(&v6).await.0, Some(("::1".into(), 80)));
    }

    #[tokio::test]
    async fn refuses_a_client_that_needs_a_login() {
        // Offers only user/password (method 2).
        assert_eq!(handshake(&[5, 1, 2]).await, (None, vec![5, 0xff]));
    }

    #[tokio::test]
    async fn refuses_other_commands_and_address_types() {
        // BIND instead of CONNECT.
        let (target, answer) = handshake(&[5, 1, 0, 5, 2, 0, 1, 10, 0, 0, 7, 0, 22]).await;
        assert_eq!((target, answer[2..4].to_vec()), (None, vec![5, SOCKS_NO_COMMAND]));
        // Unknown address type 9.
        let (target, answer) = handshake(&[5, 1, 0, 5, 1, 0, 9]).await;
        assert_eq!((target, answer[2..4].to_vec()), (None, vec![5, SOCKS_NO_ADDRESS_TYPE]));
    }

    #[tokio::test]
    async fn ignores_other_protocol_versions() {
        assert_eq!(handshake(&[4, 1, 0, 80]).await, (None, vec![]));
    }
}
