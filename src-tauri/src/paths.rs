//! Conversion between UI paths and native paths.
//!
//! The user interface always uses forward slashes. Local paths below the
//! user's home folder start with `~` (e.g. `~/Projekte/webshop`); other local
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

/// Last segment of a POSIX path in German quotation marks, for messages ("„bot.py“").
pub fn quoted_name(path: &str) -> String {
    format!("„{}“", remote_name(path))
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
        let p = to_native("~/Projekte/webshop");
        assert_eq!(to_ui(&p), "~/Projekte/webshop");
        assert_eq!(to_ui(&home()), "~");
    }
}

/// Windows Explorer folder of a mounted server (`mount_win.rs`): path below `root` as a server
/// path below `remote_root`, with the server's names (`real_name`); `None` outside the folder.
#[cfg(any(windows, test))]
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
        out = remote_join(&out, &real_name(seg));
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
        assert_eq!(
            to_remote(&root, "/var/www", Path::new(r"C:\Users\c\Bitcrane\Web\a\b.txt")).as_deref(),
            Some("/var/www/a/b.txt")
        );
        assert_eq!(
            to_remote(&root, "/var/www", Path::new(r"\\?\c:\users\c\bitcrane\web")).as_deref(),
            Some("/var/www")
        );
        assert_eq!(to_remote(&root, "/", Path::new(r"C:\Users\c\Bitcrane\Webseite\x")), None);
        assert_eq!(to_remote(&root, "/", Path::new(r"C:\Users\c\Bitcrane\Web\x")).as_deref(), Some("/x"));
    }
}

/// A name from a server as a file name this computer can store. On Windows, forbidden
/// characters, a dot or space at the end and the first letter of reserved names are written as
/// %XX, as WinSCP does ("a:b.txt" becomes "a%3Ab.txt"); elsewhere the name is kept.
/// `real_name` reverses it. This pair is the only definition of the rule: the interface receives
/// both forms with every walked file (`WalkItem`) and every watched change (`WatchedFile`).
pub fn storable_name(name: &str) -> String {
    if cfg!(windows) {
        windows_name(name)
    } else {
        name.to_string()
    }
}

/// Reverses `storable_name`: a file of this computer under the name it has on a server.
pub fn real_name(name: &str) -> String {
    if cfg!(windows) {
        name_from_windows(name)
    } else {
        name.to_string()
    }
}

/// `storable_name` for every segment of a "/"-separated relative path.
pub fn storable_rel(rel: &str) -> String {
    rel.split('/').map(storable_name).collect::<Vec<_>>().join("/")
}

/// `real_name` for every segment of a "/"-separated relative path.
pub fn real_rel(rel: &str) -> String {
    rel.split('/').map(real_name).collect::<Vec<_>>().join("/")
}

fn windows_forbidden(c: char) -> bool {
    "<>:\"|?*\\".contains(c) || c < ' '
}

fn percent(c: char) -> String {
    format!("%{:02X}", c as u32)
}

/// The character of a "%XX" at the start of `s` (upper-case hex, as `percent` writes it).
fn percent_decoded(s: &str) -> Option<char> {
    let hex = s.strip_prefix('%')?.get(..2)?;
    if !hex.bytes().all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b)) {
        return None;
    }
    u8::from_str_radix(hex, 16).ok().map(char::from)
}

/// Device names Windows reserves, with or without an extension ("CON", "con.txt", "COM¹").
fn windows_reserved(name: &str) -> bool {
    let stem = name.split_once('.').map_or(name, |(stem, _)| stem).to_lowercase();
    let numbered = |digits: &str| {
        let mut chars = digits.chars();
        matches!((chars.next(), chars.next()), (Some('1'..='9' | '¹' | '²' | '³'), None))
    };
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || stem.strip_prefix("com").or_else(|| stem.strip_prefix("lpt")).is_some_and(numbered)
}

/// The Windows rule of `storable_name` itself (separate so it is tested on every system).
fn windows_name(name: &str) -> String {
    let mut out: String = name.chars().map(|c| if windows_forbidden(c) { percent(c) } else { c.to_string() }).collect();
    if let Some(last) = out.chars().last().filter(|c| matches!(c, '.' | ' ')) {
        out.pop();
        out.push_str(&percent(last));
    }
    if windows_reserved(&out) {
        // Reserved names start with an ASCII letter, so index 0 is a whole character.
        let first = out.remove(0);
        out.insert_str(0, &percent(first));
    }
    out
}

/// Reverses `windows_name` for exactly what it encodes; any other "%" stays, so a file named
/// "100%41" on this computer keeps that name on the server.
fn name_from_windows(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut rest = name;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        match percent_decoded(tail).filter(|c| windows_forbidden(*c)) {
            Some(c) => {
                out.push(c);
                rest = &tail[3..];
            }
            None => {
                out.push('%');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    for (encoded, plain) in [("%2E", '.'), ("%20", ' ')] {
        if let Some(stem) = out.strip_suffix(encoded) {
            out = format!("{stem}{plain}");
        }
    }
    if let Some(first) = percent_decoded(&out) {
        let restored = format!("{first}{}", &out[3..]);
        if windows_reserved(&restored) {
            out = restored;
        }
    }
    out
}

#[cfg(test)]
mod windows_name_tests {
    use super::{name_from_windows, windows_name};

    #[test]
    fn encodes_characters_windows_forbids() {
        assert_eq!(windows_name("a:b.txt"), "a%3Ab.txt");
        assert_eq!(windows_name("2026-11-18 12:00.log"), "2026-11-18 12%3A00.log");
        assert_eq!(windows_name("what?.txt"), "what%3F.txt");
        assert_eq!(windows_name("tab\tname"), "tab%09name");
        assert_eq!(windows_name(r"..\evil"), "..%5Cevil");
        assert_eq!(windows_name("C:x"), "C%3Ax");
        assert_eq!(windows_name("ok.txt"), "ok.txt");
    }

    #[test]
    fn encodes_a_trailing_dot_or_space() {
        assert_eq!(windows_name("Name."), "Name%2E");
        assert_eq!(windows_name("name "), "name%20");
    }

    #[test]
    fn encodes_the_first_letter_of_reserved_names() {
        assert_eq!(windows_name("CON"), "%43ON");
        assert_eq!(windows_name("con.txt"), "%63on.txt");
        assert_eq!(windows_name("lpt1"), "%6Cpt1");
        assert_eq!(windows_name("com1"), "%63om1");
        assert_eq!(windows_name("COM¹.log"), "%43OM¹.log");
        assert_eq!(windows_name("console.txt"), "console.txt");
        assert_eq!(windows_name("com0"), "com0");
        assert_eq!(windows_name("com10"), "com10");
    }

    #[test]
    fn leaves_other_percent_signs_alone_in_both_directions() {
        assert_eq!(windows_name("100%41"), "100%41");
        assert_eq!(name_from_windows("100%41"), "100%41");
        assert_eq!(name_from_windows("%41BC"), "%41BC");
        assert_eq!(name_from_windows("a%2Eb"), "a%2Eb");
        assert_eq!(name_from_windows("50%"), "50%");
        assert_eq!(name_from_windows("%3a"), "%3a");
    }

    #[test]
    fn round_trips_the_names_it_encodes() {
        let names = ["a:b", "q?*<>|\"", "CON", "con.txt", "lpt1.log", "COM²", "x.", "a b ", r"back\slash", "plain.txt"];
        for name in names {
            assert_eq!(name_from_windows(&windows_name(name)), name);
        }
    }
}
