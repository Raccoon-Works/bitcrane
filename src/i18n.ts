/**
 * Interface language. German texts are the keys; `i18n.en.ts` holds the
 * English versions and `locales/<lang>.json` the other languages. The language
 * is read once at start (it is also kept in local storage so it is known
 * before the settings file is loaded); a change in the settings applies after
 * the next start. A text missing in a language falls back to English, then
 * to the German original.
 */
import { EN } from './i18n.en';

export type Lang = 'de' | 'en' | 'fr' | 'es' | 'it' | 'nl' | 'pl';

/** Languages with their own name, for the settings. */
export const LANGUAGES: Array<{ id: Lang; name: string; locale: string }> = [
  { id: 'de', name: 'Deutsch', locale: 'de-DE' },
  { id: 'en', name: 'English', locale: 'en-US' },
  { id: 'fr', name: 'Français', locale: 'fr-FR' },
  { id: 'es', name: 'Español', locale: 'es-ES' },
  { id: 'it', name: 'Italiano', locale: 'it-IT' },
  { id: 'nl', name: 'Nederlands', locale: 'nl-NL' },
  { id: 'pl', name: 'Polski', locale: 'pl-PL' },
];

const STORE_KEY = 'bitcrane.language';
const isLang = (v: unknown): v is Lang => LANGUAGES.some((l) => l.id === v);

function initial(): Lang {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    // Storage blocked: fall back to the system language.
  }
  const sys = (navigator.language || 'de').toLowerCase().slice(0, 2);
  return isLang(sys) ? sys : 'en';
}

export const LANG: Lang = initial();

/** Locale for numbers and dates in the interface language. */
export const LOCALE: string = LANGUAGES.find((l) => l.id === LANG)?.locale ?? 'de-DE';

/** The other languages are bundled as JSON (German original → translation). */
const OTHER = import.meta.glob<Record<string, string>>('./locales/*.json', { eager: true, import: 'default' });
const DICT: Record<string, string> | null = LANG === 'de' ? null : LANG === 'en' ? EN : { ...EN, ...(OTHER[`./locales/${LANG}.json`] ?? {}) };

/** Remembers the language for the next start. */
export function rememberLanguage(lang: Lang) {
  try {
    localStorage.setItem(STORE_KEY, lang);
  } catch {
    // Not critical: the settings file keeps it as well.
  }
}

/** Patterns for texts with variable parts (messages from the Rust side). */
const PATTERNS: Array<[RegExp, string]> = Object.entries(DICT ?? {})
  .filter(([k]) => /\{\d\}/.test(k))
  .map(([k, v]) => [new RegExp('^' + k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{(\d)\\?\}/g, '(.*?)') + '$', 's'), v]);

/** Translates a text; `{0}`, `{1}` … are replaced by the arguments. */
export function $t(text: string, ...args: unknown[]): string {
  // "Wort#context" tells apart equal German words with different meanings.
  const out = DICT ? DICT[text] ?? text.split('#')[0] : text.split('#')[0];
  return args.length ? out.replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)] ?? '')) : out;
}

/** Translates a complete text from outside (e.g. an error message from the backend). */
export function tr(message: string): string {
  if (!DICT || !message) return message;
  if (DICT[message]) return DICT[message];
  for (const [re, en] of PATTERNS) {
    const m = message.match(re);
    if (m) return en.replace(/\{(\d)\}/g, (_, i) => tr(m[Number(i) + 1] ?? ''));
  }
  return message;
}

/* Mac menus in English use title case ("Open in New Tab"); Windows keeps
   sentence case ("Open in new tab"), as each system does in its own apps. */
const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'as', 'via', 'per', 'vs', 'with', 'from', 'into', 'onto']);
const IS_MAC = typeof navigator !== 'undefined' && !/Win/i.test(`${navigator.platform} ${navigator.userAgent}`);

/** Title case for one English menu text; quoted parts (file names) stay as they are. */
export function titleCase(text: string): string {
  // Split into quoted and unquoted parts; only the unquoted ones change.
  const parts = text.split(/(“[^”]*”|„[^“]*“|"[^"]*"|'[^']*')/);
  const words = parts.flatMap((p, i) => (i % 2 ? [] : p.split(/(\s+)/).filter((w) => w.trim()).map((w) => w)));
  const last = words.length - 1;
  let n = -1;
  return parts
    .map((p, i) => (i % 2 ? p : p.replace(/\S+/g, (w) => {
      n++;
      const bare = w.replace(/^[^A-Za-z]+/, '');
      // Words with capitals, digits or symbols inside (macOS, SFTP, Ctrl+C, …) stay as they are.
      if (!bare || /[A-Z0-9@./\\:+_]/.test(bare.slice(1)) || /^[A-Z]/.test(bare)) return w;
      const lower = bare.toLowerCase();
      if (n !== 0 && n !== last && SMALL_WORDS.has(lower)) return w;
      const cap = bare.split('-').map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s)).join('-');
      return w.slice(0, w.length - bare.length) + cap;
    })))
    .join('');
}

/** Menu text as the system expects it (title case for English on the Mac). */
export function menuText(text: string): string {
  return LANG === 'en' && IS_MAC ? titleCase(text) : text;
}
