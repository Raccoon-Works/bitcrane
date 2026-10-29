//! Folder watching.
//!
//! Each watch uses the operating system's file events (FSEvents on macOS,
//! ReadDirectoryChangesW on Windows) through `notify`, debounced by the
//! watch's delay so a burst of saves becomes one batch. Excluded names
//! (".git", "*.log", ...) are filtered here; the upload queue itself lives in
//! the user interface, which receives one event per batch.

use crate::error::{AppError, AppResult};
use crate::paths::{to_native, to_ui};
use globset::{Glob, GlobSet, GlobSetBuilder};
use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// One batch of changes reported to the user interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchBatch {
    pub watch_id: String,
    /// Changed or new files (UI paths).
    pub changed: Vec<String>,
    /// Deleted files or folders (UI paths).
    pub removed: Vec<String>,
    /// Renamed or moved files and folders inside the watched folder: (from, to).
    pub renamed: Vec<(String, String)>,
}

type Handle = Debouncer<notify::RecommendedWatcher, RecommendedCache>;

/// All running watches.
#[derive(Default)]
pub struct Watches {
    running: Mutex<HashMap<String, Handle>>,
}

/// Builds a matcher from patterns like ".git", "__pycache__", "*.log".
/// A pattern matches if any path component matches it.
pub fn build_excludes(patterns: &[String]) -> AppResult<GlobSet> {
    let mut b = GlobSetBuilder::new();
    for p in patterns.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        b.add(Glob::new(p).map_err(|e| AppError::other(format!("Ungültiges Muster „{p}“.")).with_detail(e.to_string()))?);
    }
    // Bitcrane's own temporary upload/download files are never relevant.
    b.add(Glob::new("*.bitcrane-part").unwrap());
    b.build().map_err(|e| AppError::other("Ausschlüsse ungültig.").with_detail(e.to_string()))
}

/// True if any component of `path` below `root` matches the exclude set.
pub fn is_excluded(root: &Path, path: &Path, excludes: &GlobSet) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components().any(|c| excludes.is_match(c.as_os_str()))
}

