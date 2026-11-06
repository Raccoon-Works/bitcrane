/**
 * Places: favourites, recent folders, drives, shares and cloud folders of this computer.
 */

import { type CloudPlace, type Place } from '../backend/api';
import * as fs from '../backend/mockFs';
import * as live from './live';
import type { PaneSide, Tab, Transfer } from '../backend/types';

import * as paths from '../util/paths';
import { $t } from '../i18n';
import {
  activeTab,
  paneLoc,
  serverById,
  setState,
  showToast,
  LIVE,
  paneShowsServers,
  panePath,
  uid,
  getState,
} from './core';
import type { AppState } from './appState';
import { updateSettings } from './settings';
import { openDialog } from './panels';
import { placeOf } from './fileOps';
import { relFolder } from '../util/paths';
import { enqueue } from './transfers';

/** Places bar of a half: favourite folders of this computer, or of the server it shows. */
export function placesFor(side: PaneSide, s: AppState = getState(), t: Tab | undefined = activeTab(s)): Place[] {
  const [ls, sid] = paneLoc(side, t);
  if (ls === 'local') return s.settings.localPlaces ?? s.places;
  return serverById(sid, s)?.places ?? NO_PLACES;
}

/** Shared empty list, so store selectors keep a stable value. */
const NO_PLACES: Place[] = [];

function setPlaces(side: PaneSide, list: Place[]) {
  const [ls, sid] = paneLoc(side);
  if (ls === 'local') updateSettings({ localPlaces: list });
  else setState((s) => ({ servers: s.servers.map((x) => (x.id === sid ? { ...x, places: list } : x)) }));
}

/** Adds a folder to a half's places bar (dragged in, or ⌘D for the folder shown). */
export function addPlace(side: PaneSide, path: string) {
  const list = placesFor(side);
  if (list.some((p) => p.path === path)) {
    showToast($t('„{0}“ ist schon in der Ortsleiste.', paths.basename(path) || path));
    return;
  }
  const name = path === '~' ? getState().homeName : paths.basename(path) || path;
  setPlaces(side, [...list, { name, path }]);
  showToast($t('„{0}“ zur Ortsleiste hinzugefügt.', name), 'ok');
}

/** Favourites of this computer (sidebar), whatever the halves show. */
export function localPlaces(s: AppState = getState()): Place[] {
  return s.settings.localPlaces ?? s.places;
}

/** Adds a folder of this computer to the sidebar's favourites. */
export function addLocalPlace(path: string) {
  const list = localPlaces();
  const name = path === '~' ? getState().homeName : paths.basename(path) || path;
  if (list.some((p) => p.path === path)) {
    showToast($t('„{0}“ ist schon in den Favoriten.', name));
    return;
  }
  updateSettings({ localPlaces: [...list, { name, path }] });
  showToast($t('„{0}“ zu den Favoriten hinzugefügt.', name), 'ok');
}

/** Removes a favourite of this computer, or moves it before another one (`before` null: to the end). */
export function editLocalPlaces(path: string, op: { remove: true } | { before: string | null }) {
  const list = localPlaces();
  const item = list.find((p) => p.path === path);
  if (!item) return;
  const rest = list.filter((p) => p.path !== path);
  if ('remove' in op) updateSettings({ localPlaces: rest });
  else {
    const i =
      op.before === null
        ? rest.length
        : Math.max(
            0,
            rest.findIndex((p) => p.path === op.before),
          );
    updateSettings({ localPlaces: [...rest.slice(0, i), item, ...rest.slice(i)] });
  }
  setState({ contextMenu: null });
}

export function removePlace(side: PaneSide, path: string) {
  setPlaces(
    side,
    placesFor(side).filter((p) => p.path !== path),
  );
  setState({ contextMenu: null });
}

/** Moves a place before another one (`before` = null: to the end). */
export function movePlace(side: PaneSide, path: string, before: string | null) {
  const list = placesFor(side);
  const item = list.find((p) => p.path === path);
  if (!item || path === before) return;
  const rest = list.filter((p) => p.path !== path);
  const at = before === null ? rest.length : rest.findIndex((p) => p.path === before);
  rest.splice(at < 0 ? rest.length : at, 0, item);
  setPlaces(side, rest);
}

/**
 * Looks for Google Drive, OneDrive, Dropbox, iCloud Drive and Box folders and
 * offers the new ones as places (Transmit asks on its first start). `manual`:
 * from the settings, so "nothing found" is reported too.
 */
export async function offerCloudPlaces(manual: boolean) {
  const found: CloudPlace[] = LIVE
    ? await live.cloudPlaces()
    : [
        { name: 'Google Drive', path: '~/Library/CloudStorage/GoogleDrive', service: 'gdrive' },
        { name: 'OneDrive', path: '~/Library/CloudStorage/OneDrive-Personal', service: 'onedrive' },
        { name: 'iCloud Drive', path: '~/Library/Mobile Documents/com~apple~CloudDocs', service: 'icloud' },
      ];
  if (!manual) updateSettings({ cloudAsked: true });
  const known = new Set(placesForComputer().map((p) => p.path));
  const fresh = found.filter((c) => !known.has(c.path));
  if (!fresh.length) {
    if (manual)
      showToast(
        found.length
          ? $t('Alle gefundenen Cloud-Ordner sind schon in der Ortsleiste.')
          : $t('Auf diesem Rechner wurden keine Cloud-Ordner gefunden.'),
      );
    return;
  }
  if (!manual && getState().dialog) return;
  openDialog({ type: 'cloudPlaces', found: fresh });
}

