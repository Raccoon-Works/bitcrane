//! Archives as folders (after ForkLift and Commander One): a .zip, .tar,
//! .tar.gz or .tgz on this computer opens like a folder. Paths go on inside
//! the archive ("~/Downloads/site.zip/css/a.css"). Archives are read-only:
//! files can be looked at, previewed, copied out and uploaded (they are
//! extracted first), but nothing inside can be changed.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::local::copy_name;
use crate::model::{FileEntry, WalkItem};
use crate::paths::{to_native, to_ui};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Zip,
    Tar,
    TarGz,
}

fn kind_of(name: &str) -> Option<Kind> {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".zip") {
        Some(Kind::Zip)
    } else if n.ends_with(".tar.gz") || n.ends_with(".tgz") {
        Some(Kind::TarGz)
    } else if n.ends_with(".tar") {
        Some(Kind::Tar)
    } else {
        None
    }
}

/// True for file names Bitcrane opens like a folder.
pub fn is_archive_name(name: &str) -> bool {
    kind_of(name).is_some()
}

/// Splits a path inside an archive into the archive file and the path within
/// it ("" = its top). None for ordinary paths.
pub fn split(path: &str) -> Option<(PathBuf, String)> {
    let native = to_native(path);
    if native.is_dir() {
        return None;
    }
    let mut cur = native.as_path();
    let mut inner: Vec<String> = Vec::new();
    loop {
        let name = cur.file_name()?.to_string_lossy().into_owned();
        if kind_of(&name).is_some() && cur.is_file() {
            inner.reverse();
            return Some((cur.to_path_buf(), inner.join("/")));
        }
        inner.push(name);
        cur = cur.parent()?;
    }
}

fn err(e: impl ToString) -> AppError {
    AppError::other("Das Archiv konnte nicht gelesen werden.").with_detail(e.to_string())
}

/// Refuses a change inside an archive.
pub fn read_only() -> AppError {
    AppError::new(ErrorKind::PermissionDenied, "Archive sind schreibgeschützt. Zum Ändern zuerst entpacken.")
}

/// One entry of the archive: path without leading or trailing "/".
struct Item {
    path: String,
    dir: bool,
    size: u64,
    mtime: i64,
}

fn clean(name: &str) -> String {
    name.replace('\\', "/").trim_start_matches("./").trim_matches('/').to_string()
}

fn tar_reader(archive: &Path, kind: Kind) -> AppResult<Box<dyn Read>> {
    let f = io::BufReader::new(fs::File::open(archive).map_err(err)?);
    Ok(if kind == Kind::TarGz { Box::new(flate2::read::GzDecoder::new(f)) } else { Box::new(f) })
}

/// All entries, with the folders that are only implied by file paths.
fn items(archive: &Path) -> AppResult<Vec<Item>> {
    let kind = kind_of(&archive.to_string_lossy()).ok_or_else(|| err("no archive"))?;
    let mut out: Vec<Item> = Vec::new();
    match kind {
        Kind::Zip => {
            let mut zip = zip::ZipArchive::new(io::BufReader::new(fs::File::open(archive).map_err(err)?)).map_err(err)?;
            for i in 0..zip.len() {
                let e = zip.by_index(i).map_err(err)?;
                let mtime = e
                    .last_modified()
                    .and_then(|d| chrono::NaiveDate::from_ymd_opt(d.year() as i32, d.month() as u32, d.day() as u32).and_then(|day| day.and_hms_opt(d.hour() as u32, d.minute() as u32, d.second() as u32)))
                    // Zip stores the local time of the computer that packed it.
                    .and_then(|t| chrono::TimeZone::from_local_datetime(&chrono::Local, &t).earliest())
                    .map(|t| t.timestamp_millis())
                    .unwrap_or(0);
                out.push(Item { path: clean(e.name()), dir: e.is_dir(), size: e.size(), mtime });
            }
        }
        Kind::Tar | Kind::TarGz => {
            let mut tar = tar::Archive::new(tar_reader(archive, kind)?);
            for e in tar.entries().map_err(err)? {
                let e = e.map_err(err)?;
                let path = clean(&e.path().map_err(err)?.to_string_lossy());
                let h = e.header();
                let dir = h.entry_type().is_dir();
                if !dir && !h.entry_type().is_file() {
                    continue;
                }
                out.push(Item { path, dir, size: h.size().unwrap_or(0), mtime: h.mtime().map(|m| m as i64 * 1000).unwrap_or(0) });
            }
        }
    }
    // Folders named only through their files.
    let mut known: std::collections::HashSet<String> = out.iter().filter(|i| i.dir).map(|i| i.path.clone()).collect();
    let files: Vec<String> = out.iter().map(|i| i.path.clone()).collect();
    for p in files {
        let mut cur = p.as_str();
        while let Some(i) = cur.rfind('/') {
            cur = &cur[..i];
            if known.insert(cur.to_string()) {
                out.push(Item { path: cur.to_string(), dir: true, size: 0, mtime: 0 });
            }
        }
    }
    out.retain(|i| !i.path.is_empty());
    Ok(out)
}

