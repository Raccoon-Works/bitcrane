/**
 * File operations in the two halves: new, rename, delete, copy and move, archives, sizes.
 */

import * as fs from '../backend/mockFs';
import * as live from './live';
import type { PaneSide } from '../backend/types';

import { formatSize } from '../util/format';
import * as paths from '../util/paths';
import { $t } from '../i18n';
import {
  setState,
  activeTab,
  paneLoc,
  showToast,
  panePath,
  LIVE,
  isOffline,
  listEntries,
  paneOnServer,
  serverById,
  paneShowsServers,
  getState,
  emptySelection,
  placeOf,
} from './core';
import { askMoveAcross } from './clipboard';
import { paneEntries } from './rows';
import type { AppState } from './appState';
import { openDialog } from './panels';
import { pushUndo, renameAt } from './undo';

import { transferNames, copyOrMoveLocal } from './transfers';

/** Names selected in a pane, or the entry under the cursor. */
export function selectedNames(side: PaneSide): string[] {
  return getState().selection[side].names;
}

export function startRename(side: PaneSide, name?: string) {
  const sel = selectedNames(side);
  // Several selected: the window for renaming many at once.
  if (!name && sel.length > 1) {
    openDialog({ type: 'batchRename', side, names: sel });
    return;
  }
  const n = name ?? sel[0];
  if (n) setState({ renaming: { side, name: n }, contextMenu: null });
}

