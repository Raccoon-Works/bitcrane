//! Secrets: passwords, key passphrases, proxy passwords, cloud sign-ins, the Google app secret and
//! the sync password. They live in the system keychain (macOS Keychain, Windows Credential
//! Manager). The interface names a secret with a [`SecretRef`] to store or forget it or to ask
//! whether it is stored; only the core reads it, where it is used. What that gives:
//!
//! - In normal operation a stored secret never reaches the interface.
//! - A stored secret is only sent to the server it was saved for: a login request that reaches
//!   the same account another way gets only the secrets typed into it (`commands/connect.rs`).
//!   The configuration file that names the saved servers is written by the interface, though, so
//!   this protects against a request built by hand, not against an interface that rewrites it.
//! - Export and sync files carry secrets encrypted with a password the user types into the
//!   interface. Whoever controls the interface also knows that password, so these files are
//!   protected against everyone who reads them later, not against the interface itself.
//!
//! Export files and the sync file carry secrets encrypted with a password the user chooses
//! ([`seal`], [`unseal`]). The format was written by the interface's Web Crypto code before it
//! moved here and stays the same, so older export files and sync files written by older versions
//! on other computers keep working: PBKDF2-SHA256 derives an AES-256-GCM key, and salt, nonce and
//! ciphertext are stored as standard Base64.

use crate::error::{AppError, AppResult};
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const KEYRING_SERVICE: &str = "Bitcrane";

/// Where a secret is kept. [`SecretRef::account`] gives the keychain account name; the names are
/// the ones earlier versions wrote, so secrets stored by them are found without a migration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SecretRef {
    /// Login password of a server (also the S3 secret key and a vault's password).
    Password { user: String, host: String, port: u16 },
    /// Passphrase of a private key file. An empty path is the passphrase typed for the default
    /// keys that "Automatisch" tries.
    Passphrase { key_path: String },
    /// Password at a server's SOCKS5 or HTTP proxy.
    Proxy { user: String, host: String, port: u16 },
    /// Refresh token of a cloud service's sign-in, by the id of its server entry.
    Cloud { server_id: String },
    /// Client secret of the user's own Google app key (the client id is in the settings).
    GoogleClient,
    /// Password that encrypts the secrets in the sync file, the same on every computer.
    SyncPassword,
}

impl SecretRef {
    /// The keychain account name.
    pub fn account(&self) -> String {
        match self {
            SecretRef::Password { user, host, port } => format!("password:{user}@{host}:{port}"),
            SecretRef::Passphrase { key_path } => format!("passphrase:{key_path}"),
            SecretRef::Proxy { user, host, port } => format!("proxy:{user}@{host}:{port}"),
            SecretRef::Cloud { server_id } => format!("cloud:{server_id}"),
            SecretRef::GoogleClient => "cloud-client:gdrive".into(),
            SecretRef::SyncPassword => "sync-password".into(),
        }
    }

    /// Reads an account name of an export or sync file back. The sync password is never part of
    /// such a file and is not accepted from one; anything unknown gives `None`.
    fn from_account(account: &str) -> Option<Self> {
        // A user name may contain "@" (FTP logins are often e-mail addresses) and an IPv6 host
        // ":", so the port is split off at the last ":" and the user at the last "@" before it.
        let login = |rest: &str| {
            let (user_host, port) = rest.rsplit_once(':')?;
            let (user, host) = user_host.rsplit_once('@')?;
            Some((user.to_string(), host.to_string(), port.parse().ok()?))
        };
        if let Some(rest) = account.strip_prefix("password:") {
            let (user, host, port) = login(rest)?;
            Some(SecretRef::Password { user, host, port })
        } else if let Some(rest) = account.strip_prefix("proxy:") {
            let (user, host, port) = login(rest)?;
            Some(SecretRef::Proxy { user, host, port })
        } else if let Some(key_path) = account.strip_prefix("passphrase:") {
            Some(SecretRef::Passphrase { key_path: key_path.into() })
        } else if let Some(server_id) = account.strip_prefix("cloud:") {
            Some(SecretRef::Cloud { server_id: server_id.into() })
        } else if account == "cloud-client:gdrive" {
            Some(SecretRef::GoogleClient)
        } else {
            None
        }
    }
}

