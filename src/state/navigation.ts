/**
 * Going to a folder: the path field of a half, a folder of this computer, the other half.
 */
import type { PaneSide } from '../backend/types';

import * as paths from '../util/paths';
import { $t } from '../i18n';
import {
  setState,
  activeTab,
  paneLoc,
  showToast,
  panePath,
  paneOnServer,
  paneShowsServers,
  isDirEntry,
  getState,
} from './core';

import { navigate } from './tabs';

import { selectedNames } from './fileOps';
import { placeOf } from './core';

/** ⌘L: turns the path above a file list into an input field. */
export function editPath(side: PaneSide) {
  if (!activeTab()) return;
  setState({ pathEdit: side, focusSide: side });
}

/** Navigates to a typed path ("~" stands for the home folder on this computer). */
export function submitPath(side: PaneSide, typed: string) {
  setState({ pathEdit: null });
  let p = typed.trim().replace(/\\/g, '/');
  if (!p) return;
  if (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  // A bare drive ("C:") would mean the current folder on that drive; use its root.
  const onServer = paneOnServer(side);
  if (!onServer && /^[A-Za-z]:$/.test(p)) p += '/';
  if (onServer && !p.startsWith('/')) p = paths.join(panePath(side), p);
  navigate(side, p);
}

/** "Gehe zu > Schreibtisch, Downloads …": a folder of this computer, in the focused half when it shows this computer. */
export function goLocal(path: string) {
  const t = activeTab();
  if (!t) return;
  const sides: PaneSide[] = getState().focusSide === 'local' ? ['local', 'remote'] : ['remote', 'local'];
  const side = sides.find((x) => !placeOf(x, t) && !paneShowsServers(x, t));
  if (!side) {
    showToast($t('Keine Hälfte zeigt gerade diesen Computer.'));
    return;
  }
  setState({ focusSide: side });
  navigate(side, path);
}

/** "In der anderen Hälfte öffnen" (ForkLift): the selected folder, or this folder, in the other half of the same place. */
export function openInOtherHalf(side: PaneSide = getState().focusSide) {
  const t = activeTab();
  if (!t) return;
  const other: PaneSide = side === 'local' ? 'remote' : 'local';
  if (placeOf(side, t) !== placeOf(other, t) || paneShowsServers(other, t)) {
    showToast($t('Das geht, wenn beide Hälften denselben Computer oder Server zeigen.'));
    return;
  }
  const pick = selectedNames(side).find((n) => isDirEntry(...paneLoc(side, t), paths.join(panePath(side), n)));
  navigate(other, pick ? paths.join(panePath(side), pick) : panePath(side));
}