export function commitRename(side: PaneSide, oldName: string, newName: string) {
  const t = activeTab();
  setState({ renaming: null });
  // Rows inside opened folders carry a relative path; the new name is just the last part.
  const cut = oldName.lastIndexOf('/');
  const prefix = cut >= 0 ? oldName.slice(0, cut + 1) : '';
  const base = oldName.slice(cut + 1);
  const name = newName.trim();
  if (!t || !name || name === base) return;
  // Windows forbids more characters in local names than servers do.
  const winLocal = getState().platform === 'win' && paneLoc(side, t)[0] === 'local';
  if (name.includes('/') || (winLocal && /[\\:*?"<>|]/.test(name))) {
    showToast($t('Ein Name darf diese Zeichen nicht enthalten: {0}', winLocal ? '/ \\ : * ? " < > |' : '/'), 'error');
    return;
  }
  const dir = prefix ? paths.join(panePath(side), prefix.slice(0, -1)) : panePath(side);
  const selectRenamed = () =>
    setState((s) => ({ selection: { ...s.selection, [side]: { ...s.selection[side], names: [prefix + name] } } }));
  const loc = paneLoc(side, t);
  const undo = () => pushUndo({ label: $t('„{0}“ umbenannt', name), run: () => renameAt(...loc, dir, name, base) });
  if (LIVE) {
    void live.renameEntry(...loc, dir, base, name).then((ok) => {
      if (ok) {
        selectRenamed();
        undo();
      }
    });
    return;
  }
  const ok = fs.rename(...loc, paths.join(dir, base), name);
  if (!ok) {
    showToast($t('„{0}“ gibt es hier schon.', name), 'error');
    return;
  }
  undo();
  setState((s) => ({ fsRev: s.fsRev + 1 }));
  selectRenamed();
}

export function newFolder(side: PaneSide = getState().focusSide) {
  const t = activeTab();
  if (!t) return;
  const loc = paneLoc(side, t);
  if (loc[0] === 'remote' && isOffline(loc[1])) return;
  const existing = new Set((listEntries(...loc, panePath(side)) ?? []).map((e) => e.name));
  let name = $t('Neuer Ordner');
  let i = 2;
  while (existing.has(name)) name = $t('Neuer Ordner {0}', i++);
  if (LIVE) {
    const dir = panePath(side);
    void live.makeFolder(...loc, dir, name).then((ok) => {
      if (ok) pushUndo({ label: $t('Neuer Ordner „{0}“', name), run: () => live.removeIfEmpty(...loc, dir, name) });
      if (ok && getState().activeTabId === t.id && panePath(side) === dir)
        setState((s) => ({
          focusSide: side,
          selection: { ...s.selection, [side]: { names: [name], cursor: -1, anchor: -1 } },
          renaming: { side, name },
        }));
    });
    setState({ contextMenu: null });
    return;
  }
  fs.makeDir(...loc, paths.join(panePath(side), name));
  setState((s) => ({ fsRev: s.fsRev + 1, focusSide: side, contextMenu: null }));
  const idx = paneEntries(side).findIndex((e) => e.name === name);
  setState((s) => ({
    selection: { ...s.selection, [side]: { names: [name], cursor: idx, anchor: idx } },
    renaming: { side, name },
  }));
}

/**
 * "Synchron blättern" reached a folder that does not exist on this side yet:
 * creates it (Transmit asks the same), then shows it.
 */
export function createMissingFolder(side: PaneSide) {
  const t = activeTab();
  if (!t) return;
  const loc = paneLoc(side, t);
  const path = panePath(side);
  if (!LIVE) {
    fs.makeDir(...loc, path);
    setState((s) => ({ fsRev: s.fsRev + 1 }));
    return;
  }
  void live.makeFolder(...loc, paths.parent(path), paths.basename(path)).then((ok) => {
    if (ok) live.refreshVisible();
  });
}

/** "Neue Datei" (ForkLift): an empty text file, named right away. */
export function newFile(side: PaneSide = getState().focusSide) {
  const t = activeTab();
  if (!t) return;
  const loc = paneLoc(side, t);
  if (loc[0] === 'remote' && isOffline(loc[1])) return;
  const existing = new Set((listEntries(...loc, panePath(side)) ?? []).map((e) => e.name));
  let name = $t('Neue Datei.txt');
  let i = 2;
  while (existing.has(name)) name = $t('Neue Datei {0}.txt', i++);
  const dir = panePath(side);
  const select = () => {
    const idx = paneEntries(side).findIndex((e) => e.name === name);
    setState((s) => ({
      focusSide: side,
      selection: { ...s.selection, [side]: { names: [name], cursor: idx, anchor: idx } },
      renaming: { side, name },
    }));
  };
  setState({ contextMenu: null });
  if (LIVE) {
    void live.makeFile(...loc, dir, name).then((ok) => {
      if (ok) pushUndo({ label: $t('Neue Datei „{0}“', name), run: () => live.removeIfEmpty(...loc, dir, name) });
      if (ok && getState().activeTabId === t.id && panePath(side) === dir) select();
    });
    return;
  }
  fs.writeFile(...loc, paths.join(dir, name), 0);
  setState((s) => ({ fsRev: s.fsRev + 1 }));
  select();
}

export function askDelete(side: PaneSide, names = selectedNames(side)) {
  if (!names.length) return;
  if (getState().settings.confirmDelete || paneOnServer(side)) openDialog({ type: 'confirmDelete', side, names });
  else deleteNames(side, names);
}

export function deleteNames(side: PaneSide, names: string[]) {
  const t = activeTab();
  if (!t) return;
  if (LIVE) {
    setState((s) => ({ dialog: null, selection: { ...s.selection, [side]: emptySelection() } }));
    void live.removeEntries(...paneLoc(side, t), panePath(side), names);
    return;
  }
  names.forEach((n) => fs.remove(...paneLoc(side, t), paths.join(panePath(side), n)));
  setState((s) => ({
    fsRev: s.fsRev + 1,
    dialog: null,
    selection: { ...s.selection, [side]: emptySelection() },
  }));
  showToast(names.length === 1 ? $t('„{0}“ gelöscht.', names[0]) : $t('{0} Objekte gelöscht.', names.length));
}

/** Editor program for a file name ('' = the system's default program). */
export function editorFor(name: string, s: AppState = getState()): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  return (ext && s.settings.editorByExt[ext]) || s.settings.editorApp;
}

export const folderSizeKey = (side: PaneSide, serverId: string, path: string) =>
  `${side}|${side === 'local' ? '' : serverId}|${path}`;

/** "Im Finder/Explorer zeigen" (this computer only). */
export function revealEntry(side: PaneSide, name: string) {
  setState({ contextMenu: null });
  if (LIVE) live.revealLocal(paths.join(panePath(side), name));
  else showToast($t('„{0}“ wird im Finder bzw. Explorer gezeigt.', name));
}

/** Opens a local file with its default program (archives otherwise open like a folder). */
export function openWithDefaultApp(side: PaneSide, name: string) {
  setState({ contextMenu: null });
  if (LIVE) live.openLocal(paths.join(panePath(side), name));
  else showToast($t('„{0}“ wird im Standard-Programm geöffnet.', name));
}

/** "Komprimieren" (this computer only): the chosen entries go into one zip next to them. */
export function compressEntries(side: PaneSide, names: string[]) {
  setState({ contextMenu: null });
  if (!LIVE) {
    showToast($t('Komprimieren geht im echten Programm.'));
    return;
  }
  void live.zipLocal(panePath(side), names);
}

/** "Entpacken" (this computer only): a zip is unpacked into a new folder next to it. */
export function extractArchive(side: PaneSide, name: string) {
  setState({ contextMenu: null });
  if (!LIVE) {
    showToast($t('Entpacken geht im echten Programm.'));
    return;
  }
  void live.unzipLocal(panePath(side), name);
}

/** One file for "Dateien vergleichen": where it is and how it is called in the window. */
export interface CompareRef {
  side: PaneSide;
  serverId: string;
  path: string;
  label: string;
}

/** Opens the comparison of two files; each may be on this computer or a server. */
export function compareFiles(a: { side: PaneSide; name: string }, b: { side: PaneSide; name: string }) {
  const t = activeTab();
  if (!t) return;
  const ref = (x: { side: PaneSide; name: string }): CompareRef => {
    const [side, serverId] = paneLoc(x.side, t);
    const where = side === 'local' ? $t('Dieser Computer') : (serverById(serverId)?.name ?? '');
    return {
      side,
      serverId,
      path: paths.join(panePath(x.side), x.name),
      label: `${paths.basename(x.name)} · ${where}`,
    };
  };
  setState({ contextMenu: null });
  openDialog({ type: 'compareFiles', a: ref(a), b: ref(b) });
}

/**
 * "Ordnergrößen berechnen" (ForkLift, WinSCP): the given folders, or every
 * folder of the half when none are given. Sizes appear in the list as they
 * come in; three folders are read at a time.
 */
export async function computeFolderSizes(side: PaneSide = getState().focusSide, names?: string[]) {
  const t = activeTab();
  if (!t) return;
  setState({ contextMenu: null });
  const loc = paneLoc(side, t);
  if (loc[0] === 'remote' && isOffline(loc[1])) return;
  const dir = panePath(side);
  const folders = names?.length
    ? names
    : (listEntries(...loc, dir) ?? []).filter((e) => e.kind === 'dir').map((e) => e.name);
  if (!folders.length) {
    showToast($t('In diesem Ordner gibt es keine Unterordner.'));
    return;
  }
  showToast(
    folders.length === 1
      ? $t('Größe von „{0}“ wird berechnet …', folders[0])
      : $t('Größe von {0} Ordnern wird berechnet …', folders.length),
  );
  let files = 0;
  let total = 0;
  let failed = 0;
  const one = async (name: string) => {
    const path = paths.join(dir, name);
    try {
      const list = LIVE
        ? await live.walkFiles(...loc, path)
        : fs.walkFiles(...loc, path).map((f) => ({ size: f.entry.size }));
      const size = list.reduce((a, f) => a + f.size, 0);
      files += list.length;
      total += size;
      setState((s) => ({ folderSizes: { ...s.folderSizes, [folderSizeKey(...loc, path)]: size } }));
    } catch {
      failed++;
    }
  };
  for (let i = 0; i < folders.length; i += 3) await Promise.all(folders.slice(i, i + 3).map(one));
  if (failed === folders.length) {
    showToast($t('Größe nicht berechenbar.'), 'error');
    return;
  }
  const what = folders.length === 1 ? `„${folders[0]}“` : $t('{0} Ordner', folders.length);
  showToast(
    $t('{0}: {1} in {2} {3}.', what, formatSize(total), files, files === 1 ? $t('Datei') : $t('Dateien')) +
      (failed ? ' ' + $t('{0} nicht lesbar.', failed) : ''),
    'ok',
  );
}

/**
 * Entries dragged onto a folder of the same half are moved into it (Finder,
 * Transmit, ForkLift). Moves on this computer can be taken back with ⌘Z.
 */
export function moveIntoFolder(side: PaneSide, names: string[], toDir: string, dir: string = panePath(side)) {
  const t = activeTab();
  if (!t || !names.length) return;
  const loc = paneLoc(side, t);
  if (loc[0] === 'remote' && isOffline(loc[1])) return;
  // Never into itself or one of its own subfolders, and not where it already is.
  const list = names.filter((n) => {
    const from = paths.join(dir, n);
    return toDir !== from && !toDir.startsWith(from + '/') && paths.parent(from) !== toDir;
  });
  if (!list.length) return;
  if (!LIVE) {
    for (const n of list) fs.move(...loc, paths.join(dir, n), toDir);
    setState((s) => ({
      fsRev: s.fsRev + 1,
      selection: { ...s.selection, [side]: emptySelection() },
    }));
    showToast(
      list.length === 1 ? $t('„{0}“ verschoben.', paths.basename(list[0])) : $t('{0} Objekte verschoben.', list.length),
      'ok',
    );
    return;
  }
  if (loc[0] === 'local') {
    // Grouped by the folder each entry comes from (rows of opened subfolders carry a path).
    const groups = new Map<string, string[]>();
    for (const n of list) {
      const from = n.includes('/') ? paths.join(dir, n.slice(0, n.lastIndexOf('/'))) : dir;
      groups.set(from, [...(groups.get(from) ?? []), paths.basename(n)]);
    }
    for (const [from, items] of groups) {
      void live.moveLocal(from, items, toDir).then((made) => {
        if (made?.length)
          pushUndo({
            label: made.length === 1 ? $t('„{0}“ verschoben', made[0]) : $t('{0} Objekte verschoben', made.length),
            run: () => live.moveLocal(toDir, made, from),
          });
      });
    }
  } else void live.moveInto(...loc, dir, list, toDir);
  setState((s) => ({ selection: { ...s.selection, [side]: emptySelection() } }));
}

/**
 * "Neuer Ordner mit Auswahl" (ForkLift): moves the chosen entries into a new
 * folder of the same half and starts renaming it.
 */
export async function newFolderWithSelection(side: PaneSide = getState().focusSide) {
  const t = activeTab();
  const names = selectedNames(side).filter((n) => !n.includes('/'));
  if (!t || !names.length) return;
  setState({ contextMenu: null });
  const loc = paneLoc(side, t);
  if (loc[0] === 'remote' && isOffline(loc[1])) return;
  const dir = panePath(side);
  const existing = new Set((listEntries(...loc, dir) ?? []).map((e) => e.name));
  let name = $t('Neuer Ordner');
  let i = 2;
  while (existing.has(name)) name = $t('Neuer Ordner {0}', i++);
  const target = paths.join(dir, name);
  if (!LIVE) {
    fs.makeDir(...loc, target);
    for (const n of names) fs.move(...loc, paths.join(dir, n), target);
    setState((s) => ({
      fsRev: s.fsRev + 1,
      focusSide: side,
      selection: { ...s.selection, [side]: { names: [name], cursor: -1, anchor: -1 } },
      renaming: { side, name },
    }));
    return;
  }
  const ok = await live.makeFolder(...loc, dir, name);
  if (!ok) return;
  const moved = await live.moveInto(...loc, dir, names, target);
  if (moved)
    setState((s) => ({
      focusSide: side,
      selection: { ...s.selection, [side]: { names: [name], cursor: -1, anchor: -1 } },
      renaming: { side, name },
    }));
}

/** "Im Finder / Explorer zeigen" from the menu: the selected entry, or the folder itself. */
export function revealSelection(side: PaneSide = getState().focusSide) {
  const t = activeTab();
  if (!t || placeOf(side, t)) {
    showToast($t('Das geht nur mit Ordnern dieses Computers.'));
    return;
  }
  const n = selectedNames(side)[0];
  if (n) revealEntry(side, n);
  else if (LIVE) live.revealLocal(panePath(side));
}

/** F5 in the Commander keys: the selection goes into the folder of the other half (copy, upload or download). */
export function copyToOtherHalf(side: PaneSide = getState().focusSide) {
  const t = activeTab();
  if (!t) return;
  const other: PaneSide = side === 'local' ? 'remote' : 'local';
  if (paneShowsServers(other)) {
    showToast($t('Die andere Hälfte zeigt gerade die Serverliste.'));
    return;
  }
  transferNames(placeOf(side, t), panePath(side), selectedNames(side), placeOf(other, t), panePath(other));
}

/** "Verschieben in die andere Hälfte" (F6 in the Commander keys). */
export function moveToOtherSide(side: PaneSide = getState().focusSide) {
  const t = activeTab();
  if (!t) return;
  const names = selectedNames(side);
  if (!names.length) return;
  const other: PaneSide = side === 'local' ? 'remote' : 'local';
  if (paneShowsServers(other)) {
    showToast($t('Die andere Hälfte zeigt gerade die Serverliste.'));
    return;
  }
  const from = placeOf(side, t);
  const to = placeOf(other, t);
  if (from === to) {
    if (!from) copyOrMoveLocal(panePath(side), names, panePath(other), true);
    else moveIntoFolder(side, names, panePath(other));
    return;
  }
  askMoveAcross(from, panePath(side), names, to, panePath(other));
}

/** "Bearbeiten mit …": opens the file with a chosen program instead of the usual editor. */
export function editWith(side: PaneSide, name: string, app: string | null) {
  const t = activeTab();
  if (!t) return;
  setState({ dialog: null, contextMenu: null });
  const path = paths.join(panePath(side), name);
  const [ls, sid] = paneLoc(side, t);
  // null: the built-in editor of Bitcrane.
  if (app === null) {
    void import('./editor').then((m) => m.openFile(ls === 'local' ? '' : sid, path));
    return;
  }
  if (!LIVE) {
    showToast($t('„{0}“ wird mit {1} geöffnet.', name, app || $t('dem Standardprogramm')));
    return;
  }
  if (ls === 'local') live.openLocal(path, app);
  else void live.editRemote(sid, path, app);
}

export function copyPath(side: PaneSide, name?: string) {
  const p = name ? paths.join(panePath(side), name) : panePath(side);
  setState({ contextMenu: null });
  void navigator.clipboard.writeText(p).then(
    () => showToast($t('Pfad kopiert: {0}', p)),
    () => showToast($t('Kopieren nicht möglich.'), 'error'),
  );
}

export function savePerms(
  side: PaneSide,
  path: string,
  perms: string,
  owner: string,
  group: string,
  recursive: boolean,
) {
  const t = activeTab();
  if (!t) return;
  if (LIVE) {
    setState({ dialog: null });
    const [ls, sid] = paneLoc(side, t);
    if (ls === 'remote') void live.changePerms(sid, path, perms, recursive);
    else showToast($t('Rechte auf diesem Computer ändert Bitcrane nicht. Das geht im Finder bzw. Explorer.'));
    return;
  }
  fs.chmod(...paneLoc(side, t), path, perms, owner, group, recursive);
  setState((s) => ({ fsRev: s.fsRev + 1, dialog: null }));
  showToast($t('Rechte gesetzt: {0}{1}', perms, recursive ? $t(' (mit Unterordnern)') : ''), 'ok');
}
