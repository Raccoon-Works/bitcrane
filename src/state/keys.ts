/**
 * Keyboard shortcuts: the actions (keyActions.ts) with the keys the user chose in Settings >
 * Tastenkürzel, else the chosen layout, else the defaults. Menus, the context menu and the shortcut
 * overview read their labels from here, so a change shows up everywhere.
 */
import type { Platform } from '../backend/types';
import { getState, LIVE, useStore } from './store';
import { ACTIONS, type ShortcutAction } from './keyActions';
import { combosOf, formatCombo, isModifierKey, isNamedKey, keyCandidates, modsOf } from './keyCombos';

export { ACTIONS, FIXED } from './keyActions';
export { formatCombo } from './keyCombos';

/**
 * The F keys of WinSCP and Total Commander (Settings > Tastenkürzel > Belegung).
 * They take the place of the defaults; the user's own keys still come first.
 */
const COMMANDER: Record<string, string[]> = {
  previewSel: ['F3'],
  editSel: ['F4'],
  copyToOther: ['F5'],
  moveToOther: ['F6'],
  newFolder: ['F7', 'Mod+Shift+N'],
  deleteSel: ['F8'],
  propsSel: ['F9'],
  // F6 is "move" here, so switching halves has no key of its own.
  otherHalf: [],
  refresh: ['Mod+R'],
  toggleSel: ['Insert'],
  selectAdd: ['NumpadAdd'],
  selectRemove: ['NumpadSubtract'],
  invertSelection: ['NumpadMultiply', 'Mod+Shift+I'],
};

/** Current keys of an action (user setting, else the chosen key layout, else the default). */
export function keysFor(id: string, platform: Platform = getState().platform): string[] {
  const own = getState().settings.shortcuts[id];
  if (own !== undefined) return own ? [own] : [];
  if (getState().settings.keyScheme === 'commander' && COMMANDER[id]) return COMMANDER[id];
  const a = ACTIONS.find((x) => x.id === id);
  return a ? (platform === 'mac' ? a.mac : a.win) : [];
}

/** React hook: label function that updates when the user changes a shortcut. */
export function useKeyLabel() {
  const platform = useStore((s) => s.platform);
  useStore((s) => s.settings.shortcuts);
  return (id: string) => keyLabel(id, platform);
}

/** Label of the first key of an action, for menus. */
export function keyLabel(id: string, platform: Platform = getState().platform): string | undefined {
  const k = keysFor(id, platform)[0];
  return k ? formatCombo(k, platform) : undefined;
}

/** The combination to store when recording a new shortcut (null while only modifiers are held). */
export function recordCombo(e: KeyboardEvent, platform: Platform): string | null {
  if (isModifierKey(e.key)) return null;
  const k = keyCandidates(e)[0];
  if (!k) return null;
  return [...modsOf(e, platform, isNamedKey(k), LIVE), k].join('+');
}

/** Finds the action bound to a key press. */
export function actionFor(e: KeyboardEvent, platform: Platform, typing: boolean): ShortcutAction | undefined {
  const combos = combosOf(e, platform, LIVE);
  if (!combos.length) return undefined;
  for (const a of ACTIONS) {
    const keys = keysFor(a.id, platform);
    if (!keys.some((k) => combos.includes(k))) continue;
    // In a text field only combinations with ⌘/Strg count, and not the ones for text editing.
    if (typing && (a.notInText || !keys.some((k) => k.startsWith('Mod+') && combos.includes(k)))) continue;
    return a;
  }
  return undefined;
}

/** Other actions that use the same combination. */
export function conflictsWith(id: string, combo: string, platform: Platform = getState().platform): ShortcutAction[] {
  return ACTIONS.filter((a) => a.id !== id && keysFor(a.id, platform).includes(combo));
}
