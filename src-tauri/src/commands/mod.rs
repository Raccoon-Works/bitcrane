//! The Tauri commands the interface calls, one module per area.

/// Runs a remote operation and turns a dead session into `ConnectionLost`.
macro_rules! remote {
    ($state:expr, $server:expr, |$c:ident| $body:expr) => {{
        let $c = $state.conn(&$server).await?;
        match $body.await {
            Ok(v) => Ok(v),
            Err(e) => Err($state.check_lost(&$server, e).await),
        }
    }};
}

pub mod local;
pub mod app;
pub mod cloud;
pub mod connect;
pub mod mount;
pub mod terminals;
pub mod server;
pub mod content;
pub mod credentials;
pub mod transfers;
pub mod settings;