fn entry(name: &str, it: &Item) -> FileEntry {
    FileEntry {
        name: name.to_string(),
        kind: if it.dir { "dir".into() } else { "file".into() },
        size: if it.dir { 0 } else { it.size },
        mtime: it.mtime,
        perms: if it.dir { "555".into() } else { "444".into() },
        owner: String::new(),
        group: String::new(),
        link: None,
        hidden: 0,
    }
}

/// Folder listing inside an archive.
pub fn list(archive: &Path, inner: &str) -> AppResult<Vec<FileEntry>> {
    let all = items(archive)?;
    let prefix = if inner.is_empty() { String::new() } else { format!("{inner}/") };
    if !inner.is_empty() && !all.iter().any(|i| i.dir && i.path == inner) {
        return Err(AppError::new(ErrorKind::NotFound, format!("„{inner}“ gibt es im Archiv nicht.")));
    }
    let mut seen: BTreeMap<String, FileEntry> = BTreeMap::new();
    for it in &all {
        if let Some(rest) = it.path.strip_prefix(&prefix) {
            if !rest.is_empty() && !rest.contains('/') {
                seen.entry(rest.to_string()).or_insert_with(|| entry(rest, it));
            }
        }
    }
    let mut out: Vec<FileEntry> = seen.into_values().collect();
    out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// Details of one entry; the top of the archive counts as a folder.
pub fn stat(archive: &Path, inner: &str) -> AppResult<FileEntry> {
    if inner.is_empty() {
        let name = archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Ok(FileEntry { name, kind: "dir".into(), size: 0, mtime: 0, perms: "555".into(), owner: String::new(), group: String::new(), link: None, hidden: 0 });
    }
    let all = items(archive)?;
    let it = all.iter().find(|i| i.path == inner).ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("„{inner}“ gibt es im Archiv nicht.")))?;
    Ok(entry(inner.rsplit('/').next().unwrap_or(inner), it))
}

/// Calls `f` with the reader of each file whose path is `inner` or lies below it.
fn each_file(archive: &Path, inner: &str, mut f: impl FnMut(&str, &mut dyn Read) -> AppResult<bool>) -> AppResult<()> {
    let kind = kind_of(&archive.to_string_lossy()).ok_or_else(|| err("no archive"))?;
    let under = |p: &str| p == inner || inner.is_empty() || p.starts_with(&format!("{inner}/"));
    match kind {
        Kind::Zip => {
            let mut zip = zip::ZipArchive::new(io::BufReader::new(fs::File::open(archive).map_err(err)?)).map_err(err)?;
            for i in 0..zip.len() {
                let mut e = zip.by_index(i).map_err(err)?;
                let p = clean(e.name());
                if e.is_dir() || !under(&p) {
                    continue;
                }
                if !f(&p, &mut e)? {
                    break;
                }
            }
        }
        Kind::Tar | Kind::TarGz => {
            let mut tar = tar::Archive::new(tar_reader(archive, kind)?);
            for e in tar.entries().map_err(err)? {
                let mut e = e.map_err(err)?;
                if !e.header().entry_type().is_file() {
                    continue;
                }
                let p = clean(&e.path().map_err(err)?.to_string_lossy());
                if !under(&p) {
                    continue;
                }
                if !f(&p, &mut e)? {
                    break;
                }
            }
        }
    }
    Ok(())
}

/// The start of one file (preview, text).
pub fn read(archive: &Path, inner: &str, limit: usize) -> AppResult<Vec<u8>> {
    let mut out: Option<Vec<u8>> = None;
    each_file(archive, inner, |p, r| {
        if p != inner {
            return Ok(true);
        }
        let mut buf = Vec::new();
        r.take(limit as u64).read_to_end(&mut buf).map_err(err)?;
        out = Some(buf);
        Ok(false)
    })?;
    out.ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("„{inner}“ gibt es im Archiv nicht.")))
}

