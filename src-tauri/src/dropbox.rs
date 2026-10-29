//! Dropbox as a "server" (HTTP API v2). Paths in Bitcrane are those of the
//! Dropbox account ("/" is the top folder). Sign-in: see oauth.rs; the
//! connection keeps a short-lived access token and renews it with the
//! refresh token when it runs out.
//!
//! Uploads up to 8 MB go in one request, larger files in upload sessions of
//! 8 MB pieces. The modification time is kept as Dropbox's "client_modified".

use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{FileEntry, WalkItem};
use crate::oauth::{self, ascii_json};
use crate::paths::{remote_join, remote_name, remote_parent};
use futures_util::TryStreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};

const API: &str = "https://api.dropboxapi.com/2";
const CONTENT: &str = "https://content.dropboxapi.com/2";
const TOKEN_URL: &str = "https://api.dropboxapi.com/oauth2/token";
/// Size of one upload piece (Dropbox allows up to 150 MB; 8 MB keeps memory low).
const CHUNK: usize = 8 * 1024 * 1024;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DropboxParams {
    pub refresh_token: String,
}

struct Token {
    access: String,
    valid_until: Instant,
}

pub struct DropboxConn {
    client: reqwest::Client,
    key: &'static str,
    refresh: String,
    token: tokio::sync::Mutex<Token>,
    pub home: String,
}

fn not_set_up() -> AppError {
    AppError::other("Dropbox ist in dieser Version von Bitcrane noch nicht eingerichtet.")
}

/// Bitcrane path ("/" = top) to Dropbox path ("" = top).
fn dbx_path(path: &str) -> String {
    let p = path.trim_end_matches('/');
    if p.is_empty() { String::new() } else if p.starts_with('/') { p.to_string() } else { format!("/{p}") }
}

fn parse_time(s: Option<&str>) -> i64 {
    s.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|d| d.timestamp_millis()).unwrap_or(0)
}

/// One entry of a folder listing or of get_metadata.
fn entry_of(v: &Value) -> Option<FileEntry> {
    let tag = v.get(".tag")?.as_str()?;
    let name = v.get("name")?.as_str()?.to_string();
    let dir = tag == "folder";
    if tag != "folder" && tag != "file" {
        return None;
    }
    // The time the file was changed on the computer it came from; Dropbox keeps it as sent.
    let mtime = parse_time(v.get("client_modified").and_then(|t| t.as_str()).or_else(|| v.get("server_modified").and_then(|t| t.as_str())));
    Some(FileEntry {
        name,
        kind: if dir { "dir".into() } else { "file".into() },
        size: if dir { 0 } else { v.get("size").and_then(|s| s.as_u64()).unwrap_or(0) },
        mtime,
        perms: if dir { "755".into() } else { "644".into() },
        owner: String::new(),
        group: String::new(),
        link: None,
        hidden: 0,
    })
}

/// Turns an API error answer into a clear message.
fn api_err(status: reqwest::StatusCode, body: &str, what: &str) -> AppError {
    let summary = serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("error_summary").and_then(|s| s.as_str()).map(String::from)).unwrap_or_default();
    let detail = format!("{status}: {}", if summary.is_empty() { body } else { &summary });
    // The app's permissions in the Dropbox App Console do not cover this action.
    if summary.contains("missing_scope") || body.contains("missing_scope") {
        return AppError::new(ErrorKind::Other, format!("{what}: Die Bitcrane-App bei Dropbox hat dafür keine Berechtigung.")).with_detail(detail);
    }
    if status.as_u16() == 401 {
        return AppError::new(ErrorKind::AuthFailed, "Die Anmeldung bei Dropbox ist nicht mehr gültig. Bitte neu anmelden.").with_detail(detail);
    }
    if status.as_u16() == 429 {
        return AppError::new(ErrorKind::ConnectionLost, "Dropbox bremst gerade (zu viele Anfragen). Gleich noch einmal versuchen.").with_detail(detail);
    }
    let (kind, msg) = if summary.contains("not_found") {
        (ErrorKind::NotFound, format!("{what}: nicht gefunden."))
    } else if summary.contains("conflict") {
        (ErrorKind::AlreadyExists, format!("{what}: gibt es schon."))
    } else if summary.contains("insufficient_space") {
        (ErrorKind::Other, format!("{what}: kein Speicherplatz mehr in der Dropbox."))
    } else if summary.contains("no_write_permission") || summary.contains("disallowed_name") || summary.contains("restricted") {
        (ErrorKind::PermissionDenied, format!("{what}: nicht erlaubt."))
    } else {
        (ErrorKind::Other, format!("{what} fehlgeschlagen."))
    };
    AppError::new(kind, msg).with_detail(detail)
}

