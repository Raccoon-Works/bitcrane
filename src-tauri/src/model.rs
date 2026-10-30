//! Data types shared with the user interface (see `src/backend/types.ts`).

use serde::{Deserialize, Serialize};

/// One entry of a directory listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// "dir" or "file".
    pub kind: String,
    pub size: u64,
    /// Modification time in milliseconds since the Unix epoch.
    pub mtime: i64,
    /// Permission bits as octal string ("644").
    pub perms: String,
    pub owner: String,
    pub group: String,
    /// Target of a symbolic link (the entry itself shows what the link points to).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,    /// Local only: 1 = marked hidden by the system (Windows "hidden"
    /// attribute, macOS "hidden" flag), 2 = protected system item (Windows
    /// "hidden" plus "system", e.g. the old "Anwendungsdaten" junctions).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub hidden: u8,
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
    /// Path relative to the walked folder's parent, using "/" separators.
    pub relative: String,
    pub size: u64,
    pub mtime: i64,
}

/// A local place shown in the sidebar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    pub path: String,
    /// A network share (SMB, AFP, NFS, WebDAV mount or mapped network drive).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub network: bool,
}

/// Formats Unix mode bits as three octal digits.
pub fn perms_string(mode: u32) -> String {
    format!("{:03o}", mode & 0o777)
}
