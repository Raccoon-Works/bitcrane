//! Cryptomator vaults (vault format 8, cipher combo SIV_GCM), on this computer
//! or on any server. An unlocked vault behaves like a server of its own: the
//! halves show the decrypted names, transfers encrypt and decrypt on the fly.
//!
//! The format, as documented at docs.cryptomator.org:
//! - `masterkey.cryptomator`: two 256-bit keys, wrapped (RFC 3394) with a key
//!   derived from the password by scrypt.
//! - `vault.cryptomator`: a JWT signed with both keys (HS256), holding the
//!   format and the name length limit.
//! - Folders get a random id. A folder's contents live in `d/XX/YYYY…`, the
//!   Base32 SHA-1 of the AES-SIV encrypted id.
//! - Names: AES-SIV with the parent id as associated data, Base64url, `.c9r`.
//!   Names longer than the limit become `<sha1>.c9s` folders that keep the
//!   full name in `name.c9s` (and a file's content in `contents.c9r`).
//! - Contents: a 68-byte header (AES-GCM encrypted content key), then 32 KiB
//!   chunks, each AES-GCM with its own nonce and the chunk number plus header
//!   nonce as associated data.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{FileEntry, WalkItem};
use crate::paths::{remote_join, remote_name, remote_parent, to_native};
use crate::remote::{Remote, RemoteWriter};
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use aes_kw::KekAes256;
use aes_siv::siv::Aes256Siv;
use data_encoding::{BASE32, BASE64, BASE64URL, BASE64URL_NOPAD};
use hmac::{Hmac, Mac};
use rand::RngExt;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use unicode_normalization::UnicodeNormalization;

type Connections = Arc<tokio::sync::Mutex<HashMap<String, Arc<Remote>>>>;

const HEADER: usize = 68;
const CHUNK: usize = 32 * 1024;
const CHUNK_CIPHER: usize = CHUNK + 28;
const DEFAULT_THRESHOLD: usize = 220;

fn bad_vault(detail: impl Into<String>) -> AppError {
    AppError::other("Der Tresor ist beschädigt oder kein Cryptomator-Tresor.").with_detail(detail.into())
}

fn crypto_err(what: &str) -> AppError {
    AppError::other(format!("Entschlüsseln fehlgeschlagen ({what}). Die Datei im Tresor ist beschädigt.")).with_detail("integrity")
}

/* ------------------------------------------------------------------ Storage */

/// Where the encrypted files lie: this computer or a connected server.
#[derive(Clone)]
pub enum Store {
    Local,
    Remote { connections: Connections, id: String },
}

/// An open file being written to the storage.
enum StoreWriter {
    Local(tokio::fs::File),
    Remote(RemoteWriter),
}

impl StoreWriter {
    async fn write_all(&mut self, data: &[u8]) -> AppResult<()> {
        let r = match self {
            StoreWriter::Local(f) => f.write_all(data).await,
            StoreWriter::Remote(w) => w.write_all(data).await,
        };
        r.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Schreiben in den Tresor fehlgeschlagen.").with_detail(e.to_string()))
    }

    async fn finish(self) -> AppResult<()> {
        match self {
            StoreWriter::Local(mut f) => f.flush().await.map_err(Into::into),
            StoreWriter::Remote(w) => Box::pin(w.close()).await,
        }
    }

    fn abort(self) {
        if let StoreWriter::Remote(w) = self {
            w.abort();
        }
    }
}

