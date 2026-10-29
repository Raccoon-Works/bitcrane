//! SSH port forwarding (tunnels) of a server, like `ssh -L`, `-R` and `-D`.
//!
//! - local: a port on this computer leads through the server to a target
//!   (e.g. 127.0.0.1:5433 → the server's database on 127.0.0.1:5432).
//! - remote: a port on the server leads back to a target on this side.
//! - dynamic: a SOCKS5 proxy on this computer; every connection goes out
//!   from the server.
//!
//! The tunnels use the server's open SSH connection and end with it. Which
//! tunnels a server has is stored in its settings (frontend); this module
//! only runs them.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::remote::Remote;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
    task: Option<JoinHandle<()>>,
    /// Remote forward: connection and port to cancel on the server.
    remote: Option<(Arc<Remote>, String, u32)>,
}

#[derive(Default)]
pub struct Forwards(Mutex<HashMap<String, Running>>);

fn bind_error(spec: &ForwardSpec, e: std::io::Error) -> AppError {
    let what = format!("{}:{}", spec.bind_host, spec.bind_port);
    if e.kind() == std::io::ErrorKind::AddrInUse {
        AppError::new(ErrorKind::Other, format!("Der Port {what} ist auf diesem Computer schon belegt."))
    } else {
        AppError::new(ErrorKind::Other, format!("Der Port {what} kann nicht geöffnet werden.")).with_detail(e.to_string())
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

/// SOCKS5 without login (RFC 1928, CONNECT only): reads the target, answers, then tunnels.
async fn socks5(conn: Arc<Remote>, mut tcp: TcpStream) -> std::io::Result<()> {
    let mut head = [0u8; 2];
    tcp.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Ok(());
    }
    let mut methods = vec![0u8; head[1] as usize];
    tcp.read_exact(&mut methods).await?;
    tcp.write_all(&[5, 0]).await?;
    let mut req = [0u8; 4];
    tcp.read_exact(&mut req).await?;
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            tcp.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            tcp.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        4 => {
            let mut a = [0u8; 16];
            tcp.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => return Ok(()),
    };
    let mut port = [0u8; 2];
    tcp.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);
    if req[1] != 1 {
        // Only CONNECT: "command not supported".
        tcp.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Ok(());
    }
    let Ok((handle, _)) = conn.tunnel() else { return Ok(()) };
    match handle.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0).await {
        Ok(channel) => {
            tcp.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            let _ = tcp.set_nodelay(true);
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
        }
        Err(_) => {
            // "Host unreachable".
            tcp.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        }
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
                let listener = TcpListener::bind((spec.bind_host.as_str(), spec.bind_port)).await.map_err(|e| bind_error(&spec, e))?;
                let dynamic = spec.kind == "dynamic";
                let (host, port) = (spec.dest_host.clone(), spec.dest_port);
                let c = conn.clone();
                let task = tokio::spawn(async move {
                    while let Ok((tcp, _)) = listener.accept().await {
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
                Running { server_id: server_id.into(), task: Some(task), remote: None }
            }
            "remote" => {
                let (handle, map) = conn.tunnel()?;
                let port = handle
                    .tcpip_forward(spec.bind_host.clone(), spec.bind_port as u32)
                    .await
                    .map_err(|e| AppError::new(ErrorKind::Other, format!("Der Server lehnt die Weiterleitung von Port {} ab.", spec.bind_port)).with_detail(e.to_string()))?;
                // Port 0: the server chose one.
                let port = if spec.bind_port == 0 { port } else { spec.bind_port as u32 };
                map.lock().unwrap().insert(port, (spec.dest_host.clone(), spec.dest_port));
                Running { server_id: server_id.into(), task: None, remote: Some((conn.clone(), spec.bind_host.clone(), port)) }
            }
            other => return Err(AppError::other(format!("Unbekannte Art der Weiterleitung: {other}"))),
        };
        self.0.lock().unwrap().insert(spec.id, running);
        Ok(())
    }

    /// Ends a tunnel (local port closed, remote forward cancelled on the server).
    pub async fn stop(&self, id: &str) {
        let running = self.0.lock().unwrap().remove(id);
        let Some(r) = running else { return };
        if let Some(t) = r.task {
            t.abort();
        }
        if let Some((conn, host, port)) = r.remote {
            if let Ok((handle, map)) = conn.tunnel() {
                map.lock().unwrap().remove(&port);
                let _ = handle.cancel_tcpip_forward(host, port).await;
            }
        }
    }

    /// Ends every tunnel of a server (on disconnect).
    pub async fn stop_server(&self, server_id: &str) {
        let ids: Vec<String> = self.0.lock().unwrap().iter().filter(|(_, r)| r.server_id == server_id).map(|(id, _)| id.clone()).collect();
        for id in ids {
            self.stop(&id).await;
        }
    }

    /// Ids of the running tunnels (all servers).
    pub fn active(&self) -> Vec<String> {
        let mut map = self.0.lock().unwrap();
        // A tunnel whose listener ended (connection gone) is no longer running.
        map.retain(|_, r| r.task.as_ref().map(|t| !t.is_finished()).unwrap_or(true));
        map.keys().cloned().collect()
    }
}