impl Watches {
    /// Starts (or restarts) a watch. `emit` is called once per debounced batch.
    pub fn start(
        &self,
        watch_id: String,
        local_path: &str,
        recursive: bool,
        excludes: &[String],
        delay_ms: u64,
        emit: impl Fn(WatchBatch) + Send + 'static,
    ) -> AppResult<()> {
        self.stop(&watch_id);
        let root: PathBuf = to_native(local_path);
        if !root.is_dir() {
            return Err(AppError::new(crate::error::ErrorKind::NotFound, "Der lokale Ordner existiert nicht."));
        }
        let set = build_excludes(excludes)?;
        let root_for_cb = root.clone();
        let id = watch_id.clone();
        let mut debouncer = new_debouncer(Duration::from_millis(delay_ms.max(200)), None, move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let mut changed = BTreeSet::new();
            let mut removed = BTreeSet::new();
            let mut renamed: Vec<(String, String)> = Vec::new();
            for ev in events {
                // A rename with both names known (stitched by the debouncer).
                if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = ev.kind {
                    if let [from, to] = ev.paths.as_slice() {
                        let (from_ex, to_ex) = (is_excluded(&root_for_cb, from, &set), is_excluded(&root_for_cb, to, &set));
                        if !from_ex && !to_ex && to.exists() {
                            renamed.push((to_ui(from), to_ui(to)));
                            continue;
                        }
                        // Renamed into an excluded name counts as deleted, out of one as new.
                        if !from_ex {
                            removed.insert(to_ui(from));
                        }
                        if !to_ex && to.is_file() {
                            changed.insert(to_ui(to));
                        }
                        continue;
                    }
                }
                for p in &ev.paths {
                    if is_excluded(&root_for_cb, p, &set) {
                        continue;
                    }
                    match ev.kind {
                        EventKind::Remove(_) => {
                            removed.insert(to_ui(p));
                        }
                        EventKind::Create(_) | EventKind::Modify(_) => {
                            if p.is_file() {
                                changed.insert(to_ui(p));
                                removed.remove(&to_ui(p));
                            } else if !p.exists() {
                                // Renamed away or deleted right after creation.
                                removed.insert(to_ui(p));
                            }
                        }
                        _ => {}
                    }
                }
            }
            // A file that was renamed and then changed again is uploaded under its new name.
            for (from, to) in &renamed {
                removed.remove(from);
                removed.remove(to);
            }
            if !changed.is_empty() || !removed.is_empty() || !renamed.is_empty() {
                emit(WatchBatch { watch_id: id.clone(), changed: changed.into_iter().collect(), removed: removed.into_iter().collect(), renamed });
            }
        })
        .map_err(|e| AppError::other("Überwachung konnte nicht gestartet werden.").with_detail(e.to_string()))?;
        debouncer
            .watch(&root, if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive })
            .map_err(|e| AppError::other("Ordner kann nicht überwacht werden.").with_detail(e.to_string()))?;
        self.running.lock().unwrap().insert(watch_id, debouncer);
        Ok(())
    }

    pub fn stop(&self, watch_id: &str) {
        if let Some(d) = self.running.lock().unwrap().remove(watch_id) {
            d.stop_nonblocking();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn excludes_match_components() {
        let set = build_excludes(&[".git".into(), "__pycache__".into(), "*.log".into()]).unwrap();
        let root = Path::new("/p");
        assert!(is_excluded(root, Path::new("/p/.git/config"), &set));
        assert!(is_excluded(root, Path::new("/p/cogs/__pycache__/a.pyc"), &set));
        assert!(is_excluded(root, Path::new("/p/logs/bot.log"), &set));
        assert!(is_excluded(root, Path::new("/p/.bot.py.bitcrane-part"), &set));
        assert!(!is_excluded(root, Path::new("/p/cogs/welcome.py"), &set));
    }

    #[test]
    fn reports_changed_file_once_per_batch() {
        let dir = tempfile::tempdir().unwrap();
        let w = Watches::default();
        let (tx, rx) = mpsc::channel();
        let path = dir.path().to_string_lossy().replace('\\', "/");
        w.start("t".into(), &path, true, &[".git".into()], 300, move |b| { let _ = tx.send(b); }).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::write(dir.path().join("bot.py"), "a").unwrap();
        std::fs::write(dir.path().join("bot.py"), "ab").unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), "x").unwrap();
        let batch = rx.recv_timeout(Duration::from_secs(5)).expect("no batch");
        assert!(batch.changed.iter().any(|p| p.ends_with("/bot.py")));
        assert!(!batch.changed.iter().any(|p| p.contains("/.git/")));
        w.stop("t");
    }

    #[test]
    fn reports_rename_as_rename() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("bot.py"), "a").unwrap();
        let w = Watches::default();
        let (tx, rx) = mpsc::channel();
        let path = dir.path().to_string_lossy().replace('\\', "/");
        w.start("r".into(), &path, true, &[], 300, move |b| { let _ = tx.send(b); }).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        std::fs::rename(dir.path().join("bot.py"), dir.path().join("main.py")).unwrap();
        let batch = rx.recv_timeout(Duration::from_secs(5)).expect("no batch");
        if batch.renamed.is_empty() && cfg!(target_os = "macos") {
            // FSEvents may report a rename as "gone" plus "new"; the upload is still right.
            assert!(batch.changed.iter().any(|p| p.ends_with("/main.py")), "{batch:?}");
            w.stop("r");
            return;
        }
        assert_eq!(batch.renamed.len(), 1, "{batch:?}");
        assert!(batch.renamed[0].0.ends_with("/bot.py") && batch.renamed[0].1.ends_with("/main.py"));
        assert!(batch.removed.is_empty() && batch.changed.is_empty(), "{batch:?}");
        w.stop("r");
    }
}