fn net(e: reqwest::Error) -> AppError {
    if e.is_connect() || e.is_timeout() {
        AppError::new(ErrorKind::ConnectionLost, "Dropbox ist nicht erreichbar.").with_detail(e.to_string())
    } else {
        AppError::new(ErrorKind::ConnectionLost, "Verbindung zu Dropbox unterbrochen.").with_detail(e.to_string())
    }
}

/// Signs in in the browser and returns the refresh token and the account name.
pub async fn sign_in(open: impl FnOnce(&str) -> AppResult<()>) -> AppResult<oauth::SignedIn> {
    let key = oauth::app_key("dropbox").ok_or_else(not_set_up)?;
    let (verifier, challenge) = oauth::pkce();
    let state = oauth::state_token();
    let redirect = oauth::redirect_uri();
    let mut url = reqwest::Url::parse("https://www.dropbox.com/oauth2/authorize").unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", key)
        .append_pair("response_type", "code")
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("token_access_type", "offline")
        .append_pair("redirect_uri", &redirect)
        .append_pair("state", &state);
    let code = oauth::wait_for_code(url.as_str(), &state, open).await?;
    let client = oauth::http_client()?;
    let answer = oauth::token_request(&client, TOKEN_URL, &[("code", &code), ("grant_type", "authorization_code"), ("client_id", key), ("code_verifier", &verifier), ("redirect_uri", &redirect)]).await?;
    let refresh = answer.refresh_token.ok_or_else(|| AppError::other("Dropbox hat keine dauerhafte Anmeldung geschickt."))?;
    let conn = DropboxConn { client, key, refresh: refresh.clone(), token: tokio::sync::Mutex::new(Token { access: answer.access_token, valid_until: Instant::now() + Duration::from_secs(answer.expires_in.unwrap_or(3600).saturating_sub(60)) }), home: "/".into() };
    let account = conn.account().await.unwrap_or_else(|_| "Dropbox".into());
    Ok(oauth::SignedIn { refresh_token: refresh, account })
}

impl DropboxConn {
    pub async fn connect(params: DropboxParams) -> AppResult<DropboxConn> {
        let key = oauth::app_key("dropbox").ok_or_else(not_set_up)?;
        let conn = DropboxConn {
            client: oauth::http_client()?,
            key,
            refresh: params.refresh_token,
            token: tokio::sync::Mutex::new(Token { access: String::new(), valid_until: Instant::now() }),
            home: "/".into(),
        };
        // Renews the access token and checks the account at once.
        conn.account().await?;
        Ok(conn)
    }

    /// A valid access token, renewed shortly before it runs out.
    async fn access(&self) -> AppResult<String> {
        let mut t = self.token.lock().await;
        if t.access.is_empty() || Instant::now() >= t.valid_until {
            let a = oauth::token_request(&self.client, TOKEN_URL, &[("grant_type", "refresh_token"), ("refresh_token", &self.refresh), ("client_id", self.key)]).await?;
            t.access = a.access_token;
            t.valid_until = Instant::now() + Duration::from_secs(a.expires_in.unwrap_or(3600).saturating_sub(60));
        }
        Ok(t.access.clone())
    }

    /// RPC call with a JSON body; returns the JSON answer.
    async fn rpc(&self, endpoint: &str, body: Value, what: &str) -> AppResult<Value> {
        let token = self.access().await?;
        let resp = self.client.post(format!("{API}/{endpoint}")).bearer_auth(token).header("Content-Type", "application/json").body(body.to_string()).send().await.map_err(net)?;
        let status = resp.status();
        let text = resp.text().await.map_err(net)?;
        if !status.is_success() {
            return Err(api_err(status, &text, what));
        }
        serde_json::from_str(&text).map_err(|e| AppError::other("Unerwartete Antwort von Dropbox.").with_detail(e.to_string()))
    }

