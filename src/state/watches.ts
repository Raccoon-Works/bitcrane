/**
 * Folder watches: creating, pausing, the queue of changed files and the commands after an upload.
 */

import * as fs from '../backend/mockFs';
import * as live from './live';
import type { PaneSide, Tab, Transfer, Watch } from '../backend/types';

import { matchesExclude } from '../util/format';
import * as paths from '../util/paths';
import { $t } from '../i18n';
import { setState, state, showToast, uid, LIVE, watchForLocal, panePath, activeTab, paneLoc, setLeftServer } from './core';
import { relFolder } from '../util/paths';
import { enqueue } from './transfers';
import { updateTab } from './tabs';

export function toggleWatch(id: string) {
  setState((s) => ({ watches: s.watches.map((w) => (w.id === id ? { ...w, state: w.state === 'paused' ? 'active' : 'paused' } : w)) }));
}

export function pauseAllWatches() {
  const anyActive = state.watches.some((w) => w.state !== 'paused');
  setState((s) => ({ watches: s.watches.map((w) => ({ ...w, state: anyActive ? 'paused' : 'active' })) }));
  showToast(anyActive ? $t('Alle Überwachungen pausiert.') : $t('Alle Überwachungen laufen wieder.'));
}

export function saveWatch(w: Omit<Watch, 'id' | 'state' | 'lastFile' | 'lastTime'> & { id?: string }) {
  if (w.id) {
    setState((s) => ({ watches: s.watches.map((x) => (x.id === w.id ? { ...x, ...w } as Watch : x)), dialog: null }));
    showToast($t('Überwachung „{0}“ gespeichert. Sie läuft ohne Neustart weiter.', w.name), 'ok');
    return;
  }
  const watch: Watch = { ...w, id: uid('w'), state: 'active', lastFile: '', lastTime: Date.now() } as Watch;
  setState((s) => ({ watches: [...s.watches, watch], dialog: null }));
  showToast($t('Überwachung „{0}“ läuft.', watch.name), 'ok');
  // Live mode: the watcher starts through the store subscription and syncs on start itself.
  if (watch.options.syncOnStart && !LIVE) {
    // Initial sync: upload a couple of files that are "newer" locally.
    const files = fs.walkFiles('local', watch.serverId, watch.localPath).filter((f) => !matchesExclude(f.entry.name, watch.excludes)).slice(0, 2);
    enqueueWatchFiles(watch, files.map((f) => f.path));
  }
}

export function deleteWatch(id: string) {
  setState((s) => ({ watches: s.watches.filter((w) => w.id !== id), dialog: null }));
}

/** Simulated test run: tells the user what would be uploaded. */
export function testRunWatch(localPath: string, excludes: string[]) {
  if (LIVE) {
    void live.testRun(localPath, excludes);
    return;
  }
  const files = fs.walkFiles('local', 'ob', localPath).filter((f) => !matchesExclude(f.entry.name, excludes));
  showToast($t('Testlauf: {0} Dateien würden beobachtet, beim Start {1} hochgeladen. Es wurde nichts übertragen.', files.length, Math.min(2, files.length)));
}

function enqueueWatchFiles(w: Watch, files: string[]) {
  const items: Transfer[] = files.map((p) => {
    const rel = p.slice(w.localPath.length + 1);
    const target = paths.join(w.remotePath, rel);
    const st = fs.stat('local', w.serverId, p);
    return { id: uid('t'), name: paths.basename(p), direction: 'up', serverId: w.serverId, folder: relFolder(w.remotePath, target), source: p, target, size: st?.size ?? 1024, done: 0, state: 'queued', watchId: w.id };
  });
  enqueue(items);
  pendingCommand.add(w.id);
}

/** Watches whose post-upload command should run once their batch is done. */
export const pendingCommand = new Set<string>();

/**
 * Simulates the user saving a file in a watched folder. Called by the
 * prototype panel and by a slow background timer.
 */
export function simulateLocalChange(watchId?: string, path?: string) {
  if (LIVE) {
    // In the app this is "Abgleichen": compare the watched folder with the server now.
    const w = watchId ? state.watches.find((x) => x.id === watchId) : watchForLocal(panePath('local')) ?? state.watches.find((x) => x.state !== 'paused');
    if (w) live.syncWatch(w.id);
    else showToast($t('Für diesen Ordner gibt es keine Überwachung.'));
    return;
  }
  const w = state.watches.find((x) => (watchId ? x.id === watchId : x.state !== 'paused'));
  if (!w) {
    showToast($t('Keine aktive Überwachung. Starte zuerst eine.'), 'error');
    return;
  }
  const candidates = fs.walkFiles('local', w.serverId, w.localPath)
    .filter((f) => !matchesExclude(f.entry.name, w.excludes))
    .filter((f) => !f.path.includes('/static/logo.png'));
  if (!candidates.length) return;
  // A given file (used by the scripted website clips), otherwise a random one.
  const pick = candidates.find((f) => path && f.path.endsWith(path)) ?? candidates[Math.floor(Math.random() * candidates.length)];
  fs.touch('local', w.serverId, pick.path, Math.round((Math.random() - 0.3) * 600));
  setState((s) => ({ fsRev: s.fsRev + 1 }));
  if (w.state === 'paused') {
    showToast($t('„{0}“ geändert. Die Überwachung ist pausiert und lädt nichts hoch.', pick.entry.name));
    return;
  }
  // Debounce: wait the configured delay before uploading.
  window.setTimeout(() => enqueueWatchFiles(w, [pick.path]), w.options.delay * 1000);
}

