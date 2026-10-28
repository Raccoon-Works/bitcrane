/**
 * Keyboard shortcuts: one list of actions with their default keys per
 * platform. The user can change every entry in Settings > Tastenkürzel;
 * menus, the context menu and the shortcut overview read their labels from
 * here, so a change shows up everywhere.
 *
 * A combination is stored as "Mod+Alt+Shift+Ctrl+Key". "Mod" is ⌘ on the Mac
 * and Strg on Windows; "Ctrl" is the extra ⌃ key that only the Mac has.
 */
import type { Platform } from '../backend/types';
import {
  activeTab, addBookmark, closeTab, copyPath, copySelection, download, editPath, getState, goBack, goForward, LIVE, newFolder, newTab, openDialog,
  pasteClipboard, pauseAllWatches, refresh, stepZoom, setDeepSearch, toggleActivity, toggleHidden, toggleInspector, togglePopover, toggleSyncBrowse, upload, useStore, setViewMode,
} from './store';
import { $t } from '../i18n';

export interface ShortcutAction {
  id: string;
  label: string;
  group: string;
  mac: string[];
  win: string[];
  run: () => void;
  /** Not while typing in a text field (where the key has its usual meaning). */
  notInText?: boolean;
}

const focus = () => getState().focusSide;

export const ACTIONS: ShortcutAction[] = [
  { id: 'newTab', group: $t('Fenster'), label: $t('Neuer Tab'), mac: ['Mod+T'], win: ['Mod+T'], run: newTab },
  { id: 'closeTab', group: $t('Fenster'), label: $t('Tab schließen'), mac: ['Mod+W'], win: ['Mod+W'], run: () => { const t = activeTab(); if (t) closeTab(t.id); } },
  { id: 'quickConnect', group: $t('Fenster'), label: $t('Schnell verbinden'), mac: ['Mod+K'], win: ['Mod+K'], run: () => openDialog({ type: 'quickConnect' }) },
  { id: 'settings', group: $t('Fenster'), label: $t('Einstellungen'), mac: ['Mod+,'], win: ['Mod+,'], run: () => openDialog({ type: 'settings', tab: 'general' }) },
  { id: 'shortcuts', group: $t('Fenster'), label: $t('Tastenkürzel anzeigen'), mac: ['Mod+/'], win: ['Mod+/'], run: () => openDialog({ type: 'shortcuts' }) },
  { id: 'palette', group: $t('Fenster'), label: $t('Befehle suchen'), mac: ['Mod+Shift+P'], win: ['Mod+Shift+P'], run: () => openDialog({ type: 'palette' }) },
  { id: 'transfers', group: $t('Fenster'), label: $t('Übertragungen'), mac: ['Mod+Alt+T'], win: ['Mod+Alt+T'], run: () => openDialog({ type: 'transfers' }) },
  { id: 'workspaces', group: $t('Fenster'), label: $t('Arbeitsbereiche'), mac: [], win: [], run: () => openDialog({ type: 'workspaces' }) },

  { id: 'inspector', group: $t('Darstellung'), label: $t('Info-Spalte ein/aus'), mac: ['Mod+I'], win: ['Mod+I'], run: toggleInspector },
  { id: 'activity', group: $t('Darstellung'), label: $t('Aktivität ein/aus'), mac: ['Mod+Alt+A'], win: ['Mod+Shift+A'], run: toggleActivity },
  { id: 'hidden', group: $t('Darstellung'), label: $t('Versteckte Dateien ein/aus'), mac: ['Mod+Shift+.'], win: ['Mod+H'], run: toggleHidden },
  // Transmit: ⌘1 / ⌘2. Windows Explorer: Strg+Umschalt+6 (Details) and Strg+Umschalt+2 (große Symbole).
  { id: 'viewList', group: $t('Darstellung'), label: $t('Als Liste'), mac: ['Mod+1'], win: ['Mod+Shift+6'], run: () => setViewMode(focus(), 'list') },
  { id: 'viewIcons', group: $t('Darstellung'), label: $t('Als Symbole'), mac: ['Mod+2'], win: ['Mod+Shift+2'], run: () => setViewMode(focus(), 'icons') },
  { id: 'syncBrowse', group: $t('Darstellung'), label: $t('Synchron blättern ein/aus'), mac: [], win: [], run: toggleSyncBrowse },
  { id: 'compareDirs', group: $t('Darstellung'), label: $t('Verzeichnisse vergleichen ein/aus'), mac: ['Mod+Alt+V'], win: ['Mod+Alt+V'], run: () => void import('./tools').then((m) => m.toggleCompareDirs()) },
  { id: 'deepSearch', group: $t('Darstellung'), label: $t('Suche in Unterordnern ein/aus'), mac: ['Mod+Shift+F'], win: ['Mod+Shift+F'], run: () => setDeepSearch(!getState().deepSearchOn) },
  { id: 'zoomIn', group: $t('Darstellung'), label: $t('Vergrößern'), mac: ['Mod++', 'Mod+='], win: ['Mod++', 'Mod+='], run: () => stepZoom(1) },
  { id: 'zoomOut', group: $t('Darstellung'), label: $t('Verkleinern'), mac: ['Mod+-'], win: ['Mod+-'], run: () => stepZoom(-1) },
  { id: 'zoomReset', group: $t('Darstellung'), label: $t('Originalgröße'), mac: ['Mod+0'], win: ['Mod+0'], run: () => stepZoom(0) },
  { id: 'refresh', group: $t('Darstellung'), label: $t('Aktualisieren'), mac: ['Mod+R'], win: ['F5', 'Mod+R'], run: refresh },

  { id: 'back', group: $t('Gehe zu'), label: $t('Zurück'), mac: ['Mod+['], win: ['Alt+ArrowLeft'], run: goBack, notInText: true },
  { id: 'forward', group: $t('Gehe zu'), label: $t('Vor'), mac: ['Mod+]'], win: ['Alt+ArrowRight'], run: goForward, notInText: true },
  { id: 'editPath', group: $t('Gehe zu'), label: $t('Pfad eingeben'), mac: ['Mod+L'], win: ['Mod+L'], run: () => editPath(focus()) },
  { id: 'bookmark', group: $t('Gehe zu'), label: $t('Ordner zu den Orten hinzufügen'), mac: ['Mod+D'], win: ['Mod+D'], run: addBookmark },

  { id: 'upload', group: $t('Dateien'), label: $t('Hochladen'), mac: ['Mod+Alt+ArrowUp'], win: ['Mod+Alt+ArrowUp'], run: () => upload() },
  { id: 'download', group: $t('Dateien'), label: $t('Herunterladen'), mac: ['Mod+Alt+ArrowDown'], win: ['Mod+Alt+ArrowDown'], run: () => download() },
  { id: 'copy', group: $t('Dateien'), label: $t('Kopieren'), mac: ['Mod+C'], win: ['Mod+C'], run: () => copySelection(focus()), notInText: true },
  { id: 'paste', group: $t('Dateien'), label: $t('In die andere Hälfte einfügen'), mac: ['Mod+V'], win: ['Mod+V'], run: () => pasteClipboard(focus()), notInText: true },
  { id: 'copyPath', group: $t('Dateien'), label: $t('Pfad kopieren'), mac: ['Mod+Alt+C'], win: ['Mod+Shift+C'], run: () => copyPath(focus()), notInText: true },
  { id: 'newFolder', group: $t('Dateien'), label: $t('Neuer Ordner'), mac: ['Mod+Shift+N'], win: ['Mod+Shift+N'], run: () => newFolder() },
  { id: 'selectMask', group: $t('Dateien'), label: $t('Auswählen nach Muster'), mac: ['Mod+Alt+S'], win: ['Mod+Alt+S'], run: () => openDialog({ type: 'selectMask', side: focus() }) },
  { id: 'invertSelection', group: $t('Dateien'), label: $t('Auswahl umkehren'), mac: ['Mod+Shift+I'], win: ['Mod+Shift+I'], run: () => void import('./tools').then((m) => m.invertSelection(focus())), notInText: true },

  { id: 'newWatch', group: $t('Überwachung'), label: $t('Neue Überwachung'), mac: ['Mod+U'], win: ['Mod+U'], run: () => openDialog({ type: 'watchSetup' }) },
  { id: 'watchTab', group: $t('Überwachung'), label: $t('Überwachung für diesen Tab starten'), mac: ['Mod+Shift+U'], win: ['Mod+Shift+U'], run: () => openDialog({ type: 'watchSetup' }) },
  { id: 'watchOverview', group: $t('Überwachung'), label: $t('Übersicht der Überwachungen'), mac: ['Mod+Alt+U'], win: ['Mod+Alt+U'], run: togglePopover },
  { id: 'pauseWatches', group: $t('Überwachung'), label: $t('Alle pausieren oder fortsetzen'), mac: ['Mod+Alt+P'], win: ['Mod+Alt+P'], run: pauseAllWatches },
];