/// Reading and writing secrets. The app uses the system keychain ([`Keychain`]); tests use a
/// store in memory.
pub trait SecretStore: Sync {
    fn get(&self, secret: &SecretRef) -> AppResult<Option<String>>;
    fn set(&self, secret: &SecretRef, value: &str) -> AppResult<()>;
    /// Removes the secret; one that is not stored counts as removed.
    fn delete(&self, secret: &SecretRef) -> AppResult<()>;
}

/// The system keychain, under the service name "Bitcrane".
pub struct Keychain;

fn entry(secret: &SecretRef) -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &secret.account())
        .map_err(|e| AppError::other("Schlüsselbund nicht verfügbar.").with_detail(e.to_string()))
}

impl SecretStore for Keychain {
    fn get(&self, secret: &SecretRef) -> AppResult<Option<String>> {
        match entry(secret)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::other("Schlüsselbund nicht lesbar.").with_detail(e.to_string())),
        }
    }

    fn set(&self, secret: &SecretRef, value: &str) -> AppResult<()> {
        entry(secret)?
            .set_password(value)
            .map_err(|e| AppError::other("Konnte nicht im Schlüsselbund speichern.").with_detail(e.to_string()))
    }

    fn delete(&self, secret: &SecretRef) -> AppResult<()> {
        match entry(secret)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::other("Konnte nicht aus dem Schlüsselbund löschen.").with_detail(e.to_string())),
        }
    }
}

/// A stored secret for a login. A keychain that cannot be read counts as one without the entry:
/// the user is then asked for the password, which is more useful than a failed login.
pub fn saved(store: &dyn SecretStore, secret: &SecretRef) -> Option<String> {
    store.get(secret).unwrap_or_else(|e| {
        log::warn!("keychain not readable for {}: {e}", secret.account());
        None
    })
}

/// Secrets as export and sync files carry them: keychain account name -> secret.
pub type SecretMap = BTreeMap<String, String>;

/// The stored ones among these secrets.
pub fn collect(store: &dyn SecretStore, secrets: impl IntoIterator<Item = SecretRef>) -> SecretMap {
    secrets.into_iter().filter_map(|r| saved(store, &r).map(|v| (r.account(), v))).collect()
}

/// What putting the secrets of a file into the keychain did.
pub struct Restored {
    pub count: usize,
    /// The first entry the keychain refused; the others were still tried.
    pub refused: Option<AppError>,
}

/// Puts the secrets of an export or sync file into the keychain. `overwrite: false` only fills in
/// missing entries. Entries with an account name Bitcrane does not write are skipped.
pub fn restore(store: &dyn SecretStore, entries: &SecretMap, overwrite: bool) -> Restored {
    let mut done = Restored { count: 0, refused: None };
    for (account, value) in entries {
        let Some(secret) = SecretRef::from_account(account) else {
            log::warn!("skipped an unknown keychain entry from a file: {account}");
            continue;
        };
        if !overwrite && matches!(store.get(&secret), Ok(Some(_))) {
            continue;
        }
        match store.set(&secret, value) {
            Ok(()) => done.count += 1,
            Err(e) => {
                done.refused.get_or_insert(e);
            }
        }
    }
    done
}

/// Text encrypted with a password, as stored in export and sync files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sealed {
    pub kdf: String,
    pub iterations: u32,
    pub salt: String,
    pub iv: String,
    pub data: String,
}

const KDF: &str = "PBKDF2-SHA256";
/// PBKDF2 rounds for new files (OWASP's recommendation for PBKDF2-HMAC-SHA256). Older files carry
/// their own number (310 000) and still open.
const ITERATIONS: u32 = 600_000;
/// Files name their own number of rounds; this leaves room for a later increase while a
/// manipulated file cannot keep the core busy for minutes.
const MAX_ITERATIONS: u32 = 1_000_000;