fn local_entry(name: String, meta: &std::fs::Metadata) -> FileEntry {
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
    FileEntry {
        name,
        kind: if meta.is_dir() { "dir" } else { "file" }.into(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        mtime,
        perms: String::new(),
        owner: String::new(),
        group: String::new(),
        link: None,
        hidden: 0,
    }
}

impl Store {
    async fn remote(&self) -> AppResult<Arc<Remote>> {
        match self {
            Store::Local => unreachable!("local storage has no connection"),
            Store::Remote { connections, id } => connections
                .lock()
                .await
                .get(id)
                .filter(|c| !c.is_closed())
                .cloned()
                .ok_or_else(|| AppError::new(ErrorKind::NotConnected, "Keine Verbindung zum Server, auf dem der Tresor liegt.")),
        }
    }

    async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        match self {
            Store::Local => {
                let mut out = Vec::new();
                let mut rd = tokio::fs::read_dir(to_native(path)).await?;
                while let Some(e) = rd.next_entry().await? {
                    if let Ok(meta) = e.metadata().await {
                        out.push(local_entry(e.file_name().to_string_lossy().to_string(), &meta));
                    }
                }
                Ok(out)
            }
            Store::Remote { .. } => Box::pin(self.remote().await?.list(path)).await,
        }
    }

    async fn stat(&self, path: &str) -> Option<FileEntry> {
        match self {
            Store::Local => tokio::fs::metadata(to_native(path)).await.ok().map(|m| local_entry(remote_name(path), &m)),
            Store::Remote { .. } => Box::pin(self.remote().await.ok()?.stat(path)).await.ok(),
        }
    }

    async fn read_all(&self, path: &str) -> AppResult<Vec<u8>> {
        match self {
            Store::Local => Ok(tokio::fs::read(to_native(path)).await?),
            Store::Remote { .. } => {
                let r = self.remote().await?;
                let mut reader = Box::pin(r.reader(path, 0)).await?;
                let mut buf = Vec::new();
                reader.read_to_end(&mut buf).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Lesen fehlgeschlagen.").with_detail(e.to_string()))?;
                Box::pin(reader.close(true)).await?;
                Ok(buf)
            }
        }
    }

    async fn reader(&self, path: &str, offset: u64) -> AppResult<Box<dyn AsyncRead + Unpin + Send>> {
        match self {
            Store::Local => {
                let mut f = tokio::fs::File::open(to_native(path)).await?;
                if offset > 0 {
                    f.seek(std::io::SeekFrom::Start(offset)).await?;
                }
                Ok(Box::new(f))
            }
            Store::Remote { .. } => Ok(Box::new(Box::pin(self.remote().await?.reader(path, offset)).await?)),
        }
    }

    async fn writer(&self, path: &str, size: Option<u64>) -> AppResult<StoreWriter> {
        match self {
            Store::Local => Ok(StoreWriter::Local(tokio::fs::File::create(to_native(path)).await?)),
            Store::Remote { .. } => Ok(StoreWriter::Remote(Box::pin(self.remote().await?.writer(path, 0, size, None)).await?)),
        }
    }

    async fn write_all(&self, path: &str, data: &[u8]) -> AppResult<()> {
        let mut w = self.writer(path, Some(data.len() as u64)).await?;
        if let Err(e) = w.write_all(data).await {
            w.abort();
            return Err(e);
        }
        w.finish().await
    }

    async fn mkdir(&self, path: &str) -> AppResult<()> {
        match self {
            Store::Local => Ok(tokio::fs::create_dir(to_native(path)).await?),
            Store::Remote { .. } => Box::pin(self.remote().await?.mkdir(path)).await,
        }
    }

    async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        match self {
            Store::Local => Ok(tokio::fs::create_dir_all(to_native(path)).await?),
            Store::Remote { .. } => Box::pin(self.remote().await?.mkdir_all(path)).await,
        }
    }

    async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        match self {
            Store::Local => Ok(tokio::fs::rename(to_native(from), to_native(to)).await?),
            Store::Remote { .. } => Box::pin(self.remote().await?.rename(from, to)).await,
        }
    }

    /// Deletes a file or a folder with everything in it; gone already is fine.
    async fn remove(&self, path: &str) -> AppResult<()> {
        match self {
            Store::Local => {
                let p = to_native(path);
                match tokio::fs::symlink_metadata(&p).await {
                    Ok(m) if m.is_dir() => Ok(tokio::fs::remove_dir_all(&p).await?),
                    Ok(_) => Ok(tokio::fs::remove_file(&p).await?),
                    Err(_) => Ok(()),
                }
            }
            Store::Remote { .. } => {
                let r = self.remote().await?;
                if Box::pin(r.exists(path)).await {
                    Box::pin(r.remove(path)).await
                } else {
                    Ok(())
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ Crypto */

struct Keys {
    enc: [u8; 32],
    mac: [u8; 32],
}

impl Drop for Keys {
    fn drop(&mut self) {
        self.enc.fill(0);
        self.mac.fill(0);
    }
}

impl Keys {
    fn siv(&self) -> Aes256Siv {
        // RustCrypto takes the MAC key first, then the CTR key.
        let mut key = [0u8; 64];
        key[..32].copy_from_slice(&self.mac);
        key[32..].copy_from_slice(&self.enc);
        let siv = Aes256Siv::new((&key).into());
        key.fill(0);
        siv
    }

    fn jwt_key(&self) -> [u8; 64] {
        let mut key = [0u8; 64];
        key[..32].copy_from_slice(&self.enc);
        key[32..].copy_from_slice(&self.mac);
        key
    }

    fn hash_dir_id(&self, dir_id: &str) -> String {
        let empty: [&[u8]; 0] = [];
        let encrypted = self.siv().encrypt(empty, dir_id.as_bytes()).expect("siv");
        BASE32.encode(&Sha1::digest(&encrypted))
    }

    fn encrypt_name(&self, name: &str, dir_id: &str) -> String {
        let nfc: String = name.nfc().collect();
        let encrypted = self.siv().encrypt([dir_id.as_bytes()], nfc.as_bytes()).expect("siv");
        format!("{}.c9r", BASE64URL.encode(&encrypted))
    }

    fn decrypt_name(&self, encrypted: &str, dir_id: &str) -> Option<String> {
        let b64 = encrypted.strip_suffix(".c9r")?;
        let bytes = b64url(b64)?;
        let clear = self.siv().decrypt([dir_id.as_bytes()], &bytes).ok()?;
        String::from_utf8(clear).ok()
    }

    /// A new file header: nonce, content key and the 68 bytes to write.
    fn new_header(&self) -> ([u8; 12], [u8; 32], Vec<u8>) {
        let mut rng = rand::rng();
        let nonce: [u8; 12] = rng.random();
        let content_key: [u8; 32] = rng.random();
        let mut payload = vec![0xFFu8; 8];
        payload.extend_from_slice(&content_key);
        let gcm = Aes256Gcm::new((&self.enc).into());
        let mut out = nonce.to_vec();
        out.extend(gcm.encrypt(Nonce::from_slice(&nonce), payload.as_slice()).expect("gcm"));
        (nonce, content_key, out)
    }

    fn read_header(&self, header: &[u8]) -> AppResult<([u8; 12], [u8; 32])> {
        if header.len() < HEADER {
            return Err(crypto_err("Dateikopf"));
        }
        let gcm = Aes256Gcm::new((&self.enc).into());
        let payload = gcm.decrypt(Nonce::from_slice(&header[..12]), &header[12..HEADER]).map_err(|_| crypto_err("Dateikopf"))?;
        let mut nonce = [0u8; 12];
        nonce.copy_from_slice(&header[..12]);
        let mut key = [0u8; 32];
        key.copy_from_slice(&payload[8..40]);
        Ok((nonce, key))
    }
}

/// Base64url with or without padding (Cryptomator writes none, other tools do).
fn b64url(s: &str) -> Option<Vec<u8>> {
    BASE64URL_NOPAD.decode(s.trim_end_matches('=').as_bytes()).ok()
}

fn chunk_aad(number: u64, header_nonce: &[u8; 12]) -> [u8; 20] {
    let mut aad = [0u8; 20];
    aad[..8].copy_from_slice(&number.to_be_bytes());
    aad[8..].copy_from_slice(header_nonce);
    aad
}

fn encrypt_chunk(gcm: &Aes256Gcm, number: u64, header_nonce: &[u8; 12], clear: &[u8]) -> Vec<u8> {
    let nonce: [u8; 12] = rand::rng().random();
    let mut out = nonce.to_vec();
    out.extend(gcm.encrypt(Nonce::from_slice(&nonce), Payload { msg: clear, aad: &chunk_aad(number, header_nonce) }).expect("gcm"));
    out
}

fn decrypt_chunk(gcm: &Aes256Gcm, number: u64, header_nonce: &[u8; 12], chunk: &[u8]) -> AppResult<Vec<u8>> {
    if chunk.len() < 28 {
        return Err(crypto_err("Block"));
    }
    gcm.decrypt(Nonce::from_slice(&chunk[..12]), Payload { msg: &chunk[12..], aad: &chunk_aad(number, header_nonce) }).map_err(|_| crypto_err("Block"))
}

/// Size of the decrypted content for an encrypted file of `size` bytes.
pub fn clear_size(size: u64) -> u64 {
    if size <= HEADER as u64 {
        return 0;
    }
    let body = size - HEADER as u64;
    let full = body / CHUNK_CIPHER as u64;
    let rest = body % CHUNK_CIPHER as u64;
    full * CHUNK as u64 + rest.saturating_sub(28)
}

/// The whole content of a small file, encrypted (dirid.c9r).
fn encrypt_small(keys: &Keys, clear: &[u8]) -> Vec<u8> {
    let (nonce, key, mut out) = keys.new_header();
    let gcm = Aes256Gcm::new((&key).into());
    for (i, piece) in clear.chunks(CHUNK).enumerate() {
        out.extend(encrypt_chunk(&gcm, i as u64, &nonce, piece));
    }
    out
}

/* ------------------------------------------------------------------ Masterkey */

fn derive_kek(password: &str, salt: &[u8], n: u64, r: u32) -> AppResult<[u8; 32]> {
    let log_n = (63 - n.leading_zeros()) as u8;
    if n != 1u64 << log_n {
        return Err(bad_vault("scrypt cost is no power of two"));
    }
    let params = scrypt::Params::new(log_n, r, 1, 32).map_err(|e| bad_vault(e.to_string()))?;
    let mut kek = [0u8; 32];
    let nfc: String = password.nfc().collect();
    scrypt::scrypt(nfc.as_bytes(), salt, &params, &mut kek).map_err(|e| bad_vault(e.to_string()))?;
    Ok(kek)
}

fn unlock(masterkey_json: &[u8], password: &str) -> AppResult<Keys> {
    let v: Value = serde_json::from_slice(masterkey_json).map_err(|e| bad_vault(e.to_string()))?;
    let b64 = |k: &str| -> AppResult<Vec<u8>> { BASE64.decode(v.get(k).and_then(Value::as_str).unwrap_or("").as_bytes()).map_err(|e| bad_vault(format!("{k}: {e}"))) };
    let salt = b64("scryptSalt")?;
    let n = v.get("scryptCostParam").and_then(Value::as_u64).unwrap_or(32768);
    let r = v.get("scryptBlockSize").and_then(Value::as_u64).unwrap_or(8) as u32;
    let kek = derive_kek(password, &salt, n, r)?;
    let kw = KekAes256::from(kek);
    let wrong = || AppError::new(ErrorKind::AuthFailed, "Das Tresor-Passwort stimmt nicht.");
    let enc = kw.unwrap_vec(&b64("primaryMasterKey")?).map_err(|_| wrong())?;
    let mac = kw.unwrap_vec(&b64("hmacMasterKey")?).map_err(|_| wrong())?;
    if enc.len() != 32 || mac.len() != 32 {
        return Err(bad_vault("key length"));
    }
    let mut keys = Keys { enc: [0; 32], mac: [0; 32] };
    keys.enc.copy_from_slice(&enc);
    keys.mac.copy_from_slice(&mac);
    Ok(keys)
}

fn masterkey_file(keys: &Keys, password: &str) -> AppResult<Vec<u8>> {
    let salt: [u8; 32] = rand::rng().random();
    let n = 32768u64;
    let kek = derive_kek(password, &salt, n, 8)?;
    let kw = KekAes256::from(kek);
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&keys.mac).expect("hmac");
    mac.update(&999u32.to_be_bytes());
    let file = json!({
        "version": 999,
        "scryptSalt": BASE64.encode(&salt),
        "scryptCostParam": n,
        "scryptBlockSize": 8,
        "primaryMasterKey": BASE64.encode(&kw.wrap_vec(&keys.enc).expect("wrap")),
        "hmacMasterKey": BASE64.encode(&kw.wrap_vec(&keys.mac).expect("wrap")),
        "versionMac": BASE64.encode(&mac.finalize().into_bytes()),
    });
    Ok(serde_json::to_vec_pretty(&file).unwrap_or_default())
}

/// Checks the signature of vault.cryptomator; returns the name length limit.
fn read_vault_config(jwt: &str, keys: &Keys) -> AppResult<usize> {
    let parts: Vec<&str> = jwt.trim().split('.').collect();
    let [header, payload, signature] = parts.as_slice() else { return Err(bad_vault("vault.cryptomator is no JWT")) };
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&keys.jwt_key()).expect("hmac");
    mac.update(format!("{header}.{payload}").as_bytes());
    let sig = b64url(signature).ok_or_else(|| bad_vault("signature encoding"))?;
    mac.verify_slice(&sig).map_err(|_| bad_vault("signature of vault.cryptomator"))?;
    let payload: Value = serde_json::from_slice(&b64url(payload).ok_or_else(|| bad_vault("payload encoding"))?).map_err(|e| bad_vault(e.to_string()))?;
    if payload.get("format").and_then(Value::as_u64) != Some(8) {
        return Err(AppError::other("Dieses Tresor-Format unterstützt Bitcrane nicht. Bitte den Tresor mit einer aktuellen Cryptomator-Version öffnen, die ihn umstellt."));
    }
    if payload.get("cipherCombo").and_then(Value::as_str) != Some("SIV_GCM") {
        return Err(AppError::other("Diese Tresor-Verschlüsselung (SIV_CTRMAC) unterstützt Bitcrane nicht."));
    }
    Ok(payload.get("shorteningThreshold").and_then(Value::as_u64).map(|t| t as usize).unwrap_or(DEFAULT_THRESHOLD))
}

fn vault_config(keys: &Keys) -> String {
    let header = BASE64URL_NOPAD.encode(json!({ "kid": "masterkeyfile:masterkey.cryptomator", "typ": "JWT", "alg": "HS256" }).to_string().as_bytes());
    let payload = BASE64URL_NOPAD.encode(json!({ "jti": uuid::Uuid::new_v4().to_string(), "format": 8, "cipherCombo": "SIV_GCM", "shorteningThreshold": DEFAULT_THRESHOLD }).to_string().as_bytes());
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&keys.jwt_key()).expect("hmac");
    mac.update(format!("{header}.{payload}").as_bytes());
    format!("{header}.{payload}.{}", BASE64URL_NOPAD.encode(&mac.finalize().into_bytes()))
}

/* ------------------------------------------------------------------ Vault */

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    File,
    Dir,
}