/** Keys inside the file lists; shown in the overview but fixed. */
export const FIXED: Array<{ label: string; mac: string; win: string }> = [
  { label: $t('Ordner öffnen'), mac: '⌘↓', win: 'Enter' },
  { label: $t('Ordner nach oben'), mac: '⌘↑', win: 'Alt+↑' },
  { label: $t('Umbenennen'), mac: '↩', win: 'F2' },
  { label: $t('Vorschau'), mac: $t('Leertaste'), win: $t('Leertaste') },
  { label: $t('Alles auswählen'), mac: '⌘A', win: $t('Strg+A') },
  { label: $t('Löschen'), mac: '⌘⌫', win: $t('Entf') },
  { label: $t('Zur Datei springen'), mac: $t('Name tippen'), win: $t('Name tippen') },
  { label: $t('Zwischen Bereichen wechseln'), mac: 'Tab', win: 'Tab' },
  { label: $t('Dialog schließen'), mac: 'esc', win: 'Esc' },
];

/** Current keys of an action (user setting, else the default). */
export function keysFor(id: string, platform: Platform = getState().platform): string[] {
  const own = getState().settings.shortcuts[id];
  if (own !== undefined) return own ? [own] : [];
  const a = ACTIONS.find((x) => x.id === id);
  return a ? (platform === 'mac' ? a.mac : a.win) : [];
}

