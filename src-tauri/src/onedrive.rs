//! OneDrive as a "server" (Microsoft Graph). Paths in Bitcrane are those of
//! the user's OneDrive ("/" is its top folder); Graph addresses items by path
//! ("/me/drive/root:/a/b:"), so no id lookup is needed.
//!
//! Sign-in: see oauth.rs. The app key is the "Application (client) ID" of the
//! RaccoonWorks app registration (public client, no secret). Microsoft renews
//! the refresh token with every token request; the newest one is handed back
//! on connect so the interface can keep it (it stays valid while used).
//!
//! Notes:
//! - Deleting moves to the OneDrive recycle bin.
//! - Uploads up to 4 MB go in one request, larger files in an upload session of
//!   10 MiB pieces (Graph wants multiples of 320 KiB and the total size).
//! - The modification time is kept as "fileSystemInfo.lastModifiedDateTime".

use crate::error::{AppError, AppResult, ErrorKind, Message};
use crate::model::{EntryKind, FileEntry, WalkItem};
use crate::oauth;
use crate::paths::{quoted_name, remote_name, remote_parent};
use futures_util::TryStreamExt;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};

const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const AUTH_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SCOPE: &str = "Files.ReadWrite.All User.Read offline_access";
/// Files up to this size go in one request.
const SIMPLE_MAX: u64 = 4 * 1024 * 1024;
/// Size of one upload piece: 32 × 320 KiB.
const CHUNK: usize = 32 * 320 * 1024;
/// Characters escaped in a path segment.
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'/')
    .add(b'[')
    .add(b']')
    .add(b'^')
    .add(b'|')
    .add(b'\\')
    .add(b':');

// Deliberately without Debug: it holds secrets that must never end up in a log.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveParams {
    pub refresh_token: String,
}

struct Token {
    access: String,
    refresh: String,
    valid_until: Instant,
}

pub struct OneDriveConn {
    client: reqwest::Client,
    key: &'static str,
    token: tokio::sync::Mutex<Token>,
    pub home: String,
}

fn not_set_up() -> AppError {
    AppError::other("OneDrive ist in dieser Version von Bitcrane noch nicht eingerichtet.")
}

/// Normalised path: "/" for the top, else "/a/b".
fn norm(path: &str) -> String {
    let p = path.trim_end_matches('/');
    if p.is_empty() {
        "/".into()
    } else if p.starts_with('/') {
        p.to_string()
    } else {
        format!("/{p}")
    }
}

/// Graph address of an item: "…/me/drive/root" or "…/me/drive/root:/a/b:" (with `suffix` after it).
fn item_url(path: &str, suffix: &str) -> String {
    let p = norm(path);
    if p == "/" {
        return format!(
            "{GRAPH}/me/drive/root{}",
            if suffix.is_empty() { String::new() } else { format!("/{suffix}") }
        );
    }
    let encoded: Vec<String> =
        p.trim_start_matches('/').split('/').map(|s| utf8_percent_encode(s, SEGMENT).to_string()).collect();
    format!(
        "{GRAPH}/me/drive/root:/{}:{}",
        encoded.join("/"),
        if suffix.is_empty() { String::new() } else { format!("/{suffix}") }
    )
}

