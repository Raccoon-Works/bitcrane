//! Amazon S3 and compatible object storage (Backblaze B2, Cloudflare R2,
//! Wasabi, Hetzner Object Storage, MinIO, Ceph ...), signed with AWS
//! Signature Version 4.
//!
//! Object storage has no real folders. Bitcrane shows the usual view: keys are
//! split at "/", a folder is a common prefix, and "new folder" writes an empty
//! marker object ending in "/". Paths look like everywhere else in Bitcrane:
//! with a fixed bucket "/" is the bucket's root ("/docs/a.txt" = key
//! "docs/a.txt"); without one, "/" lists the buckets and the first path
//! segment is the bucket.
//!
//! Uploads are atomic on S3 (an object appears only when complete), so they go
//! straight to the target; large files use multipart uploads. The original
//! modification time travels as metadata (`x-amz-meta-mtime`, seconds, the
//! convention rclone and others use too).

use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{FileEntry, WalkItem};
use crate::paths::{remote_join, remote_name, remote_parent};
use crate::proxy::ProxyParams;
use crate::ssh::KnownHosts;
use futures_util::TryStreamExt;
use hmac::{Hmac, Mac};
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct S3Params {
    /// Host of the service, optionally with scheme and port, e.g.
    /// "s3.eu-central-1.amazonaws.com" or "http://127.0.0.1:9000".
    pub endpoint: String,
    /// Signing region ("us-east-1" when empty; Cloudflare R2 uses "auto").
    #[serde(default)]
    pub region: String,
    /// Fixed bucket; empty = the bucket list is the root.
    #[serde(default)]
    pub bucket: String,
    /// Access key ID.
    pub access_key: String,
    /// Secret access key (from the keychain).
    #[serde(default)]
    pub secret: Option<String>,
    /// Bucket in the path ("host/bucket/key") instead of the host name
    /// ("bucket.host/key"); needed for MinIO and IP addresses.
    #[serde(default)]
    pub path_style: bool,
    #[serde(default)]
    pub tls13_only: bool,
    #[serde(default)]
    pub trust: Option<String>,
    #[serde(default)]
    pub proxy: Option<ProxyParams>,
}

/// Hash of an empty body (requests without one are signed with it).
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/// Bodies streamed from a file are not hashed in advance (allowed for S3).
const UNSIGNED: &str = "UNSIGNED-PAYLOAD";
/// Smallest part of a multipart upload Bitcrane uses (S3 needs at least 5 MiB).
const MIN_PART: u64 = 16 * 1024 * 1024;
/// S3 allows at most 10,000 parts; keep a margin.
const MAX_PARTS: u64 = 9_500;

/// RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - . _ ~
/// (and "/" in paths when `keep_slash`).
fn uri_encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("any key length");
    m.update(data.as_bytes());
    m.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// One request before signing: method, host, encoded path, query pairs and
/// the headers to sign (lower-case names).
struct Req {
    method: Method,
    host: String,
    path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
}

impl Req {
    /// Query in canonical form (sorted, encoded); used for the URL as well.
    fn canonical_query(&self) -> String {
        let mut q: Vec<(String, String)> = self.query.iter().map(|(k, v)| (uri_encode(k, false), uri_encode(v, false))).collect();
        q.sort();
        q.into_iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&")
    }

    /// AWS Signature Version 4: returns the Authorization header value.
    fn authorization(&self, access_key: &str, secret: &str, region: &str, amz_date: &str, payload: &str) -> String {
        let mut headers: Vec<(String, String)> = self.headers.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string())).collect();
        headers.push(("host".into(), self.host.clone()));
        headers.sort();
        let signed: String = headers.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
        let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
        let canonical = format!("{}\n{}\n{}\n{}\n{}\n{}", self.method.as_str(), self.path, self.canonical_query(), canonical_headers, signed, payload);
        let date = &amz_date[..8];
        let scope = format!("{date}/{region}/s3/aws4_request");
        let to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hex(&Sha256::digest(canonical.as_bytes())));
        let k_date = hmac(format!("AWS4{secret}").as_bytes(), date);
        let k_region = hmac(&k_date, region);
        let k_service = hmac(&k_region, "s3");
        let k_signing = hmac(&k_service, "aws4_request");
        let signature = hex(&hmac(&k_signing, &to_sign));
        format!("AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed}, Signature={signature}")
    }
}

/// Text of an S3 error answer (<Error><Code>…</Code><Message>…</Message>).
fn error_code(xml: &str) -> (String, String) {
    let Ok(doc) = roxmltree::Document::parse(xml) else { return (String::new(), String::new()) };
    let get = |n: &str| doc.descendants().find(|x| x.tag_name().name() == n).and_then(|x| x.text()).unwrap_or("").to_string();
    (get("Code"), get("Message"))
}