/// One encrypted entry in the storage.
struct Node {
    /// Path of the `.c9r` / `.c9s` entry.
    path: String,
    shortened: bool,
    kind: Kind,
    size: u64,
    mtime: i64,
}

impl Node {
    /// Where the content of a file lies.
    fn content(&self) -> String {
        if self.shortened {
            remote_join(&self.path, "contents.c9r")
        } else {
            self.path.clone()
        }
    }
}

pub struct VaultConn {
    store: Store,
    root: String,
    keys: Keys,
    threshold: usize,
    /// Folder ids by cleartext path.
    dir_ids: Mutex<HashMap<String, String>>,
    pub home: String,
}

fn not_found(path: &str) -> AppError {
    AppError::new(ErrorKind::NotFound, format!("„{}“ gibt es nicht.", remote_name(path)))
}

impl VaultConn {
    /// Opens the vault in the folder `root` with the password.
    pub async fn open(store: Store, root: &str, password: &str) -> AppResult<VaultConn> {
        let masterkey = store.read_all(&remote_join(root, "masterkey.cryptomator")).await.map_err(|e| if e.kind == ErrorKind::NotFound { bad_vault("masterkey.cryptomator missing") } else { e })?;
        let config = store.read_all(&remote_join(root, "vault.cryptomator")).await.map_err(|e| if e.kind == ErrorKind::NotFound { bad_vault("vault.cryptomator missing") } else { e })?;
        let keys = tokio::task::spawn_blocking({
            let password = password.to_string();
            move || unlock(&masterkey, &password)
        })
        .await
        .map_err(|e| AppError::other("Entsperren abgebrochen.").with_detail(e.to_string()))??;
        let threshold = read_vault_config(&String::from_utf8_lossy(&config), &keys)?;
        let mut ids = HashMap::new();
        ids.insert("/".to_string(), String::new());
        Ok(VaultConn { store, root: root.to_string(), keys, threshold, dir_ids: Mutex::new(ids), home: "/".into() })
    }

