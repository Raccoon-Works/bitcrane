// Interface texts are German keys translated with `$t` (i18n.ts). This test reads the interface
// sources and checks that every key written in them has an English text with the same
// placeholders, and that no English text is left over without a key using it.
import { describe, expect, it } from 'vitest';
import { EN } from './i18n.en';

const SOURCES = import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.ts', '!./i18n.en.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
const RUST = import.meta.glob<string>('../src-tauri/src/**/*.rs', { query: '?raw', import: 'default', eager: true });

/** `$t('…')` and `$t("…")` with a fixed text as first argument. */
const CALL = /\$t\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
const unescape = (literal: string) => literal.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
const placeholders = (text: string) => [...text.matchAll(/\{\d\}/g)].map((m) => m[0]).sort();

function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [path, source] of Object.entries(SOURCES)) {
    for (const m of source.matchAll(CALL)) keys.set(unescape(m[1] ?? m[2]), path);
  }
  return keys;
}

describe('interface texts', () => {
  const keys = usedKeys();

  it('are found in the sources', () => {
    expect(keys.size).toBeGreaterThan(1500);
  });

  it('all have an English text with the same placeholders', () => {
    const missing = [...keys].filter(([key]) => EN[key] === undefined).map(([key, file]) => `${file}: ${key}`);
    expect(missing).toEqual([]);
    const differ = [...keys.keys()].filter(
      (key) => EN[key] !== undefined && placeholders(EN[key]).join() !== placeholders(key).join(),
    );
    expect(differ).toEqual([]);
  });

  it('leave no English text unused', () => {
    // A key may also be written as a plain string (passed on to `$t` later) or come from the core.
    const all = [...Object.values(SOURCES), ...Object.values(RUST)].join('\n');
    const quoted = (key: string) =>
      [`'${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`, JSON.stringify(key)].some((q) =>
        all.includes(q),
      );
    expect(Object.keys(EN).filter((key) => !quoted(key))).toEqual([]);
  });
});
