//! Preview pictures for the icons view: the "thumb" URI scheme serves local images, "rthumb"
//! images on a server.
//!
//! Server pictures are only requested when the user turned them on (each one means reading the
//! file from the server). They are limited to `REMOTE_MAX_BYTES`, read at most `PARALLEL` at a
//! time so a folder full of photos does not crowd out transfers, and kept for the session in a
//! temporary folder that is cleared at start (see `CACHE_DIR`), so scrolling back costs nothing.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use tokio::sync::Semaphore;

use crate::AppState;

/// Largest server image shown as a preview picture.
const REMOTE_MAX_BYTES: usize = 10 * 1024 * 1024;
/// Server pictures read at the same time.
const PARALLEL: usize = 3;
/// Name of the session cache below the system's temporary folder.
pub const CACHE_DIR: &str = "bitcrane-thumbs";

static PERMITS: Semaphore = Semaphore::const_new(PARALLEL);

/// HTTP answer for the web view: the picture, or 404 when there is none to show.
pub fn response(picture: Option<(&'static str, Vec<u8>)>) -> tauri::http::Response<Vec<u8>> {
    let builder = tauri::http::Response::builder();
    match picture {
        Some((mime, bytes)) => builder.header("Content-Type", mime).header("Cache-Control", "max-age=3600").body(bytes),
        None => builder.status(404).body(Vec::new()),
    }
    .expect("static response headers are valid")
}

/// Picture of an image on a server. `uri_path` is "/<server id>/<server path>", percent-encoded
/// by the interface; `query` carries the file's modification time, so a changed image is read
/// again instead of being served from the cache.
pub async fn remote(state: &AppState, uri_path: &str, query: &str) -> Option<(&'static str, Vec<u8>)> {
    let decoded = percent_encoding::percent_decode_str(uri_path.trim_start_matches('/')).decode_utf8().ok()?;
    let (server_id, path) = decoded.split_once('/')?;
    let mime = crate::local::image_mime(path)?;

    let mut key = DefaultHasher::new();
    (server_id, path, query).hash(&mut key);
    let cached = cache_dir().join(format!("{:016x}", key.finish()));
    if let Ok(bytes) = std::fs::read(&cached) {
        return Some((mime, bytes));
    }

    let _permit = PERMITS.acquire().await.ok()?;
    let conn = state.conn(server_id).await.ok()?;
    let bytes = conn.read_head(path, REMOTE_MAX_BYTES + 1).await.ok()?;
    if bytes.len() > REMOTE_MAX_BYTES {
        return None;
    }
    // A picture that cannot be cached is still shown; it is read again next time.
    if std::fs::create_dir_all(cache_dir()).is_ok() {
        let _ = std::fs::write(&cached, &bytes);
    }
    Some((mime, bytes))
}

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join(CACHE_DIR)
}
