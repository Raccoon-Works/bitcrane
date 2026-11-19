//! WebDAV client (HTTP and HTTPS), e.g. for Nextcloud, ownCloud, NAS boxes
//! and web hosts. Paths in Bitcrane are relative to the server's WebDAV
//! address ("/" is the address itself).

use crate::error::{AppError, AppResult, ErrorKind, Message};
use crate::model::{EntryKind, FileEntry, WalkItem};
use crate::paths::{quoted_name, remote_name};
use crate::proxy::ProxyParams;
use crate::ssh::KnownHosts;
use crate::LockExt;
use futures_util::TryStreamExt;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::{Method, StatusCode};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

// Deliberately without Debug: it holds secrets that must never end up in a log.
#[derive(Clone)]
pub struct DavParams {
    /// Full address, e.g. "https://cloud.example/remote.php/dav/files/alex".
    pub url: String,
    pub user: String,
    pub password: Option<String>,
    pub tls13_only: bool,
    pub trust: Option<String>,
    pub proxy: Option<ProxyParams>,
    /// Seconds to wait for the server when connecting (per server, default 15).
    pub timeout: Option<u64>,
}

/// Characters escaped in one path segment.
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
    .add(b'\\');

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

fn net_err(
    e: reqwest::Error,
    seen: Option<&Arc<Mutex<Option<crate::tls::SeenCert>>>>,
    known: &KnownHosts,
    host_id: &str,
    host: &str,
) -> AppError {
    // A certificate problem shows up deep inside the error chain.
    let mut text = e.to_string();
    let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
    while let Some(s) = src {
        text.push_str(" / ");
        text.push_str(&s.to_string());
        src = s.source();
    }
    if text.to_lowercase().contains("certificate") {
        if let Some(cert) = seen.and_then(|s| s.locked().clone()) {
            let stored = known.get(host_id);
            if stored.as_deref() != Some(cert.fingerprint.as_str()) {
                return crate::ftp::cert_error(host, cert.fingerprint, stored);
            }
        }
    }
    if e.is_timeout() {
        return AppError::new(ErrorKind::Unreachable, "Der Server antwortet nicht (Zeitüberschreitung).")
            .with_detail(text);
    }
    if e.is_connect() {
        return AppError::new(ErrorKind::Unreachable, "Server nicht erreichbar.").with_detail(text);
    }
    AppError::new(ErrorKind::ConnectionLost, "Verbindung zum WebDAV-Server unterbrochen.").with_detail(text)
}

/// The WebDAV methods `reqwest` has no constant for; only literal method names are passed.
fn dav_method(name: &'static [u8]) -> Method {
    Method::from_bytes(name).expect("WebDAV method names are valid HTTP tokens")
}

fn status_err(status: StatusCode, what: &Message) -> AppError {
    let err = match status.as_u16() {
        401 => AppError::new(ErrorKind::AuthFailed, "Anmeldung abgelehnt: Benutzer oder Passwort falsch."),
        403 => AppError::new(ErrorKind::PermissionDenied, "{0}: keine Berechtigung.").param(what),
        404 | 409 => AppError::new(ErrorKind::NotFound, "{0}: nicht gefunden.").param(what),
        405 | 412 => AppError::new(ErrorKind::AlreadyExists, "{0}: gibt es schon.").param(what),
        423 => AppError::new(ErrorKind::PermissionDenied, "{0}: Datei ist gesperrt.").param(what),
        507 => AppError::other("{0}: kein Speicherplatz mehr auf dem Server.").param(what),
        _ => AppError::other("{0} fehlgeschlagen.").param(what),
    };
    err.with_detail(status.to_string())
}

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;

