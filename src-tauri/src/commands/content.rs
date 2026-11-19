//! File contents for the text view, the built-in editor and the preview.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::{archive_vfs, local, paths, AppState};
use serde::Serialize;
use tauri::{Manager, State};

/// Local working copy of a server file that is opened in an editor:
/// <cache>/edit/<server id>/<path on the server>.
#[tauri::command]
pub(crate) fn edit_temp_path(app: tauri::AppHandle, server_id: String, remote_path: String) -> AppResult<String> {
    let base =
        app.path().app_cache_dir().map_err(|e| AppError::other("Kein Cache-Ordner.").with_detail(e.to_string()))?;
    let mut p = base.join("edit").join(server_id.replace(['/', '\\', ':'], "_"));
    for seg in remote_path.split('/').filter(|s| !s.is_empty() && *s != "..") {
        p.push(paths::storable_name(seg));
    }
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    Ok(paths::to_ui(&p))
}

/// Largest file shown in the difference view and the text preview.
const TEXT_LIMIT: usize = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextContent {
    text: String,
    /// True when the file is longer than the limit and was cut off.
    truncated: bool,
}

/// Turns raw bytes into text; files with NUL bytes count as binary.
fn bytes_to_text(mut bytes: Vec<u8>) -> AppResult<TextContent> {
    let truncated = bytes.len() > TEXT_LIMIT;
    bytes.truncate(TEXT_LIMIT);
    if bytes.contains(&0) {
        return Err(AppError::other("Das ist keine Textdatei; Unterschiede lassen sich nur bei Text anzeigen."));
    }
    Ok(TextContent { text: String::from_utf8_lossy(&bytes).into_owned(), truncated })
}

#[tauri::command]
pub(crate) async fn local_read_text(path: String) -> AppResult<TextContent> {
    use tokio::io::AsyncReadExt;
    if let Some((archive, inner)) = archive_vfs::split(&path) {
        return bytes_to_text(archive_vfs::read(&archive, &inner, TEXT_LIMIT + 1)?);
    }
    let file = tokio::fs::File::open(paths::to_native(&path)).await?;
    let mut buf = Vec::new();
    file.take(TEXT_LIMIT as u64 + 1).read_to_end(&mut buf).await?;
    bytes_to_text(buf)
}

#[tauri::command]
pub(crate) async fn remote_read_text(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
) -> AppResult<TextContent> {
    let bytes = remote!(state, server_id, |c| c.read_head(&path, TEXT_LIMIT + 1))?;
    bytes_to_text(bytes)
}

/// Largest file the built-in editor opens (larger files are better served by a
/// download and a desktop editor; the editor stays fast this way).
const EDITOR_LIMIT: usize = 24 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorFile {
    text: String,
    /// Modification time when read (ms), to notice changes by others before saving.
    mtime: i64,
    /// Line ending found in the file, kept when saving: "\r\n", "\n", or "mixed", in which case
    /// `text` keeps every "\r" and is written back exactly as edited.
    eol: String,
    /// The file started with a UTF-8 byte order mark, kept when saving.
    bom: bool,
    /// "utf8", or "latin1" for a file that is not valid UTF-8; saved in the same encoding.
    encoding: &'static str,
}

/// The line ending of a text: "\r\n" or "\n" when all breaks agree, else "mixed".
fn line_ending(text: &str) -> &'static str {
    let crlf = text.matches("\r\n").count();
    match (crlf, text.matches('\n').count()) {
        (0, _) => "\n",
        (c, n) if c == n => "\r\n",
        _ => "mixed",
    }
}

/// The bytes the editor saves: the text with the file's line ending, encoding and byte order mark.
fn editor_bytes(text: &str, eol: &str, bom: bool, encoding: &str) -> AppResult<Vec<u8>> {
    let body = match eol {
        "mixed" => text.to_string(),
        "\r\n" => text.replace("\r\n", "\n").replace('\n', "\r\n"),
        _ => text.replace("\r\n", "\n"),
    };
    let mut bytes = Vec::with_capacity(body.len() + 3);
    if bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    if encoding == "latin1" {
        for c in body.chars() {
            let b = u8::try_from(u32::from(c)).map_err(|_| {
                AppError::other("Die Datei ist in Latin-1 gespeichert; „{0}“ lässt sich darin nicht speichern.")
                    .param(c.to_string())
            })?;
            bytes.push(b);
        }
    } else {
        bytes.extend_from_slice(body.as_bytes());
    }
    Ok(bytes)
}

