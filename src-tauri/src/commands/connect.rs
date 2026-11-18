//! Connecting to servers and vaults, including the questions a server asks during login.

use crate::error::{AppError, AppResult};
use crate::login::{Env, Login, Opened};
use crate::secrets::Keychain;
use crate::serverconfig::{Config, Protocol, Server};
use crate::{ssh, vault, AppState, PendingPrompts};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectResult {
    pub(super) home: String,
    /// Server clock minus local clock in milliseconds, if it could be measured.
    pub(super) clock_offset_ms: Option<i64>,
    /// A problem that did not stop the login, for the interface to report.
    pub(super) warning: Option<AppError>,
}

/// A login as the interface asks for it: the server (saved, temporary or a draft being tested)
/// and what the user has just typed or confirmed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectRequest {
    server: Server,
    #[serde(flatten)]
    login: Login,
}

impl ConnectRequest {
    /// Decides what the login may use, against the saved servers. Stored secrets belong to the
    /// saved server with the request's id, so they are used only when the request reaches that
    /// server the same way ([`Server::same_login`]); otherwise only what was typed is sent. A
    /// vault's password only ever opens the vault's key on this computer, so a vault, which the
    /// interface opens as a temporary entry, may use its stored one. The jump server is the saved
    /// one the server names, not one the request brings along.
    fn checked(mut self, saved: &Config) -> (Server, Option<Server>, Login) {
        self.login.stored_secrets = match saved.server(&self.server.id) {
            Some(entry) => entry.same_login(&self.server),
            None => self.server.protocol == Protocol::Vault,
        };
        let jump = self.server.jump_id().and_then(|id| saved.server(id)).cloned();
        (self.server, jump, self.login)
    }

    /// Opens the connection; `prompt_id` is the server the login questions are shown for.
    async fn open(self, app: tauri::AppHandle, state: &AppState, prompt_id: String) -> AppResult<Opened> {
        let dir = state.config_dir.clone();
        let saved = tokio::task::spawn_blocking(move || Config::read(&dir)).await??;
        let (server, jump, login) = self.checked(&saved);
        let env = Env {
            known: state.known_hosts.clone(),
            prompter: Some(make_prompter(app, state.prompts.clone(), prompt_id)),
            secrets: &Keychain,
            connections: state.connections.clone(),
        };
        crate::login::open(server, jump, login, &env).await
    }
}

/// Event payload for a question of the server (shown as a dialog).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthPromptEvent {
    id: String,
    server_id: String,
    #[serde(flatten)]
    request: ssh::PromptRequest,
}

/// Forwards server questions to the interface and waits up to 3 minutes for answers.
pub(super) fn make_prompter(app: tauri::AppHandle, pending: PendingPrompts, server_id: String) -> ssh::Prompter {
    Arc::new(move |request| {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        pending.lock().unwrap().insert(id.clone(), tx);
        let _ = app.emit("auth-prompt", AuthPromptEvent { id: id.clone(), server_id: server_id.clone(), request });
        let pending = pending.clone();
        Box::pin(async move {
            let answer =
                tokio::time::timeout(std::time::Duration::from_secs(180), rx).await.ok().and_then(|r| r.ok()).flatten();
            pending.lock().unwrap().remove(&id);
            answer
        })
    })
}

/// Answers of the user to a server question; `None` cancels the login.
#[tauri::command]
pub(crate) fn auth_prompt_answer(state: State<'_, AppState>, id: String, answers: Option<Vec<String>>) {
    if let Some(tx) = state.prompts.lock().unwrap().remove(&id) {
        let _ = tx.send(answers);
    }
}

/// Connects to a server with any protocol and keeps the connection under `server_id` (the
/// server's id, or another id for a second connection such as the Explorer folder's).
#[tauri::command]
pub(crate) async fn server_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    request: ConnectRequest,
) -> AppResult<ConnectResult> {
    // Take it out first: closing can take a while and must not hold the lock.
    let old = state.connections.lock().await.remove(&server_id);
    if let Some(old) = old {
        old.close().await;
    }
    let Opened { remote: conn, warning } = request.open(app, &state, server_id.clone()).await?;
    let home = conn.home().to_string();
    let clock_offset_ms = conn.clock_offset_ms().await;
    state.connections.lock().await.insert(server_id, Arc::new(conn));
    Ok(ConnectResult { home, clock_offset_ms, warning })
}