    /// Creates a new, empty vault in the folder `root` (which must not exist yet).
    pub async fn create(store: Store, root: &str, password: &str) -> AppResult<()> {
        if store.stat(root).await.is_some() {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("„{}“ gibt es hier schon.", remote_name(root))));
        }
        let keys = {
            let mut rng = rand::rng();
            Keys { enc: rng.random(), mac: rng.random() }
        };
        let password = password.to_string();
        let (masterkey, keys) = tokio::task::spawn_blocking(move || masterkey_file(&keys, &password).map(|m| (m, keys)))
            .await
            .map_err(|e| AppError::other("Anlegen abgebrochen.").with_detail(e.to_string()))??;
        store.mkdir_all(root).await?;
        store.write_all(&remote_join(root, "masterkey.cryptomator"), &masterkey).await?;
        store.write_all(&remote_join(root, "vault.cryptomator"), vault_config(&keys).as_bytes()).await?;
        let vault = VaultConn { store, root: root.to_string(), keys, threshold: DEFAULT_THRESHOLD, dir_ids: Mutex::new(HashMap::new()), home: "/".into() };
        vault.store.mkdir_all(&vault.content_dir("")).await
    }

    fn content_dir(&self, dir_id: &str) -> String {
        let hash = self.keys.hash_dir_id(dir_id);
        remote_join(&remote_join(&remote_join(&self.root, "d"), &hash[..2]), &hash[2..])
    }

    /// Storage name of an entry: `<name>.c9r`, or `<sha1>.c9s` when too long.
    fn storage_name(&self, name: &str, dir_id: &str) -> (String, String, bool) {
        let encrypted = self.keys.encrypt_name(name, dir_id);
        if encrypted.len() > self.threshold {
            let short = format!("{}.c9s", BASE64URL.encode(&Sha1::digest(encrypted.as_bytes())));
            (short, encrypted, true)
        } else {
            (encrypted.clone(), encrypted, false)
        }
    }

    async fn node(&self, dir_id: &str, name: &str) -> AppResult<Option<Node>> {
        let (storage, _, shortened) = self.storage_name(name, dir_id);
        let path = remote_join(&self.content_dir(dir_id), &storage);
        let Some(entry) = self.store.stat(&path).await else { return Ok(None) };
        if !shortened {
            let kind = if entry.kind == "dir" { Kind::Dir } else { Kind::File };
            return Ok(Some(Node { path, shortened, kind, size: clear_size(entry.size), mtime: entry.mtime }));
        }
        Ok(Some(match self.store.stat(&remote_join(&path, "contents.c9r")).await {
            Some(c) => Node { path, shortened, kind: Kind::File, size: clear_size(c.size), mtime: c.mtime },
            None => Node { path, shortened, kind: Kind::Dir, size: 0, mtime: entry.mtime },
        }))
    }

    async fn node_of(&self, path: &str) -> AppResult<Node> {
        let dir_id = self.dir_id(&remote_parent(path)).await?;
        self.node(&dir_id, &remote_name(path)).await?.ok_or_else(|| not_found(path))
    }

    /// Id of a cleartext folder ("" for the vault's root), resolved from the
    /// nearest known parent down.
    async fn dir_id(&self, path: &str) -> AppResult<String> {
        let path = if path.is_empty() { "/" } else { path };
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let mut current = String::from("/");
        let mut id = String::new();
        for seg in segments {
            current = remote_join(&current, seg);
            let known = self.dir_ids.lock().unwrap().get(&current).cloned();
            if let Some(k) = known {
                id = k;
                continue;
            }
            let node = self.node(&id, seg).await?.ok_or_else(|| not_found(&current))?;
            if node.kind != Kind::Dir {
                return Err(AppError::other(format!("„{seg}“ ist kein Ordner.")));
            }
            id = String::from_utf8(self.store.read_all(&remote_join(&node.path, "dir.c9r")).await?).map_err(|_| bad_vault("dir.c9r"))?;
            self.dir_ids.lock().unwrap().insert(current.clone(), id.clone());
        }
        Ok(id)
    }

    fn forget_ids(&self, prefix: &str) {
        let inner = format!("{prefix}/");
        self.dir_ids.lock().unwrap().retain(|k, _| k != prefix && !k.starts_with(&inner));
    }

    pub async fn list(&self, path: &str) -> AppResult<Vec<FileEntry>> {
        let dir_id = self.dir_id(path).await?;
        let dir = self.content_dir(&dir_id);
        let mut out = Vec::new();
        for e in self.store.list(&dir).await? {
            let (name, kind, size, mtime) = if e.name.ends_with(".c9r") && e.name != "dirid.c9r" {
                let Some(name) = self.keys.decrypt_name(&e.name, &dir_id) else { continue };
                if e.kind == "dir" {
                    (name, Kind::Dir, 0, e.mtime)
                } else {
                    (name, Kind::File, clear_size(e.size), e.mtime)
                }
            } else if e.name.ends_with(".c9s") && e.kind == "dir" {
                let node = remote_join(&dir, &e.name);
                let Ok(long) = self.store.read_all(&remote_join(&node, "name.c9s")).await else { continue };
                let Some(name) = self.keys.decrypt_name(String::from_utf8_lossy(&long).trim(), &dir_id) else { continue };
                match self.store.stat(&remote_join(&node, "contents.c9r")).await {
                    Some(c) => (name, Kind::File, clear_size(c.size), c.mtime),
                    None => (name, Kind::Dir, 0, e.mtime),
                }
            } else {
                continue;
            };
            out.push(FileEntry {
                name,
                kind: if kind == Kind::Dir { "dir" } else { "file" }.into(),
                size,
                mtime,
                perms: String::new(),
                owner: String::new(),
                group: String::new(),
                link: None,
                hidden: 0,
            });
        }
        out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
            ("dir", "file") => std::cmp::Ordering::Less,
            ("file", "dir") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileEntry> {
        if path == "/" || path.is_empty() {
            return Ok(FileEntry { name: "/".into(), kind: "dir".into(), size: 0, mtime: 0, perms: String::new(), owner: String::new(), group: String::new(), link: None, hidden: 0 });
        }
        let n = self.node_of(path).await?;
        Ok(FileEntry {
            name: remote_name(path),
            kind: if n.kind == Kind::Dir { "dir" } else { "file" }.into(),
            size: n.size,
            mtime: n.mtime,
            perms: String::new(),
            owner: String::new(),
            group: String::new(),
            link: None,
            hidden: 0,
        })
    }

    pub async fn exists(&self, path: &str) -> bool {
        self.stat(path).await.is_ok()
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        let parent_id = self.dir_id(&remote_parent(path)).await?;
        let name = remote_name(path);
        if self.node(&parent_id, &name).await?.is_some() {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("„{name}“ gibt es hier schon.")));
        }
        let (storage, encrypted, shortened) = self.storage_name(&name, &parent_id);
        let node = remote_join(&self.content_dir(&parent_id), &storage);
        let id = uuid::Uuid::new_v4().to_string();
        self.store.mkdir_all(&node).await?;
        if shortened {
            self.store.write_all(&remote_join(&node, "name.c9s"), encrypted.as_bytes()).await?;
        }
        self.store.write_all(&remote_join(&node, "dir.c9r"), id.as_bytes()).await?;
        let content = self.content_dir(&id);
        self.store.mkdir_all(&content).await?;
        // Backup of the id inside the folder (Cryptomator 1.7+ uses it for repairs).
        self.store.write_all(&remote_join(&content, "dirid.c9r"), &encrypt_small(&self.keys, id.as_bytes())).await?;
        self.dir_ids.lock().unwrap().insert(path.to_string(), id);
        Ok(())
    }

    pub async fn mkdir_all(&self, path: &str) -> AppResult<()> {
        let mut current = String::from("/");
        for seg in path.split('/').filter(|s| !s.is_empty()) {
            current = remote_join(&current, seg);
            match self.stat(&current).await {
                Ok(e) if e.kind == "dir" => {}
                Ok(_) => return Err(AppError::other(format!("„{seg}“ ist kein Ordner."))),
                Err(_) => self.mkdir(&current).await?,
            }
        }
        Ok(())
    }

    pub async fn remove(&self, path: &str) -> AppResult<()> {
        let node = match self.node_of(path).await {
            Ok(n) => n,
            Err(e) if e.kind == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if node.kind == Kind::Dir {
            for child in self.list(path).await? {
                Box::pin(self.remove(&remote_join(path, &child.name))).await?;
            }
            let id = self.dir_id(path).await?;
            self.store.remove(&self.content_dir(&id)).await?;
            self.forget_ids(path);
        }
        self.store.remove(&node.path).await
    }

    async fn move_node(&self, from: &str, to: &str) -> AppResult<()> {
        let src = self.node_of(from).await?;
        let parent_id = self.dir_id(&remote_parent(to)).await?;
        let (storage, encrypted, shortened) = self.storage_name(&remote_name(to), &parent_id);
        let target = remote_join(&self.content_dir(&parent_id), &storage);
        match (src.shortened, shortened, src.kind) {
            (false, false, _) | (true, true, _) | (false, true, Kind::Dir) => {
                self.store.rename(&src.path, &target).await?;
                if shortened {
                    self.store.write_all(&remote_join(&target, "name.c9s"), encrypted.as_bytes()).await?;
                } else if src.shortened {
                    self.store.remove(&remote_join(&target, "name.c9s")).await?;
                }
            }
            (false, true, Kind::File) => {
                self.store.mkdir(&target).await?;
                self.store.write_all(&remote_join(&target, "name.c9s"), encrypted.as_bytes()).await?;
                self.store.rename(&src.path, &remote_join(&target, "contents.c9r")).await?;
            }
            (true, false, Kind::File) => {
                self.store.rename(&remote_join(&src.path, "contents.c9r"), &target).await?;
                self.store.remove(&src.path).await?;
            }
            (true, false, Kind::Dir) => {
                self.store.rename(&src.path, &target).await?;
                self.store.remove(&remote_join(&target, "name.c9s")).await?;
            }
        }
        self.forget_ids(from);
        Ok(())
    }

    pub async fn rename(&self, from: &str, to: &str) -> AppResult<()> {
        if self.exists(to).await {
            return Err(AppError::new(ErrorKind::AlreadyExists, format!("„{}“ gibt es hier schon.", remote_name(to))));
        }
        self.move_node(from, to).await
    }

    pub async fn replace(&self, from: &str, to: &str) -> AppResult<()> {
        self.remove(to).await?;
        self.move_node(from, to).await
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

    /// Reads and decrypts a file from `offset`.
    pub async fn reader(self: &Arc<Self>, path: &str, offset: u64) -> AppResult<Box<dyn AsyncRead + Unpin + Send>> {
        let node = self.node_of(path).await?;
        if node.kind != Kind::File {
            return Err(AppError::other(format!("„{}“ ist ein Ordner.", remote_name(path))));
        }
        let content = node.content();
        let mut head = vec![0u8; HEADER];
        {
            let mut r = self.store.reader(&content, 0).await?;
            r.read_exact(&mut head).await.map_err(|_| crypto_err("Dateikopf"))?;
        }
        let (header_nonce, key) = self.keys.read_header(&head)?;
        let first = offset / CHUNK as u64;
        let skip = (offset % CHUNK as u64) as usize;
        let mut src = self.store.reader(&content, HEADER as u64 + first * CHUNK_CIPHER as u64).await?;
        let (mut w, r) = tokio::io::duplex(4 * CHUNK);
        tokio::spawn(async move {
            let gcm = Aes256Gcm::new((&key).into());
            let mut number = first;
            let mut skip = skip;
            let mut buf = vec![0u8; CHUNK_CIPHER];
            loop {
                let mut filled = 0;
                while filled < CHUNK_CIPHER {
                    match src.read(&mut buf[filled..]).await {
                        Ok(0) => break,
                        Ok(n) => filled += n,
                        Err(_) => return,
                    }
                }
                if filled == 0 {
                    break;
                }
                // A damaged block ends the stream; the transfer notices the short file.
                let Ok(clear) = decrypt_chunk(&gcm, number, &header_nonce, &buf[..filled]) else { return };
                if w.write_all(&clear[skip.min(clear.len())..]).await.is_err() {
                    return;
                }
                skip = 0;
                number += 1;
                if filled < CHUNK_CIPHER {
                    break;
                }
            }
            let _ = w.shutdown().await;
        });
        Ok(Box::new(r))
    }

    /// Encrypts and writes a file. The task finishes the upload.
    pub async fn writer(self: &Arc<Self>, path: &str, size: Option<u64>) -> AppResult<(Box<dyn AsyncWrite + Unpin + Send>, tokio::task::JoinHandle<AppResult<()>>)> {
        let parent_id = self.dir_id(&remote_parent(path)).await?;
        let (storage, encrypted, shortened) = self.storage_name(&remote_name(path), &parent_id);
        let node = remote_join(&self.content_dir(&parent_id), &storage);
        let file = if shortened {
            if self.store.stat(&node).await.is_none() {
                self.store.mkdir(&node).await?;
            }
            self.store.write_all(&remote_join(&node, "name.c9s"), encrypted.as_bytes()).await?;
            remote_join(&node, "contents.c9r")
        } else {
            node
        };
        // Encrypted size: header plus 28 bytes per started block.
        let cipher_size = size.map(|s| HEADER as u64 + s + s.div_ceil(CHUNK as u64) * 28);
        let mut out = self.store.writer(&file, cipher_size).await?;
        let (header_nonce, key, header) = self.keys.new_header();
        let (w, mut r) = tokio::io::duplex(4 * CHUNK);
        let task = tokio::spawn(async move {
            let result = async {
                out.write_all(&header).await?;
                let gcm = Aes256Gcm::new((&key).into());
                let mut buf = vec![0u8; CHUNK];
                let mut number = 0u64;
                loop {
                    let mut filled = 0;
                    while filled < CHUNK {
                        let n = r.read(&mut buf[filled..]).await.map_err(|e| AppError::new(ErrorKind::ConnectionLost, "Hochladen abgebrochen.").with_detail(e.to_string()))?;
                        if n == 0 {
                            break;
                        }
                        filled += n;
                    }
                    if filled == 0 {
                        break;
                    }
                    out.write_all(&encrypt_chunk(&gcm, number, &header_nonce, &buf[..filled])).await?;
                    number += 1;
                    if filled < CHUNK {
                        break;
                    }
                }
                Ok::<(), AppError>(())
            }
            .await;
            match result {
                Ok(()) => out.finish().await,
                Err(e) => {
                    out.abort();
                    Err(e)
                }
            }
        });
        Ok((Box::new(w), task))
    }
}

/// Whether a folder listing looks like a Cryptomator vault.
pub fn looks_like_vault(names: &[String]) -> bool {
    names.iter().any(|n| n == "vault.cryptomator") && names.iter().any(|n| n == "masterkey.cryptomator")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_clear_sizes() {
        assert_eq!(clear_size(68), 0);
        assert_eq!(clear_size(68 + 28 + 5), 5);
        assert_eq!(clear_size(68 + CHUNK_CIPHER as u64), CHUNK as u64);
        assert_eq!(clear_size(68 + CHUNK_CIPHER as u64 + 28 + 1), CHUNK as u64 + 1);
    }

    #[tokio::test]
    async fn creates_and_uses_a_local_vault() {
        let dir = tempfile::tempdir().unwrap();
        let root = format!("{}/Tresor", dir.path().to_string_lossy().replace('\\', "/"));
        VaultConn::create(Store::Local, &root, "geheim").await.unwrap();
        assert_eq!(VaultConn::open(Store::Local, &root, "falsch").await.err().map(|e| e.kind), Some(ErrorKind::AuthFailed));
        let vault = Arc::new(VaultConn::open(Store::Local, &root, "geheim").await.unwrap());
        vault.mkdir_all("/Projekte/Über uns").await.unwrap();
        let data: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let (mut w, task) = vault.writer("/Projekte/Über uns/daten.bin", Some(data.len() as u64)).await.unwrap();
        w.write_all(&data).await.unwrap();
        w.shutdown().await.unwrap();
        drop(w);
        task.await.unwrap().unwrap();
        let st = vault.stat("/Projekte/Über uns/daten.bin").await.unwrap();
        assert_eq!(st.size, 100_000);
        let mut back = Vec::new();
        vault.reader("/Projekte/Über uns/daten.bin", 40_000).await.unwrap().read_to_end(&mut back).await.unwrap();
        assert_eq!(back, data[40_000..]);
        // A name over the length limit becomes a .c9s folder and survives renames.
        let long = format!("{}.txt", "x".repeat(200));
        vault.rename("/Projekte/Über uns/daten.bin", &format!("/Projekte/{long}")).await.unwrap();
        let names: Vec<String> = vault.list("/Projekte").await.unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["Über uns".to_string(), long.clone()]);
        vault.rename(&format!("/Projekte/{long}"), "/kurz.bin").await.unwrap();
        assert_eq!(vault.stat("/kurz.bin").await.unwrap().size, 100_000);
        vault.rename("/Projekte", "/Archiv").await.unwrap();
        assert!(vault.exists("/Archiv/Über uns").await);
        vault.remove("/Archiv").await.unwrap();
        let names: Vec<String> = vault.list("/").await.unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["kurz.bin".to_string()]);
        // Nothing readable in the storage itself.
        let walk = crate::local::walk(&root).unwrap();
        assert!(walk.iter().all(|w| !w.relative.contains("kurz") && !w.relative.contains("Projekte")));
    }
}

