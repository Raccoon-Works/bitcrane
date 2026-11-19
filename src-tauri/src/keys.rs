//! SSH key management: create a new ED25519 key pair (optionally protected
//! by a passphrase) and read the public key of an existing private key.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::paths::to_native;
use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, PrivateKey};
use std::path::Path;

/// Writes a new file, never replacing one. On macOS it is readable only by the user (ssh refuses
/// private keys that others can read); on Windows the file gets the permissions of its folder.
fn write_private(path: &Path, content: &str) -> AppResult<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(content.as_bytes())?;
    Ok(())
}

/// Creates `path` (private key) and `path.pub` (public key). Returns the public key line.
pub fn generate(path: &str, comment: &str, passphrase: Option<&str>) -> AppResult<String> {
    let native = to_native(path);
    let pub_path = native.with_file_name(format!(
        "{}.pub",
        native.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    if native.exists() || pub_path.exists() {
        return Err(AppError::new(
            ErrorKind::AlreadyExists,
            "Ein Schlüssel mit diesem Namen existiert schon. Bitte einen anderen Namen wählen.",
        ));
    }
    if let Some(dir) = native.parent() {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // ~/.ssh must not be readable by others, or ssh refuses the keys.
            if dir.file_name().map(|n| n == ".ssh").unwrap_or(false) {
                let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
            }
        }
    }
    let mut rng = rand::rng();
    let mut key = PrivateKey::random(&mut rng, Algorithm::Ed25519)
        .map_err(|e| AppError::other("Schlüssel konnte nicht erzeugt werden.").with_detail(e.to_string()))?;
    key.set_comment(comment);
    let public = key
        .public_key()
        .to_openssh()
        .map_err(|e| AppError::other("Öffentlicher Schlüssel fehlerhaft.").with_detail(e.to_string()))?;
    let stored = match passphrase.filter(|p| !p.is_empty()) {
        Some(p) => key
            .encrypt(&mut rng, p)
            .map_err(|e| AppError::other("Verschlüsseln fehlgeschlagen.").with_detail(e.to_string()))?,
        None => key,
    };
    let private = stored
        .to_openssh(LineEnding::LF)
        .map_err(|e| AppError::other("Schlüssel konnte nicht gespeichert werden.").with_detail(e.to_string()))?;
    write_private(&native, &private)?;
    std::fs::write(&pub_path, format!("{public}\n"))?;
    Ok(public)
}

/// Public key line of a private key: from `path.pub`, or derived from the key itself.
pub fn public_of(path: &str) -> AppResult<String> {
    let native = to_native(path);
    let pub_path = native.with_file_name(format!(
        "{}.pub",
        native.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    if let Ok(text) = std::fs::read_to_string(&pub_path) {
        if let Some(line) = text.lines().find(|l| l.starts_with("ssh-") || l.starts_with("ecdsa-")) {
            return Ok(line.trim().to_string());
        }
    }
    let text = std::fs::read_to_string(&native)?;
    if text.starts_with("PuTTY-User-Key-File") {
        return ppk_public(&text);
    }
    let key = PrivateKey::from_openssh(text.trim())
        .map_err(|e| AppError::other("Das ist kein privater SSH-Schlüssel.").with_detail(e.to_string()))?;
    key.public_key()
        .to_openssh()
        .map_err(|e| AppError::other("Öffentlicher Schlüssel fehlerhaft.").with_detail(e.to_string()))
}

/// The public part of a PuTTY key is stored unencrypted ("Public-Lines").
fn ppk_public(text: &str) -> AppResult<String> {
    use base64::Engine;
    let mut lines = text.lines();
    let mut blob = String::new();
    let mut comment = String::new();
    while let Some(line) = lines.next() {
        if let Some(c) = line.strip_prefix("Comment: ") {
            comment = c.trim().to_string();
        }
        if let Some(n) = line.strip_prefix("Public-Lines: ") {
            let n: usize = n.trim().parse().unwrap_or(0);
            // A damaged file may name more lines than it has.
            for line in lines.by_ref().take(n) {
                blob.push_str(line.trim());
            }
        }
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(blob.as_bytes())
        .map_err(|e| AppError::other("PuTTY-Schlüssel fehlerhaft.").with_detail(e.to_string()))?;
    let mut key = russh::keys::PublicKey::from_bytes(&bytes)
        .map_err(|e| AppError::other("PuTTY-Schlüssel fehlerhaft.").with_detail(e.to_string()))?;
    key.set_comment(comment);
    key.to_openssh().map_err(|e| AppError::other("Öffentlicher Schlüssel fehlerhaft.").with_detail(e.to_string()))
}

/// Algorithm and encryption of a PuTTY key, read from its header.
pub fn ppk_info(text: &str) -> (String, bool) {
    let algo = text.lines().next().and_then(|l| l.split(": ").nth(1)).unwrap_or("").trim().to_string();
    let algo = match algo.as_str() {
        "ssh-ed25519" => "ED25519".to_string(),
        "ssh-rsa" => "RSA".to_string(),
        a if a.starts_with("ecdsa") => "ECDSA".to_string(),
        a => a.to_uppercase(),
    };
    let encrypted = text.lines().find(|l| l.starts_with("Encryption:")).map(|l| !l.contains("none")).unwrap_or(false);
    (format!("{algo} (PuTTY)"), encrypted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ppk_naming_more_lines_than_it_has_ends() {
        let text = "PuTTY-User-Key-File-3: ssh-ed25519\nComment: x\nPublic-Lines: 18446744073709551615\nAAAA\n";
        let _ = ppk_public(text);
    }

    #[test]
    fn generates_usable_keys() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain").to_string_lossy().replace('\\', "/");
        let public = generate(&plain, "test@bitcrane", None).unwrap();
        assert!(public.starts_with("ssh-ed25519 ") && public.ends_with("test@bitcrane"));
        assert_eq!(public_of(&plain).unwrap(), public);
        assert!(russh::keys::load_secret_key(&plain, None).is_ok());

        let locked = dir.path().join("locked").to_string_lossy().replace('\\', "/");
        generate(&locked, "x", Some("geheim")).unwrap();
        assert!(matches!(russh::keys::load_secret_key(&locked, None), Err(russh::keys::Error::KeyIsEncrypted)));
        assert!(russh::keys::load_secret_key(&locked, Some("geheim")).is_ok());
        assert!(generate(&locked, "x", None).is_err(), "never overwrites an existing key");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join("plain")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    /// The public half of a passphrase-protected PuTTY key is read without the passphrase.
    #[test]
    #[ignore = "needs the SSH test keys: BITCRANE_TEST_PPK_PASS (puttygen copy of BITCRANE_TEST_KEY)"]
    fn reads_the_public_half_of_putty_keys() {
        let ppk = std::env::var("BITCRANE_TEST_PPK_PASS").expect("BITCRANE_TEST_PPK_PASS");
        let key = std::env::var("BITCRANE_TEST_KEY").expect("BITCRANE_TEST_KEY");
        let p = public_of(&ppk).unwrap();
        assert!(p.starts_with("ssh-ed25519 "));
        assert_eq!(p.split(' ').nth(1), public_of(&key).unwrap().split(' ').nth(1));
    }
}
