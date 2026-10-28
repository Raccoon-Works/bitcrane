//! Error type returned by every Tauri command.
//!
//! Errors are serialised as `{ kind, message, detail? }` so the user interface
//! can react to specific situations (for example an unknown host key) and can
//! show a plain-language message for everything else.

use serde::Serialize;

/// Machine-readable error categories understood by the frontend.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// The server presented a host key that is not yet trusted.
    HostKeyUnknown,
    /// The server presented a different host key than the stored one.
    HostKeyChanged,
    /// Authentication was rejected by the server.
    AuthFailed,
    /// The private key is protected by a passphrase that was not supplied or is wrong.
    PassphraseRequired,
    /// The server wants a password and none was given ("Automatisch").
    PasswordRequired,
    /// The server could not be reached (DNS, refused, timeout).
    Unreachable,
    /// There is no open session for the requested server.
    NotConnected,
    /// The connection dropped while an operation was running.
    ConnectionLost,
    /// The server or local system denied access.
    PermissionDenied,
    /// The requested file or folder does not exist.
    NotFound,
    /// The target already exists.
    AlreadyExists,
    /// The operation was cancelled by the user.
    Cancelled,
    /// Anything else.
    Other,
}

/// Error value sent to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Host key information for `HostKeyUnknown` / `HostKeyChanged`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_key: Option<HostKeyInfo>,
}

/// Host key data shown in the fingerprint dialogs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub algorithm: String,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), detail: None, host_key: None }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Other, message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind as K;
        let kind = match e.kind() {
            K::NotFound => ErrorKind::NotFound,
            K::PermissionDenied => ErrorKind::PermissionDenied,
            K::AlreadyExists => ErrorKind::AlreadyExists,
            K::ConnectionRefused | K::ConnectionReset | K::ConnectionAborted | K::TimedOut | K::HostUnreachable | K::NetworkUnreachable => {
                ErrorKind::Unreachable
            }
            _ => ErrorKind::Other,
        };
        let message = match kind {
            ErrorKind::NotFound => "Datei oder Ordner nicht gefunden.".to_string(),
            ErrorKind::PermissionDenied => "Keine Berechtigung.".to_string(),
            ErrorKind::AlreadyExists => "Das gibt es dort schon.".to_string(),
            ErrorKind::Unreachable => "Der Server ist nicht erreichbar.".to_string(),
            _ => "Unerwarteter Fehler.".to_string(),
        };
        AppError::new(kind, message).with_detail(e.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for AppError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        use russh_sftp::client::error::Error as E;
        use russh_sftp::protocol::StatusCode as S;
        match &e {
            E::Status(status) => {
                let (kind, message) = match status.status_code {
                    S::NoSuchFile => (ErrorKind::NotFound, "Datei oder Ordner nicht gefunden."),
                    S::PermissionDenied => (ErrorKind::PermissionDenied, "Keine Schreibrechte"),
                    S::NoConnection | S::ConnectionLost => (ErrorKind::ConnectionLost, "Verbindung unterbrochen"),
                    _ => (ErrorKind::Other, "Der Server meldet einen Fehler."),
                };
                AppError::new(kind, message).with_detail(status.error_message.clone())
            }
            E::Timeout => AppError::new(ErrorKind::ConnectionLost, "Der Server antwortet nicht.").with_detail(e.to_string()),
            _ => AppError::new(ErrorKind::ConnectionLost, "Verbindung unterbrochen").with_detail(e.to_string()),
        }
    }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::new(ErrorKind::ConnectionLost, "SSH-Verbindung fehlgeschlagen.").with_detail(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