/// Parses a PROPFIND answer into (path below the base, entry). An answer that is no XML (cut off by
/// a proxy, an error page) is an error: read as an empty folder it would make a comparison offer
/// to upload everything.
fn parse_multistatus(xml: &str, base_path: &str) -> AppResult<Vec<(String, FileEntry)>> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Antwort unvollständig.").with_detail(e.to_string()))?;
    let mut out = Vec::new();
    for resp in doc.descendants().filter(|n| n.tag_name().name() == "response") {
        let Some(href) = resp.descendants().find(|n| n.tag_name().name() == "href").and_then(|n| n.text()) else {
            continue;
        };
        // href may be absolute ("https://host/dav/x") or a path ("/dav/x").
        let path_part = match href.find("://") {
            Some(i) => href[i + 3..].find('/').map(|j| &href[i + 3 + j..]).unwrap_or("/"),
            None => href,
        };
        let decoded = percent_decode_str(path_part).decode_utf8_lossy().into_owned();
        let rel = decoded.strip_prefix(base_path).unwrap_or(&decoded).trim_end_matches('/').to_string();
        let rel = if rel.is_empty() {
            "/".to_string()
        } else if rel.starts_with('/') {
            rel
        } else {
            format!("/{rel}")
        };
        // Only properties with status 200.
        let mut is_dir = false;
        let mut size = 0u64;
        let mut mtime = 0i64;
        for ps in resp.children().filter(|n| n.tag_name().name() == "propstat") {
            let ok = ps
                .children()
                .find(|n| n.tag_name().name() == "status")
                .and_then(|n| n.text())
                .map(|t| t.contains(" 200"))
                .unwrap_or(true);
            if !ok {
                continue;
            }
            for p in ps.descendants() {
                match p.tag_name().name() {
                    "collection" => is_dir = true,
                    "getcontentlength" => size = p.text().and_then(|t| t.trim().parse().ok()).unwrap_or(0),
                    "getlastmodified" => {
                        mtime = p
                            .text()
                            .and_then(|t| chrono::DateTime::parse_from_rfc2822(t.trim()).ok())
                            .map(|d| d.timestamp_millis())
                            .unwrap_or(0)
                    }
                    _ => {}
                }
            }
        }
        let name = if rel == "/" { "/".to_string() } else { remote_name(&rel) };
        out.push((
            rel,
            FileEntry {
                name,
                kind: if is_dir { EntryKind::Dir } else { EntryKind::File },
                size: if is_dir { 0 } else { size },
                mtime,
                perms: if is_dir { "755".into() } else { "644".into() },
                owner: String::new(),
                group: String::new(),
                link: None,
                hidden: 0,
            },
        ));
    }
    Ok(out)
}

