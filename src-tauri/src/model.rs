//! Data types shared with the user interface (see `src/backend/types.ts`).

use serde::{Deserialize, Serialize};

/// One entry of a directory listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Modification time in milliseconds since the Unix epoch.
    pub mtime: i64,
    /// Permission bits as octal string ("644").
    pub perms: String,
    pub owner: String,
    pub group: String,
    /// Target of a symbolic link (the entry itself shows what the link points to).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// Local only: 1 = marked hidden by the system (Windows "hidden"
    /// attribute, macOS "hidden" flag), 2 = protected system item (Windows
    /// "hidden" plus "system", e.g. the old "Anwendungsdaten" junctions).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub hidden: u8,
}

impl FileEntry {
    /// An entry of a service without owners and permission bits (cloud storage, S3):
    /// folders show as 755 and without a size, files as 644.
    pub fn plain(name: String, dir: bool, size: u64, mtime: i64) -> Self {
        FileEntry {
            name,
            kind: if dir { EntryKind::Dir } else { EntryKind::File },
            size: if dir { 0 } else { size },
            mtime,
            perms: if dir { "755".into() } else { "644".into() },
            owner: String::new(),
            group: String::new(),
            link: None,
            hidden: 0,
        }
    }
}

/// Folder or file; a link is the kind of what it points to, with `FileEntry::link` set.
/// Serialized as "dir" and "file", as the interface and saved data know them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
}

/// Milliseconds since the Unix epoch of an RFC 3339 time, as cloud services and S3 send it;
/// 0 when the time is missing or unreadable, like a listing without times.
pub fn rfc3339_ms(time: Option<&str>) -> i64 {
    time.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map_or(0, |d| d.timestamp_millis())
}

/// Sorts a listing as every pane shows it: folders first, then by name, ignoring case.
pub fn sort_listing(list: &mut [FileEntry]) {
    list.sort_by_key(|e| (e.kind, e.name.to_lowercase()));
}

fn is_zero(v: &u8) -> bool {
    *v == 0
}

/// A file found when walking a folder for a transfer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkItem {
    /// Full UI path of the file.
    pub path: String,
    /// Path relative to the walked folder's parent, using "/" separators, with the names a server
    /// uses: what an upload creates and what both sides of a comparison are matched by.
    pub relative: String,
    /// The same path with the names this computer stores (`paths::storable_name`): what a
    /// download creates. Differs from `relative` only on Windows, for names it cannot store.
    pub local_relative: String,
    pub size: u64,
    pub mtime: i64,
}

impl WalkItem {
    /// A file named as it really is: on a server, or an entry inside an archive.
    pub fn with_real_names(path: String, relative: String, size: u64, mtime: i64) -> Self {
        let local_relative = crate::paths::storable_rel(&relative);
        WalkItem { path, relative, local_relative, size, mtime }
    }

    /// A file of this computer; `stored` is the relative path with the names it has here.
    pub fn with_stored_names(path: String, stored: String, size: u64, mtime: i64) -> Self {
        WalkItem { path, relative: crate::paths::real_rel(&stored), local_relative: stored, size, mtime }
    }
}

/// A local place shown in the sidebar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    /// A standard folder of the system (home, desktop, documents, downloads) whose `name` is the
    /// interface's German text key, so it appears in the user's language.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub standard: bool,
    pub path: String,
    /// A network share (SMB, AFP, NFS, WebDAV mount or mapped network drive).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub network: bool,
    /// Drives only: free space in bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free: Option<u64>,
    /// Windows drives only: the volume label ("GAMES - DATEN"), shown as "GAMES - DATEN (F:)" like Explorer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Formats Unix mode bits as three octal digits.
pub fn perms_string(mode: u32) -> String {
    format!("{:03o}", mode & 0o777)
}

/// A file whose content matches a search ("Inhalt durchsuchen").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    /// Full UI path of the file.
    pub path: String,
    /// Path relative to the searched folder.
    pub rel: String,
    pub size: u64,
    pub mtime: i64,
    /// First matching line (trimmed, shortened) and its number.
    pub line: String,
    pub line_no: u32,
}