fn status_err(status: StatusCode, body: &str, what: &str) -> AppError {
    let (code, message) = error_code(body);
    let detail = if code.is_empty() { status.to_string() } else { format!("{status} {code}: {message}") };
    let (kind, msg) = match (status.as_u16(), code.as_str()) {
        (_, "InvalidAccessKeyId") => (ErrorKind::AuthFailed, "Anmeldung abgelehnt: Diesen Zugriffsschlüssel kennt der Dienst nicht.".to_string()),
        (_, "SignatureDoesNotMatch") => (ErrorKind::AuthFailed, "Anmeldung abgelehnt: Der geheime Schlüssel passt nicht.".to_string()),
        (_, "NoSuchBucket") => (ErrorKind::NotFound, "Diesen Bucket gibt es nicht.".to_string()),
        (_, "NoSuchKey") | (404, _) => (ErrorKind::NotFound, format!("{what}: nicht gefunden.")),
        (301, _) | (_, "PermanentRedirect") | (_, "AuthorizationHeaderMalformed") => (ErrorKind::Other, "Der Bucket liegt in einer anderen Region. Bitte die Region in den Server-Einstellungen prüfen.".to_string()),
        (403, "AccessDenied") | (403, _) => (ErrorKind::PermissionDenied, format!("{what}: keine Berechtigung.")),
        (409, "BucketAlreadyExists") | (409, "BucketAlreadyOwnedByYou") => (ErrorKind::AlreadyExists, "Diesen Bucket-Namen gibt es schon.".to_string()),
        (_, "EntityTooLarge") => (ErrorKind::Other, format!("{what}: Die Datei ist für diesen Dienst zu groß.")),
        (_, "QuotaExceeded") | (_, "StorageQuotaExceeded") => (ErrorKind::Other, format!("{what}: kein Speicherplatz mehr.")),
        _ => (ErrorKind::Other, format!("{what} fehlgeschlagen.")),
    };
    AppError::new(kind, msg).with_detail(detail)
}

fn net_err(e: reqwest::Error) -> AppError {
    if e.is_timeout() {
        return AppError::new(ErrorKind::Unreachable, "Der Speicherdienst antwortet nicht (Zeitüberschreitung).").with_detail(e.to_string());
    }
    if e.is_connect() {
        return AppError::new(ErrorKind::Unreachable, "Speicherdienst nicht erreichbar.").with_detail(e.to_string());
    }
    AppError::new(ErrorKind::ConnectionLost, "Verbindung zum Speicherdienst unterbrochen.").with_detail(e.to_string())
}

/// Seconds of `x-amz-meta-mtime`, else Last-Modified, as milliseconds.
fn mtime_of(headers: &reqwest::header::HeaderMap) -> i64 {
    if let Some(s) = headers.get("x-amz-meta-mtime").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<f64>().ok()) {
        return (s * 1000.0) as i64;
    }
    headers.get("last-modified").and_then(|v| v.to_str().ok()).and_then(|t| chrono::DateTime::parse_from_rfc2822(t.trim()).ok()).map(|d| d.timestamp_millis()).unwrap_or(0)
}

fn entry(name: String, dir: bool, size: u64, mtime: i64) -> FileEntry {
    FileEntry { name, kind: if dir { "dir".into() } else { "file".into() }, size: if dir { 0 } else { size }, mtime, perms: if dir { "755".into() } else { "644".into() }, owner: String::new(), group: String::new(), link: None, hidden: 0 }
}

/// One page of ListObjectsV2: files (key, size, time) and folders (prefixes).
struct Listing {
    files: Vec<(String, u64, i64)>,
    prefixes: Vec<String>,
    next: Option<String>,
}

fn parse_listing(xml: &str) -> Listing {
    let mut out = Listing { files: Vec::new(), prefixes: Vec::new(), next: None };
    let Ok(doc) = roxmltree::Document::parse(xml) else { return out };
    let text = |n: roxmltree::Node, tag: &str| n.children().find(|c| c.tag_name().name() == tag).and_then(|c| c.text()).unwrap_or("").to_string();
    let root = doc.root_element();
    for c in root.children().filter(|c| c.is_element()) {
        match c.tag_name().name() {
            "Contents" => {
                let mtime = chrono::DateTime::parse_from_rfc3339(&text(c, "LastModified")).map(|d| d.timestamp_millis()).unwrap_or(0);
                out.files.push((text(c, "Key"), text(c, "Size").parse().unwrap_or(0), mtime));
            }
            "CommonPrefixes" => out.prefixes.push(text(c, "Prefix")),
            _ => {}
        }
    }
    if text(root, "IsTruncated") == "true" {
        out.next = Some(text(root, "NextContinuationToken")).filter(|t| !t.is_empty());
    }
    out
}

fn parse_buckets(xml: &str) -> Vec<(String, i64)> {
    let Ok(doc) = roxmltree::Document::parse(xml) else { return Vec::new() };
    doc.descendants()
        .filter(|n| n.tag_name().name() == "Bucket")
        .filter_map(|b| {
            let name = b.children().find(|c| c.tag_name().name() == "Name")?.text()?.to_string();
            let created = b.children().find(|c| c.tag_name().name() == "CreationDate").and_then(|c| c.text()).and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|d| d.timestamp_millis()).unwrap_or(0);
            Some((name, created))
        })
        .collect()
}