/** Scenario: the file on the server was changed by someone else. */
export function simulateConflict() {
  const w = state.watches[0];
  if (!w) return;
  const path = paths.join(w.localPath, 'app.py');
  const target = paths.join(w.remotePath, 'app.py');
  // The user saved locally a moment ago, someone else changed the server copy afterwards.
  fs.touch('local', w.serverId, path, 120);
  window.setTimeout(() => {
    fs.touch('remote', w.serverId, target, 1024);
    setState((s) => ({ fsRev: s.fsRev + 1 }));
    enqueueWatchFiles(w, [path]);
  }, 300);
  setState((s) => ({ fsRev: s.fsRev + 1 }));
}

/** Scenario: an upload fails because the server folder belongs to root. */
export function simulateError() {
  const w = state.watches[0];
  if (!w) return;
  fs.chmod('remote', w.serverId, paths.join(w.remotePath, 'admin/static'), '755', 'root', 'root');
  const path = paths.join(w.localPath, 'admin/static/logo.png');
  fs.touch('local', w.serverId, path, 200);
  setState((s) => ({ fsRev: s.fsRev + 1 }));
  enqueueWatchFiles(w, [path]);
}

/** Scenario: the SSH connection of the active tab drops. */
export function simulateDisconnect(serverId = activeTab()?.serverId) {
  if (!serverId) return;
  setState((s) => ({
    offline: { ...s.offline, [serverId]: { attempt: 2, nextRetry: Date.now() + 5000 } },
    watches: s.watches.map((w) => (w.serverId === serverId && w.state === 'active' ? { ...w, state: 'waiting' } : w)),
    servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: false } : x)),
  }));
  const w = state.watches.find((x) => x.serverId === serverId && x.state === 'waiting');
  if (w) {
    // Changes keep being collected while offline.
    const files = fs.walkFiles('local', serverId, w.localPath).filter((f) => !matchesExclude(f.entry.name, w.excludes)).slice(0, 3);
    files.forEach((f) => fs.touch('local', serverId, f.path));
    enqueueWatchFiles(w, files.map((f) => f.path));
  }
}

export function reconnect(serverId = activeTab()?.serverId) {
  if (!serverId) return;
  if (LIVE) {
    live.connectNow(serverId);
    return;
  }
  setState((s) => {
    const offline = { ...s.offline };
    delete offline[serverId];
    return {
      offline,
      watches: s.watches.map((w) => (w.serverId === serverId && w.state === 'waiting' ? { ...w, state: 'active' } : w)),
      servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: true } : x)),
    };
  });
  showToast($t('Wieder verbunden. Wartende Dateien werden hochgeladen.'), 'ok');
}

export function disconnect(serverId = activeTab()?.serverId, quiet = false) {
  if (!serverId) return;
  if (LIVE) void live.disconnectServer(serverId);
  setState((s) => ({ servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: false } : x)) }));
  if (!quiet) showToast($t('Verbindung getrennt.'));
}

/**
 * Whether a server connection is still needed: a tab shows it, a running
 * folder watch uploads to it, a transfer is queued or running, or one of its
 * SSH tunnels is open.
 */
function serverStillUsed(sid: string): boolean {
  const s = state;
  if (s.tabs.some((x) => x.serverId === sid || x.leftServerId === sid)) return true;
  if (s.watches.some((w) => w.serverId === sid && w.state !== 'paused')) return true;
  if (s.transfers.some((t) => (t.serverId === sid || t.sourceServerId === sid) && (t.state === 'queued' || t.state === 'running'))) return true;
  const tunnels = s.servers.find((x) => x.id === sid)?.forwards?.map((f) => f.id) ?? [];
  return tunnels.some((id) => s.tunnels.includes(id));
}

/**
 * After tabs were closed (WinSCP, FileZilla): servers no longer used anywhere
 * are disconnected quietly, so no connection stays open unnoticed.
 */
export function releaseServers(closed: Tab[]) {
  const ids = new Set(closed.flatMap((t) => [t.serverId, t.leftServerId]).filter((x): x is string => !!x));
  for (const sid of ids) {
    if (!state.servers.find((x) => x.id === sid)?.online) continue;
    if (!serverStillUsed(sid)) disconnect(sid, true);
  }
}

/**
 * "Trennen" in a half's path bar (Transmit's eject button): the half goes back
 * to the server list (left: to this computer). The connection is closed when
 * no other tab still uses the server.
 */
export function closePaneServer(side: PaneSide) {
  const t = activeTab();
  if (!t) return;
  const [ls, sid] = paneLoc(side, t);
  if (ls !== 'remote' || !sid) return;
  if (side === 'local') setLeftServer('');
  else {
    updateTab({ serverId: '', remotePath: '', back: [], forward: [], syncBrowse: undefined, serverList: { ...t.serverList, remote: true } });
    setState((s) => ({ selection: { ...s.selection, remote: { names: [], cursor: -1, anchor: -1 } }, expanded: { ...s.expanded, remote: [] } }));
  }
  if (!serverStillUsed(sid)) disconnect(sid);
}
