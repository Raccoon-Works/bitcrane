/**
 * Copy, cut and paste of files and folders (⌘C, ⌘X, ⌘V and ⌥⌘V), within a half and across halves.
 */
import * as live from './live';
import type { PaneSide } from '../backend/types';

import * as paths from '../util/paths';
import { $t } from '../i18n';
import { setState, activeTab, showToast, panePath, LIVE, getState } from './core';

import { openDialog } from './panels';

import { transferNames } from './transfers';

import { moveIntoFolder, selectedNames } from './fileOps';
import { placeOf } from './core';

/** ⌘C on files: remembers them; ⌘V elsewhere copies or transfers them. */
export function copySelection(side: PaneSide) {
  const t = activeTab();
  const names = selectedNames(side);
  if (!t || !names.length) return;
  const from = placeOf(side, t);
  setState({ clipboard: { side, serverId: from, dir: panePath(side), names } });
  const what = names.length === 1 ? `„${names[0]}“` : $t('{0} Objekte', names.length);
  const other = placeOf(side === 'local' ? 'remote' : 'local', t);
  showToast(
    !from
      ? $t('{0} kopiert. In der anderen Hälfte einfügen, um hochzuladen.', what)
      : !other
        ? $t('{0} kopiert. In der anderen Hälfte einfügen, um herunterzuladen.', what)
        : $t('{0} kopiert. In der anderen Hälfte einfügen, um es dorthin zu übertragen.', what),
  );
}

/** ⌘X / Strg+X on files: remembered for moving; pasting in a folder of the same computer or server moves them. */
export function cutSelection(side: PaneSide) {
  const t = activeTab();
  const names = selectedNames(side);
  if (!t || !names.length) return;
  setState({ clipboard: { side, serverId: placeOf(side, t), dir: panePath(side), names, cut: true } });
  const what = names.length === 1 ? `„${names[0]}“` : $t('{0} Objekte', names.length);
  showToast($t('{0} ausgeschnitten. In einem anderen Ordner einfügen, um es dorthin zu verschieben.', what));
}

export function pasteClipboard(side: PaneSide) {
  const c = getState().clipboard;
  const t = activeTab();
  if (!c || !t) return;
  const to = placeOf(side, t);
  const toDir = panePath(side);
  if (c.cut && c.serverId === to) {
    // Moving within one computer or server; the clipboard is used up.
    if (toDir === c.dir) {
      showToast($t('Die Objekte liegen schon in diesem Ordner.'));
      return;
    }
    setState({ clipboard: null });
    moveIntoFolder(side, c.names, toDir, c.dir);
    return;
  }
  if (c.cut) {
    // Between computer and server: a move with a question first (transfer, then remove the originals).
    setState({ clipboard: null });
    askMoveAcross(c.serverId, c.dir, c.names, to, toDir);
    return;
  }
  if (c.serverId === to) {
    // Same computer or same server: a plain copy there.
    if (!LIVE) {
      showToast($t('In der anderen Hälfte einfügen, um zu übertragen.'));
      return;
    }
    if (to) void live.copyOnServer(to, c.dir, c.names, toDir);
    else void live.copyLocal(c.dir, c.names, toDir);
    return;
  }
  transferNames(c.serverId, c.dir, c.names, to, toDir);
}

/**
 * Moving between this computer and a server (or two servers), after a question:
 * the files are transferred, then the originals are removed once all arrived.
 */
export function askMoveAcross(from: string, fromDir: string, names: string[], to: string, toDir: string) {
  if (!names.length) return;
  const what = names.length === 1 ? `„${paths.basename(names[0])}“` : $t('{0} Objekte', names.length);
  openDialog({
    type: 'confirm',
    title: $t('{0} verschieben?', what),
    confirm: $t('Verschieben'),
    text: `${$t('Bitcrane überträgt die Dateien und löscht sie danach an der alten Stelle.')} ${
      !from
        ? $t(
            'Auf diesem Computer kommen die Originale in den Papierkorb. Gelöscht wird nur, wenn alle Dateien angekommen sind.',
          )
        : $t('Gelöscht wird nur, wenn alle Dateien angekommen sind.')
    }`,
    run: () => {
      setState({ dialog: null });
      if (LIVE) void live.moveAcross(from, fromDir, names, to, toDir);
      else showToast($t('{0} wird verschoben (Prototyp).', what));
    },
  });
}

/** ⌥⌘V (Finder "Objekt hierher bewegen"): what ⌘C remembered is moved here instead of copied. */
export function pasteMove(side: PaneSide = getState().focusSide) {
  const c = getState().clipboard;
  if (!c) return;
  setState({ clipboard: { ...c, cut: true } });
  pasteClipboard(side);
}
