//! Error type returned by every Tauri command, and the messages it carries.
//!
//! Errors are serialised as `{ kind, key, params?, detail? }`. `kind` lets the
//! interface react to specific situations (for example an unknown host key);
//! `key` and `params` are the message (see [`Message`]), which the interface
//! translates; `detail` is technical text for the protocol and is shown as it is.

use serde::Serialize;

/// A text for the user. The German sentence is what German users read and, at the same time,
/// the key under which the interface finds the translation (`src/i18n.en.ts`, `src/locales/`), as
/// every German text of the interface is. `{0}`, `{1}` … stand for `params`.
///
/// The key is a `&'static str`, so it can only be a fixed text: names, hosts and numbers go into
/// `params` and are never taken for a text to translate. `src/backend/rustMessages.test.ts` checks
/// that every key written here has an English version.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Message {
    pub key: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<Param>,
}

/// A value inserted into a [`Message`]: text shown as it is (a file name, a host), or a message
/// of its own that is translated in turn (for example "„a.txt“ lesen" inside "{0} fehlgeschlagen.").
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Param {
    Text(String),
    Message(Message),
}

impl Message {
    pub const fn new(key: &'static str) -> Self {
        Self { key, params: Vec::new() }
    }

    /// Adds the value for the next placeholder (`{0}` first).
    pub fn param(mut self, value: impl Into<Param>) -> Self {
        self.params.push(value.into());
        self
    }

    /// The message in English, for the command line, which runs without the interface. Texts are
    /// looked up in the interface's dictionary; a key without an English version stays German.
    pub fn english(&self) -> String {
        self.render(&|key| crate::i18n::english(key).unwrap_or(key))
    }

    fn render(&self, text_of: &dyn Fn(&'static str) -> &'static str) -> String {
        let values: Vec<String> = self
            .params
            .iter()
            .map(|p| match p {
                Param::Text(t) => t.clone(),
                Param::Message(m) => m.render(text_of),
            })
            .collect();
        fill(text_of(self.key), &values)
    }
}

/// Replaces `{0}` … `{9}` in one pass, so a value that itself contains "{1}" stays as it is
/// (the same placeholders as `$t` in the interface).
fn fill(template: &str, values: &[String]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let index = tail.as_bytes().get(1).filter(|b| b.is_ascii_digit()).map(|b| usize::from(b - b'0'));
        match index {
            Some(i) if tail.as_bytes().get(2) == Some(&b'}') => {
                out.push_str(values.get(i).map_or("", String::as_str));
                rest = &tail[3..];
            }
            _ => {
                out.push('{');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The German text with its parameters filled in (logs, technical details).
impl std::fmt::Display for Message {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.render(&|key| key))
    }
}

impl From<&'static str> for Message {
    fn from(key: &'static str) -> Self {
        Self::new(key)
    }
}

impl From<String> for Param {
    fn from(text: String) -> Self {
        Param::Text(text)
    }
}

impl From<&str> for Param {
    fn from(text: &str) -> Self {
        Param::Text(text.to_string())
    }
}

impl From<&String> for Param {
    fn from(text: &String) -> Self {
        Param::Text(text.clone())
    }
}

impl From<Message> for Param {
    fn from(message: Message) -> Self {
        Param::Message(message)
    }
}

impl From<&Message> for Param {
    fn from(message: &Message) -> Self {
        Param::Message(message.clone())
    }
}

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
    #[serde(flatten)]
    pub message: Message,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Host key information for `HostKeyUnknown` / `HostKeyChanged`; boxed, as it is rare and
    /// would otherwise make every `AppResult` large.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_key: Option<Box<HostKeyInfo>>,
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
    pub fn new(kind: ErrorKind, message: impl Into<Message>) -> Self {
        Self { kind, message: message.into(), detail: None, host_key: None }
    }

    /// Adds the value for the next placeholder of the message (see [`Message::param`]).
    pub fn param(mut self, value: impl Into<Param>) -> Self {
        self.message = self.message.param(value);
        self
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn other(message: impl Into<Message>) -> Self {
        Self::new(ErrorKind::Other, message)
    }

    /// What a system feature answers on a system Bitcrane does not support (CONTRIBUTING rule 3).
    /// Linux builds exist only for development, tests and Clippy, so they get this instead.
    #[cfg(not(any(target_os = "macos", windows)))]
    pub fn unsupported_system() -> Self {
        AppError::other("Das gibt es nur unter macOS und Windows.")
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
            K::ConnectionRefused
            | K::ConnectionReset
            | K::ConnectionAborted
            | K::TimedOut
            | K::HostUnreachable
            | K::NetworkUnreachable => ErrorKind::Unreachable,
            _ => ErrorKind::Other,
        };
        let message = match kind {
            ErrorKind::NotFound => Message::new("Datei oder Ordner nicht gefunden."),
            ErrorKind::PermissionDenied => Message::new("Keine Berechtigung."),
            ErrorKind::AlreadyExists => Message::new("Das gibt es dort schon."),
            ErrorKind::Unreachable => Message::new("Der Server ist nicht erreichbar."),
            _ => Message::new("Unerwarteter Fehler."),
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
                    // Reading and writing both end here, so the message must not say "write".
                    S::PermissionDenied => (ErrorKind::PermissionDenied, "Keine Berechtigung."),
                    S::NoConnection | S::ConnectionLost => (ErrorKind::ConnectionLost, "Verbindung unterbrochen"),
                    _ => (ErrorKind::Other, "Der Server meldet einen Fehler."),
                };
                AppError::new(kind, message).with_detail(status.error_message.clone())
            }
            E::Timeout => {
                AppError::new(ErrorKind::ConnectionLost, "Der Server antwortet nicht.").with_detail(e.to_string())
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_reach_the_interface_as_key_and_parameters() {
        let what = Message::new("„{0}“ lesen").param("a {1}.txt");
        let e = AppError::new(ErrorKind::NotFound, "{0}: nicht gefunden.").param(&what).with_detail("404");
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({
                "kind": "notFound",
                "key": "{0}: nicht gefunden.",
                "params": [{ "key": "„{0}“ lesen", "params": ["a {1}.txt"] }],
                "detail": "404",
            })
        );
        let plain = serde_json::to_value(AppError::other("Unerwarteter Fehler.")).unwrap();
        assert_eq!(plain, serde_json::json!({ "kind": "other", "key": "Unerwarteter Fehler." }));
    }

    #[test]
    fn messages_render_in_german_and_english() {
        let e = AppError::new(ErrorKind::NotFound, "{0}: nicht gefunden.")
            .param(Message::new("„{0}“ lesen").param("Abbrechen {1}.txt"));
        // The file name is never translated, and "{1}" inside it is not a placeholder.
        assert_eq!(e.message.to_string(), "„Abbrechen {1}.txt“ lesen: nicht gefunden.");
        assert_eq!(e.message.english(), "Reading “Abbrechen {1}.txt”: not found.");
        assert_eq!(e.to_string(), "NotFound: „Abbrechen {1}.txt“ lesen: nicht gefunden.");
        // A placeholder without a value stays empty instead of showing "{2}".
        assert_eq!(Message::new("{0} und {2}").param("a").to_string(), "a und ");
    }
}
