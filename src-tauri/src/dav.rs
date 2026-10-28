//! WebDAV client (HTTP and HTTPS), e.g. for Nextcloud, ownCloud, NAS boxes
//! and web hosts. Paths in Bitcrane are relative to the server's WebDAV
//! address ("/" is the address itself).

use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{FileEntry, WalkItem};
use crate::paths::{remote_join, remote_name, remote_parent};
use crate::proxy::ProxyParams;
use crate::ssh::KnownHosts;
use futures_util::TryStreamExt;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DavParams {
    /// Full address, e.g. "https://cloud.example/remote.php/dav/files/alex".
    pub url: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub tls13_only: bool,
    #[serde(default)]
    pub trust: Option<String>,
    #[serde(default)]
    pub proxy: Option<ProxyParams>,
}

/// Characters escaped in one path segment.
const SEGMENT: &AsciiSet = &CONTROLS.add(b' ').add(b'"').add(b'#').add(b'%').add(b'<').add(b'>').add(b'?').add(b'`').add(b'{').add(b'}').add(b'/').add(b'[').add(b']').add(b'^').add(b'|').add(b'\\');

pub struct DavConn {
    client: reqwest::Client,
    /// Address without trailing slash.
    base: String,
    /// Path part of `base` (to turn hrefs of answers back into Bitcrane paths).
    base_path: String,
    user: String,
    password: Option<String>,
    pub home: String,
}

fn net_err(e: reqwest::Error, seen: Option<&Arc<Mutex<Option<crate::tls::SeenCert>>>>, known: &KnownHosts, host_id: &str, host: &str) -> AppError {
    // A certificate problem shows up deep inside the error chain.
    let mut text = e.to_string();
    let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
    while let Some(s) = src {
        text.push_str(" / ");
        text.push_str(&s.to_string());
        src = s.source();
    }
    if text.to_lowercase().contains("certificate") {
        if let Some(cert) = seen.and_then(|s| s.lock().unwrap().clone()) {
            let stored = known.get(host_id);
            if stored.as_deref() != Some(cert.fingerprint.as_str()) {
                return crate::ftp::cert_error(host, cert.fingerprint, stored);
            }
        }
    }
    if e.is_timeout() {
        return AppError::new(ErrorKind::Unreachable, "Der Server antwortet nicht (Zeitüberschreitung).").with_detail(text);
    }
    if e.is_connect() {
        return AppError::new(ErrorKind::Unreachable, "Server nicht erreichbar.").with_detail(text);
    }
    AppError::new(ErrorKind::ConnectionLost, "Verbindung zum WebDAV-Server unterbrochen.").with_detail(text)
}

fn status_err(status: StatusCode, what: &str) -> AppError {
    let (kind, msg) = match status.as_u16() {
        401 => (ErrorKind::AuthFailed, "Anmeldung abgelehnt: Benutzer oder Passwort falsch.".to_string()),
        403 => (ErrorKind::PermissionDenied, format!("{what}: keine Berechtigung.")),
        404 | 409 => (ErrorKind::NotFound, format!("{what}: nicht gefunden.")),
        405 | 412 => (ErrorKind::AlreadyExists, format!("{what}: gibt es schon.")),
        423 => (ErrorKind::PermissionDenied, format!("{what}: Datei ist gesperrt.")),
        507 => (ErrorKind::Other, format!("{what}: kein Speicherplatz mehr auf dem Server.")),
        _ => (ErrorKind::Other, format!("{what} fehlgeschlagen.")),
    };
    AppError::new(kind, msg).with_detail(status.to_string())
}

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;

