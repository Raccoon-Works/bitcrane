//! Google Drive as a "server" (Drive API v3). Paths in Bitcrane are those of
//! "My Drive" ("/" is its top folder). Drive itself knows files by id, not by
//! path, so every path is looked up folder by folder and the ids are kept in a
//! small cache.
//!
//! Google requires each user to bring their own app key ("client id" and
//! "client secret" of a desktop app in their own Google Cloud project, see
//! docs/google-drive.md); Bitcrane ships none. Sign-in: see oauth.rs.
//!
//! Notes:
//! - Drive allows two entries with the same name in one folder; Bitcrane takes
//!   the first one and refuses to create a second.
//! - Deleting moves to the Drive trash (restorable for 30 days); only the old
//!   copy that an upload replaces is deleted for good.
//! - Google Docs, Sheets and Slides have no file content of their own and
//!   cannot be downloaded as they are; they are listed with size 0.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{FileEntry, WalkItem};
use crate::oauth;
use crate::paths::{remote_join, remote_name, remote_parent};
use futures_util::TryStreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};

const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/drive";
const FOLDER: &str = "application/vnd.google-apps.folder";
const FIELDS: &str = "id,name,mimeType,size,modifiedTime";
/// Size of one upload piece; Drive wants multiples of 256 KiB.
const CHUNK: usize = 8 * 1024 * 1024;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GDriveParams {
    pub refresh_token: String,
    pub client_id: String,
    pub client_secret: String,
}

struct Token {
    access: String,
    valid_until: Instant,
}

pub struct GDriveConn {
    client: reqwest::Client,
    client_id: String,
    client_secret: String,
    refresh: String,
    token: tokio::sync::Mutex<Token>,
    /// Path ("/a/b") to file id; "/" is "root".
    ids: std::sync::Mutex<HashMap<String, String>>,
    pub home: String,
}

/// Normalised path: "/" for the top, else "/a/b" without a trailing slash.
fn norm(path: &str) -> String {
    let p = path.trim_end_matches('/');
    if p.is_empty() { "/".into() } else if p.starts_with('/') { p.to_string() } else { format!("/{p}") }
}

