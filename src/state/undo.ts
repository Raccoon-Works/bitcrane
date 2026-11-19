/**
 * Undo of file operations (rename, move, delete to the trash, new folders).
 */
import * as fs from '../backend/mockFs';
import * as live from './live';
import type { PaneSide } from '../backend/types';

import * as paths from '../util/paths';
import { $t } from '../i18n';
import { showToast, LIVE, setState, activeTab, panePath, paneLoc, getState } from './core';

/**
 * "Widerrufen" for file actions (ForkLift): renaming, moving on this computer
 * and new files and folders can be taken back with ⌘Z / Ctrl+Z, the last one
 * first. Deleting is not on the list: on this computer it goes to the trash
 * (put back from there), on a server it is final and asked for beforehand.
 * So undoing a new folder or file removes it only while it is still empty.
 */
interface UndoEntry {
  label: string;
  run: () => Promise<unknown> | void;
}
const undoStack: UndoEntry[] = [];

export function pushUndo(entry: UndoEntry) {
  undoStack.push(entry);
  if (undoStack.length > 30) undoStack.shift();
}

export function undoLast() {
  const e = undoStack.pop();
  if (!e) {
    showToast($t('Nichts zum Widerrufen.'));
    return;
  }
  void Promise.resolve(e.run()).then((ok) => {
    if (ok !== false) showToast($t('Widerrufen: {0}', e.label), 'ok');
  });
}

/** Renames in a folder of a place (this computer or a server); for undo. */
export function renameAt(side: PaneSide, serverId: string, dir: string, from: string, to: string): Promise<boolean> {
  if (LIVE) return live.renameEntry(side, serverId, dir, from, to);
  const ok = fs.rename(side, serverId, paths.join(dir, from), to);
  setState((s) => ({ fsRev: s.fsRev + 1 }));
  return Promise.resolve(!!ok);
}

export function renameMany(side: PaneSide, pairs: Array<[string, string]>) {
  const t = activeTab();
  setState({ dialog: null });
  if (!t || !pairs.length) return;
  // The folder is fixed now; the user may switch tabs while the renames run.
  const dir = panePath(side);
  if (LIVE) {
    void (async () => {
      let ok = 0;
      const loc = paneLoc(side, t);
      const done: Array<[string, string]> = [];
      for (const [from, to] of pairs)
        if (await live.renameEntry(...loc, dir, from, to)) {
          ok++;
          done.push([from, to]);
        }
      if (done.length)
        pushUndo({
          label: $t('{0} Objekte umbenannt', done.length),
          run: async () => {
            for (const [from, to] of [...done].reverse()) await renameAt(...loc, dir, to, from);
          },
        });
      showToast(
        ok === pairs.length ? $t('{0} Objekte umbenannt.', ok) : $t('{0} von {1} umbenannt.', ok, pairs.length),
        ok === pairs.length ? 'ok' : 'error',
      );
      if (getState().activeTabId === t.id && panePath(side) === dir)
        setState((s) => ({
          selection: { ...s.selection, [side]: { names: pairs.map((p) => p[1]), cursor: -1, anchor: -1 } },
        }));
    })();
    return;
  }
  for (const [from, to] of pairs) fs.rename(...paneLoc(side, t), paths.join(dir, from), to);
  const loc = paneLoc(side, t);
  pushUndo({
    label: $t('{0} Objekte umbenannt', pairs.length),
    run: async () => {
      for (const [from, to] of [...pairs].reverse()) await renameAt(...loc, dir, to, from);
    },
  });
  setState((s) => ({
    fsRev: s.fsRev + 1,
    selection: { ...s.selection, [side]: { names: pairs.map((p) => p[1]), cursor: -1, anchor: -1 } },
  }));
  showToast($t('{0} Objekte umbenannt.', pairs.length), 'ok');
}