fn rfc3339(secs: u32) -> Option<String> {
    chrono::DateTime::from_timestamp(secs as i64, 0).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// One entry of a listing (packages and other special items are left out).
fn entry_of(v: &Value) -> Option<FileEntry> {
    let name = v.get("name")?.as_str()?.to_string();
    let dir = v.get("folder").is_some();
    if !dir && v.get("file").is_none() {
        return None;
    }
    // The time the file was changed on the computer it came from, else the server's.
    let mtime = crate::model::rfc3339_ms(
        v.pointer("/fileSystemInfo/lastModifiedDateTime")
            .and_then(|t| t.as_str())
            .or_else(|| v.get("lastModifiedDateTime").and_then(|t| t.as_str())),
    );
    Some(FileEntry::plain(name, dir, v.get("size").and_then(|s| s.as_u64()).unwrap_or(0), mtime))
}

/// Turns an API error answer into a clear message.
fn api_err(status: reqwest::StatusCode, body: &str, what: &Message) -> AppError {
    let v = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    let code = v.pointer("/error/code").and_then(|c| c.as_str()).unwrap_or_default().to_string();
    let message = v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or(body).to_string();
    let detail = format!("{status}: {code} {message}");
    match status.as_u16() {
        401 => AppError::new(
            ErrorKind::AuthFailed,
            "Die Anmeldung bei OneDrive ist nicht mehr gültig. Bitte neu anmelden.",
        )
        .with_detail(detail),
        404 => AppError::new(ErrorKind::NotFound, "{0}: nicht gefunden.").param(what).with_detail(detail),
        409 => AppError::new(ErrorKind::AlreadyExists, "{0}: gibt es schon.").param(what).with_detail(detail),
        429 | 503 => AppError::new(
            ErrorKind::ConnectionLost,
            "OneDrive bremst gerade (zu viele Anfragen). Gleich noch einmal versuchen.",
        )
        .with_detail(detail),
        507 => {
            AppError::new(ErrorKind::Other, "{0}: kein Speicherplatz mehr in OneDrive.").param(what).with_detail(detail)
        }
        403 => AppError::new(ErrorKind::PermissionDenied, "{0}: nicht erlaubt.").param(what).with_detail(detail),
        _ => AppError::new(ErrorKind::Other, "{0} fehlgeschlagen.").param(what).with_detail(detail),
    }
}

fn net(e: reqwest::Error) -> AppError {
    if e.is_connect() || e.is_timeout() {
        AppError::new(ErrorKind::ConnectionLost, "OneDrive ist nicht erreichbar.").with_detail(e.to_string())
    } else {
        AppError::new(ErrorKind::ConnectionLost, "Verbindung zu OneDrive unterbrochen.").with_detail(e.to_string())
    }
}

/// Signs in in the browser and returns the refresh token and the account name.
pub async fn sign_in(open: impl FnOnce(&str) -> AppResult<()>) -> AppResult<oauth::SignedIn> {
    let key = oauth::app_key("onedrive").ok_or_else(not_set_up)?;
    let (verifier, challenge) = oauth::pkce();
    let state = oauth::state_token();
    let redirect = oauth::redirect_uri();
    let mut url = reqwest::Url::parse(AUTH_URL).unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", key)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_mode", "query")
        .append_pair("prompt", "select_account")
        .append_pair("state", &state);
    let code = oauth::wait_for_code(url.as_str(), &state, open).await?;
    let client = oauth::http_client()?;
    let answer = oauth::token_request(
        &client,
        TOKEN_URL,
        &[
            ("code", &code),
            ("grant_type", "authorization_code"),
            ("client_id", key),
            ("code_verifier", &verifier),
            ("redirect_uri", &redirect),
            ("scope", SCOPE),
        ],
    )
    .await?;
    let refresh =
        answer.refresh_token.ok_or_else(|| AppError::other("OneDrive hat keine dauerhafte Anmeldung geschickt."))?;
    let conn = OneDriveConn {
        client,
        key,
        token: tokio::sync::Mutex::new(Token {
            access: answer.access_token,
            refresh: refresh.clone(),
            valid_until: Instant::now() + Duration::from_secs(answer.expires_in.unwrap_or(3600).saturating_sub(60)),
        }),
        home: "/".into(),
    };
    let account = conn.account().await.unwrap_or_else(|_| "OneDrive".into());
    Ok(oauth::SignedIn { refresh_token: refresh, account })
}

impl OneDriveConn {
    pub async fn connect(params: OneDriveParams) -> AppResult<OneDriveConn> {
        let key = oauth::app_key("onedrive").ok_or_else(not_set_up)?;
        let conn = OneDriveConn {
            client: oauth::http_client()?,
            key,
            token: tokio::sync::Mutex::new(Token {
                access: String::new(),
                refresh: params.refresh_token,
                valid_until: Instant::now(),
            }),
            home: "/".into(),
        };
        // Renews the access token and checks the account at once.
        conn.account().await?;
        Ok(conn)
    }