/// Cross-check with another implementation: writes a vault to
/// `BITCRANE_VAULT_OUT`, reads the one in `BITCRANE_VAULT_IN` (password "geheim").
#[cfg(test)]
mod interop {
    use super::*;

    #[tokio::test]
    async fn writes_and_reads_foreign_vaults() {
        if let Ok(out) = std::env::var("BITCRANE_VAULT_OUT") {
            VaultConn::create(Store::Local, &out, "geheim").await.unwrap();
            let v = Arc::new(VaultConn::open(Store::Local, &out, "geheim").await.unwrap());
            v.mkdir_all("/Ordner/Unterordner").await.unwrap();
            for (path, len) in [("/Ordner/klein.txt", 5usize), ("/Ordner/Unterordner/gross.bin", 70_000), (&*format!("/{}.txt", "lang".repeat(60)), 10), ("/leer.txt", 0)] {
                let data: Vec<u8> = (0..len as u32).map(|i| (i % 251) as u8).collect();
                let (mut w, t) = v.writer(path, Some(len as u64)).await.unwrap();
                w.write_all(&data).await.unwrap();
                w.shutdown().await.unwrap();
                drop(w);
                t.await.unwrap().unwrap();
            }
        }
        if let Ok(inp) = std::env::var("BITCRANE_VAULT_IN") {
            let v = Arc::new(VaultConn::open(Store::Local, &inp, "geheim").await.unwrap());
            for item in v.walk("/").await.unwrap() {
                let mut data = Vec::new();
                v.reader(&item.path, 0).await.unwrap().read_to_end(&mut data).await.unwrap();
                println!("IN {} {} {}", item.path, item.size, String::from_utf8_lossy(&data).chars().take(30).collect::<String>());
            }
        }
    }
}
