/**
 * Folder listings of the real backend, cached per server and folder, and how
 * they are loaded, refreshed and invalidated.
 */
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { type FileEntry, type PaneSide } from '../../backend/types';
import { setState, activeTab, paneLoc, type AppState } from '../core';
import { basename, join, parent } from '../../util/paths';
import { connected, handleRemoteError } from './connections';
import { addLog } from '../log';
import { $t } from '../../i18n';
import { toBackendError } from '../../backend/api';
import { explainError } from '../errors';

interface Listing {
  entries: FileEntry[];
  loading: boolean;
  error?: string;
  /** What the user can do about the error (second line, see errors.ts). */
  hint?: string;
  /** The folder does not exist (offered "Ordner anlegen" while browsing synchronized). */
  missing?: boolean;
}

export const listings = new Map<string, Listing>();

function key(side: PaneSide, serverId: string, path: string): string {
  return side === 'local' ? `L|${path}` : `R|${serverId}|${path}`;
}

export const bump = () => setState((s) => ({ fsRev: s.fsRev + 1 }));

/** Cached listing of a folder, or undefined while it was never loaded. */
export function cachedList(side: PaneSide, serverId: string, path: string): FileEntry[] | undefined {
  return listings.get(key(side, serverId, path))?.entries;
}

/** Loading and error state of a folder listing. */
export function listingStatus(
  side: PaneSide,
  serverId: string,
  path: string,
): { loading: boolean; error?: string; hint?: string; missing?: boolean } {
  const l = listings.get(key(side, serverId, path));
  return { loading: !l || l.loading, error: l?.error, hint: l?.hint, missing: l?.missing };
}

/** Entry of a path, looked up in the cached listing of its parent folder. */
export function cachedStat(side: PaneSide, serverId: string, path: string): FileEntry | undefined {
  const list = cachedList(side, serverId, parent(path));
  const name = basename(path);
  return list?.find((e) => e.name === name);
}

/** Reads a folder unless it is cached or being read (folders opened in place, views). */
export function requestListing(side: PaneSide, serverId: string, path: string) {
  if (side === 'remote' && (!serverId || !connected.has(serverId))) return;
  if (!listings.has(key(side, serverId, path))) void load(side, serverId, path);
}

async function load(side: PaneSide, serverId: string, path: string) {
  const k = key(side, serverId, path);
  const prev = listings.get(k);
  listings.set(k, { entries: prev?.entries ?? [], loading: true });
  bump();
  try {
    const t0 = Date.now();
    const entries = side === 'local' ? await backend.localList(path) : await backend.remoteList(serverId, path);
    listings.set(k, { entries, loading: false });
    if (side === 'remote')
      addLog(
        'debug',
        $t('Ordner gelesen: {0} ({1} Einträge, {2} ms)', path, entries.length, Date.now() - t0),
        serverId,
      );
  } catch (e) {
    const err = toBackendError(e);
    // Same wording as the error messages: what happened, then what to do.
    const { text, hint } = explainError(err);
    listings.set(k, { entries: [], loading: false, error: text, hint, missing: err.kind === 'notFound' });
    if (side === 'remote') handleRemoteError(serverId, err);
  }
  bump();
}

/** Forgets a cached folder so it is read again when visible. */
export function invalidate(side: PaneSide, serverId: string, path: string) {
  listings.delete(key(side, serverId, path));
}

/** Re-reads both visible folders of the active tab. */
export function refreshVisible() {
  const t = activeTab();
  if (!t) return;
  invalidate(...paneLoc('local', t), t.localPath);
  invalidate(...paneLoc('remote', t), t.remotePath);
  bump();
}

/** Loads the folders of the active tab when they are not cached yet. */
export function ensureVisible(s: AppState) {
  const t = s.tabs.find((x) => x.id === s.activeTabId);
  if (!t) return;
  const [ls, lsid] = paneLoc('local', t);
  if (
    ls === 'local'
      ? !listings.has(key(ls, lsid, t.localPath))
      : t.localPath && connected.has(lsid) && !listings.has(key(ls, lsid, t.localPath))
  )
    void load(ls, lsid, t.localPath);
  if (
    t.serverId &&
    t.remotePath &&
    connected.has(t.serverId) &&
    !listings.has(key('remote', t.serverId, t.remotePath))
  ) {
    void load('remote', t.serverId, t.remotePath);
  }
  // Two local halves (Total Commander): the right half lists this computer too.
  if (t.rightLocal && !t.serverId && t.remotePath && !listings.has(key('local', '', t.remotePath)))
    void load('local', '', t.remotePath);
  // Folders opened in place (triangle) are read again after a refresh.
  for (const side of ['local', 'remote'] as PaneSide[]) {
    const [sd, sid] = paneLoc(side, t);
    const base = side === 'local' ? t.localPath : t.remotePath;
    for (const rel of s.expanded[side]) requestListing(sd, sid, join(base, rel));
  }
}