/// Parses a PROPFIND answer into (path below the base, entry).
fn parse_multistatus(xml: &str, base_path: &str) -> Vec<(String, FileEntry)> {
    let Ok(doc) = roxmltree::Document::parse(xml) else { return vec![] };
    let mut out = Vec::new();
    for resp in doc.descendants().filter(|n| n.tag_name().name() == "response") {
        let Some(href) = resp.descendants().find(|n| n.tag_name().name() == "href").and_then(|n| n.text()) else { continue };
        // href may be absolute ("https://host/dav/x") or a path ("/dav/x").
        let path_part = match href.find("://") {
            Some(i) => href[i + 3..].find('/').map(|j| &href[i + 3 + j..]).unwrap_or("/"),
            None => href,
        };
        let decoded = percent_decode_str(path_part).decode_utf8_lossy().into_owned();
        let rel = decoded.strip_prefix(base_path).unwrap_or(&decoded).trim_end_matches('/').to_string();
        let rel = if rel.is_empty() { "/".to_string() } else if rel.starts_with('/') { rel } else { format!("/{rel}") };
        // Only properties with status 200.
        let mut is_dir = false;
        let mut size = 0u64;
        let mut mtime = 0i64;
        for ps in resp.children().filter(|n| n.tag_name().name() == "propstat") {
            let ok = ps.children().find(|n| n.tag_name().name() == "status").and_then(|n| n.text()).map(|t| t.contains(" 200")).unwrap_or(true);
            if !ok {
                continue;
            }
            for p in ps.descendants() {
                match p.tag_name().name() {
                    "collection" => is_dir = true,
                    "getcontentlength" => size = p.text().and_then(|t| t.trim().parse().ok()).unwrap_or(0),
                    "getlastmodified" => mtime = p.text().and_then(|t| chrono::DateTime::parse_from_rfc2822(t.trim()).ok()).map(|d| d.timestamp_millis()).unwrap_or(0),
                    _ => {}
                }
            }
        }
        let name = if rel == "/" { "/".to_string() } else { remote_name(&rel) };
        out.push((rel, FileEntry { name, kind: if is_dir { "dir".into() } else { "file".into() }, size: if is_dir { 0 } else { size }, mtime, perms: if is_dir { "755".into() } else { "644".into() }, owner: String::new(), group: String::new(), link: None, hidden: 0 }));
    }
    out
}

impl DavConn {
    pub async fn connect(params: DavParams, known: Arc<KnownHosts>) -> AppResult<DavConn> {
        let url = reqwest::Url::parse(params.url.trim()).map_err(|_| AppError::other("Die WebDAV-Adresse ist ungültig (Beispiel: https://cloud.example/remote.php/dav/files/name)."))?;
        let host = url.host_str().unwrap_or_default().to_string();
        let port = url.port_or_known_default().unwrap_or(443);
        let host_id = format!("https://{host}:{port}");
        let (tls, seen) = crate::tls::client_config(known.clone(), host_id.clone(), params.trust.clone(), params.tls13_only);
        let mut builder = reqwest::Client::builder()
            .use_preconfigured_tls((*tls).clone())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .user_agent(concat!("Bitcrane/", env!("CARGO_PKG_VERSION")));
        if let Some(p) = &params.proxy {
            let scheme = if p.kind == "http" { "http" } else { "socks5h" };
            let mut proxy = reqwest::Proxy::all(format!("{scheme}://{}:{}", p.host, p.port)).map_err(|e| AppError::other("Proxy-Adresse ungültig.").with_detail(e.to_string()))?;
            if let Some(u) = p.user.as_deref().filter(|u| !u.is_empty()) {
                proxy = proxy.basic_auth(u, p.password.as_deref().unwrap_or(""));
            }
            builder = builder.proxy(proxy);
        } else {
            builder = builder.no_proxy();
        }
        let client = builder.build().map_err(|e| AppError::other("WebDAV konnte nicht vorbereitet werden.").with_detail(e.to_string()))?;
        let base = url.as_str().trim_end_matches('/').to_string();
        let base_path = percent_decode_str(url.path().trim_end_matches('/')).decode_utf8_lossy().into_owned();
        let conn = DavConn { client, base, base_path, user: params.user.clone(), password: params.password.clone(), home: "/".into() };
        // First request: checks address, certificate and login.
        let resp = conn.request(Method::from_bytes(b"PROPFIND").unwrap(), "/").header("Depth", "0").body(PROPFIND_BODY).send().await.map_err(|e| net_err(e, Some(&seen), &known, &host_id, &host))?;
        match resp.status().as_u16() {
            207 => Ok(conn),
            401 if params.password.is_none() => Err(AppError::new(ErrorKind::PasswordRequired, "Der Server möchte ein Passwort.")),
            401 => Err(status_err(resp.status(), "Anmeldung")),
            404 => Err(AppError::new(ErrorKind::NotFound, "Unter dieser Adresse gibt es keinen WebDAV-Ordner.")),
            405 | 501 => Err(AppError::other("Diese Adresse spricht kein WebDAV.")),
            _ => Err(status_err(resp.status(), "Verbinden")),
        }
    }