const NAMED: Record<string, [string, string]> = {
  ArrowUp: ['↑', '↑'], ArrowDown: ['↓', '↓'], ArrowLeft: ['←', '←'], ArrowRight: ['→', '→'],
  Enter: ['↩', 'Enter'], Backspace: ['⌫', $t('Rücktaste')], Delete: ['⌦', $t('Entf')], Escape: ['esc', $t('Esc')], Tab: ['⇥', 'Tab'], Space: [$t('Leertaste'), $t('Leertaste')],
};

/** Display text: "⌥⌘T" on the Mac, "Strg+Alt+T" on Windows. */
export function formatCombo(combo: string, platform: Platform = getState().platform): string {
  if (!combo) return '';
  const parts = combo.split('+');
  // "Mod++" (plus key) splits into an empty last part.
  const key = combo.endsWith('++') ? '+' : parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const keyText = NAMED[key] ? NAMED[key][platform === 'mac' ? 0 : 1] : key;
  if (platform === 'mac') {
    return `${mods.has('Ctrl') ? '⌃' : ''}${mods.has('Alt') ? '⌥' : ''}${mods.has('Shift') ? '⇧' : ''}${mods.has('Mod') ? '⌘' : ''}${keyText}`;
  }
  return [mods.has('Mod') ? $t('Strg') : '', mods.has('Alt') ? 'Alt' : '', mods.has('Shift') ? $t('Umschalt') : '', keyText].filter(Boolean).join('+');
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

const CODE_KEYS: Record<string, string> = {
  Period: '.', Comma: ',', Slash: '/', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\',
};
const isModifierKey = (k: string) => k === 'Meta' || k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'AltGraph' || k === 'OS';

/** Key part of an event: the printed letter, else the physical key (⌥ changes letters on the Mac). */
function keyCandidates(e: KeyboardEvent): string[] {
  const out: string[] = [];
  if (/^[a-z]$/i.test(e.key)) out.push(e.key.toUpperCase());
  // The physical key only when no letter is printed (⌥ on the Mac); on AZERTY or
  // Dvorak the physical position would trigger the wrong shortcut.
  if (/^Key[A-Z]$/.test(e.code) && !/^[a-z]$/i.test(e.key)) out.push(e.code.slice(3));
  if (/^Digit\d$/.test(e.code)) out.push(e.code.slice(5));
  if (/^F\d{1,2}$/.test(e.key) || NAMED[e.key]) out.push(e.key);
  if (e.key === ' ') out.push('Space');
  if (e.key.length === 1 && !/^[a-z0-9 ]$/i.test(e.key)) out.push(e.key);
  if (CODE_KEYS[e.code]) out.push(CODE_KEYS[e.code]);
  return [...new Set(out)];
}

function modsOf(e: KeyboardEvent, platform: Platform, withShift: boolean) {
  // The browser prototype shows the Mac look on any computer; there Strg stands in for ⌘.
  const ctrlAsMod = !LIVE && platform === 'mac' && !e.metaKey;
  const mod = platform === 'mac' ? e.metaKey || (ctrlAsMod && e.ctrlKey) : e.ctrlKey;
  return [mod ? 'Mod' : '', platform === 'mac' && e.ctrlKey && !ctrlAsMod ? 'Ctrl' : '', e.altKey ? 'Alt' : '', withShift && e.shiftKey ? 'Shift' : ''].filter(Boolean);
}

/** All spellings of a key press; punctuation also matches without Shift (layouts differ). */
export function combosOf(e: KeyboardEvent, platform: Platform): string[] {
  if (isModifierKey(e.key)) return [];
  const out: string[] = [];
  for (const k of keyCandidates(e)) {
    out.push([...modsOf(e, platform, true), k].join('+'));
    if (!/^[A-Z0-9]$|^F\d|^[A-Z][a-z]/.test(k)) out.push([...modsOf(e, platform, false), k].join('+'));
  }
  return [...new Set(out)];
}

/** The combination to store when recording a new shortcut (null while only modifiers are held). */
export function recordCombo(e: KeyboardEvent, platform: Platform): string | null {
  if (isModifierKey(e.key)) return null;
  const k = keyCandidates(e)[0];
  if (!k) return null;
  const punctuation = !/^[A-Z0-9]$|^F\d|^[A-Z][a-z]/.test(k);
  return [...modsOf(e, platform, !punctuation), k].join('+');
}

/** Finds the action bound to a key press. */
export function actionFor(e: KeyboardEvent, platform: Platform, typing: boolean): ShortcutAction | undefined {
  const combos = combosOf(e, platform);
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
