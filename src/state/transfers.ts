/**
 * Transfers: uploads, downloads and copies between servers, their queue, and the
 * questions when a file already exists at the target.
 */

import * as fs from '../backend/mockFs';
import * as live from './live';
import type { ConflictChoice, PaneSide, Transfer } from '../backend/types';

import * as paths from '../util/paths';
import { $t } from '../i18n';
import {
  setState,
  showToast,
  LIVE,
  serverById,
  uid,
  activeTab,
  panePath,
  state,
  listEntries,
  isDirEntry,
} from './core';
import { placeOf, selectedNames } from './fileOps';
import { updateSettings } from './settings';
import { openDialog } from './panels';
import { pushUndo } from './undo';
import { relFolder } from '../util/paths';

/** Adds transfers to the end of the queue. */
export function enqueue(items: Transfer[]) {
  if (!items.length) return;
  setState((s) => ({ transfers: [...s.transfers, ...items] }));
}

/**
 * Copies files or folders from one place to another; a place is this computer
 * ('') or a server id. Computer to server uploads, server to computer
 * downloads, server to server streams through this computer.
 */
export function transferNames(from: string, fromDir: string, names: string[], to: string, toDir: string) {
  if (!names.length) return;
  // An opened archive on this computer is read-only.
  if (!to && paths.archiveFolder(toDir)) {
    showToast($t('Archive sind schreibgeschützt. Zum Ändern zuerst entpacken.'), 'error');
    return;
  }
  // Two local halves: a plain copy on this computer (Total Commander).
  if (!from && !to) {
    copyOrMoveLocal(fromDir, names, toDir, false);
    return;
  }
  if (from === to) return;
  // Rows inside opened folders carry a relative path ("routes/cart.py"); like in
  // the Finder they land directly in the target folder, grouped by their source folder.
  if (names.some((n) => n.includes('/'))) {
    const groups = new Map<string, string[]>();
    for (const n of names) {
      const dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
      groups.set(dir, [...(groups.get(dir) ?? []), n.slice(n.lastIndexOf('/') + 1)]);
    }
    for (const [dir, list] of groups) transferNames(from, dir ? paths.join(fromDir, dir) : fromDir, list, to, toDir);
    return;
  }
  setState({ contextMenu: null });
  if (LIVE) {
    const offline = [from, to].find((id) => id && !live.isConnected(id));
    if (offline) {
      showToast($t('Keine Verbindung zu {0}.', serverById(offline)?.name ?? $t('dem Server')), 'error');
      if (!live.isConnecting(offline)) live.connectNow(offline);
      return;
    }
    if (!from) void live.uploadNames(to, fromDir, toDir, names);
    else if (!to) void live.downloadNames(from, fromDir, toDir, names);
    else void live.crossNames(from, fromDir, to, toDir, names);
    return;
  }
  const items: Transfer[] = [];
  const direction: Transfer['direction'] = !from ? 'up' : !to ? 'down' : 'cross';
  for (const n of names) {
    const src = paths.join(fromDir, n);
    for (const f of fs.walkFiles(from ? 'remote' : 'local', from || to, src)) {
      const target = paths.join(toDir, f.path.slice(fromDir.length + 1));
      items.push({
        id: uid('t'),
        name: f.entry.name,
        direction,
        serverId: to || from,
        ...(direction === 'cross' ? { sourceServerId: from } : {}),
        folder: relFolder(toDir, target),
        source: f.path,
        target,
        size: f.entry.size,
        done: 0,
        state: 'queued',
      });
    }
  }
  enqueue(items);
  if (items.length > 1) showToast($t('{0} Dateien in der Warteschlange.', items.length));
}

/** Copies or moves between two folders of this computer; names may carry a relative path. */
/**
 * "Kopieren nach …" (ForkLift): the chosen entries of a half into a folder of
 * this computer, without opening it in the other half first. From a server
 * that is a download; on this computer a copy or, if chosen, a move.
 */
export function copyTo(side: PaneSide, names: string[], toDir: string, move = false) {
  const t = activeTab();
  if (!t || !names.length) return;
  setState({ dialog: null });
  const from = placeOf(side, t);
  const fromDir = panePath(side);
  if (!from && fromDir === toDir) {
    showToast($t('Das ist schon der Ordner der Dateien.'));
    return;
  }
  if (!from) copyOrMoveLocal(fromDir, names, toDir, move);
  else transferNames(from, fromDir, names, '', toDir);
  const recent = [toDir, ...(state.settings.copyToRecent ?? []).filter((p) => p !== toDir)].slice(0, 6);
  updateSettings({ copyToRecent: recent });
}