    fn url(&self, path: &str) -> String {
        let mut u = self.base.clone();
        for seg in path.split('/').filter(|s| !s.is_empty()) {
            u.push('/');
            u.push_str(&utf8_percent_encode(seg, SEGMENT).to_string());
        }
        if path.ends_with('/') || u == self.base {
            u.push('/');
        }
        u
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let r = self.client.request(method, self.url(path));
        if self.user.is_empty() {
            r
        } else {
            r.basic_auth(&self.user, self.password.as_deref())
        }
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> AppResult<reqwest::Response> {
        req.send().await.map_err(|e| {
            if e.is_timeout() || e.is_connect() {
                AppError::new(ErrorKind::ConnectionLost, "Verbindung zum WebDAV-Server unterbrochen.").with_detail(e.to_string())
            } else {
                AppError::new(ErrorKind::ConnectionLost, "WebDAV-Anfrage fehlgeschlagen.").with_detail(e.to_string())
            }
        })
    }

    async fn propfind(&self, path: &str, depth: &str) -> AppResult<Vec<(String, FileEntry)>> {
        let dir_path = if depth == "1" && !path.ends_with('/') { format!("{path}/") } else { path.to_string() };
        let resp = self.send(self.request(Method::from_bytes(b"PROPFIND").unwrap(), &dir_path).header("Depth", depth).header("Content-Type", "application/xml").body(PROPFIND_BODY)).await?;
        if resp.status().as_u16() != 207 {
            return Err(status_err(resp.status(), &format!("„{}“", remote_name(path))));
        }
        let xml = resp.text().await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Antwort unvollständig.").with_detail(e.to_string()))?;
        Ok(parse_multistatus(&xml, &self.base_path))
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        let me = path.trim_end_matches('/');
        let me = if me.is_empty() { "/" } else { me };
        let mut out: Vec<FileEntry> = self.propfind(path, "1").await?.into_iter().filter(|(p, _)| p != me).map(|(_, e)| e).collect();
        out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
            ("dir", "file") => std::cmp::Ordering::Less,
            ("file", "dir") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        let mut all = self.propfind(path, "0").await?;
        let mut e = all.pop().map(|(_, e)| e).ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("„{}“ gibt es nicht.", remote_name(path))))?;
        e.name = remote_name(path);
        Ok(e)
    }

    pub async fn exists(&self, path: &str) -> bool {
        self.stat(path).await.is_ok()
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        let resp = self.send(self.request(Method::from_bytes(b"MKCOL").unwrap(), path)).await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(status_err(resp.status(), &format!("Ordner „{}“ anlegen", remote_name(path))))
        }
    }

    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        let mut current = String::new();
        for seg in path.split('/').filter(|s| !s.is_empty()) {
            current.push('/');
            current.push_str(seg);
            if !self.exists(&current).await {
                if let Err(e) = self.mkdir(&current).await {
                    if !self.exists(&current).await {
                        return Err(e);
                    }
                }
            }
        }
        Ok(())
    }

    async fn move_or_copy(&self, method: &[u8], from: &str, to: &str, overwrite: bool, what: &str) -> AppResult<()> {
        let resp = self
            .send(self.request(Method::from_bytes(method).unwrap(), from).header("Destination", self.url(to)).header("Overwrite", if overwrite { "T" } else { "F" }))
            .await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(status_err(resp.status(), what))
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        if self.exists(to).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("„{}“ gibt es hier schon.", remote_name(to))));
        }
        self.move_or_copy(b"MOVE", from, to, false, &format!("„{}“ umbenennen", remote_name(from))).await
    }

    pub async fn replace(&self, from: &str, to: &str) -> AppResult<()> {
        self.move_or_copy(b"MOVE", from, to, true, &format!("„{}“ ersetzen", remote_name(to))).await
    }

    /// Server-side copy (WebDAV COPY), with "Kopie" names on clashes.
    pub async fn copy_within(&self, paths: &[String], dest_dir: &str) -> AppResult<Vec<String>> {
        let mut taken: std::collections::HashSet<String> = self.list(dest_dir).await?.into_iter().map(|e| e.name).collect();
        let mut out = Vec::new();
        for from in paths {
            if dest_dir == from.as_str() || dest_dir.starts_with(&format!("{from}/")) {
                return Err(AppError::other("Ein Ordner kann nicht in sich selbst kopiert werden."));
            }
            let name = crate::local::copy_name(|n| taken.contains(n), &remote_name(from));
            self.move_or_copy(b"COPY", from, &remote_join(dest_dir, &name), false, &format!("„{}“ kopieren", remote_name(from))).await?;
            taken.insert(name.clone());
            out.push(name);
        }
        Ok(out)
    }

    pub async fn remove(&self, path: &str) -> AppResult<()> {
        let resp = self.send(self.request(Method::DELETE, path)).await?;
        if resp.status().is_success() || resp.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(status_err(resp.status(), &format!("„{}“ löschen", remote_name(path))))
        }
    }

    pub async fn walk(&self, path: &str) -> AppResult<Vec<WalkItem>> {
        let base = remote_parent(path);
        let root = self.stat(path).await?;
        let rel = |p: &str| p.strip_prefix(&base).unwrap_or(p).trim_start_matches('/').to_string();
        if root.kind != "dir" {
            return Ok(vec![WalkItem { path: path.to_string(), relative: rel(path), size: root.size, mtime: root.mtime }]);
        }
        let mut out = Vec::new();
        let mut stack = vec![path.to_string()];
        while let Some(dir) = stack.pop() {
            for e in self.list(&dir).await? {
                let p = remote_join(&dir, &e.name);
                if e.kind == "dir" {
                    stack.push(p);
                } else {
                    out.push(WalkItem { relative: rel(&p), path: p, size: e.size, mtime: e.mtime });
                }
            }
        }
        Ok(out)
    }

    /// Reads a file from `offset` (HTTP Range).
    pub async fn reader(&self, path: &str, offset: u64) -> AppResult<Box<dyn AsyncRead + Unpin + Send>> {
        let mut req = self.request(Method::GET, path);
        if offset > 0 {
            req = req.header("Range", format!("bytes={offset}-"));
        }
        let resp = self.send(req).await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(status_err(status, &format!("„{}“ lesen", remote_name(path))));
        }
        if offset > 0 && status != StatusCode::PARTIAL_CONTENT {
            return Err(AppError::other("Der Server kann nicht an einer Stelle weiterlesen.").with_detail("no-range"));
        }
        let stream = resp.bytes_stream().map_err(|e| std::io::Error::other(e.to_string()));
        Ok(Box::new(tokio_util::io::StreamReader::new(stream)))
    }

    /// Writes a file. The returned task finishes the upload; `size` lets the
    /// server know the length in advance, `mtime` (seconds) is kept where the
    /// server supports it (Nextcloud/ownCloud: X-OC-MTime).
    pub fn writer(&self, path: &str, size: Option<u64>, mtime: Option<u32>) -> (Box<dyn AsyncWrite + Unpin + Send>, tokio::task::JoinHandle<AppResult<()>>) {
        let (w, r) = tokio::io::duplex(256 * 1024);
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(r));
        let mut req = self.request(Method::PUT, path).body(body);
        if let Some(s) = size {
            req = req.header("Content-Length", s.to_string());
        }
        if let Some(m) = mtime {
            req = req.header("X-OC-MTime", m.to_string());
        }
        let what = format!("„{}“ schreiben", remote_name(path));
        let task = tokio::spawn(async move {
            let resp = req.send().await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Hochladen abgebrochen.").with_detail(e.to_string()))?;
            if resp.status().is_success() {
                Ok(())
            } else {
                Err(status_err(resp.status(), &what))
            }
        });
        (Box::new(w), task)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_propfind_answers() {
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
          <d:response><d:href>/dav/files/c/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
          <d:response><d:href>/dav/files/c/Neuer%20Ordner/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Tue, 27 Oct 2026 12:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
          <d:response><d:href>https://x.example/dav/files/c/%C3%BCber.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>42</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
            <d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
        </d:multistatus>"#;
        let r = parse_multistatus(xml, "/dav/files/c");
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].0, "/");
        assert_eq!((r[1].0.as_str(), r[1].1.kind.as_str()), ("/Neuer Ordner", "dir"));
        assert_eq!(r[1].1.mtime, 1793102400000);
        assert_eq!((r[2].1.name.as_str(), r[2].1.size), ("über.txt", 42));
    }
}

