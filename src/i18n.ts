/**
 * Interface language. German texts are the keys; `en.ts` holds the English
 * versions. The language is read once at start (it is also kept in local
 * storage so it is known before the settings file is loaded); a change in
 * the settings applies after the next start.
 */
import { EN } from './i18n.en';

export type Lang = 'de' | 'en';

const STORE_KEY = 'bitcrane.language';

function initial(): Lang {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === 'de' || saved === 'en') return saved;
  } catch {
    // Storage blocked: fall back to the system language.
  }
  return (navigator.language || 'de').toLowerCase().startsWith('de') ? 'de' : 'en';
}

export const LANG: Lang = initial();

/** Remembers the language for the next start. */
export function rememberLanguage(lang: Lang) {
  try {
    localStorage.setItem(STORE_KEY, lang);
  } catch {
    // Not critical: the settings file keeps it as well.
  }
}

/** Patterns for texts with variable parts (messages from the Rust side). */
const PATTERNS: Array<[RegExp, string]> = Object.entries(EN)
  .filter(([k]) => /\{\d\}/.test(k))
  .map(([k, v]) => [new RegExp('^' + k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{(\d)\\?\}/g, '(.*?)') + '$', 's'), v]);

/** Translates a text; `{0}`, `{1}` … are replaced by the arguments. */
export function $t(text: string, ...args: unknown[]): string {
  // "Wort#context" tells apart equal German words with different meanings.
  const out = LANG === 'en' ? EN[text] ?? text.split('#')[0] : text.split('#')[0];
  return args.length ? out.replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)] ?? '')) : out;
}

/** Translates a complete text from outside (e.g. an error message from the backend). */
export function tr(message: string): string {
  if (LANG !== 'en' || !message) return message;
  if (EN[message]) return EN[message];
  for (const [re, en] of PATTERNS) {
    const m = message.match(re);
    if (m) return en.replace(/\{(\d)\}/g, (_, i) => tr(m[Number(i) + 1] ?? ''));
  }
  return message;
}
