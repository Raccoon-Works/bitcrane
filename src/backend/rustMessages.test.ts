// Messages of the Rust core reach the interface as a German key with parameters (see
// src-tauri/src/error.rs) and are translated with `$t`. This test reads the Rust sources and checks
// that every key has an English text with the same placeholders, so a changed wording on the Rust
// side cannot silently stay untranslated.
import { describe, expect, it } from 'vitest';
import { EN } from '../i18n.en';

const SOURCES = import.meta.glob<string>('../../src-tauri/src/**/*.rs', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * Files whose texts never reach the interface: the command line writes its own messages in
 * English, and the load test is test code.
 */
const NOT_SHOWN = ['/cli.rs', '/loadtest.rs'];

/** Where Rust writes a message key: the only ways to build a `Message`. */
const KEY_SITES = [
  /AppError::new\(\s*[^,()]+,\s*"((?:[^"\\]|\\.)*)"/g,
  /AppError::other\(\s*"((?:[^"\\]|\\.)*)"/g,
  /Message::new\(\s*"((?:[^"\\]|\\.)*)"/g,
  /\(ErrorKind::\w+,\s*"((?:[^"\\]|\\.)*)"/g,
];

/** Test modules start with `#[cfg(test)]` and end with the first unindented `}` (rustfmt). */
function withoutTests(source: string): string {
  return source.replace(/#\[cfg\(test\)\]\n(?:pub )?mod \w+ \{\n[\s\S]*?\n\}\n?/g, '');
}

function unescape(literal: string): string {
  return literal.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
}

function rustKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [path, source] of Object.entries(SOURCES)) {
    if (NOT_SHOWN.some((name) => path.endsWith(name))) continue;
    const code = withoutTests(source);
    for (const site of KEY_SITES) {
      for (const match of code.matchAll(site)) keys.set(unescape(match[1]), path.replace('../../src-tauri/', ''));
    }
  }
  return keys;
}

const placeholders = (text: string) => [...text.matchAll(/\{\d\}/g)].map((m) => m[0]).sort();

describe('messages of the Rust core', () => {
  const keys = rustKeys();

  it('are found in the sources', () => {
    // A guard against the patterns above silently matching nothing after a change of style.
    expect(keys.size).toBeGreaterThan(300);
  });

  it('all have an English text with the same placeholders', () => {
    const missing = [...keys].filter(([key]) => EN[key] === undefined).map(([key, file]) => `${file}: ${key}`);
    expect(missing).toEqual([]);
    const different = [...keys.keys()].filter(
      (key) => EN[key] !== undefined && placeholders(key).join() !== placeholders(EN[key]).join(),
    );
    expect(different).toEqual([]);
  });
});