    /// Link to share a file or folder (Transmit "Copy Link"). An existing link is
    /// reused, otherwise a new one is made with the account's default settings.
    pub async fn share_link(&self, path: &str) -> AppResult<String> {
        let what = format!("Link für „{}“", remote_name(path));
        let token = self.access().await?;
        let resp = self
            .client
            .post(format!("{API}/sharing/create_shared_link_with_settings"))
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .body(json!({ "path": dbx_path(path) }).to_string())
            .send()
            .await
            .map_err(net)?;
        let status = resp.status();
        let text = resp.text().await.map_err(net)?;
        if status.is_success() {
            let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if let Some(url) = v.get("url").and_then(|u| u.as_str()) {
                return Ok(url.to_string());
            }
        } else if !text.contains("shared_link_already_exists") {
            return Err(api_err(status, &text, &what));
        }
        // A link exists already: take it.
        let v = self.rpc("sharing/list_shared_links", json!({ "path": dbx_path(path), "direct_only": true }), &what).await?;
        v.pointer("/links/0/url")
            .and_then(|u| u.as_str())
            .map(String::from)
            .ok_or_else(|| AppError::other(format!("{what}: Dropbox hat keinen Link geliefert.")))
    }

    /// E-mail address of the signed-in account.
    pub async fn account(&self) -> AppResult<String> {
        let token = self.access().await?;
        let resp = self.client.post(format!("{API}/users/get_current_account")).bearer_auth(token).send().await.map_err(net)?;
        let status = resp.status();
        let text = resp.text().await.map_err(net)?;
        if !status.is_success() {
            return Err(api_err(status, &text, "Konto lesen"));
        }
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        Ok(v.get("email").and_then(|e| e.as_str()).or_else(|| v.pointer("/name/display_name").and_then(|e| e.as_str())).unwrap_or("Dropbox").to_string())
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        let what = format!("„{}“ lesen", remote_name(path));
        let mut v = self.rpc("files/list_folder", json!({ "path": dbx_path(path), "limit": 2000 }), &what).await?;
        let mut out = Vec::new();
        loop {
            if let Some(entries) = v.get("entries").and_then(|e| e.as_array()) {
                out.extend(entries.iter().filter_map(entry_of));
            }
            if !v.get("has_more").and_then(|h| h.as_bool()).unwrap_or(false) {
                break;
            }
            let cursor = v.get("cursor").and_then(|c| c.as_str()).unwrap_or_default().to_string();
            v = self.rpc("files/list_folder/continue", json!({ "cursor": cursor }), &what).await?;
        }
        out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
            ("dir", "file") => std::cmp::Ordering::Less,
            ("file", "dir") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        let p = dbx_path(path);
        if p.is_empty() {
            // The top folder has no metadata of its own.
            return Ok(FileEntry { name: "/".into(), kind: "dir".into(), size: 0, mtime: 0, perms: "755".into(), owner: String::new(), group: String::new(), link: None, hidden: 0 });
        }
        let v = self.rpc("files/get_metadata", json!({ "path": p }), &format!("„{}“", remote_name(path))).await?;
        entry_of(&v).ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("„{}“ gibt es nicht.", remote_name(path))))
    }

    pub async fn exists(&self, path: &str) -> bool {
        self.stat(path).await.is_ok()
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        self.rpc("files/create_folder_v2", json!({ "path": dbx_path(path), "autorename": false }), &format!("Ordner „{}“ anlegen", remote_name(path))).await.map(|_| ())
    }

    /// Dropbox creates missing parent folders by itself.
    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        if dbx_path(path).is_empty() || self.exists(path).await {
            return Ok(());
        }
        match self.mkdir(path).await {
            Err(e) if e.kind == ErrorKind::AlreadyExists => Ok(()),
            r => r,
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        self.rpc("files/move_v2", json!({ "from_path": dbx_path(from), "to_path": dbx_path(to), "autorename": false }), &format!("„{}“ umbenennen", remote_name(from))).await.map(|_| ())
    }

    pub async fn replace(&self, from: &str, to: &str) -> AppResult<()> {
        if self.exists(to).await {
            self.remove(to).await?;
        }
        self.rename(from, to).await
    }

    pub async fn remove(&self, path: &str) -> AppResult<()> {
        match self.rpc("files/delete_v2", json!({ "path": dbx_path(path) }), &format!("„{}“ löschen", remote_name(path))).await {
            Err(e) if e.kind == ErrorKind::NotFound => Ok(()),
            r => r.map(|_| ()),
        }
    }

    /// Copy inside the Dropbox, with "Kopie" names on clashes.
    pub async fn copy_within(&self, paths: &[String], dest_dir: &str) -> AppResult<Vec<String>> {
        let mut taken: std::collections::HashSet<String> = self.list(dest_dir).await?.into_iter().map(|e| e.name).collect();
        let mut out = Vec::new();
        for from in paths {
            if dest_dir == from.as_str() || dest_dir.starts_with(&format!("{from}/")) {
                return Err(AppError::other("Ein Ordner kann nicht in sich selbst kopiert werden."));
            }
            let name = crate::local::copy_name(|n| taken.contains(n), &remote_name(from));
            self.rpc("files/copy_v2", json!({ "from_path": dbx_path(from), "to_path": dbx_path(&remote_join(dest_dir, &name)), "autorename": false }), &format!("„{}“ kopieren", remote_name(from))).await?;
            taken.insert(name.clone());
            out.push(name);
        }
        Ok(out)
    }

    /// All files below a folder in one listing (recursive list_folder).
    pub async fn walk(&self, path: &str) -> AppResult<Vec<WalkItem>> {
        let base = remote_parent(path);
        let root = self.stat(path).await?;
        let rel = |p: &str| p.strip_prefix(&base).unwrap_or(p).trim_start_matches('/').to_string();
        if root.kind != "dir" {
            return Ok(vec![WalkItem { path: path.to_string(), relative: rel(path), size: root.size, mtime: root.mtime }]);
        }
        let what = format!("„{}“ lesen", remote_name(path));
        let mut v = self.rpc("files/list_folder", json!({ "path": dbx_path(path), "recursive": true, "limit": 2000 }), &what).await?;
        let mut out = Vec::new();
        loop {
            for e in v.get("entries").and_then(|e| e.as_array()).into_iter().flatten() {
                if e.get(".tag").and_then(|t| t.as_str()) != Some("file") {
                    continue;
                }
                // path_display keeps the user's spelling of the names.
                let Some(p) = e.get("path_display").and_then(|p| p.as_str()) else { continue };
                if let Some(f) = entry_of(e) {
                    out.push(WalkItem { path: p.to_string(), relative: rel(p), size: f.size, mtime: f.mtime });
                }
            }
            if !v.get("has_more").and_then(|h| h.as_bool()).unwrap_or(false) {
                break;
            }
            let cursor = v.get("cursor").and_then(|c| c.as_str()).unwrap_or_default().to_string();
            v = self.rpc("files/list_folder/continue", json!({ "cursor": cursor }), &what).await?;
        }
        Ok(out)
    }

    /// Reads a file from `offset` (HTTP Range).
    pub async fn reader(&self, path: &str, offset: u64) -> AppResult<Box<dyn AsyncRead + Unpin + Send>> {
        let token = self.access().await?;
        let mut req = self.client.post(format!("{CONTENT}/files/download")).bearer_auth(token).header("Dropbox-API-Arg", ascii_json(&json!({ "path": dbx_path(path) })));
        if offset > 0 {
            req = req.header("Range", format!("bytes={offset}-"));
        }
        let resp = req.send().await.map_err(net)?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(api_err(status, &text, &format!("„{}“ lesen", remote_name(path))));
        }
        if offset > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(AppError::other("Dropbox kann hier nicht an einer Stelle weiterlesen.").with_detail("no-range"));
        }
        let stream = resp.bytes_stream().map_err(|e| std::io::Error::other(e.to_string()));
        Ok(Box::new(tokio_util::io::StreamReader::new(stream)))
    }

    /// Commit settings of an upload: overwrite, keep the modification time, no notification.
    fn commit(path: &str, mtime: Option<u32>) -> Value {
        let mut c = json!({ "path": dbx_path(path), "mode": "overwrite", "mute": true, "strict_conflict": false });
        if let Some(m) = mtime.and_then(|m| chrono::DateTime::from_timestamp(m as i64, 0)) {
            c["client_modified"] = json!(m.format("%Y-%m-%dT%H:%M:%SZ").to_string());
        }
        c
    }

    async fn content_call(&self, endpoint: &str, arg: Value, body: Vec<u8>, what: &str) -> AppResult<Value> {
        let token = self.access().await?;
        let resp = self
            .client
            .post(format!("{CONTENT}/{endpoint}"))
            .bearer_auth(token)
            .header("Dropbox-API-Arg", ascii_json(&arg))
            .header("Content-Type", "application/octet-stream")
            .body(body)
            .send()
            .await
            .map_err(net)?;
        let status = resp.status();
        let text = resp.text().await.map_err(net)?;
        if !status.is_success() {
            return Err(api_err(status, &text, what));
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    /// Writes a file. Bitcrane writes into the returned stream; the task
    /// sends it to Dropbox in pieces and finishes the upload.
    pub fn writer(self: &std::sync::Arc<Self>, path: &str, mtime: Option<u32>) -> (Box<dyn AsyncWrite + Unpin + Send>, tokio::task::JoinHandle<AppResult<()>>) {
        let (w, mut r) = tokio::io::duplex(1024 * 1024);
        let conn = self.clone();
        let path = path.to_string();
        let task = tokio::spawn(async move {
            let what = format!("„{}“ schreiben", remote_name(&path));
            let mut session: Option<String> = None;
            let mut offset: u64 = 0;
            loop {
                // Fill one piece (or less at the end of the file).
                let mut buf = Vec::with_capacity(CHUNK);
                while buf.len() < CHUNK {
                    let mut part = vec![0u8; (CHUNK - buf.len()).min(256 * 1024)];
                    let n = r.read(&mut part).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Hochladen abgebrochen.").with_detail(e.to_string()))?;
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&part[..n]);
                }
                let last = buf.len() < CHUNK;
                match (&session, last) {
                    // Small file: one request.
                    (None, true) => {
                        conn.content_call("files/upload", Self::commit(&path, mtime), buf, &what).await?;
                        return Ok(());
                    }
                    (None, false) => {
                        let v = conn.content_call("files/upload_session/start", json!({ "close": false }), buf.clone(), &what).await?;
                        session = v.get("session_id").and_then(|s| s.as_str()).map(String::from);
                        if session.is_none() {
                            return Err(AppError::other("Dropbox hat das Hochladen in Teilen nicht gestartet."));
                        }
                        offset += buf.len() as u64;
                    }
                    (Some(id), false) => {
                        conn.content_call("files/upload_session/append_v2", json!({ "cursor": { "session_id": id, "offset": offset }, "close": false }), buf.clone(), &what).await?;
                        offset += buf.len() as u64;
                    }
                    (Some(id), true) => {
                        conn.content_call("files/upload_session/finish", json!({ "cursor": { "session_id": id, "offset": offset }, "commit": Self::commit(&path, mtime) }), buf, &what).await?;
                        return Ok(());
                    }
                }
            }
        });
        (Box::new(w), task)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_entries() {
        assert_eq!(dbx_path("/"), "");
        assert_eq!(dbx_path("/Fotos/2026/"), "/Fotos/2026");
        let v = json!({ ".tag": "file", "name": "a.txt", "size": 42, "client_modified": "2026-10-29T08:00:00Z", "server_modified": "2026-10-29T09:00:00Z" });
        let e = entry_of(&v).unwrap();
        assert_eq!((e.kind.as_str(), e.size, e.mtime), ("file", 42, 1793260800000));
        assert!(entry_of(&json!({ ".tag": "deleted", "name": "x" })).is_none());
        let c = DropboxConn::commit("/a/ü.txt", Some(1793260800));
        assert_eq!(c["client_modified"], "2026-10-29T08:00:00Z");
    }
}
