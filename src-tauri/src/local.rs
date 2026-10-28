//! Local file system operations.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::model::{perms_string, FileEntry, Place, WalkItem};
use crate::paths::{to_native, to_ui};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn mode_of(meta: &fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    perms_string(meta.permissions().mode())
}

#[cfg(not(unix))]
fn mode_of(meta: &fs::Metadata) -> String {
    // Windows has no Unix permissions; show a sensible equivalent.
    if meta.permissions().readonly() { "444".into() } else if meta.is_dir() { "755".into() } else { "644".into() }
}

fn entry_from(name: String, meta: &fs::Metadata) -> FileEntry {
    FileEntry {
        name,
        kind: if meta.is_dir() { "dir".into() } else { "file".into() },
        size: if meta.is_dir() { 0 } else { meta.len() },
        mtime: mtime_ms(meta),
        perms: mode_of(meta),
        owner: String::new(),
        group: String::new(),
        link: None,
        hidden: 0,
    }
}

/// How the system marks an item as hidden: 0 = not, 1 = hidden, 2 = protected system item.
#[cfg(windows)]
fn hidden_mark(meta: &fs::Metadata) -> u8 {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    let a = meta.file_attributes();
    if a & HIDDEN != 0 && a & SYSTEM != 0 {
        2
    } else if a & HIDDEN != 0 {
        1
    } else {
        0
    }
}

#[cfg(target_os = "macos")]
fn hidden_mark(meta: &fs::Metadata) -> u8 {
    use std::os::macos::fs::MetadataExt;
    // UF_HIDDEN, set e.g. on ~/Library.
    const UF_HIDDEN: u32 = 0x8000;
    u8::from(meta.st_flags() & UF_HIDDEN != 0)
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn hidden_mark(_meta: &fs::Metadata) -> u8 {
    0
}

/// Lists a local folder. Folders first, then files, both case-insensitively sorted.
pub fn list(path: &str) -> AppResult<Vec<FileEntry>> {
    let dir = to_native(path);
    let mut out = Vec::new();
    for item in fs::read_dir(&dir)? {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        // Follow symlinks so linked folders behave like folders.
        let meta = match fs::metadata(item.path()) {
            Ok(m) => m,
            Err(_) => match item.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            },
        };
        let mut entry = entry_from(item.file_name().to_string_lossy().into_owned(), &meta);
        if item.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
            entry.link = Some(fs::read_link(item.path()).map(|t| to_ui(&t)).unwrap_or_default());
        }
        // The item itself (not a link target) carries the hidden marks.
        if let Ok(own) = item.metadata() {
            entry.hidden = hidden_mark(&own);
        }
        out.push(entry);
    }
    out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

pub fn stat(path: &str) -> AppResult<FileEntry> {
    let p = to_native(path);
    let meta = fs::metadata(&p)?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());
    Ok(entry_from(name, &meta))
}

pub fn mkdir(path: &str) -> AppResult<()> {
    fs::create_dir(to_native(path))?;
    Ok(())
}

pub fn rename(path: &str, new_name: &str) -> AppResult<()> {
    if new_name.contains('/') || new_name.contains('\\') {
        return Err(AppError::new(ErrorKind::Other, "Der Name darf keinen Schrägstrich enthalten."));
    }
    let from = to_native(path);
    let to = from.with_file_name(new_name);
    if to.exists() {
        return Err(AppError::new(ErrorKind::AlreadyExists, format!("„{new_name}“ gibt es hier schon.")));
    }
    fs::rename(from, to)?;
    Ok(())
}

/// Moves files or folders to the system trash (never deletes permanently).
pub fn trash(paths: &[String]) -> AppResult<()> {
    let natives: Vec<_> = paths.iter().map(|p| to_native(p)).collect();
    trash::delete_all(&natives).map_err(|e| AppError::other("Konnte nicht in den Papierkorb legen.").with_detail(e.to_string()))
}

