//! English texts for the command line. The command line runs without the interface, so it reads
//! the interface's own dictionary (`src/i18n.en.ts`, built into the program) instead of keeping a
//! second list of translations that would drift apart from the first.
//!
//! The file is Prettier-formatted TypeScript with one entry per line, or the key on one line and
//! the text on the next:
//!
//! ```text
//!   Fehler: 'Error',
//!   'Datei nicht gefunden': 'File not found',
//!   'Ein langer Satz …':
//!     'A long sentence …',
//! ```

use std::collections::HashMap;
use std::sync::LazyLock;

static SOURCE: &str = include_str!("../../src/i18n.en.ts");

static ENGLISH: LazyLock<HashMap<String, &'static str>> = LazyLock::new(|| parse(SOURCE));

/// The English text for a German key, if the dictionary has one.
pub fn english(key: &str) -> Option<&'static str> {
    ENGLISH.get(key).copied()
}

/// Reads the entries of the dictionary. Values are kept as slices of the source where they need
/// no unescaping, and leaked otherwise (a handful of entries, read once per process).
fn parse(source: &'static str) -> HashMap<String, &'static str> {
    let mut map = HashMap::new();
    let mut pending_key: Option<String> = None;
    for line in source.lines().map(str::trim) {
        if let Some(key) = pending_key.take() {
            if let Some((value, _)) = quoted(line) {
                map.insert(key, value);
            }
            continue;
        }
        let Some((key, rest)) = entry_key(line) else { continue };
        match rest.trim_start() {
            "" => pending_key = Some(key),
            value => {
                if let Some((value, _)) = quoted(value) {
                    map.insert(key, value);
                }
            }
        }
    }
    map
}

/// The key of an entry line (`key:` or `'key':`) and what follows the colon.
fn entry_key(line: &'static str) -> Option<(String, &'static str)> {
    if line.starts_with('\'') || line.starts_with('"') {
        let (key, rest) = quoted(line)?;
        return Some((key.to_string(), rest.strip_prefix(':')?));
    }
    let (key, rest) = line.split_once(':')?;
    let is_identifier = !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_');
    is_identifier.then(|| (key.to_string(), rest))
}

/// A string literal at the start of `text` (single or double quotes) and the text after it.
fn quoted(text: &'static str) -> Option<(&'static str, &'static str)> {
    let quote = text.chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let body = &text[1..];
    let mut escaped = false;
    for (i, c) in body.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            c if c == quote => {
                let raw = &body[..i];
                let value = if raw.contains('\\') { &*unescape(raw).leak() } else { raw };
                return Some((value, &body[i + 1..]));
            }
            _ => {}
        }
    }
    None
}

fn unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_entry_shape() {
        let map = parse(
            "export const EN = {\n  Fehler: 'Error',\n  'Datei nicht gefunden': 'File not found',\n  \
             '„{0}“ gibt es hier schon.': '“{0}” already exists here.',\n  'Ein langer Satz':\n    \
             'A long sentence',\n  'Mit Apostroph': \"Don't\",\n  'Escaped': 'It\\'s',\n};\n",
        );
        assert_eq!(map.get("Fehler"), Some(&"Error"));
        assert_eq!(map.get("Datei nicht gefunden"), Some(&"File not found"));
        assert_eq!(map.get("„{0}“ gibt es hier schon."), Some(&"“{0}” already exists here."));
        assert_eq!(map.get("Ein langer Satz"), Some(&"A long sentence"));
        assert_eq!(map.get("Mit Apostroph"), Some(&"Don't"));
        assert_eq!(map.get("Escaped"), Some(&"It's"));
        assert_eq!(map.len(), 6);
    }

    #[test]
    fn reads_the_real_dictionary() {
        // Every line of the object is an entry or half of one; a change of format shows up here.
        let lines = SOURCE.lines().filter(|l| l.starts_with("  ") && !l.starts_with("    ")).count();
        assert_eq!(ENGLISH.len(), lines);
        assert_eq!(english("Unerwarteter Fehler."), Some("Unexpected error."));
    }
}
