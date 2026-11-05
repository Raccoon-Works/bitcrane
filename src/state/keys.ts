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
  activeTab, addBookmark, closeTab, copyPath, copySelection, cutSelection, copyToOtherHalf, moveToOtherSide, toggleAtCursor, askDelete, openInEditor, panePath, pasteMove, goLocal, openInOtherHalf, download, editPath, getState, updateSettings, goBack, goForward, LIVE, newFile, selectedNames, undoLast, newFolder, newTab, openDialog,
  computeFolderSizes, newFolderWithSelection, pasteClipboard, pauseAllWatches, refresh, stepZoom, setDeepSearch, setSearchContent, toggleActivity, toggleHidden, toggleInspector, togglePopover, toggleSyncBrowse, upload, useStore, setViewMode, toggleSingleHalf, focusOtherHalf,
} from './store';
import { $t, LANG } from '../i18n';
import { join as joinPath } from '../util/paths';

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
  { id: 'viewColumns', group: $t('Darstellung'), label: $t('Als Spalten'), mac: ['Mod+3'], win: ['Mod+Shift+3'], run: () => setViewMode(focus(), 'columns') },
  { id: 'codeEditor', group: $t('Darstellung'), label: $t('Editor ein/aus'), mac: ['Mod+Shift+E'], win: ['Mod+Shift+E'], run: () => void import('./editor').then((m) => m.toggleEditor()) },
  // Windows: Ctrl+Alt+2 would be AltGr+2 (²) on German keyboards; F6 moves between the areas of an Explorer window.
  { id: 'singleHalf', group: $t('Darstellung'), label: $t('Nur eine Hälfte ein/aus'), mac: ['Mod+Alt+1'], win: ['Mod+Alt+1'], run: toggleSingleHalf },
  { id: 'otherHalf', group: $t('Darstellung'), label: $t('Zur anderen Hälfte wechseln'), mac: ['Mod+Alt+2'], win: ['F6'], run: focusOtherHalf },
  { id: 'sidebar', group: $t('Darstellung'), label: $t('Seitenleiste ein/aus'), mac: ['Mod+Ctrl+S'], win: ['Mod+B'], run: () => updateSettings({ sidebar: getState().settings.sidebar === false }) },
  { id: 'syncBrowse', group: $t('Darstellung'), label: $t('Synchron blättern ein/aus'), mac: [], win: [], run: toggleSyncBrowse },
  { id: 'compareDirs', group: $t('Darstellung'), label: $t('Verzeichnisse vergleichen ein/aus'), mac: ['Mod+Alt+Shift+V'], win: ['Mod+Alt+V'], run: () => void import('./tools').then((m) => m.toggleCompareDirs()) },
  { id: 'deepSearch', group: $t('Darstellung'), label: $t('Suche in Unterordnern ein/aus'), mac: ['Mod+Shift+F'], win: ['Mod+Shift+F'], run: () => setDeepSearch(!getState().deepSearchOn) },
  { id: 'contentSearch', group: $t('Darstellung'), label: $t('Suche im Inhalt ein/aus'), mac: ['Mod+Alt+F'], win: ['Mod+Alt+F'], run: () => setSearchContent(!getState().searchContent) },
  { id: 'zoomIn', group: $t('Darstellung'), label: $t('Vergrößern'), mac: ['Mod++', 'Mod+='], win: ['Mod++', 'Mod+='], run: () => stepZoom(1) },
  { id: 'zoomOut', group: $t('Darstellung'), label: $t('Verkleinern'), mac: ['Mod+-'], win: ['Mod+-'], run: () => stepZoom(-1) },
  { id: 'zoomReset', group: $t('Darstellung'), label: $t('Originalgröße'), mac: ['Mod+0'], win: ['Mod+0'], run: () => stepZoom(0) },
  { id: 'refresh', group: $t('Darstellung'), label: $t('Aktualisieren'), mac: ['Mod+R'], win: ['F5', 'Mod+R'], run: refresh },
  { id: 'terminal', group: $t('Darstellung'), label: $t('Terminal ein/aus'), mac: ['Ctrl+`'], win: ['Mod+`'], run: () => void import('./terminal').then((m) => m.toggleTerminal()) },
  { id: 'terminalNew', group: $t('Darstellung'), label: $t('Neues Terminal'), mac: ['Ctrl+Shift+`'], win: ['Mod+Shift+`'], run: () => void import('./terminal').then((m) => m.newTerminal()) },

  { id: 'back', group: $t('Gehe zu'), label: $t('Zurück'), mac: ['Mod+['], win: ['Alt+ArrowLeft'], run: goBack, notInText: true },
  { id: 'forward', group: $t('Gehe zu'), label: $t('Vor'), mac: ['Mod+]'], win: ['Alt+ArrowRight'], run: goForward, notInText: true },
  { id: 'editPath', group: $t('Gehe zu'), label: $t('Pfad eingeben'), mac: ['Mod+L'], win: ['Mod+L'], run: () => editPath(focus()) },
  { id: 'goHome', group: $t('Gehe zu'), label: $t('Startordner'), mac: ['Mod+Shift+H'], win: [], run: () => goLocal('~') },
  { id: 'goDesktop', group: $t('Gehe zu'), label: $t('Schreibtisch'), mac: ['Mod+Shift+D'], win: [], run: () => goLocal('~/Desktop') },
  { id: 'goDocuments', group: $t('Gehe zu'), label: $t('Dokumente'), mac: ['Mod+Shift+O'], win: [], run: () => goLocal('~/Documents') },
  { id: 'goDownloads', group: $t('Gehe zu'), label: $t('Downloads'), mac: ['Mod+Alt+L'], win: [], run: () => goLocal('~/Downloads') },
  { id: 'openOther', group: $t('Gehe zu'), label: $t('In der anderen Hälfte öffnen'), mac: [], win: [], run: () => openInOtherHalf(focus()) },
  { id: 'bookmark', group: $t('Gehe zu'), label: $t('Ordner zu den Orten hinzufügen'), mac: ['Mod+D'], win: ['Mod+D'], run: addBookmark },

  { id: 'upload', group: $t('Dateien'), label: $t('Hochladen'), mac: ['Mod+Alt+ArrowUp'], win: ['Mod+Alt+ArrowUp'], run: () => upload() },
  { id: 'download', group: $t('Dateien'), label: $t('Herunterladen'), mac: ['Mod+Alt+ArrowDown'], win: ['Mod+Alt+ArrowDown'], run: () => download() },
  { id: 'copy', group: $t('Dateien'), label: $t('Kopieren'), mac: ['Mod+C'], win: ['Mod+C'], run: () => copySelection(focus()), notInText: true },
  { id: 'cut', group: $t('Dateien'), label: $t('Ausschneiden'), mac: ['Mod+X'], win: ['Mod+X'], run: () => cutSelection(focus()), notInText: true },
  { id: 'paste', group: $t('Dateien'), label: $t('In die andere Hälfte einfügen'), mac: ['Mod+V'], win: ['Mod+V'], run: () => pasteClipboard(focus()), notInText: true },
  { id: 'pasteMove', group: $t('Dateien'), label: $t('Hierher bewegen'), mac: ['Mod+Alt+V'], win: [], run: () => pasteMove(focus()), notInText: true },
  { id: 'copyPath', group: $t('Dateien'), label: $t('Pfad kopieren'), mac: ['Mod+Alt+C'], win: ['Mod+Shift+C'], run: () => copyPath(focus()), notInText: true },
  { id: 'newFolder', group: $t('Dateien'), label: $t('Neuer Ordner'), mac: ['Mod+Shift+N'], win: ['Mod+Shift+N'], run: () => newFolder() },
  { id: 'copyTo', group: $t('Dateien'), label: $t('Kopieren nach …'), mac: [], win: [], run: () => { const side = getState().focusSide; const names = selectedNames(side); if (names.length) openDialog({ type: 'copyTo', side, names }); } },
  { id: 'undo', group: $t('Dateien'), label: $t('Widerrufen'), mac: ['Mod+Z'], win: ['Mod+Z'], run: () => undoLast(), notInText: true },
  { id: 'newFile', group: $t('Dateien'), label: $t('Neue Datei'), mac: ['Mod+Alt+N'], win: ['Mod+Alt+N'], run: () => newFile() },
  { id: 'newFolderWithSelection', group: $t('Dateien'), label: $t('Neuer Ordner mit Auswahl'), mac: ['Mod+Ctrl+N'], win: ['Mod+Alt+Shift+N'], run: () => void newFolderWithSelection(), notInText: true },
  { id: 'checksum', group: $t('Dateien'), label: $t('Prüfsumme'), mac: [], win: [], run: () => { const side = focus(); const n = selectedNames(side); if (n.length === 1) openDialog({ type: 'checksum', side, name: n[0] }); } },
  { id: 'folderSizes', group: $t('Dateien'), label: $t('Ordnergrößen berechnen'), mac: [], win: [], run: () => void computeFolderSizes(focus(), selectedNames(focus()).length ? selectedNames(focus()) : undefined) },
  { id: 'selectMask', group: $t('Dateien'), label: $t('Auswählen nach Muster'), mac: ['Mod+Alt+S'], win: ['Mod+Alt+S'], run: () => openDialog({ type: 'selectMask', side: focus() }) },
  { id: 'invertSelection', group: $t('Dateien'), label: $t('Auswahl umkehren'), mac: ['Mod+Shift+I'], win: ['Mod+Shift+I'], run: () => void import('./tools').then((m) => m.invertSelection(focus())), notInText: true },

  // Without keys by default; the Commander keys (WinSCP, Total Commander) put them on F3 … F9.
  { id: 'copyToOther', group: $t('Dateien'), label: $t('In die andere Hälfte kopieren'), mac: [], win: [], run: () => copyToOtherHalf(), notInText: true },
  { id: 'moveToOther', group: $t('Dateien'), label: $t('In die andere Hälfte verschieben'), mac: [], win: [], run: () => moveToOtherSide(), notInText: true },
  { id: 'deleteSel', group: $t('Dateien'), label: $t('Löschen'), mac: [], win: [], run: () => askDelete(focus()), notInText: true },
  { id: 'editSel', group: $t('Dateien'), label: $t('Bearbeiten'), mac: [], win: [], run: () => { const n = selectedNames(focus())[0]; if (n) openInEditor(focus(), n); }, notInText: true },
  { id: 'previewSel', group: $t('Dateien'), label: $t('Vorschau'), mac: [], win: [], run: () => { if (selectedNames(focus()).length) openDialog({ type: 'preview', side: focus() }); }, notInText: true },
  { id: 'propsSel', group: $t('Dateien'), label: $t('Informationen und Rechte'), mac: [], win: [], run: () => { const n = selectedNames(focus())[0]; if (n) openDialog({ type: 'perms', side: focus(), path: joinPath(panePath(focus()), n) }); }, notInText: true },
  { id: 'toggleSel', group: $t('Dateien'), label: $t('Auswahl umschalten und weiter'), mac: [], win: [], run: () => toggleAtCursor(), notInText: true },
  { id: 'selectAdd', group: $t('Dateien'), label: $t('Nach Muster hinzufügen'), mac: [], win: [], run: () => openDialog({ type: 'selectMask', side: focus(), mode: 'add' }), notInText: true },
  { id: 'selectRemove', group: $t('Dateien'), label: $t('Nach Muster abwählen'), mac: [], win: [], run: () => openDialog({ type: 'selectMask', side: focus(), mode: 'remove' }), notInText: true },

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

