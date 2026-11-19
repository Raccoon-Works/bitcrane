/**
 * Key combinations as pure functions: how a key press is written ("Mod+Shift+K"), all spellings
 * of a press, and how a combination is shown ("⇧⌘K" on the Mac, "Strg+Umschalt+K" on Windows).
 */
import type { Platform } from '../backend/types';
import { $t, LANG } from '../i18n';

/** Letters, digits, F keys and named keys ("Enter"); other keys are punctuation, which also matches without Shift. */
export const isNamedKey = (k: string) => /^[A-Z0-9]$|^F\d|^[A-Z][a-z]/.test(k);

const NAMED: Record<string, [string, string]> = {
  ArrowUp: ['↑', '↑'],
  ArrowDown: ['↓', '↓'],
  ArrowLeft: ['←', '←'],
  ArrowRight: ['→', '→'],
  Insert: ['Einfg', $t('Einfg')],
  NumpadAdd: ['+ (Ziffernblock)', $t('+ (Ziffernblock)')],
  NumpadSubtract: ['− (Ziffernblock)', $t('− (Ziffernblock)')],
  NumpadMultiply: ['* (Ziffernblock)', $t('* (Ziffernblock)')],
  Enter: ['↩', 'Enter'],
  Backspace: ['⌫', $t('Rücktaste')],
  Delete: ['⌦', $t('Entf')],
  Escape: ['esc', $t('Esc')],
  Tab: ['⇥', 'Tab'],
  Space: [$t('Leertaste'), $t('Leertaste')],
};

/** Display text: "⌥⌘T" on the Mac, "Strg+Alt+T" on Windows. */
export function formatCombo(combo: string, platform: Platform): string {
  if (!combo) return '';
  const parts = combo.split('+');
  // "Mod++" (plus key) splits into an empty last part.
  const key = combo.endsWith('++') ? '+' : parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  // The key left of 1 (Backquote) shows "^" on German keyboards, where the shortcut is pressed with it.
  const keyText = NAMED[key] ? NAMED[key][platform === 'mac' ? 0 : 1] : key === '`' && LANG === 'de' ? '^' : key;
  if (platform === 'mac') {
    return `${mods.has('Ctrl') ? '⌃' : ''}${mods.has('Alt') ? '⌥' : ''}${mods.has('Shift') ? '⇧' : ''}${mods.has('Mod') ? '⌘' : ''}${keyText}`;
  }
  return [
    mods.has('Mod') ? $t('Strg') : '',
    mods.has('Alt') ? 'Alt' : '',
    mods.has('Shift') ? $t('Umschalt') : '',
    keyText,
  ]
    .filter(Boolean)
    .join('+');
}

const CODE_KEYS: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Backslash: '\\',
};
export const isModifierKey = (k: string) =>
  k === 'Meta' || k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'AltGraph' || k === 'OS';

/** Key part of an event: the printed letter, else the physical key (⌥ changes letters on the Mac). */
export function keyCandidates(e: KeyboardEvent): string[] {
  const out: string[] = [];
  if (/^[a-z]$/i.test(e.key)) out.push(e.key.toUpperCase());
  // The physical key only when no letter is printed (⌥ on the Mac); on AZERTY or
  // Dvorak the physical position would trigger the wrong shortcut.
  if (/^Key[A-Z]$/.test(e.code) && !/^[a-z]$/i.test(e.key)) out.push(e.code.slice(3));
  if (/^Digit\d$/.test(e.code)) out.push(e.code.slice(5));
  // Number pad + - * have names of their own (Commander keys), apart from the keys of the main block.
  if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract' || e.code === 'NumpadMultiply') out.push(e.code);
  if (/^F\d{1,2}$/.test(e.key) || NAMED[e.key]) out.push(e.key);
  if (e.key === ' ') out.push('Space');
  if (e.key.length === 1 && !/^[a-z0-9 ]$/i.test(e.key)) out.push(e.key);
  if (CODE_KEYS[e.code]) out.push(CODE_KEYS[e.code]);
  return [...new Set(out)];
}

/**
 * Modifier part of a key press. `live`: the app; the browser prototype shows the Mac look on any
 * computer, and there Strg stands in for ⌘.
 */
export function modsOf(e: KeyboardEvent, platform: Platform, withShift: boolean, live: boolean) {
  const ctrlAsMod = !live && platform === 'mac' && !e.metaKey;
  const mod = platform === 'mac' ? e.metaKey || (ctrlAsMod && e.ctrlKey) : e.ctrlKey;
  return [
    mod ? 'Mod' : '',
    platform === 'mac' && e.ctrlKey && !ctrlAsMod ? 'Ctrl' : '',
    e.altKey ? 'Alt' : '',
    withShift && e.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
}

/** All spellings of a key press; punctuation also matches without Shift (layouts differ). */
export function combosOf(e: KeyboardEvent, platform: Platform, live: boolean): string[] {
  if (isModifierKey(e.key)) return [];
  const out: string[] = [];
  for (const k of keyCandidates(e)) {
    out.push([...modsOf(e, platform, true, live), k].join('+'));
    if (!isNamedKey(k)) out.push([...modsOf(e, platform, false, live), k].join('+'));
  }
  return [...new Set(out)];
}