/// Copies an entry (file or folder) out of the archive into `dest_dir`; a
/// clashing name gets " Kopie". Returns the name used.
pub fn extract(archive: &Path, inner: &str, dest_dir: &Path) -> AppResult<String> {
    let base = inner.rsplit('/').next().unwrap_or(inner).to_string();
    let base = if base.is_empty() { archive.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Archiv".into()) } else { base };
    let name = copy_name(|n| dest_dir.join(n).exists(), &base);
    let is_dir = inner.is_empty() || stat(archive, inner)?.kind == "dir";
    let target_root = dest_dir.join(&name);
    if is_dir {
        fs::create_dir_all(&target_root).map_err(err)?;
    }
    each_file(archive, inner, |p, r| {
        let target = if is_dir {
            let rel = if inner.is_empty() { p } else { &p[inner.len() + 1..] };
            // Refuse "../" tricks.
            if rel.split('/').any(|s| s == ".." || s.is_empty()) {
                return Ok(true);
            }
            target_root.join(rel)
        } else {
            target_root.clone()
        };
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let mut out = fs::File::create(&target).map_err(err)?;
        io::copy(r, &mut out).map_err(err)?;
        Ok(true)
    })?;
    Ok(name)
}

/// All files below a folder of the archive (search, folder size).
pub fn walk(archive: &Path, inner: &str, ui_path: &str) -> AppResult<Vec<WalkItem>> {
    let all = items(archive)?;
    let parent_len = inner.rfind('/').map(|i| i + 1).unwrap_or(0);
    let base_ui = ui_path.trim_end_matches('/');
    Ok(all
        .iter()
        .filter(|i| !i.dir && (inner.is_empty() || i.path.starts_with(&format!("{inner}/"))))
        .map(|i| {
            let rel_in = if inner.is_empty() { i.path.as_str() } else { &i.path[inner.len() + 1..] };
            WalkItem {
                path: format!("{base_ui}/{rel_in}"),
                relative: if inner.is_empty() { format!("{}/{}", archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), i.path) } else { i.path[parent_len..].to_string() },
                size: i.size,
                mtime: i.mtime,
            }
        })
        .collect())
}

/// Extracts entries (paths inside archives) into a new temporary folder, so
/// they can be uploaded like ordinary files. Returns the folder and the names.
pub fn extract_to_temp(paths: &[String]) -> AppResult<(String, Vec<String>)> {
    let dir = std::env::temp_dir().join("bitcrane-archive").join(uuid::Uuid::new_v4().simple().to_string());
    fs::create_dir_all(&dir).map_err(err)?;
    let mut names = Vec::new();
    for p in paths {
        let (archive, inner) = split(p).ok_or_else(|| err(format!("{p}: not in an archive")))?;
        names.push(extract(&archive, &inner, &dir)?);
    }
    Ok((to_ui(&dir), names))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_and_tar_open_like_folders() {
        let base = std::env::temp_dir().join(format!("bitcrane-vfs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("site/css")).unwrap();
        fs::write(base.join("site/index.html"), "<h1>Hallo</h1>").unwrap();
        fs::write(base.join("site/css/a.css"), "body{}").unwrap();
        crate::archive::compress(&[base.join("site").to_string_lossy().into_owned()]).unwrap();
        let zip = base.join("site.zip");
        let p = |rest: &str| format!("{}{rest}", zip.to_string_lossy());
        let (a, inner) = split(&p("/site/css")).unwrap();
        assert_eq!((a, inner.as_str()), (zip.clone(), "site/css"));
        let top = list(&zip, "").unwrap();
        assert_eq!(top.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["site"]);
        let site = list(&zip, "site").unwrap();
        assert_eq!(site.iter().map(|e| (e.name.as_str(), e.kind.as_str())).collect::<Vec<_>>(), vec![("css", "dir"), ("index.html", "file")]);
        assert_eq!(read(&zip, "site/index.html", 100).unwrap(), b"<h1>Hallo</h1>");
        let out = base.join("out");
        fs::create_dir_all(&out).unwrap();
        assert_eq!(extract(&zip, "site/css", &out).unwrap(), "css");
        assert_eq!(fs::read_to_string(out.join("css/a.css")).unwrap(), "body{}");
        // tar.gz with an implied folder
        let tgz = base.join("b.tgz");
        {
            let gz = flate2::write::GzEncoder::new(fs::File::create(&tgz).unwrap(), flate2::Compression::default());
            let mut t = tar::Builder::new(gz);
            let mut h = tar::Header::new_gnu();
            h.set_size(3);
            h.set_mode(0o644);
            h.set_cksum();
            t.append_data(&mut h, "docs/x.txt", &b"abc"[..]).unwrap();
            t.into_inner().unwrap().finish().unwrap();
        }
        assert_eq!(list(&tgz, "").unwrap()[0].name, "docs");
        assert_eq!(read(&tgz, "docs/x.txt", 10).unwrap(), b"abc");
        assert!(split(&base.to_string_lossy()).is_none());
        let _ = fs::remove_dir_all(&base);
    }
}