fn editor_text(mut bytes: Vec<u8>, mtime: i64) -> AppResult<EditorFile> {
    if bytes.len() > EDITOR_LIMIT {
        return Err(AppError::other("Die Datei ist zu groß für den eingebauten Editor (über 24 MB)."));
    }
    // Binary files (NUL bytes in the first part) are not opened as text.
    if bytes.iter().take(64 * 1024).any(|&b| b == 0) {
        return Err(AppError::other("Das ist keine Textdatei; der Editor öffnet nur Text."));
    }
    let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    if bom {
        bytes.drain(..3);
    }
    let (text, encoding) = match String::from_utf8(bytes) {
        Ok(t) => (t, "utf8"),
        // Not UTF-8: read as Latin-1 (every byte is one character), and saved the same way.
        Err(e) => (e.into_bytes().iter().map(|&b| b as char).collect(), "latin1"),
    };
    let eol = line_ending(&text);
    let text = if eol == "mixed" { text } else { text.replace("\r\n", "\n") };
    Ok(EditorFile { text, mtime, eol: eol.to_string(), bom, encoding })
}

/// Reads a file for the built-in editor: of this computer (no server) or of a server.
#[tauri::command]
pub(crate) async fn editor_read(
    state: State<'_, AppState>,
    server_id: Option<String>,
    path: String,
) -> AppResult<EditorFile> {
    match server_id.filter(|s| !s.is_empty()) {
        None => {
            let native = paths::to_native(&path);
            let md = tokio::fs::metadata(&native).await?;
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if md.len() as usize > EDITOR_LIMIT {
                return Err(AppError::other("Die Datei ist zu groß für den eingebauten Editor (über 24 MB)."));
            }
            editor_text(tokio::fs::read(&native).await?, mtime)
        }
        Some(sid) => {
            let st = remote!(state, sid, |c| c.stat(&path))?;
            if st.size as usize > EDITOR_LIMIT {
                return Err(AppError::other("Die Datei ist zu groß für den eingebauten Editor (über 24 MB)."));
            }
            let bytes = remote!(state, sid, |c| c.read_head(&path, EDITOR_LIMIT + 1))?;
            editor_text(bytes, st.mtime)
        }
    }
}

/// Modification time of a file (ms), to check for changes by others before saving.
#[tauri::command]
pub(crate) async fn editor_mtime(
    state: State<'_, AppState>,
    server_id: Option<String>,
    path: String,
) -> AppResult<i64> {
    match server_id.filter(|s| !s.is_empty()) {
        None => {
            let md = tokio::fs::metadata(paths::to_native(&path)).await?;
            Ok(md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0))
        }
        Some(sid) => Ok(remote!(state, sid, |c| c.stat(&path))?.mtime),
    }
}

/// Saves the editor's text, with the file's own line ending, encoding and byte
/// order mark, and returns the new modification time. Writes in place, so
/// permissions and owner of a server file stay as they were.
#[tauri::command]
pub(crate) async fn editor_write(
    state: State<'_, AppState>,
    server_id: Option<String>,
    path: String,
    text: String,
    eol: String,
    bom: bool,
    encoding: String,
) -> AppResult<i64> {
    use tokio::io::AsyncWriteExt;
    let bytes = editor_bytes(&text, &eol, bom, &encoding)?;
    match server_id.filter(|s| !s.is_empty()) {
        None => {
            let native = paths::to_native(&path);
            tokio::fs::write(&native, &bytes).await?;
            let md = tokio::fs::metadata(&native).await?;
            Ok(md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0))
        }
        Some(sid) => {
            let len = bytes.len() as u64;
            let mut w = remote!(state, sid, |c| c.writer(&path, 0, Some(len), None))?;
            w.write_all(&bytes).await.map_err(|e| {
                AppError::new(ErrorKind::ConnectionLost, "Speichern auf dem Server fehlgeschlagen.")
                    .with_detail(e.to_string())
            })?;
            w.close().await?;
            Ok(remote!(state, sid, |c| c.stat(&path)).map(|st| st.mtime).unwrap_or(0))
        }
    }
}

/// Largest image shown in the preview.
const IMAGE_LIMIT: usize = 8 * 1024 * 1024;

/// Text shown in the preview (the start of longer files).
const PREVIEW_TEXT_LIMIT: usize = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    /// "text", "image" or "binary".
    kind: &'static str,
    /// MIME type for images.
    mime: String,
    /// Text, or base64 of the image bytes.
    data: String,
    truncated: bool,
}

fn make_preview(path: &str, mut bytes: Vec<u8>) -> Preview {
    use base64::Engine;
    if let Some(mime) = local::image_mime(path) {
        let truncated = bytes.len() > IMAGE_LIMIT;
        if truncated {
            return Preview { kind: "binary", mime: mime.into(), data: String::new(), truncated };
        }
        return Preview {
            kind: "image",
            mime: mime.into(),
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            truncated: false,
        };
    }
    let truncated = bytes.len() > PREVIEW_TEXT_LIMIT;
    bytes.truncate(PREVIEW_TEXT_LIMIT);
    // Text if there are no NUL bytes in the first part and it is mostly valid UTF-8.
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Preview { kind: "binary", mime: String::new(), data: String::new(), truncated };
    }
    Preview { kind: "text", mime: String::new(), data: String::from_utf8_lossy(&bytes).into_owned(), truncated }
}

