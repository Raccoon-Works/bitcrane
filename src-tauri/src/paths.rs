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

/// Windows Explorer folder of a mounted server (`mount_win.rs`): path below
/// `root` as a server path below `remote_root`; `None` outside the folder.
pub fn sync_root_to_remote(root: &Path, remote_root: &str, local: &Path) -> Option<String> {
    let root_s = root.to_string_lossy().trim_end_matches('\\').to_lowercase();
    let local_s = local.to_string_lossy().to_string();
    // Windows may report the path with a "\\?\" prefix or different letter case.
    let plain = local_s.strip_prefix(r"\\?\").unwrap_or(&local_s);
    if !plain.to_lowercase().starts_with(&root_s) {
        return None;
    }
    let rest = &plain[root_s.len()..];
    if !(rest.is_empty() || rest.starts_with('\\')) {
        return None;
    }
    let mut out = remote_root.to_string();
    for seg in rest.split('\\').filter(|s| !s.is_empty()) {
        out = remote_join(&out, seg);
    }
    Some(out)
}

#[cfg(test)]
mod sync_root_tests {
    use super::sync_root_to_remote as to_remote;
    use std::path::{Path, PathBuf};

    #[test]
    fn maps_explorer_paths_to_the_server() {
        let root = PathBuf::from(r"C:\Users\c\Bitcrane\Web");
        assert_eq!(to_remote(&root, "/var/www", Path::new(r"C:\Users\c\Bitcrane\Web\a\b.txt")).as_deref(), Some("/var/www/a/b.txt"));
        assert_eq!(to_remote(&root, "/var/www", Path::new(r"\\?\c:\users\c\bitcrane\web")).as_deref(), Some("/var/www"));
        assert_eq!(to_remote(&root, "/", Path::new(r"C:\Users\c\Bitcrane\Webseite\x")), None);
        assert_eq!(to_remote(&root, "/", Path::new(r"C:\Users\c\Bitcrane\Web\x")).as_deref(), Some("/x"));
    }
}