/// "Verbindung testen": logs in with a connection of its own and closes it again; resolves to the
/// start folder. A warning of the login (see [`Opened`]) is only logged: the test is about
/// reaching the server, and the next real connection reports it.
#[tauri::command]
pub(crate) async fn server_test(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: ConnectRequest,
) -> AppResult<String> {
    let conn = request.open(app, &state, String::new()).await?.remote;
    let home = conn.home().to_string();
    conn.close().await;
    Ok(home)
}

/// Creates a new, empty Cryptomator vault in the folder `location`.
#[tauri::command]
pub(crate) async fn vault_create(
    state: State<'_, AppState>,
    location: String,
    storage_id: Option<String>,
    password: String,
) -> AppResult<()> {
    let store = match storage_id {
        Some(id) => vault::Store::Remote { connections: state.connections.clone(), id },
        None => vault::Store::Local,
    };
    vault::VaultConn::create(store, &location, &password).await
}

#[tauri::command]
pub(crate) async fn ssh_disconnect(state: State<'_, AppState>, server_id: String) -> AppResult<()> {
    state.forwards.stop_server(&server_id).await;
    let old = state.connections.lock().await.remove(&server_id);
    if let Some(c) = old {
        c.close().await;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn ssh_is_connected(state: State<'_, AppState>, server_id: String) -> AppResult<bool> {
    Ok(state.conn(&server_id).await.is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn saved() -> Config {
        Config::from_value(json!({ "servers": [
            { "id": "f1", "name": "Shop FTP", "protocol": "ftps", "host": "ftp.example", "port": 21, "user": "shop",
              "auth": "password", "proxy": { "kind": "socks5", "host": "proxy.example", "port": 1080 } },
            { "id": "s1", "name": "Webserver", "host": "web.example", "port": 22, "user": "anna", "jumpServerId": "s2" },
            { "id": "s2", "name": "Bastion", "host": "jump.example", "port": 22, "user": "ops" },
        ]}))
        .unwrap()
    }

    fn request(server: serde_json::Value) -> ConnectRequest {
        serde_json::from_value(json!({ "server": server, "keepalive": true, "googleClientId": "" })).unwrap()
    }

    fn uses_stored(server: serde_json::Value) -> bool {
        request(server).checked(&saved()).2.stored_secrets
    }

    #[test]
    fn stored_secrets_go_only_to_the_server_they_were_saved_for() {
        let shop = saved().server("f1").unwrap().clone();
        let entry = json!({ "id": "f1", "name": "Shop FTP", "protocol": "ftps", "host": "ftp.example", "port": 21,
                            "user": "shop", "auth": "password", "color": "blue",
                            "proxy": { "kind": "socks5", "host": "proxy.example", "port": 1080 } });
        assert!(uses_stored(entry.clone()), "the saved server as it is");
        // The same account reached another way: in clear text, or through another proxy.
        let mut plain = entry.clone();
        plain["protocol"] = json!("ftp");
        assert!(!uses_stored(plain));
        let mut other_proxy = entry.clone();
        other_proxy["proxy"]["host"] = json!("listening.example");
        assert!(!uses_stored(other_proxy));
        let mut no_proxy = entry.clone();
        no_proxy["proxy"] = json!(null);
        assert!(!uses_stored(no_proxy));
        let mut dav = json!({ "id": "f1", "protocol": "webdav", "host": shop.host, "port": shop.port,
                              "user": shop.user, "davHttps": false });
        assert!(!uses_stored(dav.clone()));
        dav["id"] = json!("unsaved");
        assert!(!uses_stored(dav), "a server that is not saved");
        // A vault (always a temporary entry) uses its stored password, which never leaves this computer.
        assert!(uses_stored(json!({ "id": "v1", "protocol": "vault", "host": "/Tresore/privat", "user": "local" })));
    }

    #[test]
    fn the_jump_server_is_the_saved_one() {
        let (server, jump, _) = request(json!({ "id": "s1", "host": "web.example", "port": 22, "user": "anna",
                                                 "jumpServerId": "s2" }))
        .checked(&saved());
        assert_eq!((server.id.as_str(), jump.map(|j| j.host)), ("s1", Some("jump.example".to_string())));
        // A jump server the request brings along itself is not read.
        let r: ConnectRequest = serde_json::from_value(json!({
            "server": { "id": "x", "host": "web.example", "jumpServerId": "nowhere" },
            "jump": { "id": "nowhere", "host": "listening.example" }, "keepalive": false, "googleClientId": ""
        }))
        .unwrap();
        assert!(r.checked(&saved()).1.is_none());
    }
}