/// Integration test against a WebDAV server: `BITCRANE_TEST_DAV=http://…,https://…`.
#[cfg(test)]
mod integration {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn dav_round_trip() {
        let Ok(urls) = std::env::var("BITCRANE_TEST_DAV") else { return };
        let dir = tempfile::tempdir().unwrap();
        let known = Arc::new(KnownHosts::load(dir.path().join("known.json")));
        for url in urls.split(',') {
            let params = |trust: Option<String>, password: &str| DavParams { url: url.into(), user: "test".into(), password: Some(password.into()), tls13_only: false, trust, proxy: None };
            assert_eq!(DavConn::connect(params(None, "falsch"), known.clone()).await.err().map(|e| e.kind).filter(|k| *k != ErrorKind::HostKeyUnknown), if url.starts_with("https") { None } else { Some(ErrorKind::AuthFailed) });
            let conn = match DavConn::connect(params(None, "geheim123"), known.clone()).await {
                Ok(c) => c,
                Err(e) if e.kind == ErrorKind::HostKeyUnknown => {
                    let fp = e.host_key.unwrap().fingerprint;
                    DavConn::connect(params(Some(fp), "geheim123"), known.clone()).await.expect("trusted")
                }
                Err(e) => panic!("{url}: {e:?}"),
            };
            let base = format!("/bitcrane-dav-{}", uuid::Uuid::new_v4().simple());
            conn.mkdir_all(&format!("{base}/a b")).await.unwrap();
            let file = format!("{base}/a b/über.txt");
            let (mut w, task) = conn.writer(&file, Some(11), None);
            w.write_all(b"hallo welt!").await.unwrap();
            w.shutdown().await.unwrap();
            drop(w);
            task.await.unwrap().unwrap();
            let st = conn.stat(&file).await.unwrap();
            assert_eq!((st.size, st.name.as_str()), (11, "über.txt"));
            let mut r = conn.reader(&file, 6).await.unwrap();
            let mut got = String::new();
            r.read_to_string(&mut got).await.unwrap();
            assert_eq!(got, "welt!");
            let names: Vec<String> = conn.list(&format!("{base}/a b")).await.unwrap().into_iter().map(|e| e.name).collect();
            assert_eq!(names, vec!["über.txt".to_string()]);
            assert_eq!(conn.copy_within(&[file.clone()], &format!("{base}/a b")).await.unwrap(), vec!["über Kopie.txt".to_string()]);
            conn.rename(&file, &format!("{base}/neu.txt")).await.unwrap();
            assert_eq!(conn.walk(&base).await.unwrap().len(), 2);
            assert_eq!(conn.stat(&format!("{base}/fehlt")).await.err().map(|e| e.kind), Some(ErrorKind::NotFound));
            conn.remove(&base).await.unwrap();
            assert!(!conn.exists(&base).await);
        }
    }
}