#[tauri::command]
pub(crate) async fn local_preview(path: String) -> AppResult<Preview> {
    use tokio::io::AsyncReadExt;
    let limit = if local::image_mime(&path).is_some() { IMAGE_LIMIT } else { PREVIEW_TEXT_LIMIT };
    if let Some((archive, inner)) = archive_vfs::split(&path) {
        return Ok(make_preview(&path, archive_vfs::read(&archive, &inner, limit + 1)?));
    }
    let file = tokio::fs::File::open(paths::to_native(&path)).await?;
    let mut buf = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut buf).await?;
    Ok(make_preview(&path, buf))
}

/// Largest server file loaded for playing in the preview.
const MEDIA_LIMIT: u64 = 500 * 1024 * 1024;

/// Copies a PDF, audio or video file from the server into a temporary file
/// (kept until Bitcrane ends) and returns its path for the "media" scheme.
#[tauri::command]
pub(crate) async fn remote_media(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let entry = remote!(state, server_id, |c| c.stat(&path))?;
    if entry.size > MEDIA_LIMIT {
        return Err(AppError::other("Die Datei ist für eine Vorschau zu groß (über 500 MB). Bitte herunterladen."));
    }
    let name = crate::paths::remote_name(&path);
    let dir = std::env::temp_dir().join("bitcrane-preview");
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(format!("{}-{}", uuid::Uuid::new_v4().simple(), paths::storable_name(&name)));
    let conn = state.conn(&server_id).await?;
    let mut reader = conn.reader(&path, 0).await?;
    let mut file = tokio::fs::File::create(&target).await?;
    // The size above is the server's word; the copy keeps to the limit itself.
    let copied = tokio::io::copy(&mut (&mut reader).take(MEDIA_LIMIT + 1), &mut file).await;
    reader.close(copied.is_ok()).await?;
    if copied? > MEDIA_LIMIT {
        drop(file);
        let _ = tokio::fs::remove_file(&target).await;
        return Err(AppError::other("Die Datei ist für eine Vorschau zu groß (über 500 MB). Bitte herunterladen."));
    }
    file.flush().await?;
    Ok(paths::to_ui(&target))
}

#[tauri::command]
pub(crate) async fn remote_preview(state: State<'_, AppState>, server_id: String, path: String) -> AppResult<Preview> {
    let limit = if local::image_mime(&path).is_some() { IMAGE_LIMIT } else { PREVIEW_TEXT_LIMIT };
    let bytes = remote!(state, server_id, |c| c.read_head(&path, limit + 1))?;
    Ok(make_preview(&path, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the editor opens and saves unchanged must give back the same bytes.
    fn round_trip(bytes: &[u8]) -> Vec<u8> {
        let f = editor_text(bytes.to_vec(), 0).unwrap();
        editor_bytes(&f.text, &f.eol, f.bom, f.encoding).unwrap()
    }

    #[test]
    fn saving_keeps_line_endings_encoding_and_bom() {
        for bytes in [
            &b"a\nb\n"[..],
            b"a\r\nb\r\n",
            b"a\nb\r\nc\n",
            b"\xEF\xBB\xBFa\r\nb",
            b"Gr\xFC\xDFe\r\nende",
            "Grüße\n".as_bytes(),
        ] {
            assert_eq!(round_trip(bytes), bytes, "{bytes:?}");
        }
    }

    #[test]
    fn line_endings_are_read_as_they_are() {
        let lf = editor_text(b"a\nb".to_vec(), 0).unwrap();
        let crlf = editor_text(b"a\r\nb".to_vec(), 0).unwrap();
        let mixed = editor_text(b"a\nb\r\nc".to_vec(), 0).unwrap();
        assert_eq!((lf.eol.as_str(), crlf.eol.as_str(), crlf.text.as_str()), ("\n", "\r\n", "a\nb"));
        assert_eq!((mixed.eol.as_str(), mixed.text.as_str()), ("mixed", "a\nb\r\nc"));
        // Switching a mixed file to one ending normalises every line.
        assert_eq!(editor_bytes("a\nb\r\nc", "\r\n", false, "utf8").unwrap(), b"a\r\nb\r\nc");
        assert_eq!(editor_bytes("a\nb\r\nc", "\n", false, "utf8").unwrap(), b"a\nb\nc");
    }

    #[test]
    fn latin1_files_stay_latin1() {
        let f = editor_text(b"caf\xE9".to_vec(), 0).unwrap();
        assert_eq!((f.text.as_str(), f.encoding), ("café", "latin1"));
        assert!(editor_bytes("5 €", "\n", false, "latin1").is_err(), "€ has no Latin-1 byte");
    }

    #[test]
    fn previews_refuse_binary_and_mark_long_texts() {
        assert!(bytes_to_text(b"a\0b".to_vec()).is_err());
        let long = bytes_to_text(vec![b'x'; TEXT_LIMIT + 1]).unwrap();
        assert!(long.truncated && long.text.len() == TEXT_LIMIT);
        assert!(editor_text(b"\0".to_vec(), 0).is_err());
    }
}
