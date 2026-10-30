//! Finder tags of files on this computer (macOS): the coloured labels the
//! Finder shows, kept in the extended attribute
//! `com.apple.metadata:_kMDItemUserTags` as a binary property list of strings
//! "Name\nColour" (colour 0 none, 1 grey, 2 green, 3 purple, 4 blue,
//! 5 yellow, 6 red, 7 orange). Other systems have no tags: empty answers.

use crate::error::AppResult;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Tag {
    pub name: String,
    /// Finder colour number (0–7).
    pub color: u8,
}

#[cfg(target_os = "macos")]
const ATTR: &str = "com.apple.metadata:_kMDItemUserTags";

/// Parses the strings of the attribute ("Rot\n6", or just "Projekt").
pub fn parse(items: &[String]) -> Vec<Tag> {
    items
        .iter()
        .map(|s| match s.rsplit_once('\n') {
            Some((name, c)) => Tag { name: name.to_string(), color: c.trim().parse().unwrap_or(0) },
            None => Tag { name: s.clone(), color: 0 },
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn read(path: &std::path::Path) -> Vec<Tag> {
    let Ok(Some(raw)) = xattr::get(path, ATTR) else { return Vec::new() };
    match plist::from_bytes::<Vec<String>>(&raw) {
        Ok(items) => parse(&items),
        Err(_) => Vec::new(),
    }
}

/// Tags of the entries of a folder: name → tags (entries without tags are left out).
pub fn list(dir: &str) -> HashMap<String, Vec<Tag>> {
    #[allow(unused_mut)]
    let mut out = HashMap::new();
    #[cfg(target_os = "macos")]
    if let Ok(rd) = std::fs::read_dir(crate::paths::to_native(dir)) {
        for e in rd.flatten() {
            let tags = read(&e.path());
            if !tags.is_empty() {
                out.insert(e.file_name().to_string_lossy().into_owned(), tags);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = dir;
    out
}

/// Turns one colour tag on or off for the given files (the Finder's colour
/// names are kept, so the tags look the same in the Finder).
pub fn toggle(paths: &[String], name: &str, color: u8, on: bool) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    for p in paths {
        let native = crate::paths::to_native(p);
        let mut tags = read(&native);
        tags.retain(|t| t.name != name);
        if on {
            tags.push(Tag { name: name.to_string(), color });
        }
        if tags.is_empty() {
            let _ = xattr::remove(&native, ATTR);
            continue;
        }
        let items: Vec<String> = tags.iter().map(|t| format!("{}\n{}", t.name, t.color)).collect();
        let mut buf = Vec::new();
        plist::to_writer_binary(&mut buf, &items).map_err(|e| crate::error::AppError::other("Markierung konnte nicht gesetzt werden.").with_detail(e.to_string()))?;
        xattr::set(&native, ATTR, &buf).map_err(|e| crate::error::AppError::other("Markierung konnte nicht gesetzt werden.").with_detail(e.to_string()))?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (paths, name, color, on);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_finder_strings() {
        let t = parse(&["Rot\n6".to_string(), "Projekt".to_string()]);
        assert_eq!(t, vec![Tag { name: "Rot".into(), color: 6 }, Tag { name: "Projekt".into(), color: 0 }]);
    }
}