/** Places of this computer (independent of what the left half shows right now). */
function placesForComputer(): Place[] {
  return getState().settings.localPlaces ?? getState().places;
}

/** Adds the cloud folders the user ticked to the places of this computer. */
export function addCloudPlaces(list: CloudPlace[]) {
  setState({ dialog: null });
  if (!list.length) return;
  const cur = placesForComputer();
  const add = list
    .filter((c) => !cur.some((p) => p.path === c.path))
    .map((c) => ({ name: c.name, path: c.path, cloud: c.service }));
  updateSettings({ localPlaces: [...cur, ...add] });
  showToast(
    add.length === 1
      ? $t('„{0}“ zur Ortsleiste hinzugefügt.', add[0].name)
      : $t('{0} Cloud-Ordner zur Ortsleiste hinzugefügt.', add.length),
    'ok',
  );
}

/** ⌘D: the folder shown in the focused half goes into its places bar. */
export function addBookmark() {
  const side = getState().focusSide;
  if (!activeTab() || paneShowsServers(side)) return;
  addPlace(side, panePath(side));
}

/** One line of "Ordner abgleichen" the user ticked; `rel` is relative to the tab's folders. */
export interface SyncAction {
  kind: 'upload' | 'download' | 'deleteRemote' | 'deleteLocal';
  /** Path relative to the two folders (in NFC form, see walkPlace). */
  rel: string;
  size: number;
  /** Real path of the source file (copies) or of the file to delete; may differ from `rel` in its Unicode form. */
  from?: string;
  /** Real path of the existing target file, if there is one. */
  to?: string;
}

/** Carries out the ticked lines of "Ordner abgleichen". */
export function applySyncActions(actions: SyncAction[]) {
  const t = activeTab();
  setState({ dialog: null });
  if (!t || !actions.length) return;
  const { n, deleteCount } = runSyncBetween(
    placeOf('local', t),
    t.localPath,
    placeOf('remote', t),
    t.remotePath,
    actions,
  );
  showToast(
    $t(
      'Abgleich gestartet: {0} {1}{2}.',
      n,
      n === 1 ? $t('Übertragung') : $t('Übertragungen'),
      deleteCount ? $t(', {0} zu löschen', deleteCount) : '',
    ),
  );
}

/**
 * Carries out sync actions between two places: this computer ('') or a server id,
 * each with its folder. "upload" goes from the left place to the right one,
 * "download" from right to left; this covers computer ↔ server, server ↔ server
 * and two folders of this computer. Used by the comparison window and by
 * scheduled comparisons. Returns the number of copies and deletes started.
 */
export function runSyncBetween(
  L: string,
  leftDir: string,
  R: string,
  rightDir: string,
  actions: SyncAction[],
): { n: number; deleteCount: number } {
  const t = { localPath: leftDir, remotePath: rightDir };
  const items: Transfer[] = [];
  const localPairs: Array<[string, string]> = [];
  for (const a of actions) {
    if (a.kind !== 'upload' && a.kind !== 'download') continue;
    const toRight = a.kind === 'upload';
    const [from, to] = toRight ? [L, R] : [R, L];
    const source = a.from ?? paths.join(toRight ? t.localPath : t.remotePath, a.rel);
    // A new file on this computer gets a name Windows can store; one on a server its real name back.
    const rel = !to ? live.localRel(a.rel) : !from ? live.remoteRel(to, a.rel) : a.rel;
    const target = a.to ?? paths.join(toRight ? t.remotePath : t.localPath, rel);
    const base = {
      id: uid('t'),
      name: paths.basename(a.rel),
      folder: relFolder(toRight ? t.remotePath : t.localPath, target),
      source,
      target,
      size: a.size,
      done: 0,
      state: 'queued' as const,
      decided: true,
    };
    if (!from && !to) localPairs.push([source, target]);
    else if (!from) items.push({ ...base, direction: 'up', serverId: to });
    else if (!to) items.push({ ...base, direction: 'down', serverId: from });
    else items.push({ ...base, direction: 'cross', sourceServerId: from, serverId: to });
  }
  enqueue(items);
  // Deletes per place: files in the trash on this computer, removed on a server.
  const deletes = new Map<string, string[]>();
  for (const a of actions) {
    if (a.kind !== 'deleteRemote' && a.kind !== 'deleteLocal') continue;
    const right = a.kind === 'deleteRemote';
    const place = right ? R : L;
    deletes.set(place, [
      ...(deletes.get(place) ?? []),
      a.from ?? paths.join(right ? t.remotePath : t.localPath, a.rel),
    ]);
  }
  const deleteCount = [...deletes.values()].reduce((n, l) => n + l.length, 0);
  if (LIVE) {
    void live.copyLocalFiles(localPairs);
    for (const [place, list] of deletes) void live.syncDeletes(place, place ? list : [], place ? [] : list);
  } else {
    for (const [place, list] of deletes) list.forEach((p) => fs.remove(place ? 'remote' : 'local', place, p));
    setState((s) => ({ fsRev: s.fsRev + 1 }));
  }
  return { n: items.length + localPairs.length, deleteCount };
}

/** Renames several entries at once (from the "Mehrere umbenennen" window). */