fn key_for(password: &str, salt: &[u8], iterations: u32) -> Aes256Gcm {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), salt, iterations, &mut key);
    let cipher = Aes256Gcm::new(&key.into());
    // Cleared like the vault keys (vault.rs); the cipher keeps its own expanded copy.
    key.fill(0);
    cipher
}

/// Encrypts `text` with a key derived from `password`, with a new random salt and nonce.
pub fn seal(text: &str, password: &str) -> Sealed {
    let mut rng = rand::rng();
    seal_with(text, password, &rng.random(), &rng.random(), ITERATIONS)
}

fn seal_with(text: &str, password: &str, salt: &[u8; 16], nonce: &[u8; 12], iterations: u32) -> Sealed {
    let data = key_for(password, salt, iterations)
        .encrypt(Nonce::from_slice(nonce), text.as_bytes())
        .expect("AES-GCM encrypts any text that fits in memory");
    Sealed {
        kdf: KDF.into(),
        iterations,
        salt: BASE64.encode(salt),
        iv: BASE64.encode(nonce),
        data: BASE64.encode(data),
    }
}

/// Decrypts a sealed text. `None` when the password is wrong or the data is damaged: AES-GCM
/// checks the integrity, so the two cannot be told apart, and neither can be repaired.
pub fn unseal(sealed: &Sealed, password: &str) -> Option<String> {
    if sealed.kdf != KDF || sealed.iterations == 0 || sealed.iterations > MAX_ITERATIONS {
        return None;
    }
    let salt = BASE64.decode(&sealed.salt).ok()?;
    let nonce = BASE64.decode(&sealed.iv).ok()?;
    let data = BASE64.decode(&sealed.data).ok()?;
    // Web Crypto took any nonce length; every file written so far has 12 bytes, all AES-GCM here takes.
    if nonce.len() != 12 {
        return None;
    }
    let plain = key_for(password, &salt, sealed.iterations).decrypt(Nonce::from_slice(&nonce), data.as_slice()).ok()?;
    String::from_utf8(plain).ok()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A keychain in memory, by account name.
    #[derive(Default)]
    pub struct MemoryStore(pub Mutex<HashMap<String, String>>);

    impl MemoryStore {
        pub fn with(entries: &[(SecretRef, &str)]) -> Self {
            let store = MemoryStore::default();
            for (r, v) in entries {
                store.set(r, v).unwrap();
            }
            store
        }

        pub fn value(&self, account: &str) -> Option<String> {
            self.0.lock().unwrap().get(account).cloned()
        }
    }

    impl SecretStore for MemoryStore {
        fn get(&self, secret: &SecretRef) -> AppResult<Option<String>> {
            Ok(self.0.lock().unwrap().get(&secret.account()).cloned())
        }
        fn set(&self, secret: &SecretRef, value: &str) -> AppResult<()> {
            self.0.lock().unwrap().insert(secret.account(), value.into());
            Ok(())
        }
        fn delete(&self, secret: &SecretRef) -> AppResult<()> {
            self.0.lock().unwrap().remove(&secret.account());
            Ok(())
        }
    }

    fn password(user: &str, host: &str, port: u16) -> SecretRef {
        SecretRef::Password { user: user.into(), host: host.into(), port }
    }

    #[test]
    fn account_names_are_the_ones_earlier_versions_wrote() {
        // The names the interface formed before (connections.ts, cloud.ts, sync.ts, KeyPanel.tsx).
        let cases = [
            (password("anna", "web.example", 2222), "password:anna@web.example:2222"),
            // A vault on this computer (src/state/vault.ts names its user "local").
            (password("local", "/Users/x/Tresor", 0), "password:local@/Users/x/Tresor:0"),
            (SecretRef::Passphrase { key_path: "~/.ssh/id_ed25519".into() }, "passphrase:~/.ssh/id_ed25519"),
            (SecretRef::Passphrase { key_path: String::new() }, "passphrase:"),
            (
                SecretRef::Proxy { user: "pu".into(), host: "proxy.example".into(), port: 1080 },
                "proxy:pu@proxy.example:1080",
            ),
            (SecretRef::Cloud { server_id: "s-12ab".into() }, "cloud:s-12ab"),
            (SecretRef::GoogleClient, "cloud-client:gdrive"),
            (SecretRef::SyncPassword, "sync-password"),
        ];
        for (secret, account) in cases {
            assert_eq!(secret.account(), account);
        }
    }

    #[test]
    fn account_names_of_files_are_read_back() {
        for secret in [
            password("anna@example.com", "ftp.example", 21),
            password("ops", "::1", 22),
            password("local", "/Users/x/Tresor", 0),
            password("local", "C:/Users/x/Tresor", 0),
            password("n1", "/Tresore/privat", 0),
            SecretRef::Passphrase { key_path: "C:\\Users\\x\\.ssh\\id_rsa".into() },
            SecretRef::Proxy { user: "p@q".into(), host: "proxy.example".into(), port: 8080 },
            SecretRef::Cloud { server_id: "s1".into() },
            SecretRef::GoogleClient,
        ] {
            assert_eq!(SecretRef::from_account(&secret.account()), Some(secret));
        }
        for unknown in ["sync-password", "password:nohost", "password:a@b:undefined", "other:x"] {
            assert_eq!(SecretRef::from_account(unknown), None, "{unknown}");
        }
    }

    #[test]
    fn secret_refs_arrive_from_the_interface_as_tagged_objects() {
        let r: SecretRef =
            serde_json::from_str(r#"{"kind":"password","user":"anna","host":"web.example","port":22}"#).unwrap();
        assert_eq!(r, password("anna", "web.example", 22));
        let r: SecretRef = serde_json::from_str(r#"{"kind":"passphrase","keyPath":"~/.ssh/k"}"#).unwrap();
        assert_eq!(r.account(), "passphrase:~/.ssh/k");
        let r: SecretRef = serde_json::from_str(r#"{"kind":"cloud","serverId":"s9"}"#).unwrap();
        assert_eq!(r.account(), "cloud:s9");
        assert_eq!(serde_json::from_str::<SecretRef>(r#"{"kind":"syncPassword"}"#).unwrap(), SecretRef::SyncPassword);
    }

    /// Made by the interface's former Web Crypto code (src/util/crypto.ts, run in Node) with salt
    /// 0..15 and nonce 100..111, so the expected ciphertext is fixed.
    const WEB_CRYPTO_FIXED: &str = r#"{"kdf":"PBKDF2-SHA256","iterations":310000,"salt":"AAECAwQFBgcICQoLDA0ODw==","iv":"ZGVmZ2hpamtsbW5v","data":"GzlFZdHoIeNNrLf2tHgmyuDZBj+OUZfLdmBChxFYGTsJ++EEy9ZwRSleVotTEgTBrOzm5VMjNzKHkS21n+OW8D7vmkKZeE1LInMSbSbuyg=="}"#;
    const FIXED_TEXT: &str = r#"{"password:anna@web.example:2222":"geheim ü","cloud:s9":"tok"}"#;
    const FIXED_PASSWORD: &str = "Grüße an alle";

    /// An encrypted export file's payload as the former interface code wrote it (random salt and
    /// nonce), password "Abgleich-Passwort".
    const WEB_CRYPTO_EXPORT: &str = r#"{"kdf":"PBKDF2-SHA256","iterations":310000,"salt":"0J+rlB3ds29GgCm7tySfNw==","iv":"Z0kuQ7hhFdpSfJVn","data":"ziF/t/hsItc7V5sa0xiXDRXVHC6cz6UpmHdTAT5pWhnZeW4hdDk9YSCK1qtY6j4h1IYUP0vZzca1xDLRglBhWSclIrXHug0VVY+CnekLUa6P+m6XdSP6YWVnF/5wr/7TWvg+bhGG7pU7h6QWUIgK6bla3b05lW9i1ZNIOJ2LdXnfppVdBipxkXQV9MsB+37M10XNurtNUq18kR8yswIGy4QIl5iSCxjhwi+6S1LPPVeFp4ObIR1tlgN0ggdb6Us9MzhD+rQ="}"#;

    #[test]
    fn files_sealed_by_the_former_web_crypto_code_open() {
        let fixed: Sealed = serde_json::from_str(WEB_CRYPTO_FIXED).unwrap();
        assert_eq!(unseal(&fixed, FIXED_PASSWORD).as_deref(), Some(FIXED_TEXT));
        let export: Sealed = serde_json::from_str(WEB_CRYPTO_EXPORT).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&unseal(&export, "Abgleich-Passwort").unwrap()).unwrap();
        assert_eq!(payload["format"], "bitcrane-export");
        assert_eq!(payload["secrets"]["passphrase:~/.ssh/id_ed25519"], "Grüße");
        assert_eq!(unseal(&export, "falsch"), None);
    }

    #[test]
    fn sealing_writes_exactly_what_web_crypto_wrote() {
        // Same password, salt, nonce, rounds and text give the same bytes: the format is unchanged,
        // and the file names its rounds, so files written now open in older versions too.
        let salt: [u8; 16] = std::array::from_fn(|i| i as u8);
        let nonce: [u8; 12] = std::array::from_fn(|i| 100 + i as u8);
        let sealed = seal_with(FIXED_TEXT, FIXED_PASSWORD, &salt, &nonce, 310_000);
        assert_eq!(sealed, serde_json::from_str::<Sealed>(WEB_CRYPTO_FIXED).unwrap());
        assert_eq!(serde_json::to_string(&sealed).unwrap(), WEB_CRYPTO_FIXED);
    }

    #[test]
    fn sealing_round_trips_with_fresh_salt_and_nonce() {
        let a = seal("Grüße", "pw");
        let b = seal("Grüße", "pw");
        assert_ne!((&a.salt, &a.iv), (&b.salt, &b.iv));
        assert_eq!((BASE64.decode(&a.salt).unwrap().len(), BASE64.decode(&a.iv).unwrap().len()), (16, 12));
        assert_eq!(unseal(&a, "pw").as_deref(), Some("Grüße"));
        assert_eq!(unseal(&a, "PW"), None);
        let damaged = Sealed { data: BASE64.encode(b"too short"), ..a.clone() };
        assert_eq!(unseal(&damaged, "pw"), None);
        assert_eq!(unseal(&Sealed { iterations: u32::MAX, ..a }, "pw"), None);
    }

    #[test]
    fn restoring_fills_in_or_overwrites_and_skips_unknown_entries() {
        let store = MemoryStore::with(&[(password("anna", "web.example", 22), "neu")]);
        let file: SecretMap = [
            ("password:anna@web.example:22", "alt"),
            ("cloud:s1", "tok"),
            ("sync-password", "nicht aus einer Datei"),
            ("unbekannt", "x"),
        ]
        .into_iter()
        .map(|(a, v)| (a.to_string(), v.to_string()))
        .collect();
        let r = restore(&store, &file, false);
        assert_eq!((r.count, r.refused.is_none()), (1, true));
        assert_eq!(store.value("password:anna@web.example:22").as_deref(), Some("neu"));
        assert_eq!(store.value("cloud:s1").as_deref(), Some("tok"));
        assert_eq!(store.value("sync-password"), None);
        assert_eq!(restore(&store, &file, true).count, 2);
        assert_eq!(store.value("password:anna@web.example:22").as_deref(), Some("alt"));
    }

    #[test]
    fn collecting_takes_only_stored_secrets() {
        let store = MemoryStore::with(&[(SecretRef::GoogleClient, "g")]);
        let map = collect(&store, [SecretRef::GoogleClient, SecretRef::Cloud { server_id: "x".into() }]);
        assert_eq!(map, SecretMap::from([("cloud-client:gdrive".to_string(), "g".to_string())]));
    }
}