pub struct S3Conn {
    client: reqwest::Client,
    /// "https" or "http".
    scheme: String,
    /// Host with port when not the default one.
    host: String,
    region: String,
    bucket: Option<String>,
    access_key: String,
    secret: String,
    path_style: bool,
    pub home: String,
}

impl S3Conn {
    pub async fn connect(params: S3Params, known: Arc<KnownHosts>) -> AppResult<S3Conn> {
        let raw = params.endpoint.trim().trim_end_matches('/');
        if raw.is_empty() {
            return Err(AppError::other("Bitte den Endpunkt des Speicherdienstes angeben (z. B. s3.eu-central-1.amazonaws.com)."));
        }
        let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("https://{raw}") };
        let url = reqwest::Url::parse(&with_scheme).map_err(|_| AppError::other("Der Endpunkt ist ungültig (Beispiel: s3.eu-central-1.amazonaws.com)."))?;
        let scheme = url.scheme().to_string();
        let host_name = url.host_str().unwrap_or_default().to_string();
        let host = match url.port() {
            Some(p) => format!("{host_name}:{p}"),
            None => host_name.clone(),
        };
        let Some(secret) = params.secret.clone().filter(|s| !s.is_empty()) else {
            return Err(AppError::new(ErrorKind::PasswordRequired, "Der geheime Zugriffsschlüssel fehlt."));
        };
        let port = url.port_or_known_default().unwrap_or(443);
        let host_id = format!("https://{host_name}:{port}");
        let (tls, _seen) = crate::tls::client_config(known.clone(), host_id, params.trust.clone(), params.tls13_only);
        let mut builder = reqwest::Client::builder()
            .use_preconfigured_tls((*tls).clone())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(120))
            .user_agent(concat!("Bitcrane/", env!("CARGO_PKG_VERSION")));
        if let Some(p) = &params.proxy {
            let kind = if p.kind == "http" { "http" } else { "socks5h" };
            let mut proxy = reqwest::Proxy::all(format!("{kind}://{}:{}", p.host, p.port)).map_err(|e| AppError::other("Proxy-Adresse ungültig.").with_detail(e.to_string()))?;
            if let Some(u) = p.user.as_deref().filter(|u| !u.is_empty()) {
                proxy = proxy.basic_auth(u, p.password.as_deref().unwrap_or(""));
            }
            builder = builder.proxy(proxy);
        } else {
            builder = builder.no_proxy();
        }
        let client = builder.build().map_err(|e| AppError::other("Der Speicherdienst konnte nicht vorbereitet werden.").with_detail(e.to_string()))?;
        // An IP address or "localhost" cannot carry the bucket in the host name.
        let path_style = params.path_style || host_name.parse::<std::net::IpAddr>().is_ok() || host_name == "localhost";
        let region = if params.region.trim().is_empty() { "us-east-1".to_string() } else { params.region.trim().to_string() };
        let bucket = Some(params.bucket.trim().trim_matches('/').to_string()).filter(|b| !b.is_empty());
        let conn = S3Conn { client, scheme, host, region, bucket, access_key: params.access_key.trim().to_string(), secret, path_style, home: "/".into() };
        // First request: checks endpoint, keys and (with a fixed bucket) the bucket.
        match &conn.bucket {
            Some(b) => {
                conn.list_page(b, "", Some("/"), None, Some(1)).await?;
            }
            None => {
                conn.buckets().await?;
            }
        }
        Ok(conn)
    }

    /// Bucket and key of a Bitcrane path ("" key = the bucket's root).
    fn split(&self, path: &str) -> (Option<String>, String) {
        let p = path.trim_start_matches('/');
        match &self.bucket {
            Some(b) => (Some(b.clone()), p.to_string()),
            None => {
                let (b, k) = p.split_once('/').unwrap_or((p, ""));
                (Some(b.to_string()).filter(|b| !b.is_empty()), k.to_string())
            }
        }
    }

    /// Request for a bucket (None = the service) and key.
    fn req(&self, method: Method, bucket: Option<&str>, key: &str) -> Req {
        let enc_key = uri_encode(key, true);
        let (host, path) = match bucket {
            None => (self.host.clone(), "/".to_string()),
            Some(b) if self.path_style => (self.host.clone(), format!("/{}/{}", uri_encode(b, false), enc_key)),
            Some(b) => (format!("{b}.{}", self.host), format!("/{enc_key}")),
        };
        Req { method, host, path, query: Vec::new(), headers: Vec::new() }
    }

    /// Signs and builds the reqwest request.
    fn build(&self, r: &Req, payload: &str) -> reqwest::RequestBuilder {
        let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let mut signed = Req { method: r.method.clone(), host: r.host.clone(), path: r.path.clone(), query: r.query.clone(), headers: r.headers.clone() };
        signed.headers.push(("x-amz-date".into(), amz_date.clone()));
        signed.headers.push(("x-amz-content-sha256".into(), payload.into()));
        let auth = signed.authorization(&self.access_key, &self.secret, &self.region, &amz_date, payload);
        let q = r.canonical_query();
        let url = format!("{}://{}{}{}", self.scheme, r.host, r.path, if q.is_empty() { String::new() } else { format!("?{q}") });
        let mut b = self.client.request(r.method.clone(), url);
        for (k, v) in &signed.headers {
            b = b.header(k.as_str(), v.as_str());
        }
        b.header("Authorization", auth)
    }

    async fn send(&self, r: &Req, what: &str) -> AppResult<reqwest::Response> {
        let resp = self.build(r, EMPTY_SHA256).send().await.map_err(net_err)?;
        if resp.status().is_success() {
            return Ok(resp);
        }
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(status_err(status, &body, what))
    }

    async fn buckets(&self) -> AppResult<Vec<(String, i64)>> {
        let r = self.req(Method::GET, None, "");
        let body = self.send(&r, "Buckets lesen").await?.text().await.map_err(net_err)?;
        Ok(parse_buckets(&body))
    }

    async fn list_page(&self, bucket: &str, prefix: &str, delimiter: Option<&str>, token: Option<&str>, max: Option<u32>) -> AppResult<Listing> {
        let mut r = self.req(Method::GET, Some(bucket), "");
        r.query.push(("list-type".into(), "2".into()));
        r.query.push(("prefix".into(), prefix.into()));
        if let Some(d) = delimiter {
            r.query.push(("delimiter".into(), d.into()));
        }
        if let Some(t) = token {
            r.query.push(("continuation-token".into(), t.into()));
        }
        if let Some(m) = max {
            r.query.push(("max-keys".into(), m.to_string()));
        }
        let body = self.send(&r, "Ordner lesen").await?.text().await.map_err(net_err)?;
        Ok(parse_listing(&body))
    }

    /// Every object below a prefix (all pages).
    async fn list_all(&self, bucket: &str, prefix: &str) -> AppResult<Vec<(String, u64, i64)>> {
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let page = self.list_page(bucket, prefix, None, token.as_deref(), None).await?;
            out.extend(page.files);
            match page.next {
                Some(t) => token = Some(t),
                None => return Ok(out),
            }
        }
    }

    fn dir_prefix(key: &str) -> String {
        let k = key.trim_matches('/');
        if k.is_empty() {
            String::new()
        } else {
            format!("{k}/")
        }
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        let (bucket, key) = self.split(path);
        let Some(bucket) = bucket else {
            return Ok(self.buckets().await?.into_iter().map(|(n, t)| entry(n, true, 0, t)).collect());
        };
        let prefix = Self::dir_prefix(&key);
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let page = self.list_page(&bucket, &prefix, Some("/"), token.as_deref(), None).await?;
            for p in page.prefixes {
                let name = p.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
                if !name.is_empty() {
                    out.push(entry(name, true, 0, 0));
                }
            }
            for (k, size, mtime) in page.files {
                // The folder's own marker object ("docs/") is not an entry.
                let name = k.strip_prefix(&prefix).unwrap_or(&k).to_string();
                if !name.is_empty() && !name.contains('/') {
                    out.push(entry(name, false, size, mtime));
                }
            }
            match page.next {
                Some(t) => token = Some(t),
                None => break,
            }
        }
        out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
            ("dir", "file") => std::cmp::Ordering::Less,
            ("file", "dir") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        let (bucket, key) = self.split(path);
        let name = if path.trim_matches('/').is_empty() { "/".to_string() } else { remote_name(path) };
        let Some(bucket) = bucket else { return Ok(entry(name, true, 0, 0)) };
        let key = key.trim_end_matches('/').to_string();
        if key.is_empty() {
            // A bucket: exists when it can be listed.
            self.list_page(&bucket, "", Some("/"), None, Some(1)).await?;
            return Ok(entry(name, true, 0, 0));
        }
        let r = self.req(Method::HEAD, Some(&bucket), &key);
        let resp = self.build(&r, EMPTY_SHA256).send().await.map_err(net_err)?;
        if resp.status().is_success() {
            let size = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
            return Ok(entry(name, false, size, mtime_of(resp.headers())));
        }
        if resp.status() != StatusCode::NOT_FOUND {
            return Err(status_err(resp.status(), "", &format!("„{name}“")));
        }
        // No object: a folder when anything lies below it.
        let page = self.list_page(&bucket, &Self::dir_prefix(&key), Some("/"), None, Some(1)).await?;
        if !page.files.is_empty() || !page.prefixes.is_empty() {
            return Ok(entry(name, true, 0, 0));
        }
        Err(AppError::new(ErrorKind::NotFound, format!("„{name}“ gibt es nicht.")))
    }

    pub async fn exists(&self, path: &str) -> bool {
        self.stat(path).await.is_ok()
    }

    /// A folder is an empty marker object "name/"; at the top without a fixed
    /// bucket it is a new bucket.
    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        let (bucket, key) = self.split(path);
        let Some(bucket) = bucket else { return Err(AppError::other("Hier kann kein Ordner angelegt werden.")) };
        if key.trim_matches('/').is_empty() {
            let mut r = self.req(Method::PUT, Some(&bucket), "");
            let region = self.region.as_str();
            // us-east-1 (and R2's "auto") take no location; elsewhere it must be named.
            let body = if region == "us-east-1" || region == "auto" { String::new() } else { format!("<CreateBucketConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><LocationConstraint>{region}</LocationConstraint></CreateBucketConfiguration>") };
            r.headers.push(("content-length".into(), body.len().to_string()));
            let resp = self.build(&r, UNSIGNED).body(body).send().await.map_err(net_err)?;
            if resp.status().is_success() {
                return Ok(());
            }
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(status_err(status, &text, &format!("Bucket „{bucket}“ anlegen")));
        }
        let r = self.req(Method::PUT, Some(&bucket), &Self::dir_prefix(&key));
        let resp = self.build(&r, EMPTY_SHA256).header("content-length", "0").send().await.map_err(net_err)?;
        if resp.status().is_success() {
            Ok(())
        } else {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            Err(status_err(status, &text, &format!("Ordner „{}“ anlegen", remote_name(path))))
        }
    }

    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        // Objects need no parent folders; only the last one gets a marker so it shows when empty.
        if self.exists(path).await {
            return Ok(());
        }
        self.mkdir(path).await
    }

    async fn delete_key(&self, bucket: &str, key: &str) -> AppResult<()> {
        let r = self.req(Method::DELETE, Some(bucket), key);
        let resp = self.build(&r, EMPTY_SHA256).send().await.map_err(net_err)?;
        if resp.status().is_success() || resp.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            Err(status_err(status, &text, &format!("„{}“ löschen", remote_name(key))))
        }
    }

    /// Server-side copy of one object (keeps its metadata, e.g. the mtime).
    async fn copy_key(&self, bucket: &str, from: &str, to: &str) -> AppResult<()> {
        let mut r = self.req(Method::PUT, Some(bucket), to);
        r.headers.push(("x-amz-copy-source".into(), format!("/{}/{}", uri_encode(bucket, false), uri_encode(from, true))));
        let resp = self.build(&r, EMPTY_SHA256).header("content-length", "0").send().await.map_err(net_err)?;
        let status = resp.status();
        // A copy can fail inside a 200 answer.
        let text = resp.text().await.unwrap_or_default();
        if status.is_success() && !text.contains("<Error>") {
            Ok(())
        } else {
            Err(status_err(if status.is_success() { StatusCode::INTERNAL_SERVER_ERROR } else { status }, &text, &format!("„{}“ kopieren", remote_name(from))))
        }
    }

    pub async fn remove(&self, path: &str) -> AppResult<()> {
        let (bucket, key) = self.split(path);
        let Some(bucket) = bucket else { return Err(AppError::other("Das geht hier nicht.")) };
        let key = key.trim_end_matches('/').to_string();
        if key.is_empty() {
            return Err(AppError::other("Buckets löschst du in der Verwaltung deines Speicherdienstes."));
        }
        let e = self.stat(path).await?;
        if e.kind == "file" {
            return self.delete_key(&bucket, &key).await;
        }
        let prefix = Self::dir_prefix(&key);
        let mut keys: Vec<String> = self.list_all(&bucket, &prefix).await?.into_iter().map(|(k, _, _)| k).collect();
        if !keys.contains(&prefix) {
            keys.push(prefix);
        }
        // Eight at a time; S3 has no "delete folder".
        for chunk in keys.chunks(8) {
            let mut futs = Vec::with_capacity(chunk.len());
            for k in chunk {
                futs.push(self.delete_key(&bucket, k));
            }
            for r in futures_util::future::join_all(futs).await {
                r?;
            }
        }
        Ok(())
    }

    /// Moves a file or a whole folder (copy, then delete; S3 has no rename).
    async fn move_path(&self, from: &str, to: &str) -> AppResult<()> {
        let (fb, fk) = self.split(from);
        let (tb, tk) = self.split(to);
        let (Some(fb), Some(tb)) = (fb, tb) else { return Err(AppError::other("Buckets lassen sich nicht umbenennen.")) };
        if fb != tb || fk.trim_matches('/').is_empty() || tk.trim_matches('/').is_empty() {
            return Err(AppError::other("Verschieben geht nur innerhalb eines Buckets."));
        }
        let e = self.stat(from).await?;
        if e.kind == "file" {
            self.copy_key(&fb, &fk, &tk).await?;
            return self.delete_key(&fb, &fk).await;
        }
        let (fp, tp) = (Self::dir_prefix(&fk), Self::dir_prefix(&tk));
        for (k, _, _) in self.list_all(&fb, &fp).await? {
            let rest = k.strip_prefix(&fp).unwrap_or(&k);
            self.copy_key(&fb, &k, &format!("{tp}{rest}")).await?;
        }
        self.remove(from).await
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        if self.exists(to).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("„{}“ gibt es hier schon.", remote_name(to))));
        }
        self.move_path(from, to).await
    }

    pub async fn replace(&self, from: &str, to: &str) -> AppResult<()> {
        self.move_path(from, to).await
    }

    pub async fn copy_within(&self, paths: &[String], dest_dir: &str) -> AppResult<Vec<String>> {
        let mut taken: std::collections::HashSet<String> = self.list(dest_dir).await?.into_iter().map(|e| e.name).collect();
        let mut out = Vec::new();
        for from in paths {
            if dest_dir == from.as_str() || dest_dir.starts_with(&format!("{from}/")) {
                return Err(AppError::other("Ein Ordner kann nicht in sich selbst kopiert werden."));
            }
            let name = crate::local::copy_name(|n| taken.contains(n), &remote_name(from));
            let to = remote_join(dest_dir, &name);
            let (fb, fk) = self.split(from);
            let (tb, tk) = self.split(&to);
            let (Some(fb), Some(tb)) = (fb, tb) else { return Err(AppError::other("Buckets lassen sich nicht kopieren.")) };
            if fb != tb {
                return Err(AppError::other("Kopieren auf dem Server geht nur innerhalb eines Buckets."));
            }
            if self.stat(from).await?.kind == "file" {
                self.copy_key(&fb, &fk, &tk).await?;
            } else {
                let (fp, tp) = (Self::dir_prefix(&fk), Self::dir_prefix(&tk));
                for (k, _, _) in self.list_all(&fb, &fp).await? {
                    let rest = k.strip_prefix(&fp).unwrap_or(&k);
                    self.copy_key(&fb, &k, &format!("{tp}{rest}")).await?;
                }
            }
            taken.insert(name.clone());
            out.push(name);
        }
        Ok(out)
    }

    pub async fn walk(&self, path: &str) -> AppResult<Vec<WalkItem>> {
        let base = remote_parent(path);
        let rel = |p: &str| p.strip_prefix(&base).unwrap_or(p).trim_start_matches('/').to_string();
        let root = self.stat(path).await?;
        if root.kind != "dir" {
            return Ok(vec![WalkItem { path: path.to_string(), relative: rel(path), size: root.size, mtime: root.mtime }]);
        }
        let (bucket, key) = self.split(path);
        let Some(bucket) = bucket else { return Err(AppError::other("Bitte zuerst einen Bucket öffnen.")) };
        let prefix = Self::dir_prefix(&key);
        let top = path.trim_end_matches('/');
        let mut out = Vec::new();
        for (k, size, mtime) in self.list_all(&bucket, &prefix).await? {
            let rest = k.strip_prefix(&prefix).unwrap_or(&k);
            if rest.is_empty() || rest.ends_with('/') {
                continue;
            }
            let p = format!("{top}/{rest}");
            out.push(WalkItem { relative: rel(&p), path: p, size, mtime });
        }
        Ok(out)
    }

    /// Reads an object from `offset` (HTTP Range).
    pub async fn reader(&self, path: &str, offset: u64) -> AppResult<Box<dyn AsyncRead + Unpin + Send>> {
        let (bucket, key) = self.split(path);
        let Some(bucket) = bucket else { return Err(AppError::other("Das ist keine Datei.")) };
        let r = self.req(Method::GET, Some(&bucket), &key);
        let mut b = self.build(&r, EMPTY_SHA256);
        if offset > 0 {
            b = b.header("Range", format!("bytes={offset}-"));
        }
        let resp = b.send().await.map_err(net_err)?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(status_err(status, &text, &format!("„{}“ lesen", remote_name(path))));
        }
        if offset > 0 && status != StatusCode::PARTIAL_CONTENT {
            return Err(AppError::other("Der Dienst kann nicht an einer Stelle weiterlesen.").with_detail("no-range"));
        }
        let stream = resp.bytes_stream().map_err(|e| std::io::Error::other(e.to_string()));
        Ok(Box::new(tokio_util::io::StreamReader::new(stream)))
    }

    /// Writes an object. Small files go up in one request; from the first
    /// full part on it becomes a multipart upload (parts sized so even very
    /// large files stay below S3's 10,000 parts). The returned task finishes
    /// the upload; if it fails, a started multipart upload is aborted so no
    /// invisible parts are left (and billed).
    pub fn writer(self: &Arc<Self>, path: &str, size: Option<u64>, mtime: Option<u32>) -> (Box<dyn AsyncWrite + Unpin + Send>, tokio::task::JoinHandle<AppResult<()>>) {
        let (w, r) = tokio::io::duplex(1024 * 1024);
        let me = self.clone();
        let path = path.to_string();
        let part_size = size.map(|s| (s.div_ceil(MAX_PARTS)).max(MIN_PART)).unwrap_or(MIN_PART);
        let task = tokio::spawn(async move { me.upload(r, &path, part_size, mtime).await });
        (Box::new(w), task)
    }

    async fn read_part(r: &mut (impl AsyncRead + Unpin), size: u64) -> AppResult<Vec<u8>> {
        let mut buf = Vec::with_capacity(size.min(64 * 1024 * 1024) as usize);
        (&mut *r).take(size).read_to_end(&mut buf).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Hochladen abgebrochen.").with_detail(e.to_string()))?;
        Ok(buf)
    }

    async fn upload(&self, mut r: tokio::io::DuplexStream, path: &str, part_size: u64, mtime: Option<u32>) -> AppResult<()> {
        let (bucket, key) = self.split(path);
        let Some(bucket) = bucket else { return Err(AppError::other("Dateien gehören in einen Bucket.")) };
        let what = format!("„{}“ schreiben", remote_name(path));
        let meta: Vec<(String, String)> = mtime.map(|m| vec![("x-amz-meta-mtime".to_string(), m.to_string())]).unwrap_or_default();
        let first = Self::read_part(&mut r, part_size).await?;
        if (first.len() as u64) < part_size {
            // Everything fits into one request.
            let mut req = self.req(Method::PUT, Some(&bucket), &key);
            req.headers.extend(meta);
            let resp = self.build(&req, UNSIGNED).header("content-length", first.len().to_string()).body(first).send().await.map_err(net_err)?;
            if resp.status().is_success() {
                return Ok(());
            }
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(status_err(status, &text, &what));
        }
        // Multipart: start, parts, complete.
        let mut start = self.req(Method::POST, Some(&bucket), &key);
        start.query.push(("uploads".into(), String::new()));
        start.headers.extend(meta);
        let body = self.send(&start, &what).await?.text().await.map_err(net_err)?;
        let upload_id = roxmltree::Document::parse(&body).ok().and_then(|d| d.descendants().find(|n| n.tag_name().name() == "UploadId").and_then(|n| n.text()).map(str::to_string));
        let Some(upload_id) = upload_id else { return Err(AppError::other(format!("{what} fehlgeschlagen.")).with_detail(body)) };
        let result: AppResult<()> = async {
            let mut etags: Vec<String> = Vec::new();
            let mut part = first;
            loop {
                let n = etags.len() + 1;
                let mut req = self.req(Method::PUT, Some(&bucket), &key);
                req.query.push(("partNumber".into(), n.to_string()));
                req.query.push(("uploadId".into(), upload_id.clone()));
                let len = part.len();
                let resp = self.build(&req, UNSIGNED).header("content-length", len.to_string()).body(part).send().await.map_err(net_err)?;
                if !resp.status().is_success() {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    return Err(status_err(status, &text, &what));
                }
                let etag = resp.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                etags.push(etag);
                part = Self::read_part(&mut r, part_size).await?;
                if part.is_empty() {
                    break;
                }
            }
            let mut xml = String::from("<CompleteMultipartUpload>");
            for (i, e) in etags.iter().enumerate() {
                xml.push_str(&format!("<Part><PartNumber>{}</PartNumber><ETag>{}</ETag></Part>", i + 1, e.replace('&', "&amp;").replace('<', "&lt;")));
            }
            xml.push_str("</CompleteMultipartUpload>");
            let mut done = self.req(Method::POST, Some(&bucket), &key);
            done.query.push(("uploadId".into(), upload_id.clone()));
            let resp = self.build(&done, UNSIGNED).header("content-length", xml.len().to_string()).body(xml).send().await.map_err(net_err)?;
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            // Completing can fail inside a 200 answer as well.
            if status.is_success() && !text.contains("<Error>") {
                Ok(())
            } else {
                Err(status_err(if status.is_success() { StatusCode::INTERNAL_SERVER_ERROR } else { status }, &text, &what))
            }
        }
        .await;
        if result.is_err() {
            let mut abort = self.req(Method::DELETE, Some(&bucket), &key);
            abort.query.push(("uploadId".into(), upload_id));
            let _ = self.build(&abort, EMPTY_SHA256).send().await;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The example "GET Object" from the AWS Signature Version 4 documentation.
    #[test]
    fn signs_like_aws() {
        let r = Req {
            method: Method::GET,
            host: "examplebucket.s3.amazonaws.com".into(),
            path: "/test.txt".into(),
            query: Vec::new(),
            headers: vec![("range".into(), "bytes=0-9".into()), ("x-amz-content-sha256".into(), EMPTY_SHA256.into()), ("x-amz-date".into(), "20130524T000000Z".into())],
        };
        let auth = r.authorization("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", "20130524T000000Z", EMPTY_SHA256);
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    /// The example "GET Bucket Lifecycle" (a query parameter without value).
    #[test]
    fn signs_query_like_aws() {
        let r = Req {
            method: Method::GET,
            host: "examplebucket.s3.amazonaws.com".into(),
            path: "/".into(),
            query: vec![("lifecycle".into(), String::new())],
            headers: vec![("x-amz-content-sha256".into(), EMPTY_SHA256.into()), ("x-amz-date".into(), "20130524T000000Z".into())],
        };
        let auth = r.authorization("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", "20130524T000000Z", EMPTY_SHA256);
        assert!(auth.ends_with("Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"), "{auth}");
    }

    #[test]
    fn encodes_keys() {
        assert_eq!(uri_encode("a b/ü+x.txt", true), "a%20b/%C3%BC%2Bx.txt");
        assert_eq!(uri_encode("a/b", false), "a%2Fb");
    }

    #[test]
    fn parses_listings() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
          <IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken>
          <Contents><Key>docs/</Key><Size>0</Size><LastModified>2026-10-30T12:00:00.000Z</LastModified></Contents>
          <Contents><Key>docs/a.txt</Key><Size>42</Size><LastModified>2026-10-30T12:00:00.000Z</LastModified></Contents>
          <CommonPrefixes><Prefix>docs/sub/</Prefix></CommonPrefixes></ListBucketResult>"#;
        let l = parse_listing(xml);
        assert_eq!(l.files.len(), 2);
        assert_eq!(l.files[1], ("docs/a.txt".to_string(), 42, 1793361600000));
        assert_eq!(l.prefixes, vec!["docs/sub/".to_string()]);
        assert_eq!(l.next.as_deref(), Some("tok"));
        let b = parse_buckets(r#"<ListAllMyBucketsResult><Buckets><Bucket><Name>fotos</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>"#);
        assert_eq!(b[0].0, "fotos");
    }
}

/// Integration test against an S3-compatible server: `BITCRANE_TEST_S3=http://127.0.0.1:9000`
/// (e.g. moto_server; any access key and secret).
#[cfg(test)]
mod integration {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn s3_round_trip() {
        let Ok(endpoint) = std::env::var("BITCRANE_TEST_S3") else { return };
        let dir = tempfile::tempdir().unwrap();
        let known = Arc::new(KnownHosts::load(dir.path().join("known.json")));
        let params = |bucket: &str| S3Params { endpoint: endpoint.clone(), region: "eu-central-1".into(), bucket: bucket.into(), access_key: "test".into(), secret: Some("geheim".into()), path_style: true, tls13_only: false, trust: None, proxy: None };
        let bucket = format!("bitcrane-{}", uuid::Uuid::new_v4().simple());
        let root = Arc::new(S3Conn::connect(params(""), known.clone()).await.unwrap());
        root.mkdir(&format!("/{bucket}")).await.unwrap();
        assert!(root.list("/").await.unwrap().iter().any(|e| e.name == bucket));
        let conn = Arc::new(S3Conn::connect(params(&bucket), known.clone()).await.unwrap());
        conn.mkdir_all("/a b").await.unwrap();
        assert_eq!(conn.list("/").await.unwrap().iter().map(|e| (e.name.as_str(), e.kind.as_str())).collect::<Vec<_>>(), vec![("a b", "dir")]);
        // Small file with mtime.
        let file = "/a b/über.txt";
        let (mut w, task) = conn.writer(file, Some(11), Some(1_700_000_000));
        w.write_all(b"hallo welt!").await.unwrap();
        w.shutdown().await.unwrap();
        drop(w);
        task.await.unwrap().unwrap();
        let st = conn.stat(file).await.unwrap();
        assert_eq!((st.size, st.mtime), (11, 1_700_000_000_000));
        let mut r = conn.reader(file, 6).await.unwrap();
        let mut got = String::new();
        r.read_to_string(&mut got).await.unwrap();
        assert_eq!(got, "welt!");
        // Large file: multipart (two parts plus a tail).
        let big: Vec<u8> = (0..(MIN_PART * 2 + 1234)).map(|i| (i % 251) as u8).collect();
        let (mut w, task) = conn.writer("/a b/gross.bin", None, None);
        w.write_all(&big).await.unwrap();
        w.shutdown().await.unwrap();
        drop(w);
        task.await.unwrap().unwrap();
        let mut back = Vec::new();
        conn.reader("/a b/gross.bin", 0).await.unwrap().read_to_end(&mut back).await.unwrap();
        assert!(back == big, "multipart content");
        // Copy, rename (folder), walk, remove.
        assert_eq!(conn.copy_within(&[file.to_string()], "/a b").await.unwrap(), vec!["über Kopie.txt".to_string()]);
        conn.rename("/a b", "/neu").await.unwrap();
        assert!(!conn.exists("/a b").await);
        assert_eq!(conn.walk("/neu").await.unwrap().len(), 3);
        assert_eq!(conn.stat("/fehlt").await.err().map(|e| e.kind), Some(ErrorKind::NotFound));
        conn.remove("/neu").await.unwrap();
        assert!(conn.list("/").await.unwrap().is_empty());
    }
}
