//! Conversion between UI paths and native paths.
//!
//! The user interface always uses forward slashes. Local paths below the
//! user's home folder start with `~` (e.g. `~/Projekte/taskbot`); other local
//! paths are absolute (`/Volumes/Data` on macOS, `D:/Daten` on Windows).
//! Remote paths are plain POSIX paths.

use std::path::{Path, PathBuf};

/// Returns the user's home folder.
pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Converts a UI path into a native path on this computer.
pub fn to_native(ui_path: &str) -> PathBuf {
    if ui_path == "~" {
        return home();
    }
    if let Some(rest) = ui_path.strip_prefix("~/") {
        let mut p = home();
        for seg in rest.split('/').filter(|s| !s.is_empty()) {
            p.push(seg);
        }
        return p;
    }
    // On Windows, "D:/x" and "D:\x" both work with PathBuf; normalise separators.
    #[cfg(windows)]
    {
        PathBuf::from(ui_path.replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(ui_path)
    }
}

/// Converts a native path back into the UI form (`~/...` below home).
pub fn to_ui(native: &Path) -> String {
    let home = home();
    if let Ok(rel) = native.strip_prefix(&home) {
        let rel = rel.to_string_lossy().replace('\\', "/");
        return if rel.is_empty() { "~".to_string() } else { format!("~/{rel}") };
    }
    native.to_string_lossy().replace('\\', "/")
}

/// Joins a POSIX parent path and a child name.
pub fn remote_join(parent: &str, name: &str) -> String {
    if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

/// Parent of a POSIX path ("/a/b" -> "/a", "/a" -> "/").
pub fn remote_parent(path: &str) -> String {
    match path.trim_end_matches('/').rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => path[..i].to_string(),
    }
}

/// Last segment of a POSIX path.
pub fn remote_name(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_helpers() {
        assert_eq!(remote_join("/home/ubuntu", "bot.py"), "/home/ubuntu/bot.py");
        assert_eq!(remote_join("/", "etc"), "/etc");
        assert_eq!(remote_parent("/home/ubuntu/bot.py"), "/home/ubuntu");
        assert_eq!(remote_parent("/home"), "/");
        assert_eq!(remote_name("/home/ubuntu/bot.py"), "bot.py");
    }

    #[test]
    fn home_round_trip() {
        let p = to_native("~/Projekte/taskbot");
        assert_eq!(to_ui(&p), "~/Projekte/taskbot");
        assert_eq!(to_ui(&home()), "~");
    }
}
