//! Zip archives on this computer: "Komprimieren" packs files and folders into
//! one .zip next to them, "Entpacken" unpacks a .zip into a new folder next to
//! it (taken over from ForkLift). Nothing existing is ever overwritten: clashing
//! names get " Kopie" like copies do.

use crate::error::{AppError, AppResult};
use crate::local::{copy_name, NameWords};
use crate::paths::to_native;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

fn zip_error(e: impl ToString) -> AppError {
    AppError::other("Das Archiv konnte nicht geschrieben werden.").with_detail(e.to_string())
}

/// Packs `paths` (all in one folder) into a zip next to them. One item becomes
/// "name.zip", several become "Archiv.zip" (in the interface language). Returns the name of the
/// archive.
pub fn compress(paths: &[String], words: &NameWords) -> AppResult<String> {
    let items: Vec<PathBuf> = paths.iter().map(|p| to_native(p)).collect();
    let first = items.first().ok_or_else(|| AppError::other("Nichts ausgewählt."))?;
    let dir = first.parent().map(Path::to_path_buf).ok_or_else(|| AppError::other("Ordner nicht gefunden."))?;
    let base = match (items.len(), first.file_name()) {
        (1, Some(name)) => format!("{}.zip", name.to_string_lossy()),
        _ => format!("{}.zip", words.archive),
    };
    let name = copy_name(|n| dir.join(n).exists(), &base, words);
    let target = dir.join(&name);
    let result = write_zip(&items, &target);
    if result.is_err() {
        // No half-written archive is left behind.
        let _ = fs::remove_file(&target);
    }
    result.map(|_| name)
}

fn write_zip(items: &[PathBuf], target: &Path) -> AppResult<()> {
    let file = fs::File::create(target).map_err(zip_error)?;
    let mut zip = zip::ZipWriter::new(io::BufWriter::new(file));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
    let mut buf = vec![0u8; 256 * 1024];
    for item in items {
        let root = item.parent().unwrap_or(Path::new(""));
        for entry in WalkDir::new(item).follow_links(false) {
            let entry = entry.map_err(zip_error)?;
            let rel = entry.path().strip_prefix(root).map_err(zip_error)?;
            // Zip paths always use "/".
            let name = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            let kind = entry.file_type();
            if kind.is_dir() {
                zip.add_directory(format!("{name}/"), options).map_err(zip_error)?;
            } else if kind.is_file() {
                // Unix keeps the file's permissions in the archive.
                #[cfg(unix)]
                let opts = {
                    use std::os::unix::fs::PermissionsExt;
                    match entry.metadata() {
                        Ok(meta) => options.unix_permissions(meta.permissions().mode() & 0o777),
                        Err(_) => options,
                    }
                };
                #[cfg(not(unix))]
                let opts = options;
                zip.start_file(name, opts).map_err(zip_error)?;
                let mut f = fs::File::open(entry.path()).map_err(zip_error)?;
                loop {
                    let n = f.read(&mut buf).map_err(zip_error)?;
                    if n == 0 {
                        break;
                    }
                    zip.write_all(&buf[..n]).map_err(zip_error)?;
                }
            }
            // Links and special files are left out (a zip cannot carry them portably).
        }
    }
    zip.finish().map_err(zip_error)?.flush().map_err(zip_error)?;
    Ok(())
}

/// Unpacks a zip into a new folder next to it (named like the archive) and
/// returns the folder's name. An archive with an entry that could land outside that folder is
/// refused as a whole (see `archive_vfs::safe_entry_path`).
pub fn extract(path: &str, words: &NameWords) -> AppResult<String> {
    let archive = to_native(path);
    // tar and tar.gz: through the archive reader (same "../" protection).
    if !archive.to_string_lossy().to_ascii_lowercase().ends_with(".zip") {
        let dir = archive.parent().map(Path::to_path_buf).ok_or_else(|| AppError::other("Ordner nicht gefunden."))?;
        return crate::archive_vfs::extract(&archive, "", &dir, words);
    }
    let dir = archive.parent().map(Path::to_path_buf).ok_or_else(|| AppError::other("Ordner nicht gefunden."))?;
    let stem = archive.file_stem().map_or_else(|| words.archive.clone(), |n| n.to_string_lossy().into_owned());
    let file = fs::File::open(&archive)
        .map_err(|e| AppError::other("Das Archiv konnte nicht geöffnet werden.").with_detail(e.to_string()))?;
    let mut zip = zip::ZipArchive::new(io::BufReader::new(file))
        .map_err(|e| AppError::other("Das ist kein gültiges Zip-Archiv.").with_detail(e.to_string()))?;
    let name = copy_name(|n| dir.join(n).exists(), &stem, words);
    let out = dir.join(&name);
    fs::create_dir(&out).map_err(|e| {
        AppError::other("Der Ordner zum Entpacken konnte nicht angelegt werden.").with_detail(e.to_string())
    })?;
    let result = (|| -> AppResult<()> {
        for i in 0..zip.len() {
            let mut entry = zip
                .by_index(i)
                .map_err(|e| AppError::other("Das Archiv ist beschädigt.").with_detail(e.to_string()))?;
            let target = out.join(crate::archive_vfs::safe_entry_path(entry.name())?);
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(zip_error_read)?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(zip_error_read)?;
            }
            let mut f = fs::File::create(&target).map_err(zip_error_read)?;
            io::copy(&mut entry, &mut f).map_err(zip_error_read)?;
            #[cfg(unix)]
            if let Some(mode) = entry.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o777));
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&out);
    }
    result.map(|_| name)
}

fn zip_error_read(e: impl ToString) -> AppError {
    AppError::other("Das Archiv konnte nicht entpackt werden.").with_detail(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_and_unpacks_a_folder() {
        let base = std::env::temp_dir().join(format!("bitcrane-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("site/css")).unwrap();
        fs::write(base.join("site/index.html"), "<h1>Hallo</h1>").unwrap();
        fs::write(base.join("site/css/a.css"), "body{}").unwrap();
        let p = base.join("site").to_string_lossy().into_owned();
        let name = compress(&[p], &NameWords::german()).unwrap();
        assert_eq!(name, "site.zip");
        // A second archive does not overwrite the first.
        assert_eq!(
            compress(&[base.join("site").to_string_lossy().into_owned()], &NameWords::german()).unwrap(),
            "site Kopie.zip"
        );
        let folder = extract(&base.join("site.zip").to_string_lossy(), &NameWords::german()).unwrap();
        // "site" exists next to the archive, so it is unpacked into "site Kopie".
        assert_eq!(folder, "site Kopie");
        let out = base.join(&folder);
        assert_eq!(fs::read_to_string(out.join("site/index.html")).unwrap(), "<h1>Hallo</h1>");
        assert_eq!(fs::read_to_string(out.join("site/css/a.css")).unwrap(), "body{}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn made_up_names_follow_the_interface_language() {
        let base = std::env::temp_dir().join(format!("bitcrane-zip-words-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        for name in ["a.txt", "b.txt"] {
            fs::write(base.join(name), name).unwrap();
        }
        let both = ["a.txt", "b.txt"].map(|n| base.join(n).to_string_lossy().into_owned());
        let english = NameWords { copy: "copy".into(), archive: "Archive".into() };
        assert_eq!(compress(&both, &english).unwrap(), "Archive.zip");
        assert_eq!(compress(&both, &english).unwrap(), "Archive copy.zip");
        assert_eq!(compress(&both, &NameWords::german()).unwrap(), "Archiv.zip");
        let _ = fs::remove_dir_all(&base);
    }
}
