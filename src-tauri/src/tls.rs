//! TLS settings for FTPS and WebDAV over HTTPS.
//!
//! Certificates are checked against the usual public certificate
//! authorities. Servers with their own (self-signed) certificate are common
//! for FTPS; for those the user confirms the certificate's fingerprint once,
//! exactly like the SSH host key ("Erste Verbindung"), and Bitcrane remembers
//! it in the same known-hosts file.

use crate::ssh::KnownHosts;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

/// Certificate the server showed in the last handshake (for the dialog).
#[derive(Clone, Debug)]
pub struct SeenCert {
    pub fingerprint: String,
}

#[derive(Debug)]
struct Verifier {
    inner: Arc<WebPkiServerVerifier>,
    known: Arc<KnownHosts>,
    /// Key in the known-hosts file, e.g. "ftps://example.com:21".
    host_id: String,
    /// Fingerprint the user has just confirmed.
    trust: Option<String>,
    seen: Arc<Mutex<Option<SeenCert>>>,
}

pub fn fingerprint(cert: &CertificateDer<'_>) -> String {
    use base64::Engine;
    let digest = Sha256::digest(cert.as_ref());
    format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest))
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(&self, end_entity: &CertificateDer<'_>, intermediates: &[CertificateDer<'_>], server_name: &ServerName<'_>, ocsp: &[u8], now: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        let fp = fingerprint(end_entity);
        *self.seen.lock().unwrap() = Some(SeenCert { fingerprint: fp.clone() });
        // A certificate from a public authority needs no confirmation.
        if self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp, now).is_ok() {
            return Ok(ServerCertVerified::assertion());
        }
        if self.known.get(&self.host_id).as_deref() == Some(fp.as_str()) {
            return Ok(ServerCertVerified::assertion());
        }
        if self.trust.as_deref() == Some(fp.as_str()) {
            self.known.set(&self.host_id, &fp);
            return Ok(ServerCertVerified::assertion());
        }
        Err(rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer))
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// Client configuration with certificate check as described above.
/// `min_tls13`: only TLS 1.3 (setting "TLS-Version"), otherwise 1.2 and 1.3.
pub fn client_config(known: Arc<KnownHosts>, host_id: String, trust: Option<String>, min_tls13: bool) -> (Arc<rustls::ClientConfig>, Arc<Mutex<Option<SeenCert>>>) {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let inner = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone()).build().expect("root certificates");
    let seen = Arc::new(Mutex::new(None));
    let verifier = Arc::new(Verifier { inner, known, host_id, trust, seen: seen.clone() });
    let versions: &[&rustls::SupportedProtocolVersion] = if min_tls13 { &[&rustls::version::TLS13] } else { &[&rustls::version::TLS13, &rustls::version::TLS12] };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .expect("protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    (Arc::new(config), seen)
}

/// Client configuration for well-known public services (cloud APIs): the usual
/// check against the public certificate authorities, nothing to confirm.
pub fn public_client_config() -> Arc<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .expect("protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(config)
}

/// Server name for the TLS handshake (host name or IP address).
pub fn server_name(host: &str) -> Result<ServerName<'static>, rustls::pki_types::InvalidDnsNameError> {
    ServerName::try_from(host.to_string())
}