impl DavConn {
    pub async fn connect(params: DavParams, known: Arc<KnownHosts>) -> AppResult<DavConn> {
        let url = reqwest::Url::parse(params.url.trim()).map_err(|_| {
            AppError::other(
                "Die WebDAV-Adresse ist ungültig (Beispiel: https://cloud.example/remote.php/dav/files/name).",
            )
        })?;
        let host = url.host_str().unwrap_or_default().to_string();
        let port = url.port_or_known_default().unwrap_or(443);
        let host_id = format!("https://{host}:{port}");
        let (tls, seen) =
            crate::tls::client_config(known.clone(), host_id.clone(), params.trust.clone(), params.tls13_only);
        let mut builder = reqwest::Client::builder()
            .use_preconfigured_tls((*tls).clone())
            .connect_timeout(crate::ssh::connect_timeout(params.timeout))
            .read_timeout(Duration::from_secs(60))
            .user_agent(concat!("Bitcrane/", env!("CARGO_PKG_VERSION")));
        if let Some(p) = &params.proxy {
            let scheme = if p.kind == "http" { "http" } else { "socks5h" };
            let mut proxy = reqwest::Proxy::all(format!("{scheme}://{}:{}", p.host, p.port))
                .map_err(|e| AppError::other("Proxy-Adresse ungültig.").with_detail(e.to_string()))?;
            if let Some(u) = p.user.as_deref().filter(|u| !u.is_empty()) {
                proxy = proxy.basic_auth(u, p.password.as_deref().unwrap_or(""));
            }
            builder = builder.proxy(proxy);
        } else {
            builder = builder.no_proxy();
        }
        let client = builder
            .build()
            .map_err(|e| AppError::other("WebDAV konnte nicht vorbereitet werden.").with_detail(e.to_string()))?;
        let base = url.as_str().trim_end_matches('/').to_string();
        let base_path = percent_decode_str(url.path().trim_end_matches('/')).decode_utf8_lossy().into_owned();
        let conn = DavConn {
            client,
            base,
            base_path,
            user: params.user.clone(),
            password: params.password.clone(),
            home: "/".into(),
        };
        // First request: checks address, certificate and login.
        let resp = conn
            .request(dav_method(b"PROPFIND"), "/")
            .header("Depth", "0")
            .body(PROPFIND_BODY)
            .send()
            .await
            .map_err(|e| net_err(e, Some(&seen), &known, &host_id, &host))?;
        match resp.status().as_u16() {
            207 => Ok(conn),
            401 if params.password.is_none() => {
                Err(AppError::new(ErrorKind::PasswordRequired, "Der Server möchte ein Passwort."))
            }
            401 => Err(status_err(resp.status(), &Message::new("Anmeldung"))),
            404 => Err(AppError::new(ErrorKind::NotFound, "Unter dieser Adresse gibt es keinen WebDAV-Ordner.")),
            405 | 501 => Err(AppError::other("Diese Adresse spricht kein WebDAV.")),
            _ => Err(status_err(resp.status(), &Message::new("Verbinden"))),
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
                AppError::new(ErrorKind::ConnectionLost, "Verbindung zum WebDAV-Server unterbrochen.")
                    .with_detail(e.to_string())
            } else {
                AppError::new(ErrorKind::ConnectionLost, "WebDAV-Anfrage fehlgeschlagen.").with_detail(e.to_string())
            }
        })
    }

    async fn propfind(&self, path: &str, depth: &str) -> AppResult<Vec<(String, FileEntry)>> {
        let dir_path = if depth == "1" && !path.ends_with('/') { format!("{path}/") } else { path.to_string() };
        let resp = self
            .send(
                self.request(dav_method(b"PROPFIND"), &dir_path)
                    .header("Depth", depth)
                    .header("Content-Type", "application/xml")
                    .body(PROPFIND_BODY),
            )
            .await?;
        if resp.status().as_u16() != 207 {
            return Err(status_err(resp.status(), &quoted_name(path)));
        }
        let xml = resp.text().await.map_err(|e| {
            AppError::new(ErrorKind::ConnectionLost, "Antwort unvollständig.").with_detail(e.to_string())
        })?;
        parse_multistatus(&xml, &self.base_path)
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        let me = path.trim_end_matches('/');
        let me = if me.is_empty() { "/" } else { me };
        let mut out: Vec<FileEntry> =
            self.propfind(path, "1").await?.into_iter().filter(|(p, _)| p != me).map(|(_, e)| e).collect();
        crate::model::sort_listing(&mut out);
        Ok(out)
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        let mut all = self.propfind(path, "0").await?;
        let mut e = all
            .pop()
            .map(|(_, e)| e)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, "„{0}“ gibt es nicht.").param(remote_name(path)))?;
        e.name = remote_name(path);
        Ok(e)
    }

    pub async fn exists(&self, path: &str) -> bool {
        self.stat(path).await.is_ok()
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        let resp = self.send(self.request(dav_method(b"MKCOL"), path)).await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(status_err(resp.status(), &Message::new("Ordner „{0}“ anlegen").param(remote_name(path))))
        }
    }

    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        crate::remote::mkdir_levels(
            "",
            path,
            |p| async move { self.exists(&p).await },
            |p| async move { self.mkdir(&p).await },
        )
        .await
    }

    async fn move_or_copy(
        &self,
        method: &'static [u8],
        from: &str,
        to: &str,
        overwrite: bool,
        what: &Message,
    ) -> AppResult<()> {
        let resp = self
            .send(
                self.request(dav_method(method), from)
                    .header("Destination", self.url(to))
                    .header("Overwrite", if overwrite { "T" } else { "F" }),
            )
            .await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(status_err(resp.status(), what))
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        if self.exists(to).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, "„{0}“ gibt es hier schon.").param(remote_name(to)));
        }
        self.move_or_copy(b"MOVE", from, to, false, &Message::new("„{0}“ umbenennen").param(remote_name(from))).await
    }

    pub async fn replace(&self, from: &str, to: &str) -> AppResult<()> {
        self.move_or_copy(b"MOVE", from, to, true, &Message::new("„{0}“ ersetzen").param(remote_name(to))).await
    }

    /// Server-side copy of a file or folder to `to` (WebDAV COPY).
    pub async fn copy_to(&self, from: &str, to: &str) -> AppResult<()> {
        self.move_or_copy(b"COPY", from, to, false, &Message::new("„{0}“ kopieren").param(remote_name(from))).await?;
        Ok(())
    }

    pub async fn remove(&self, path: &str) -> AppResult<()> {
        let resp = self.send(self.request(Method::DELETE, path)).await?;
        if resp.status().is_success() || resp.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(status_err(resp.status(), &Message::new("„{0}“ löschen").param(remote_name(path))))
        }
    }

    pub async fn walk(&self, path: &str) -> AppResult<Vec<WalkItem>> {
        crate::remote::walk_by_listing(
            path,
            |p| async move { self.stat(&p).await },
            |d| async move { self.list(&d).await },
        )
        .await
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
            return Err(status_err(status, &Message::new("„{0}“ lesen").param(remote_name(path))));
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
    pub fn writer(
        &self,
        path: &str,
        size: Option<u64>,
        mtime: Option<u32>,
    ) -> (Box<dyn AsyncWrite + Unpin + Send>, tokio::task::JoinHandle<AppResult<()>>) {
        let (w, r) = tokio::io::duplex(256 * 1024);
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(r));
        let mut req = self.request(Method::PUT, path).body(body);
        if let Some(s) = size {
            req = req.header("Content-Length", s.to_string());
        }
        if let Some(m) = mtime {
            req = req.header("X-OC-MTime", m.to_string());
        }
        let what = Message::new("„{0}“ schreiben").param(remote_name(path));
        let task = tokio::spawn(async move {
            let resp = req.send().await.map_err(|e| {
                AppError::new(ErrorKind::ConnectionLost, "Hochladen abgebrochen.").with_detail(e.to_string())
            })?;
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
        let r = parse_multistatus(xml, "/dav/files/c").unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].0, "/");
        assert_eq!((r[1].0.as_str(), r[1].1.kind), ("/Neuer Ordner", EntryKind::Dir));
        assert_eq!(r[1].1.mtime, 1793102400000);
        assert_eq!((r[2].1.name.as_str(), r[2].1.size), ("über.txt", 42));
        assert!(parse_multistatus(r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:resp"#, "/").is_err());
    }
}

/// Integration test against a WebDAV server (`cargo test -- --ignored`):
/// `BITCRANE_TEST_DAV=http://…,https://…`.
#[cfg(test)]
mod integration {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    #[ignore = "needs a test server: BITCRANE_TEST_DAV"]
    async fn dav_round_trip() {
        let urls = std::env::var("BITCRANE_TEST_DAV").expect("BITCRANE_TEST_DAV=http://…,https://…");
        let dir = tempfile::tempdir().unwrap();
        let known = Arc::new(KnownHosts::load(dir.path().join("known.json")));
        for url in urls.split(',') {
            let params = |trust: Option<String>, password: &str| DavParams {
                url: url.into(),
                user: "test".into(),
                password: Some(password.into()),
                tls13_only: false,
                trust,
                proxy: None,
                timeout: None,
            };
            assert_eq!(
                DavConn::connect(params(None, "falsch"), known.clone())
                    .await
                    .err()
                    .map(|e| e.kind)
                    .filter(|k| *k != ErrorKind::HostKeyUnknown),
                if url.starts_with("https") { None } else { Some(ErrorKind::AuthFailed) }
            );
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
            let names: Vec<String> =
                conn.list(&format!("{base}/a b")).await.unwrap().into_iter().map(|e| e.name).collect();
            assert_eq!(names, vec!["über.txt".to_string()]);
            conn.copy_to(&file, &format!("{base}/a b/über Kopie.txt")).await.unwrap();
            assert!(conn.exists(&format!("{base}/a b/über Kopie.txt")).await);
            conn.rename(&file, &format!("{base}/neu.txt")).await.unwrap();
            assert_eq!(conn.walk(&base).await.unwrap().len(), 2);
            assert_eq!(conn.stat(&format!("{base}/fehlt")).await.err().map(|e| e.kind), Some(ErrorKind::NotFound));
            conn.remove(&base).await.unwrap();
            assert!(!conn.exists(&base).await);
        }
    }
}