export function copyOrMoveLocal(fromDir: string, names: string[], toDir: string, move: boolean) {
  setState({ contextMenu: null });
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
    groups.set(dir, [...(groups.get(dir) ?? []), n.slice(n.lastIndexOf('/') + 1)]);
  }
  for (const [dir, list] of groups) {
    const src = dir ? paths.join(fromDir, dir) : fromDir;
    if (src === toDir) {
      showToast($t('Quelle und Ziel sind derselbe Ordner.'));
      continue;
    }
    // Folders that already exist in the target: ask "Zusammenführen" or "Beide behalten" (Transmit).
    const target = new Set((listEntries('local', '', toDir) ?? []).filter((e) => e.kind === 'dir').map((e) => e.name));
    const clashes = list.filter((n) => target.has(n) && isDirEntry('local', '', paths.join(src, n)));
    if (clashes.length) {
      openDialog({ type: 'mergeFolders', fromDir: src, names: list, toDir, move, clashes });
      continue;
    }
    if (LIVE) {
      if (move)
        void live.moveLocal(src, list, toDir).then((made) => {
          if (made?.length)
            pushUndo({
              label: made.length === 1 ? $t('„{0}“ verschoben', made[0]) : $t('{0} Objekte verschoben', made.length),
              run: () => live.moveLocal(toDir, made, src),
            });
        });
      else void live.copyLocal(src, list, toDir);
      continue;
    }
    showToast(
      move
        ? $t('{0} Objekte verschoben (simuliert).', list.length)
        : $t('{0} Objekte kopiert (simuliert).', list.length),
      'ok',
    );
  }
}

/** Answer of the "Ordner zusammenführen?" window: copies or moves, merging same-named folders or keeping both. */
export function finishCopyOrMove(fromDir: string, names: string[], toDir: string, move: boolean, merge: boolean) {
  setState({ dialog: null });
  if (LIVE) {
    void (move ? live.moveLocal(fromDir, names, toDir, merge) : live.copyLocal(fromDir, names, toDir, merge));
    return;
  }
  showToast(
    merge
      ? $t('{0} Objekte zusammengeführt (simuliert).', names.length)
      : move
        ? $t('{0} Objekte verschoben (simuliert).', names.length)
        : $t('{0} Objekte kopiert (simuliert).', names.length),
    'ok',
  );
}

/** Two local halves: moves the selection of one half into the folder of the other. */
export function moveToOtherHalf(side: PaneSide) {
  const t = activeTab();
  if (!t) return;
  const other: PaneSide = side === 'local' ? 'remote' : 'local';
  if (placeOf(side, t) || placeOf(other, t)) return;
  copyOrMoveLocal(panePath(side), selectedNames(side), panePath(other), true);
}

/** "Hochladen": the selected names of the left half go into the right half. */
export function upload(names = selectedNames('local'), targetDir?: string, sourceDir?: string) {
  const t = activeTab();
  if (!t) return;
  transferNames(
    placeOf('local', t),
    sourceDir ?? panePath('local'),
    names,
    placeOf('remote', t),
    targetDir ?? panePath('remote'),
  );
}

/** Files dropped in from the Finder / Explorer (native paths) go to a server folder. */
export function uploadLocalPaths(nativePaths: string[], dir: string, side: PaneSide = 'remote') {
  const t = activeTab();
  const to = placeOf(side, t);
  if (!t || !LIVE || !to) return;
  if (!live.isConnected(to)) {
    showToast($t('Keine Verbindung zum Server.'), 'error');
    return;
  }
  void live.uploadNativePaths(to, nativePaths, dir);
}

/** "Herunterladen": the selected names of the right half go into the left half. */
export function download(names = selectedNames('remote'), targetDir?: string, sourceDir?: string) {
  const t = activeTab();
  if (!t) return;
  transferNames(
    placeOf('remote', t),
    sourceDir ?? panePath('remote'),
    names,
    placeOf('local', t),
    targetDir ?? panePath('local'),
  );
}

export function retryTransfer(id: string) {
  const tr = state.transfers.find((x) => x.id === id);
  if (LIVE && tr) live.clearFailed(tr.serverId);
  setState((s) => ({
    transfers: s.transfers.map((x) =>
      x.id === id ? { ...x, state: 'queued', done: 0, error: undefined, errorDetail: undefined, hold: undefined } : x,
    ),
  }));
}

export function skipTransfer(id: string) {
  setState((s) => ({ transfers: s.transfers.filter((x) => x.id !== id) }));
}

export function cancelTransfer(id: string) {
  setState((s) => ({ transfers: s.transfers.filter((x) => x.id !== id) }));
}

export function toggleTransferPause(id: string) {
  setState((s) => ({
    transfers: s.transfers.map((x) =>
      x.id === id
        ? {
            ...x,
            hold: undefined,
            state: x.state === 'paused' ? 'queued' : x.state === 'running' || x.state === 'queued' ? 'paused' : x.state,
          }
        : x,
    ),
  }));
}

export function pauseAllTransfers() {
  const anyActive = state.transfers.some((x) => x.state === 'running' || x.state === 'queued');
  setState((s) => ({
    transfers: s.transfers.map((x) =>
      anyActive
        ? x.state === 'running' || x.state === 'queued'
          ? { ...x, state: 'paused', hold: undefined }
          : x
        : x.state === 'paused'
          ? { ...x, state: 'queued', hold: undefined }
          : x,
    ),
  }));
}