/// A name inside a Drive search query ('…' with \ and ' escaped).
fn quoted(name: &str) -> String {
    format!("'{}'", name.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn parse_time(s: Option<&str>) -> i64 {
    s.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|d| d.timestamp_millis()).unwrap_or(0)
}

fn rfc3339(secs: u32) -> Option<String> {
    chrono::DateTime::from_timestamp(secs as i64, 0).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

fn is_dir(v: &Value) -> bool {
    v.get("mimeType").and_then(|m| m.as_str()) == Some(FOLDER)
}

/// One entry of a listing. Shortcuts and other non-file items are left out.
fn entry_of(v: &Value) -> Option<FileEntry> {
    let name = v.get("name")?.as_str()?.to_string();
    let mime = v.get("mimeType").and_then(|m| m.as_str()).unwrap_or_default();
    if mime == "application/vnd.google-apps.shortcut" {
        return None;
    }
    let dir = mime == FOLDER;
    Some(FileEntry {
        name,
        kind: if dir { "dir".into() } else { "file".into() },
        size: if dir { 0 } else { v.get("size").and_then(|s| s.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0) },
        mtime: parse_time(v.get("modifiedTime").and_then(|t| t.as_str())),
        perms: if dir { "755".into() } else { "644".into() },
        owner: String::new(),
        group: String::new(),
        link: None,
        hidden: 0,
    })
}

/// Turns an API error answer into a clear message.
fn api_err(status: reqwest::StatusCode, body: &str, what: &str) -> AppError {
    let v = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    let reason = v.pointer("/error/errors/0/reason").and_then(|r| r.as_str()).unwrap_or_default().to_string();
    let message = v.pointer("/error/message").and_then(|r| r.as_str()).unwrap_or(body).to_string();
    let detail = format!("{status}: {message}");
    match status.as_u16() {
        401 => AppError::new(ErrorKind::AuthFailed, "Die Anmeldung bei Google Drive ist nicht mehr gültig. Bitte neu anmelden.").with_detail(detail),
        404 => AppError::new(ErrorKind::NotFound, format!("{what}: nicht gefunden.")).with_detail(detail),
        429 => AppError::new(ErrorKind::ConnectionLost, "Google Drive bremst gerade (zu viele Anfragen). Gleich noch einmal versuchen.").with_detail(detail),
        403 if reason.contains("RateLimit") || reason.contains("rateLimit") => {
            AppError::new(ErrorKind::ConnectionLost, "Google Drive bremst gerade (zu viele Anfragen). Gleich noch einmal versuchen.").with_detail(detail)
        }
        403 if reason.contains("storageQuota") => AppError::new(ErrorKind::Other, format!("{what}: kein Speicherplatz mehr in Google Drive.")).with_detail(detail),
        403 if reason == "accessNotConfigured" || message.contains("has not been used") || message.contains("is disabled") => AppError::new(
            ErrorKind::Other,
            "In deinem Google-Cloud-Projekt ist die „Google Drive API“ noch nicht aktiviert (siehe Anleitung, Schritt 2).",
        )
        .with_detail(detail),
        403 => AppError::new(ErrorKind::PermissionDenied, format!("{what}: nicht erlaubt.")).with_detail(detail),
        _ => AppError::new(ErrorKind::Other, format!("{what} fehlgeschlagen.")).with_detail(detail),
    }
}

fn net(e: reqwest::Error) -> AppError {
    if e.is_connect() || e.is_timeout() {
        AppError::new(ErrorKind::ConnectionLost, "Google Drive ist nicht erreichbar.").with_detail(e.to_string())
    } else {
        AppError::new(ErrorKind::ConnectionLost, "Verbindung zu Google Drive unterbrochen.").with_detail(e.to_string())
    }
}

fn not_set_up() -> AppError {
    AppError::other("Für Google Drive fehlt dein eigener App-Schlüssel (Client-ID und Client-Schlüssel). Die Anleitung zeigt, wie du ihn bekommst.")
}

/// Signs in in the browser with the user's own app key; returns the refresh token and the account.
pub async fn sign_in(client_id: &str, client_secret: &str, open: impl FnOnce(&str) -> AppResult<()>) -> AppResult<oauth::SignedIn> {
    if client_id.trim().is_empty() || client_secret.trim().is_empty() {
        return Err(not_set_up());
    }
    let (verifier, challenge) = oauth::pkce();
    let state = oauth::state_token();
    let redirect = oauth::redirect_uri();
    let mut url = reqwest::Url::parse(AUTH_URL).unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", client_id.trim())
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        // "offline" + "consent": Google sends a lasting sign-in (refresh token) every time.
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("redirect_uri", &redirect)
        .append_pair("state", &state);
    let code = oauth::wait_for_code(url.as_str(), &state, open).await?;
    let client = oauth::http_client()?;
    let answer = oauth::token_request(
        &client,
        TOKEN_URL,
        &[
            ("code", &code),
            ("grant_type", "authorization_code"),
            ("client_id", client_id.trim()),
            ("client_secret", client_secret.trim()),
            ("code_verifier", &verifier),
            ("redirect_uri", &redirect),
        ],
    )
    .await?;
    let refresh = answer.refresh_token.ok_or_else(|| AppError::other("Google hat keine dauerhafte Anmeldung geschickt."))?;
    let conn = GDriveConn::new(client, client_id.trim().into(), client_secret.trim().into(), refresh.clone());
    *conn.token.lock().await = Token { access: answer.access_token, valid_until: Instant::now() + Duration::from_secs(answer.expires_in.unwrap_or(3600).saturating_sub(60)) };
    let account = conn.account().await.unwrap_or_else(|_| "Google Drive".into());
    Ok(oauth::SignedIn { refresh_token: refresh, account })
}

impl GDriveConn {
    fn new(client: reqwest::Client, client_id: String, client_secret: String, refresh: String) -> GDriveConn {
        let mut ids = HashMap::new();
        ids.insert("/".to_string(), "root".to_string());
        GDriveConn {
            client,
            client_id,
            client_secret,
            refresh,
            token: tokio::sync::Mutex::new(Token { access: String::new(), valid_until: Instant::now() }),
            ids: std::sync::Mutex::new(ids),
            home: "/".into(),
        }
    }

    pub async fn connect(params: GDriveParams) -> AppResult<GDriveConn> {
        if params.client_id.trim().is_empty() || params.client_secret.trim().is_empty() {
            return Err(not_set_up());
        }
        let conn = GDriveConn::new(oauth::http_client()?, params.client_id.trim().into(), params.client_secret.trim().into(), params.refresh_token);
        // Renews the access token and checks the account at once.
        conn.account().await?;
        Ok(conn)
    }

    /// A valid access token, renewed shortly before it runs out.
    async fn access(&self) -> AppResult<String> {
        let mut t = self.token.lock().await;
        if t.access.is_empty() || Instant::now() >= t.valid_until {
            let a = oauth::token_request(
                &self.client,
                TOKEN_URL,
                &[("grant_type", "refresh_token"), ("refresh_token", &self.refresh), ("client_id", &self.client_id), ("client_secret", &self.client_secret)],
            )
            .await?;
            t.access = a.access_token;
            t.valid_until = Instant::now() + Duration::from_secs(a.expires_in.unwrap_or(3600).saturating_sub(60));
        }
        Ok(t.access.clone())
    }

    /// A JSON call; `body` None means no request body.
    async fn call(&self, method: reqwest::Method, url: &str, query: &[(&str, &str)], body: Option<Value>, what: &str) -> AppResult<Value> {
        let token = self.access().await?;
        let mut req = self.client.request(method, url).bearer_auth(token).query(query);
        if let Some(b) = body {
            req = req.header("Content-Type", "application/json; charset=UTF-8").body(b.to_string());
        }
        let resp = req.send().await.map_err(net)?;
        let status = resp.status();
        let text = resp.text().await.map_err(net)?;
        if !status.is_success() {
            return Err(api_err(status, &text, what));
        }
        Ok(if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) })
    }

    /// E-mail address of the signed-in account.
    pub async fn account(&self) -> AppResult<String> {
        let v = self.call(reqwest::Method::GET, &format!("{API}/about"), &[("fields", "user(emailAddress,displayName)")], None, "Konto lesen").await?;
        Ok(v.pointer("/user/emailAddress").or_else(|| v.pointer("/user/displayName")).and_then(|e| e.as_str()).unwrap_or("Google Drive").to_string())
    }

    /// All children of a folder id (every page).
    async fn children(&self, parent: &str, what: &str) -> AppResult<Vec<Value>> {
        let q = format!("{} in parents and trashed = false", quoted(parent));
        let fields = format!("nextPageToken,files({FIELDS})");
        let mut out = Vec::new();
        let mut page = String::new();
        loop {
            let mut query = vec![("q", q.as_str()), ("fields", fields.as_str()), ("pageSize", "1000"), ("spaces", "drive")];
            if !page.is_empty() {
                query.push(("pageToken", page.as_str()));
            }
            let v = self.call(reqwest::Method::GET, &format!("{API}/files"), &query, None, what).await?;
            out.extend(v.get("files").and_then(|f| f.as_array()).cloned().unwrap_or_default());
            match v.get("nextPageToken").and_then(|p| p.as_str()) {
                Some(p) => page = p.to_string(),
                None => break,
            }
        }
        Ok(out)
    }

    /// The item with this name in a folder (the first one if Drive has several).
    async fn child(&self, parent: &str, name: &str, what: &str) -> AppResult<Option<Value>> {
        let q = format!("{} in parents and name = {} and trashed = false", quoted(parent), quoted(name));
        let fields = format!("files({FIELDS})");
        let v = self.call(reqwest::Method::GET, &format!("{API}/files"), &[("q", q.as_str()), ("fields", fields.as_str()), ("pageSize", "10"), ("spaces", "drive")], None, what).await?;
        Ok(v.pointer("/files/0").cloned())
    }

    /// Metadata of a path, looked up folder by folder (ids are cached).
    async fn lookup(&self, path: &str) -> AppResult<Value> {
        let path = norm(path);
        let what = format!("„{}“", remote_name(&path));
        if path == "/" {
            return Ok(json!({ "id": "root", "name": "/", "mimeType": FOLDER }));
        }
        let cached = self.ids.lock().unwrap().get(&path).cloned();
        if let Some(id) = cached {
            let fields = FIELDS.to_string();
            match self.call(reqwest::Method::GET, &format!("{API}/files/{id}"), &[("fields", fields.as_str())], None, &what).await {
                Ok(v) if v.get("trashed").and_then(|t| t.as_bool()) != Some(true) => return Ok(v),
                _ => self.forget(&path),
            }
        }
        let parent = Box::pin(self.lookup(&remote_parent(&path))).await?;
        let parent_id = parent.get("id").and_then(|i| i.as_str()).unwrap_or("root").to_string();
        let item = self.child(&parent_id, &remote_name(&path), &what).await?.ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("„{}“ gibt es nicht.", remote_name(&path))))?;
        if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
            self.ids.lock().unwrap().insert(path, id.to_string());
        }
        Ok(item)
    }

    async fn id_of(&self, path: &str) -> AppResult<String> {
        let v = self.lookup(path).await?;
        Ok(v.get("id").and_then(|i| i.as_str()).unwrap_or_default().to_string())
    }

    /// Drops a path and everything below it from the id cache.
    fn forget(&self, path: &str) {
        let path = norm(path);
        let prefix = format!("{path}/");
        self.ids.lock().unwrap().retain(|k, _| k != &path && !k.starts_with(&prefix));
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        let what = format!("„{}“ lesen", remote_name(path));
        let id = self.id_of(path).await?;
        let base = norm(path);
        let items = self.children(&id, &what).await?;
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for v in &items {
            let Some(e) = entry_of(v) else { continue };
            // Same name twice: Bitcrane shows (and uses) the first one only.
            if !seen.insert(e.name.clone()) {
                continue;
            }
            if let Some(cid) = v.get("id").and_then(|i| i.as_str()) {
                self.ids.lock().unwrap().insert(remote_join(&base, &e.name), cid.to_string());
            }
            out.push(e);
        }
        out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
            ("dir", "file") => std::cmp::Ordering::Less,
            ("file", "dir") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        if norm(path) == "/" {
            return Ok(FileEntry { name: "/".into(), kind: "dir".into(), size: 0, mtime: 0, perms: "755".into(), owner: String::new(), group: String::new(), link: None, hidden: 0 });
        }
        let v = self.lookup(path).await?;
        entry_of(&v).ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("„{}“ gibt es nicht.", remote_name(path))))
    }

    pub async fn exists(&self, path: &str) -> bool {
        self.stat(path).await.is_ok()
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        let what = format!("Ordner „{}“ anlegen", remote_name(path));
        if self.exists(path).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("{what}: gibt es schon.")));
        }
        let parent = self.id_of(&remote_parent(&norm(path))).await?;
        let v = self
            .call(reqwest::Method::POST, &format!("{API}/files"), &[("fields", "id")], Some(json!({ "name": remote_name(path), "mimeType": FOLDER, "parents": [parent] })), &what)
            .await?;
        if let Some(id) = v.get("id").and_then(|i| i.as_str()) {
            self.ids.lock().unwrap().insert(norm(path), id.to_string());
        }
        Ok(())
    }

    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        let path = norm(path);
        if path == "/" || self.exists(&path).await {
            return Ok(());
        }
        Box::pin(self.mkdir_all(&remote_parent(&path))).await?;
        match self.mkdir(&path).await {
            Err(e) if e.kind == ErrorKind::AlreadyExists => Ok(()),
            r => r,
        }
    }

    /// Renames and/or moves an item; refuses when the target name is taken.
    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        let what = format!("„{}“ umbenennen", remote_name(from));
        let (from, to) = (norm(from), norm(to));
        if self.exists(&to).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("„{}“ gibt es schon.", remote_name(&to))));
        }
        let id = self.id_of(&from).await?;
        let old_parent = self.id_of(&remote_parent(&from)).await?;
        let new_parent = self.id_of(&remote_parent(&to)).await?;
        let mut query: Vec<(&str, &str)> = vec![("fields", "id")];
        if old_parent != new_parent {
            query.push(("addParents", &new_parent));
            query.push(("removeParents", &old_parent));
        }
        self.call(reqwest::Method::PATCH, &format!("{API}/files/{id}"), &query, Some(json!({ "name": remote_name(&to) })), &what).await?;
        self.forget(&from);
        self.ids.lock().unwrap().insert(to, id);
        Ok(())
    }

    /// Puts `from` in place of `to` (end of an upload with a temporary name).
    /// The replaced old copy is deleted for good, like an overwrite.
    pub async fn replace(&self, from: &str, to: &str) -> AppResult<()> {
        if let Ok(old) = self.id_of(to).await {
            self.call(reqwest::Method::DELETE, &format!("{API}/files/{old}"), &[], None, &format!("„{}“ ersetzen", remote_name(to))).await?;
            self.forget(to);
        }
        self.rename(from, to).await
    }

    /// Moves to the Drive trash (restorable there for 30 days).
    pub async fn remove(&self, path: &str) -> AppResult<()> {
        let id = match self.id_of(path).await {
            Ok(id) => id,
            Err(e) if e.kind == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        self.call(reqwest::Method::PATCH, &format!("{API}/files/{id}"), &[("fields", "id")], Some(json!({ "trashed": true })), &format!("„{}“ löschen", remote_name(path))).await?;
        self.forget(path);
        Ok(())
    }

    /// Copy inside the Drive, with "Kopie" names on clashes; folders are copied with their content.
    pub async fn copy_within(&self, paths: &[String], dest_dir: &str) -> AppResult<Vec<String>> {
        let mut taken: std::collections::HashSet<String> = self.list(dest_dir).await?.into_iter().map(|e| e.name).collect();
        let mut out = Vec::new();
        for from in paths {
            if dest_dir == from.as_str() || dest_dir.starts_with(&format!("{from}/")) {
                return Err(AppError::other("Ein Ordner kann nicht in sich selbst kopiert werden."));
            }
            let name = crate::local::copy_name(|n| taken.contains(n), &remote_name(from));
            self.copy_item(from, &remote_join(dest_dir, &name)).await?;
            taken.insert(name.clone());
            out.push(name);
        }
        Ok(out)
    }

    async fn copy_item(&self, from: &str, to: &str) -> AppResult<()> {
        let what = format!("„{}“ kopieren", remote_name(from));
        let src = self.lookup(from).await?;
        if is_dir(&src) {
            self.mkdir(to).await?;
            for e in self.list(from).await? {
                Box::pin(self.copy_item(&remote_join(from, &e.name), &remote_join(to, &e.name))).await?;
            }
            return Ok(());
        }
        let id = src.get("id").and_then(|i| i.as_str()).unwrap_or_default();
        let parent = self.id_of(&remote_parent(&norm(to))).await?;
        self.call(reqwest::Method::POST, &format!("{API}/files/{id}/copy"), &[("fields", "id")], Some(json!({ "name": remote_name(to), "parents": [parent] })), &what).await?;
        Ok(())
    }

    /// All files below a folder.
    pub async fn walk(&self, path: &str) -> AppResult<Vec<WalkItem>> {
        let base = remote_parent(&norm(path));
        let rel = |p: &str| p.strip_prefix(&base).unwrap_or(p).trim_start_matches('/').to_string();
        let root = self.stat(path).await?;
        if root.kind != "dir" {
            return Ok(vec![WalkItem { path: norm(path), relative: rel(&norm(path)), size: root.size, mtime: root.mtime }]);
        }
        let mut out = Vec::new();
        let mut todo = vec![norm(path)];
        while let Some(dir) = todo.pop() {
            for e in self.list(&dir).await? {
                let p = remote_join(&dir, &e.name);
                if e.kind == "dir" {
                    todo.push(p);
                } else {
                    out.push(WalkItem { relative: rel(&p), path: p, size: e.size, mtime: e.mtime });
                }
            }
        }
        Ok(out)
    }

    /// Link to the file in Google Drive (who may open it is set in Drive itself).
    pub async fn share_link(&self, path: &str) -> AppResult<String> {
        let id = self.id_of(path).await?;
        let v = self.call(reqwest::Method::GET, &format!("{API}/files/{id}"), &[("fields", "webViewLink")], None, &format!("Link für „{}“", remote_name(path))).await?;
        v.get("webViewLink").and_then(|u| u.as_str()).map(String::from).ok_or_else(|| AppError::other("Google Drive hat keinen Link geliefert."))
    }

    /// Reads a file from `offset` (HTTP Range).
    pub async fn reader(&self, path: &str, offset: u64) -> AppResult<Box<dyn AsyncRead + Unpin + Send>> {
        let what = format!("„{}“ lesen", remote_name(path));
        let item = self.lookup(path).await?;
        let mime = item.get("mimeType").and_then(|m| m.as_str()).unwrap_or_default();
        if mime.starts_with("application/vnd.google-apps.") {
            return Err(AppError::other(format!("„{}“ ist ein Google-Dokument und lässt sich nicht direkt herunterladen. In Google Drive über „Herunterladen“ als Word-, Excel- oder PDF-Datei speichern.", remote_name(path))));
        }
        let id = item.get("id").and_then(|i| i.as_str()).unwrap_or_default();
        let token = self.access().await?;
        let mut req = self.client.get(format!("{API}/files/{id}")).query(&[("alt", "media")]).bearer_auth(token);
        if offset > 0 {
            req = req.header("Range", format!("bytes={offset}-"));
        }
        let resp = req.send().await.map_err(net)?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(api_err(status, &text, &what));
        }
        if offset > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(AppError::other("Google Drive kann hier nicht an einer Stelle weiterlesen.").with_detail("no-range"));
        }
        let stream = resp.bytes_stream().map_err(|e| std::io::Error::other(e.to_string()));
        Ok(Box::new(tokio_util::io::StreamReader::new(stream)))
    }

    /// Starts a resumable upload: a new file in the parent folder, or new
    /// content for an existing one. Returns the session address.
    async fn start_upload(&self, path: &str, mtime: Option<u32>, what: &str) -> AppResult<String> {
        let token = self.access().await?;
        let mut meta = json!({});
        if let Some(t) = mtime.and_then(rfc3339) {
            meta["modifiedTime"] = json!(t);
        }
        let existing = self.lookup(path).await.ok().filter(|v| !is_dir(v));
        let req = match existing.as_ref().and_then(|v| v.get("id")).and_then(|i| i.as_str()) {
            Some(id) => self.client.patch(format!("{UPLOAD}/files/{id}")),
            None => {
                let parent = self.id_of(&remote_parent(&norm(path))).await?;
                meta["name"] = json!(remote_name(path));
                meta["parents"] = json!([parent]);
                self.client.post(format!("{UPLOAD}/files"))
            }
        };
        let resp = req
            .query(&[("uploadType", "resumable"), ("fields", "id")])
            .bearer_auth(token)
            .header("Content-Type", "application/json; charset=UTF-8")
            .header("X-Upload-Content-Type", "application/octet-stream")
            .body(meta.to_string())
            .send()
            .await
            .map_err(net)?;
        let status = resp.status();
        let location = resp.headers().get("location").and_then(|l| l.to_str().ok()).map(String::from);
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(api_err(status, &text, what));
        }
        location.ok_or_else(|| AppError::other("Google Drive hat das Hochladen nicht gestartet."))
    }

    /// Sends one piece; `total` is known only with the last one.
    async fn send_piece(&self, session: &str, start: u64, piece: Vec<u8>, total: Option<u64>, what: &str) -> AppResult<Option<Value>> {
        let range = match (piece.is_empty(), total) {
            (true, Some(t)) => format!("bytes */{t}"),
            (_, Some(t)) => format!("bytes {start}-{}/{t}", start + piece.len() as u64 - 1),
            (_, None) => format!("bytes {start}-{}/*", start + piece.len() as u64 - 1),
        };
        let resp = self.client.put(session).header("Content-Range", range).body(piece).send().await.map_err(net)?;
        let status = resp.status();
        // 308: piece received, more expected.
        if status.as_u16() == 308 {
            return Ok(None);
        }
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(api_err(status, &text, what));
        }
        Ok(Some(serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    /// Writes a file. Bitcrane writes into the returned stream; the task sends
    /// it to Drive in pieces (resumable upload) and finishes the upload.
    pub fn writer(self: &std::sync::Arc<Self>, path: &str, mtime: Option<u32>) -> (Box<dyn AsyncWrite + Unpin + Send>, tokio::task::JoinHandle<AppResult<()>>) {
        let (w, mut r) = tokio::io::duplex(1024 * 1024);
        let conn = self.clone();
        let path = norm(path);
        let task = tokio::spawn(async move {
            let what = format!("„{}“ schreiben", remote_name(&path));
            let session = conn.start_upload(&path, mtime, &what).await?;
            let mut offset: u64 = 0;
            loop {
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
                let len = buf.len() as u64;
                let total = if last { Some(offset + len) } else { None };
                let done = conn.send_piece(&session, offset, buf, total, &what).await?;
                offset += len;
                if last {
                    if let Some(id) = done.as_ref().and_then(|v| v.get("id")).and_then(|i| i.as_str()) {
                        conn.ids.lock().unwrap().insert(path.clone(), id.to_string());
                    }
                    return Ok(());
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
    fn paths_queries_and_entries() {
        assert_eq!(norm(""), "/");
        assert_eq!(norm("/Fotos/2026/"), "/Fotos/2026");
        assert_eq!(quoted("Max's \\ Ordner"), "'Max\\'s \\\\ Ordner'");
        let f = entry_of(&json!({ "id": "1", "name": "a.txt", "mimeType": "text/plain", "size": "42", "modifiedTime": "2026-10-29T08:00:00.000Z" })).unwrap();
        assert_eq!((f.kind.as_str(), f.size, f.mtime), ("file", 42, 1793260800000));
        let d = entry_of(&json!({ "id": "2", "name": "Fotos", "mimeType": FOLDER })).unwrap();
        assert_eq!(d.kind, "dir");
        assert!(entry_of(&json!({ "id": "3", "name": "x", "mimeType": "application/vnd.google-apps.shortcut" })).is_none());
        assert_eq!(rfc3339(1793260800).as_deref(), Some("2026-10-29T08:00:00Z"));
    }
}