    /// The newest refresh token (Microsoft sends a new one with each renewal).
    pub async fn refresh_token(&self) -> String {
        self.token.lock().await.refresh.clone()
    }

    /// A valid access token, renewed shortly before it runs out.
    async fn access(&self) -> AppResult<String> {
        let mut t = self.token.lock().await;
        if t.access.is_empty() || Instant::now() >= t.valid_until {
            let refresh = t.refresh.clone();
            let a = oauth::token_request(
                &self.client,
                TOKEN_URL,
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &refresh),
                    ("client_id", self.key),
                    ("scope", SCOPE),
                ],
            )
            .await?;
            t.access = a.access_token;
            if let Some(r) = a.refresh_token {
                t.refresh = r;
            }
            t.valid_until = Instant::now() + Duration::from_secs(a.expires_in.unwrap_or(3600).saturating_sub(60));
        }
        Ok(t.access.clone())
    }

    /// A JSON call; `body` None means no request body.
    async fn call(&self, method: reqwest::Method, url: &str, body: Option<Value>, what: &Message) -> AppResult<Value> {
        let token = self.access().await?;
        let mut req = self.client.request(method, url).bearer_auth(token);
        if let Some(b) = body {
            req = req.header("Content-Type", "application/json").body(b.to_string());
        }
        let resp = req.send().await.map_err(net)?;
        let status = resp.status();
        let text = resp.text().await.map_err(net)?;
        if !status.is_success() {
            return Err(api_err(status, &text, what));
        }
        Ok(if text.trim().is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) })
    }

    /// E-mail address (or name) of the signed-in account.
    pub async fn account(&self) -> AppResult<String> {
        let v = self
            .call(
                reqwest::Method::GET,
                &format!("{GRAPH}/me?$select=mail,userPrincipalName,displayName"),
                None,
                &Message::new("Konto lesen"),
            )
            .await?;
        Ok(["mail", "userPrincipalName", "displayName"]
            .iter()
            .find_map(|k| v.get(*k).and_then(|x| x.as_str()).filter(|x| !x.is_empty()))
            .unwrap_or("OneDrive")
            .to_string())
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        let what = Message::new("„{0}“ lesen").param(remote_name(path));
        let mut url = format!(
            "{}?$top=1000&$select=name,size,folder,file,fileSystemInfo,lastModifiedDateTime",
            item_url(path, "children")
        );
        let mut out = Vec::new();
        loop {
            let v = self.call(reqwest::Method::GET, &url, None, &what).await?;
            out.extend(v.get("value").and_then(|e| e.as_array()).into_iter().flatten().filter_map(entry_of));
            match v.get("@odata.nextLink").and_then(|n| n.as_str()) {
                Some(next) => url = next.to_string(),
                None => break,
            }
        }
        crate::model::sort_listing(&mut out);
        Ok(out)
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        if norm(path) == "/" {
            return Ok(FileEntry {
                name: "/".into(),
                kind: EntryKind::Dir,
                size: 0,
                mtime: 0,
                perms: "755".into(),
                owner: String::new(),
                group: String::new(),
                link: None,
                hidden: 0,
            });
        }
        let v = self.call(reqwest::Method::GET, &item_url(path, ""), None, &quoted_name(path)).await?;
        entry_of(&v).ok_or_else(|| AppError::new(ErrorKind::NotFound, "„{0}“ gibt es nicht.").param(remote_name(path)))
    }

    pub async fn exists(&self, path: &str) -> bool {
        self.stat(path).await.is_ok()
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        let what = Message::new("Ordner „{0}“ anlegen").param(remote_name(path));
        let body = json!({ "name": remote_name(path), "folder": {}, "@microsoft.graph.conflictBehavior": "fail" });
        self.call(reqwest::Method::POST, &item_url(&remote_parent(&norm(path)), "children"), Some(body), &what)
            .await
            .map(|_| ())
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

    /// The parent reference Graph wants for a move or copy target folder.
    fn parent_ref(dir: &str) -> Value {
        let d = norm(dir);
        json!({ "path": if d == "/" { "/drive/root:".to_string() } else { format!("/drive/root:{d}") } })
    }

    /// Renames and/or moves an item; refuses when the target name is taken.
    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        let what = Message::new("„{0}“ umbenennen").param(remote_name(from));
        if self.exists(to).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, "„{0}“ gibt es schon.").param(remote_name(to)));
        }
        let mut body = json!({ "name": remote_name(to) });
        if remote_parent(&norm(from)) != remote_parent(&norm(to)) {
            body["parentReference"] = Self::parent_ref(&remote_parent(&norm(to)));
        }
        self.call(reqwest::Method::PATCH, &item_url(from, ""), Some(body), &what).await.map(|_| ())
    }

    /// Puts `from` in place of `to` (end of an upload with a temporary name).
    pub async fn replace(&self, from: &str, to: &str) -> AppResult<()> {
        if self.exists(to).await {
            self.remove(to).await?;
        }
        self.rename(from, to).await
    }

    /// Moves to the OneDrive recycle bin.
    pub async fn remove(&self, path: &str) -> AppResult<()> {
        match self
            .call(
                reqwest::Method::DELETE,
                &item_url(path, ""),
                None,
                &Message::new("„{0}“ löschen").param(remote_name(path)),
            )
            .await
        {
            Err(e) if e.kind == ErrorKind::NotFound => Ok(()),
            r => r.map(|_| ()),
        }
    }

    /// Copy inside the OneDrive, with "Kopie" names on clashes. Graph copies in
    /// the background; Bitcrane waits until it is done (at most two minutes per item).
    pub async fn copy_within(
        &self,
        paths: &[String],
        dest_dir: &str,
        words: &crate::local::NameWords,
    ) -> AppResult<Vec<String>> {
        let mut taken: std::collections::HashSet<String> =
            self.list(dest_dir).await?.into_iter().map(|e| e.name).collect();
        let mut out = Vec::new();
        for from in paths {
            if dest_dir == from.as_str() || dest_dir.starts_with(&format!("{from}/")) {
                return Err(AppError::other("Ein Ordner kann nicht in sich selbst kopiert werden."));
            }
            let name = crate::local::copy_name(|n| taken.contains(n), &remote_name(from), words);
            let what = Message::new("„{0}“ kopieren").param(remote_name(from));
            let token = self.access().await?;
            let body = json!({ "parentReference": Self::parent_ref(dest_dir), "name": name });
            let resp = self
                .client
                .post(item_url(from, "copy"))
                .bearer_auth(token)
                .header("Content-Type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .map_err(net)?;
            let status = resp.status();
            let monitor = resp.headers().get("location").and_then(|l| l.to_str().ok()).map(String::from);
            if !status.is_success() {
                let text = resp.text().await.unwrap_or_default();
                return Err(api_err(status, &text, &what));
            }
            if let Some(m) = monitor {
                self.wait_for_copy(&m, &what).await?;
            }
            taken.insert(name.clone());
            out.push(name);
        }
        Ok(out)
    }

    /// Polls the status address of a background copy (no sign-in needed there).
    async fn wait_for_copy(&self, monitor: &str, what: &Message) -> AppResult<()> {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let resp = self.client.get(monitor).send().await.map_err(net)?;
            let v: Value = serde_json::from_str(&resp.text().await.unwrap_or_default()).unwrap_or(Value::Null);
            match v.get("status").and_then(|s| s.as_str()) {
                Some("completed") => return Ok(()),
                Some("failed") => {
                    return Err(AppError::other("{0} fehlgeschlagen.").param(what).with_detail(v.to_string()))
                }
                // A finished copy redirects to the new item and has no status any more.
                None if v.get("id").is_some() => return Ok(()),
                _ => {}
            }
            if Instant::now() > deadline {
                return Err(
                    AppError::other("{0}: OneDrive kopiert noch im Hintergrund. Bitte gleich neu laden.").param(what)
                );
            }
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
    }

    /// All files below a folder.
    pub async fn walk(&self, path: &str) -> AppResult<Vec<WalkItem>> {
        crate::remote::walk_by_listing(
            &norm(path),
            |p| async move { self.stat(&p).await },
            |d| async move { self.list(&d).await },
        )
        .await
    }

    /// A view link anyone with the link can open (Transmit "Copy Link"). Accounts
    /// that do not allow such links (some work accounts) get a link for their organisation.
    pub async fn share_link(&self, path: &str) -> AppResult<String> {
        let what = Message::new("Link für „{0}“").param(remote_name(path));
        let url = item_url(path, "createLink");
        let v = match self
            .call(reqwest::Method::POST, &url, Some(json!({ "type": "view", "scope": "anonymous" })), &what)
            .await
        {
            Ok(v) => v,
            Err(e) if e.kind == ErrorKind::PermissionDenied || e.kind == ErrorKind::Other => {
                self.call(reqwest::Method::POST, &url, Some(json!({ "type": "view", "scope": "organization" })), &what)
                    .await?
            }
            Err(e) => return Err(e),
        };
        v.pointer("/link/webUrl")
            .and_then(|u| u.as_str())
            .map(String::from)
            .ok_or_else(|| AppError::other("{0}: OneDrive hat keinen Link geliefert.").param(what))
    }

    /// Reads a file from `offset` (HTTP Range; Graph redirects to the download address).
    pub async fn reader(&self, path: &str, offset: u64) -> AppResult<Box<dyn AsyncRead + Unpin + Send>> {
        let token = self.access().await?;
        let mut req = self.client.get(item_url(path, "content")).bearer_auth(token);
        if offset > 0 {
            req = req.header("Range", format!("bytes={offset}-"));
        }
        let resp = req.send().await.map_err(net)?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(api_err(status, &text, &Message::new("„{0}“ lesen").param(remote_name(path))));
        }
        if offset > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(
                AppError::other("OneDrive kann hier nicht an einer Stelle weiterlesen.").with_detail("no-range")
            );
        }
        let stream = resp.bytes_stream().map_err(|e| std::io::Error::other(e.to_string()));
        Ok(Box::new(tokio_util::io::StreamReader::new(stream)))
    }

    /// Keeps the modification time after a simple upload.
    async fn set_mtime(&self, path: &str, mtime: Option<u32>) -> AppResult<()> {
        let Some(t) = mtime.and_then(rfc3339) else { return Ok(()) };
        self.call(
            reqwest::Method::PATCH,
            &item_url(path, ""),
            Some(json!({ "fileSystemInfo": { "lastModifiedDateTime": t } })),
            &Message::new("„{0}“ schreiben").param(remote_name(path)),
        )
        .await
        .map(|_| ())
    }

    async fn put_simple(&self, path: &str, body: Vec<u8>, what: &Message) -> AppResult<()> {
        let token = self.access().await?;
        let resp = self
            .client
            .put(item_url(path, "content"))
            .bearer_auth(token)
            .header("Content-Type", "application/octet-stream")
            .body(body)
            .send()
            .await
            .map_err(net)?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(api_err(status, &text, what));
        }
        Ok(())
    }

    /// Writes a file of `size` bytes (unknown size: the file is collected first).
    pub fn writer(
        self: &std::sync::Arc<Self>,
        path: &str,
        size: Option<u64>,
        mtime: Option<u32>,
    ) -> (Box<dyn AsyncWrite + Unpin + Send>, tokio::task::JoinHandle<AppResult<()>>) {
        let (w, mut r) = tokio::io::duplex(1024 * 1024);
        let conn = self.clone();
        let path = norm(path);
        let task = tokio::spawn(async move {
            let what = Message::new("„{0}“ schreiben").param(remote_name(&path));
            let read_err = |e: std::io::Error| {
                AppError::new(ErrorKind::ConnectionLost, "Hochladen abgebrochen.").with_detail(e.to_string())
            };
            // Small or unknown size: one request.
            let total = match size {
                Some(s) if s > SIMPLE_MAX => s,
                _ => {
                    let mut all = Vec::new();
                    r.read_to_end(&mut all).await.map_err(read_err)?;
                    if all.len() as u64 <= SIMPLE_MAX {
                        conn.put_simple(&path, all, &what).await?;
                        return conn.set_mtime(&path, mtime).await;
                    }
                    // Unknown size turned out large: send what was collected in pieces.
                    let total = all.len() as u64;
                    let session = conn.start_session(&path, mtime, &what).await?;
                    let mut offset = 0u64;
                    for piece in all.chunks(CHUNK) {
                        conn.send_piece(&session, offset, piece.to_vec(), total, &what).await?;
                        offset += piece.len() as u64;
                    }
                    return Ok(());
                }
            };
            let session = conn.start_session(&path, mtime, &what).await?;
            let mut offset = 0u64;
            while offset < total {
                let want = ((total - offset) as usize).min(CHUNK);
                let mut buf = vec![0u8; want];
                r.read_exact(&mut buf).await.map_err(read_err)?;
                conn.send_piece(&session, offset, buf, total, &what).await?;
                offset += want as u64;
            }
            Ok(())
        });
        (Box::new(w), task)
    }

    async fn start_session(&self, path: &str, mtime: Option<u32>, what: &Message) -> AppResult<String> {
        let mut item = json!({ "@microsoft.graph.conflictBehavior": "replace" });
        if let Some(t) = mtime.and_then(rfc3339) {
            item["fileSystemInfo"] = json!({ "lastModifiedDateTime": t });
        }
        let v = self
            .call(reqwest::Method::POST, &item_url(path, "createUploadSession"), Some(json!({ "item": item })), what)
            .await?;
        v.get("uploadUrl")
            .and_then(|u| u.as_str())
            .map(String::from)
            .ok_or_else(|| AppError::other("OneDrive hat das Hochladen in Teilen nicht gestartet."))
    }

    /// Sends one piece to an upload session (the session address needs no sign-in).
    async fn send_piece(&self, session: &str, start: u64, piece: Vec<u8>, total: u64, what: &Message) -> AppResult<()> {
        let end = start + piece.len() as u64 - 1;
        let resp = self
            .client
            .put(session)
            .header("Content-Range", format!("bytes {start}-{end}/{total}"))
            .body(piece)
            .send()
            .await
            .map_err(net)?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(api_err(status, &text, what));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_and_entries() {
        assert_eq!(item_url("/", "children"), format!("{GRAPH}/me/drive/root/children"));
        assert_eq!(
            item_url("/Fotos/Mai 2026/a#1.jpg", "content"),
            format!("{GRAPH}/me/drive/root:/Fotos/Mai%202026/a%231.jpg:/content")
        );
        assert_eq!(item_url("/Übersicht", ""), format!("{GRAPH}/me/drive/root:/%C3%9Cbersicht:"));
        let f = entry_of(&json!({ "name": "a.txt", "size": 42, "file": {}, "fileSystemInfo": { "lastModifiedDateTime": "2026-10-29T08:00:00Z" } })).unwrap();
        assert_eq!((f.kind, f.size, f.mtime), (EntryKind::File, 42, 1793260800000));
        assert_eq!(entry_of(&json!({ "name": "Fotos", "folder": { "childCount": 3 } })).unwrap().kind, EntryKind::Dir);
        assert!(entry_of(&json!({ "name": "Notizbuch", "package": { "type": "oneNote" } })).is_none());
        assert_eq!(OneDriveConn::parent_ref("/"), json!({ "path": "/drive/root:" }));
        assert_eq!(OneDriveConn::parent_ref("/a/b"), json!({ "path": "/drive/root:/a/b" }));
    }
}