/**
 * "Alle abbrechen" (WinSCP, FileZilla: clear the queue): every transfer that has not
 * finished is removed, after asking. Files already transferred stay where they are.
 */
export function askCancelAllTransfers() {
  const open = state.transfers.filter((x) => x.state !== 'done');
  if (!open.length) return;
  openDialog({
    type: 'confirm',
    danger: true,
    confirm: $t('Alle abbrechen'),
    title: open.length === 1 ? $t('Die Übertragung abbrechen?') : $t('Alle {0} Übertragungen abbrechen?', open.length),
    text: $t('Was schon übertragen ist, bleibt erhalten. Die übrigen Dateien werden nicht mehr übertragen.'),
    run: () =>
      setState((s) => ({ transfers: s.transfers.filter((x) => x.state === 'done'), dialog: { type: 'transfers' } })),
  });
}

export function clearFinished() {
  setState((s) => ({ transfers: s.transfers.filter((x) => x.state !== 'done') }));
}

/** Moves a waiting transfer before another one (drag to reorder). */
export function reorderTransfer(id: string, beforeId: string) {
  setState((s) => {
    const list = [...s.transfers];
    const from = list.findIndex((x) => x.id === id);
    if (from < 0) return {};
    const [item] = list.splice(from, 1);
    const to = list.findIndex((x) => x.id === beforeId);
    list.splice(to < 0 ? list.length : to, 0, item);
    return { transfers: list };
  });
}

/** Fixes the demo permission problem so "Wiederholen" succeeds. */
export function fixDemoPermissions() {
  if (LIVE) return;
  fs.chmod('remote', 'ob', '/home/deploy/apps/webshop/admin/static', '775', 'deploy', 'deploy');
  setState((s) => ({ fsRev: s.fsRev + 1 }));
}

/* ------------------------------------------------------------------------ */
/* Conflicts                                                                */
/* ------------------------------------------------------------------------ */

export function resolveConflict(choice: ConflictChoice, applyToAll: boolean) {
  const queue = applyToAll ? state.conflicts : state.conflicts.slice(0, 1);
  for (const c of queue) {
    const tr = state.transfers.find((x) => x.id === c.transferId);
    if (!tr) continue;
    // "Take the server version" on a download conflict means: download and replace.
    const pick: ConflictChoice = choice === 'download' && c.direction === 'down' ? 'replace' : choice;
    if (pick === 'keepServer') {
      // "Keep what is already at the target": the server file on uploads, the local file on downloads.
      const note =
        c.direction === 'down'
          ? $t('Übersprungen, Datei auf diesem Rechner behalten')
          : $t('Übersprungen, Server-Datei behalten');
      setState((s) => ({
        transfers: s.transfers.map((x) =>
          x.id === tr.id ? { ...x, state: 'done', done: 0, finishedAt: Date.now(), error: note, hold: undefined } : x,
        ),
      }));
    } else if (pick === 'replace') {
      setState((s) => ({
        transfers: s.transfers.map((x) =>
          x.id === tr.id ? { ...x, state: 'queued', error: undefined, hold: undefined } : x,
        ),
      }));
      forced.add(tr.id);
      live.forcedLive.add(tr.id);
    } else if (pick === 'keepBoth') {
      const dot = tr.name.lastIndexOf('.');
      const tag =
        c.direction === 'down'
          ? $t('Server')
          : c.cross
            ? (serverById(c.sourceServerId ?? '')?.name ?? $t('Server'))
            : state.platform === 'mac'
              ? $t('Mac')
              : 'PC';
      const newName = dot > 0 ? `${tr.name.slice(0, dot)} (${tag})${tr.name.slice(dot)}` : `${tr.name} (${tag})`;
      setState((s) => ({
        transfers: s.transfers.map((x) =>
          x.id === tr.id
            ? {
                ...x,
                state: 'queued',
                error: undefined,
                hold: undefined,
                name: newName,
                target: paths.join(paths.parent(x.target), newName),
              }
            : x,
        ),
      }));
      forced.add(tr.id);
      live.forcedLive.add(tr.id);
    } else if (LIVE) {
      live.downloadInstead(tr);
    } else {
      const remote = fs.stat('remote', tr.serverId, tr.target);
      fs.writeFile('local', tr.serverId, tr.source, remote?.size ?? tr.size, Date.now());
      setState((s) => ({
        fsRev: s.fsRev + 1,
        transfers: s.transfers.map((x) =>
          x.id === tr.id ? { ...x, direction: 'down', state: 'done', done: x.size, finishedAt: Date.now() } : x,
        ),
      }));
    }
  }
  const rest = state.conflicts.slice(queue.length).map((c, i, arr) => ({ ...c, more: arr.length - 1 - i }));
  setState({ conflicts: rest, dialog: rest.length ? { type: 'conflict' } : null });
}

/** Transfers that already passed the conflict check. */
export const forced = new Set<string>();