/**
 * The F keys of WinSCP and Total Commander (Settings > Tastenkürzel > Belegung).
 * They take the place of the defaults; the user's own keys still come first.
 */
const COMMANDER: Record<string, string[]> = {
  previewSel: ['F3'], editSel: ['F4'], copyToOther: ['F5'], moveToOther: ['F6'], newFolder: ['F7', 'Mod+Shift+N'], deleteSel: ['F8'], propsSel: ['F9'],
  // F6 is "move" here, so switching halves has no key of its own.
  otherHalf: [],
  refresh: ['Mod+R'], toggleSel: ['Insert'], selectAdd: ['NumpadAdd'], selectRemove: ['NumpadSubtract'], invertSelection: ['NumpadMultiply', 'Mod+Shift+I'],
};

/** Current keys of an action (user setting, else the chosen key layout, else the default). */
export function keysFor(id: string, platform: Platform = getState().platform): string[] {
  const own = getState().settings.shortcuts[id];
  if (own !== undefined) return own ? [own] : [];
  if (getState().settings.keyScheme === 'commander' && COMMANDER[id]) return COMMANDER[id];
  const a = ACTIONS.find((x) => x.id === id);
  return a ? (platform === 'mac' ? a.mac : a.win) : [];
}

const NAMED: Record<string, [string, string]> = {
  ArrowUp: ['↑', '↑'], ArrowDown: ['↓', '↓'], ArrowLeft: ['←', '←'], ArrowRight: ['→', '→'],
  Insert: ['Einfg', $t('Einfg')], NumpadAdd: ['+ (Ziffernblock)', $t('+ (Ziffernblock)')], NumpadSubtract: ['− (Ziffernblock)', $t('− (Ziffernblock)')], NumpadMultiply: ['* (Ziffernblock)', $t('* (Ziffernblock)')],
  Enter: ['↩', 'Enter'], Backspace: ['⌫', $t('Rücktaste')], Delete: ['⌦', $t('Entf')], Escape: ['esc', $t('Esc')], Tab: ['⇥', 'Tab'], Space: [$t('Leertaste'), $t('Leertaste')],
};

/** Display text: "⌥⌘T" on the Mac, "Strg+Alt+T" on Windows. */
export function formatCombo(combo: string, platform: Platform = getState().platform): string {
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
  // Number pad + - * have names of their own (Commander keys), apart from the keys of the main block.
  if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract' || e.code === 'NumpadMultiply') out.push(e.code);
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