/// Recursively lists all files below `path` (or the file itself).
/// `relative` is relative to the parent of `path`, so it starts with the item's own name.
pub fn walk(path: &str) -> AppResult<Vec<WalkItem>> {
    let root = to_native(path);
    let base = root.parent().map(Path::to_path_buf).unwrap_or_else(|| root.clone());
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&root).follow_links(false) {
        let entry = entry.map_err(|e| AppError::other("Ordner konnte nicht gelesen werden.").with_detail(e.to_string()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let meta = entry.metadata().map_err(|e| AppError::other("Datei konnte nicht gelesen werden.").with_detail(e.to_string()))?;
        let rel = entry.path().strip_prefix(&base).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/");
        out.push(WalkItem { path: to_ui(entry.path()), relative: rel, size: meta.len(), mtime: mtime_ms(&meta) });
    }
    Ok(out)
}

/// SHA-256 of a file as hex.
pub fn checksum(path: &str) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = fs::File::open(to_native(path))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

/// Free name for a copy: the name itself, else "name Kopie.ext", "name Kopie 2.ext", ...
pub fn copy_name(exists: impl Fn(&str) -> bool, name: &str) -> String {
    if !exists(name) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1.. {
        let candidate = if n == 1 { format!("{stem} Kopie{ext}") } else { format!("{stem} Kopie {n}{ext}") };
        if !exists(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.is_dir() {
        fs::create_dir(to)?;
        for item in fs::read_dir(from)? {
            let item = item?;
            copy_tree(&item.path(), &to.join(item.file_name()))?;
        }
    } else {
        fs::copy(from, to)?;
    }
    let _ = filetime::set_file_mtime(to, filetime::FileTime::from_last_modification_time(&meta));
    Ok(())
}

/// "Zusammenführen" (Transmit "Merge"): puts the contents of folder `from` into the existing
/// folder `to`. Sub-folders present on both sides are merged as well; a file whose name is
/// already taken is kept next to the existing one as "… Kopie" (nothing is overwritten).
/// With `moving`, entries are moved (renamed) where possible and the emptied source is removed.
fn merge_tree(from: &Path, to: &Path, moving: bool) -> std::io::Result<()> {
    for item in fs::read_dir(from)? {
        let item = item?;
        let src = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        let existing = to.join(&name);
        let src_is_dir = fs::symlink_metadata(&src)?.is_dir();
        if src_is_dir && existing.is_dir() {
            merge_tree(&src, &existing, moving)?;
            continue;
        }
        let target = to.join(copy_name(|n| to.join(n).exists(), &name));
        if !moving || fs::rename(&src, &target).is_err() {
            copy_tree(&src, &target)?;
            if moving {
                if src_is_dir { fs::remove_dir_all(&src)?; } else { fs::remove_file(&src)?; }
            }
        }
    }
    if moving {
        // Everything was moved out; the empty folder goes away (it is not data any more).
        let _ = fs::remove_dir(from);
    }
    Ok(())
}

/// True when `name` exists as a folder in `dest` and `from` is a folder: the case "Zusammenführen" applies to.
fn merges_into(from: &Path, dest: &Path, name: &str) -> bool {
    fs::symlink_metadata(from).map(|m| m.is_dir()).unwrap_or(false) && dest.join(name).is_dir()
}

/// Copies files or folders into `dest_dir` on this computer. Returns the new names.
/// With `merge`, a folder whose name already exists there is merged into it instead of
/// getting a " Kopie" name.
pub fn copy(paths: &[String], dest_dir: &str, merge: bool) -> AppResult<Vec<String>> {
    let dest = to_native(dest_dir);
    let mut out = Vec::new();
    for p in paths {
        let from = to_native(p);
        if dest.starts_with(&from) {
            return Err(AppError::other("Ein Ordner kann nicht in sich selbst kopiert werden."));
        }
        let name = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if merge && merges_into(&from, &dest, &name) {
            merge_tree(&from, &dest.join(&name), false)?;
            out.push(name);
            continue;
        }
        let target = copy_name(|n| dest.join(n).exists(), &name);
        copy_tree(&from, &dest.join(&target))?;
        out.push(target);
    }
    Ok(out)
}

/// Copies one file to an exact target path on this computer, replacing a file
/// that is there (for comparing two local folders). Missing folders are
/// created; the modification time is kept, so the next comparison sees both
/// files as equal.
pub fn copy_file_over(from: &str, to: &str) -> AppResult<()> {
    let (src, dst) = (to_native(from), to_native(to));
    if src == dst {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(&src, &dst)?;
    let meta = fs::metadata(&src)?;
    let _ = filetime::set_file_mtime(&dst, filetime::FileTime::from_last_modification_time(&meta));
    Ok(())
}

/// Moves files or folders into `dest_dir` on this computer. On the same drive
/// this is a rename; across drives the item is copied and the original then
/// goes to the trash (never deleted permanently). A name that already exists
/// in the target gets " Kopie" like a copy. Returns the new names.
pub fn move_into(paths: &[String], dest_dir: &str, merge: bool) -> AppResult<Vec<String>> {
    let dest = to_native(dest_dir);
    let mut out = Vec::new();
    for p in paths {
        let from = to_native(p);
        if dest.starts_with(&from) {
            return Err(AppError::other("Ein Ordner kann nicht in sich selbst verschoben werden."));
        }
        let name = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if merge && merges_into(&from, &dest, &name) {
            merge_tree(&from, &dest.join(&name), true)?;
            out.push(name);
            continue;
        }
        let target = copy_name(|n| dest.join(n).exists(), &name);
        let to = dest.join(&target);
        if fs::rename(&from, &to).is_err() {
            // Different drive: copy, then the original into the trash.
            copy_tree(&from, &to)?;
            trash::delete(&from).map_err(|e| AppError::other("Kopiert, aber das Original konnte nicht in den Papierkorb.").with_detail(e.to_string()))?;
        }
        out.push(target);
    }
    Ok(out)
}

/// Largest image the icons view loads as a preview picture.
const THUMB_MAX_BYTES: u64 = 40 * 1024 * 1024;

/// Image type of a file name for the preview pictures, or None.
fn image_mime(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// Serves a local image for the icons view ("thumb" URI scheme). Only image
/// files up to `THUMB_MAX_BYTES` are answered, so the scheme cannot be used
/// to read other files. `uri_path` is the percent-encoded UI path.
pub fn thumb(uri_path: &str) -> Option<(&'static str, Vec<u8>)> {
    let decoded = percent_encoding::percent_decode_str(uri_path.trim_start_matches('/')).decode_utf8().ok()?;
    let mime = image_mime(&decoded)?;
    let native = to_native(&decoded);
    let meta = fs::metadata(&native).ok()?;
    if !meta.is_file() || meta.len() > THUMB_MAX_BYTES {
        return None;
    }
    Some((mime, fs::read(native).ok()?))
}

/// Standard places for the sidebar (only those that exist).
pub fn places() -> Vec<Place> {
    let mut out = vec![];
    let mut push = |name: &str, p: Option<std::path::PathBuf>| {
        if let Some(p) = p {
            if p.is_dir() {
                out.push(Place { name: name.into(), path: to_ui(&p) });
            }
        }
    };
    // The home folder carries the user's name, like in Explorer and the Finder sidebar
    // (the path row shows the same name).
    let home = dirs::home_dir();
    let home_name = home.as_ref().and_then(|h| h.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Persönlich".into());
    push(&home_name, home);
    push("Schreibtisch", dirs::desktop_dir());
    push("Dokumente", dirs::document_dir());
    push("Downloads", dirs::download_dir());
    out
}

/// Drives and volumes of this computer: C:, D:, USB sticks and network
/// drives on Windows, the mounted volumes on the Mac, mount points on Linux.
pub fn drives() -> Vec<Place> {
    #[allow(unused_mut)]
    let mut out = vec![];
    #[cfg(windows)]
    for letter in b'C'..=b'Z' {
        // A: and B: are floppy letters and are skipped; an empty card reader or
        // DVD drive reports "not a folder" and is left out as well.
        let l = letter as char;
        if Path::new(&format!("{l}:\\")).is_dir() {
            out.push(Place { name: format!("{l}:"), path: format!("{l}:/") });
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(rd) = fs::read_dir("/Volumes") {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            // The start volume appears there as a link to "/".
            let target = fs::canonicalize(e.path()).unwrap_or_else(|_| e.path());
            if target.is_dir() {
                out.push(Place { name, path: to_ui(&target) });
            }
        }
        out.sort_by(|a, b| (a.path != "/").cmp(&(b.path != "/")).then(a.name.cmp(&b.name)));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        out.push(Place { name: "/".into(), path: "/".into() });
        let user = std::env::var("USER").unwrap_or_default();
        for base in [format!("/media/{user}"), format!("/run/media/{user}"), "/mnt".to_string()] {
            if let Ok(rd) = fs::read_dir(&base) {
                for e in rd.flatten() {
                    if e.path().is_dir() {
                        out.push(Place { name: e.file_name().to_string_lossy().into_owned(), path: to_ui(&e.path()) });
                    }
                }
            }
        }
    }
    out
}

/// A cloud storage folder found on this computer (Google Drive, OneDrive,
/// Dropbox, iCloud Drive, Box). Offered as places on the first start, like
/// Transmit does on the Mac.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPlace {
    pub name: String,
    pub path: String,
    /// "gdrive", "onedrive", "dropbox", "icloud", "box" or "other".
    pub service: String,
}

/// Service and display name of a provider folder ("GoogleDrive-a@b.c" -> Google Drive).
fn cloud_kind(folder: &str) -> Option<(&'static str, &'static str)> {
    let f = folder.to_ascii_lowercase();
    if f.starts_with("googledrive") || f == "google drive" || f == "my drive" || f == "meine ablage" {
        Some(("gdrive", "Google Drive"))
    } else if f.starts_with("onedrive") {
        Some(("onedrive", "OneDrive"))
    } else if f.starts_with("dropbox") {
        Some(("dropbox", "Dropbox"))
    } else if f.starts_with("box") {
        Some(("box", "Box"))
    } else if f == "iclouddrive" || f == "icloud drive" {
        Some(("icloud", "iCloud Drive"))
    } else {
        None
    }
}

/// Looks for cloud storage folders in their usual places. Only names of
/// folders are read here; macOS asks for access itself when one is opened.
pub fn cloud_places() -> Vec<CloudPlace> {
    let mut found: Vec<(String, std::path::PathBuf)> = vec![];
    let mut add = |service: &str, p: std::path::PathBuf| {
        if p.is_dir() && !found.iter().any(|(_, q)| q == &p) {
            found.push((service.to_string(), p));
        }
    };
    let home = dirs::home_dir();
    if let Some(home) = &home {
        // macOS 12.3 and later: every File Provider (Google Drive, OneDrive, Dropbox, Box …).
        if let Ok(rd) = fs::read_dir(home.join("Library/CloudStorage")) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }
                add(cloud_kind(&name).map(|k| k.0).unwrap_or("other"), e.path());
            }
        }
        add("icloud", home.join("Library/Mobile Documents/com~apple~CloudDocs"));
        // Older clients and Windows put their folder into the home folder.
        for name in ["Dropbox", "Google Drive", "My Drive", "iCloudDrive"] {
            if let Some((service, _)) = cloud_kind(name) {
                add(service, home.join(name));
            }
        }
        if let Ok(rd) = fs::read_dir(home) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.to_ascii_lowercase().starts_with("onedrive") {
                    add("onedrive", e.path());
                }
            }
        }
    }
    #[cfg(windows)]
    {
        // OneDrive tells its folders through environment variables.
        for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
            if let Ok(v) = std::env::var(var) {
                add("onedrive", std::path::PathBuf::from(v));
            }
        }
        // Dropbox writes its folders into info.json.
        for base in [std::env::var("APPDATA").ok(), std::env::var("LOCALAPPDATA").ok()].into_iter().flatten() {
            if let Ok(text) = fs::read_to_string(Path::new(&base).join("Dropbox").join("info.json")) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    for kind in ["personal", "business"] {
                        if let Some(p) = v.get(kind).and_then(|x| x.get("path")).and_then(|x| x.as_str()) {
                            add("dropbox", std::path::PathBuf::from(p));
                        }
                    }
                }
            }
        }
        // Google Drive for desktop: a drive letter with "My Drive" (streaming)
        // or a "Google Drive" folder on a drive (mirroring).
        for letter in b'C'..=b'Z' {
            let root = std::path::PathBuf::from(format!("{}:\\", letter as char));
            for name in ["My Drive", "Meine Ablage", "Google Drive"] {
                let p = root.join(name);
                if p.is_dir() {
                    add("gdrive", p);
                }
            }
        }
    }
    let mut out: Vec<CloudPlace> = found
        .into_iter()
        .map(|(service, p)| {
            let folder = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let name = match service.as_str() {
                "icloud" => "iCloud Drive".to_string(),
                "other" => folder.split('-').next().unwrap_or(&folder).to_string(),
                _ => cloud_kind(&folder).map(|k| k.1.to_string()).unwrap_or_else(|| folder.clone()),
            };
            CloudPlace { name, path: to_ui(&p), service }
        })
        .collect();
    // Two accounts of one service: tell them apart by the account part of the folder name.
    let names: Vec<String> = out.iter().map(|c| c.name.clone()).collect();
    for c in out.iter_mut() {
        if names.iter().filter(|n| **n == c.name).count() > 1 {
            let folder = c.path.rsplit('/').next().unwrap_or("").to_string();
            if let Some((_, account)) = folder.split_once('-') {
                c.name = format!("{} ({})", c.name, account);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_puts_contents_into_existing_folder() {
        let base = std::env::temp_dir().join(format!("bitcrane-merge-{}", std::process::id()));
        let a = base.join("a/site");
        let b = base.join("b/site");
        fs::create_dir_all(a.join("css")).unwrap();
        fs::create_dir_all(b.join("css")).unwrap();
        fs::write(a.join("index.html"), "new").unwrap();
        fs::write(a.join("css/x.css"), "x").unwrap();
        fs::write(b.join("index.html"), "old").unwrap();
        fs::write(b.join("css/y.css"), "y").unwrap();
        let made = copy(&[to_ui(&a)], &to_ui(&base.join("b")), true).unwrap();
        assert_eq!(made, vec!["site".to_string()]);
        // Both css files side by side, the existing index.html kept, the new one as a copy.
        assert!(b.join("css/x.css").exists() && b.join("css/y.css").exists());
        assert_eq!(fs::read_to_string(b.join("index.html")).unwrap(), "old");
        assert_eq!(fs::read_to_string(b.join("index Kopie.html")).unwrap(), "new");
        // Moving merges as well and removes the emptied source.
        fs::create_dir_all(base.join("c/site/js")).unwrap();
        fs::write(base.join("c/site/js/app.js"), "a").unwrap();
        move_into(&[to_ui(&base.join("c/site"))], &to_ui(&base.join("b")), true).unwrap();
        assert!(b.join("js/app.js").exists() && !base.join("c/site").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn move_into_renames_and_keeps_both_on_clash() {
        let base = std::env::temp_dir().join(format!("bitcrane-move-{}", std::process::id()));
        let (a, b) = (base.join("a"), base.join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("x.txt"), "1").unwrap();
        fs::write(b.join("x.txt"), "2").unwrap();
        let made = move_into(&[to_ui(&a.join("x.txt"))], &to_ui(&b), false).unwrap();
        assert_eq!(made, vec!["x Kopie.txt".to_string()]);
        assert!(!a.join("x.txt").exists());
        assert_eq!(fs::read_to_string(b.join("x.txt")).unwrap(), "2");
        assert_eq!(fs::read_to_string(b.join("x Kopie.txt")).unwrap(), "1");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn cloud_folder_names() {
        assert_eq!(cloud_kind("GoogleDrive-someone@example.com").map(|k| k.0), Some("gdrive"));
        assert_eq!(cloud_kind("OneDrive-Personal").map(|k| k.1), Some("OneDrive"));
        assert_eq!(cloud_kind("Dropbox").map(|k| k.0), Some("dropbox"));
        assert_eq!(cloud_kind("iCloudDrive").map(|k| k.0), Some("icloud"));
        assert_eq!(cloud_kind("Projekte"), None);
    }

    #[test]
    fn list_rename_walk() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_string_lossy().replace('\\', "/");
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("b.txt"), "hello").unwrap();
        fs::write(dir.path().join("sub/a.py"), "print(1)").unwrap();

        let l = list(&base).unwrap();
        assert_eq!(l[0].name, "sub");
        assert_eq!(l[0].kind, "dir");
        assert_eq!(l[1].size, 5);

        rename(&format!("{base}/b.txt"), "c.txt").unwrap();
        assert!(dir.path().join("c.txt").exists());

        let w = walk(&format!("{base}/sub")).unwrap();
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].relative, "sub/a.py");

        // Copies: a clash gets "Kopie", folders are copied with content, never into themselves.
        assert_eq!(copy(&[format!("{base}/c.txt")], &base, false).unwrap(), vec!["c Kopie.txt".to_string()]);
        assert_eq!(copy(&[format!("{base}/c.txt")], &base, false).unwrap(), vec!["c Kopie 2.txt".to_string()]);
        assert_eq!(copy(&[format!("{base}/sub")], &base, false).unwrap(), vec!["sub Kopie".to_string()]);
        assert!(dir.path().join("sub Kopie/a.py").exists());
        assert!(copy(&[format!("{base}/sub")], &format!("{base}/sub"), false).is_err());
    }
}
