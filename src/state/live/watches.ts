/**
 * Folder watches: changes on this computer are uploaded to the server as they happen.
 */
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { type Watch, type Transfer } from '../../backend/types';
import { watchExcludes } from '../tabs';
import { type AppState, setState, uid, getState, showToast } from '../core';
import { showError } from '../errors';
import { $t } from '../../i18n';
import { basename, join, parent, relFolder } from '../../util/paths';
import { remoteRel } from './transfers';
import { addLog } from '../log';
import { isExcluded } from '../syncPlan';
import { connected, connectNow, autoConnect, timeTolerance, connectServer } from './connections';
import { invalidate, bump } from './listing';
import { toBackendError, type WalkItem } from '../../backend/api';
import { pendingCommand } from './transfers';
import { enqueue } from '../transfers';

/** Watchers running in the backend: watch id -> configuration signature. */
const runningWatches = new Map<string, string>();

function signature(w: Watch) {
  return JSON.stringify([w.localPath, w.options.includeSubfolders, watchExcludes(w), w.options.delay]);
}

/** Starts, restarts and stops backend watchers to match the watch list. */
export function reconcileWatches(s: AppState) {
  const wanted = new Map(s.watches.filter((w) => w.state !== 'paused').map((w) => [w.id, w] as const));
  for (const [id] of runningWatches) {
    const w = wanted.get(id);
    if (!w || signature(w) !== runningWatches.get(id)) {
      runningWatches.delete(id);
      backend.watchStop(id).catch(() => undefined);
    }
  }
  for (const [id, w] of wanted) {
    if (runningWatches.has(id)) continue;
    runningWatches.set(id, signature(w));
    backend.watchStart(id, w.localPath, w.options.includeSubfolders, watchExcludes(w), Math.max(200, w.options.delay * 1000), onWatchBatch)
      .then(() => {
        if (w.options.syncOnStart) {
          synced.delete(id);
          void initialSync(w);
        }
      })
      .catch((e) => {
        runningWatches.delete(id);
        showError(e, { prefix: $t('Überwachung „{0}“', w.name), serverId: w.serverId });
        setState((st) => ({ watches: st.watches.map((x) => (x.id === id ? { ...x, state: 'paused' } : x)) }));
      });
  }
}

function watchTransfer(w: Watch, source: string, size: number, existing?: string): Transfer {
  // An existing file on the server keeps its exact name (also its Unicode form).
  const target = existing ?? remoteOf(w, source);
  return { id: uid('t'), name: basename(source), direction: 'up', serverId: w.serverId, folder: relFolder(w.remotePath, target), source, target, size, done: 0, state: 'queued', watchId: w.id };
}

/** True when a path (relative to the watched folder) lies in the selected subfolders. */
function inSelection(w: Watch, rel: string): boolean {
  if (!w.options.onlySelectedSubfolders) return true;
  return (w.subfolders ?? []).some((f) => rel === f || rel.startsWith(f + '/'));
}

/** Path below the watched folder; tolerates a trailing slash in older saved watches. */
function relOf(w: Watch, localPath: string) {
  const base = w.localPath.replace(/\/+$/, '');
  return localPath.startsWith(`${base}/`) ? localPath.slice(base.length + 1) : basename(localPath);
}
const remoteOf = (w: Watch, localPath: string) => join(w.remotePath, remoteRel(w.serverId, relOf(w, localPath)));

async function onWatchBatch(b: { watchId: string; changed: string[]; removed: string[]; renamed?: Array<[string, string]> }) {
  const w = getState().watches.find((x) => x.id === b.watchId);
  if (!w || w.state === 'paused') return;
  addLog('debug', $t('Überwachung „{0}“: {1} geändert, {2} gelöscht, {3} umbenannt', w.name, b.changed.length, b.removed.length, b.renamed?.length ?? 0), w.serverId);
  const items: Transfer[] = [];
  const addFile = async (p: string) => {
    if (!inSelection(w, relOf(w, p))) return;
    // Skip files that are already waiting in the queue.
    if (getState().transfers.some((x) => x.source === p && x.state === 'queued')) return;
    try {
      const st = await backend.localStat(p);
      if (st.kind === 'file') items.push(watchTransfer(w, p, st.size));
      else if (st.kind === 'dir') {
        // A whole folder appeared (moved in or renamed): upload its files.
        for (const f of await backend.localWalk(p)) {
          if (!isExcluded(relOf(w, f.path), watchExcludes(w)) && inSelection(w, relOf(w, f.path))) items.push(watchTransfer(w, f.path, f.size));
        }
      }
    } catch {
      // Deleted again before we got to it.
    }
  };
  for (const p of b.changed) await addFile(p);

  // Renamed locally: rename on the server too when deleting is allowed for this
  // watch; otherwise upload under the new name and leave the old name alone.
  for (const [from, to] of b.renamed ?? []) {
    if (w.options.mirrorDeletes && connected.has(w.serverId) && inSelection(w, relOf(w, from))) {
      try {
        await backend.remoteMove(w.serverId, remoteOf(w, from), remoteOf(w, to));
        addLog('ok', $t('Umbenannt: {0} → {1}', remoteOf(w, from), remoteOf(w, to)), w.serverId);
        invalidate('remote', w.serverId, parent(remoteOf(w, from)));
        invalidate('remote', w.serverId, parent(remoteOf(w, to)));
        bump();
        continue;
      } catch (e) {
        // Not on the server (yet) or the new name exists: fall back to uploading.
        addLog('info', $t('Umbenennen auf dem Server nicht möglich, lade neu hoch: {0}', remoteOf(w, to)), w.serverId, toBackendError(e).message);
      }
    }
    await addFile(to);
  }

  if (items.length) {
    addLog('info', items.length === 1 ? $t('Änderung erkannt: {0}', relOf(w, items[0].source)) : $t('{0} Änderungen erkannt', items.length), w.serverId);
    pendingCommand.add(w.id);
    enqueue(items);
  }
  const removed = b.removed.filter((p) => inSelection(w, relOf(w, p)));
  if (w.options.mirrorDeletes && removed.length && connected.has(w.serverId)) {
    const targets = removed.map((p) => remoteOf(w, p));
    backend.remoteRemove(w.serverId, targets)
      .then(() => {
        targets.forEach((t) => {
          invalidate('remote', w.serverId, parent(t));
          addLog('ok', $t('Auf dem Server gelöscht: {0}', t), w.serverId);
        });
        bump();
      })
      .catch((e) => addLog('warn', $t('Löschen auf dem Server fehlgeschlagen'), w.serverId, toBackendError(e).message));
  }
}

/** "Beim Start abgleichen": uploads files that are newer locally or missing on the server. */
export async function initialSync(w: Watch, manual = false) {
  if (!connected.has(w.serverId)) {
    // Runs again as soon as the connection is up (see doConnect).
    if (manual) connectNow(w.serverId);
    else autoConnect(w.serverId);
    return;
  }
  if (synced.has(w.id) && !manual) return;
  synced.add(w.id);
  try {
    const [local, remote] = await Promise.all([backend.localWalk(w.localPath), backend.remoteWalk(w.serverId, w.remotePath).catch(() => [] as WalkItem[])]);
    // Compared in NFC form, so a name decomposed on one side still meets its counterpart.
    const remoteByRel = new Map(remote.map((r) => [r.path.slice(w.remotePath.length + 1).normalize('NFC'), r] as const));
    const items: Transfer[] = [];
    for (const f of local) {
      const rel = relOf(w, f.path);
      if (isExcluded(rel, watchExcludes(w)) || !inSelection(w, rel)) continue;
      const r = remoteByRel.get(remoteRel(w.serverId, rel).normalize('NFC'));
      if (!r && w.options.onlyExisting) continue;
      if (!r || f.mtime - r.mtime > timeTolerance(w.serverId)) items.push(watchTransfer(w, f.path, f.size, r?.path));
    }
    if (items.length) {
      pendingCommand.add(w.id);
      enqueue(items);
      showToast(items.length === 1 ? $t('„{0}“: 1 Datei ist neuer als auf dem Server und wird hochgeladen.', w.name) : $t('„{0}“: {1} Dateien sind neuer als auf dem Server und werden hochgeladen.', w.name, items.length));
    } else if (manual) {
      showToast($t('„{0}“ ist auf dem Server aktuell.', w.name), 'ok');
    }
  } catch (e) {
    showError(e, { prefix: $t('Abgleich „{0}“', w.name), serverId: w.serverId });
  }
}

/** "Abgleichen": runs the start comparison of a watch now. */
export function syncWatch(watchId: string) {
  const w = getState().watches.find((x) => x.id === watchId);
  if (w) void initialSync(w, true);
}

/** Watches whose start comparison already ran in this session. */
export const synced = new Set<string>();

/** Runs the post-upload command of a watch right away. */
export function runCommandNow(watchId: string) {
  const w = getState().watches.find((x) => x.id === watchId);
  if (!w?.options.command.trim()) {
    showToast($t('Für diese Überwachung ist kein Befehl eingetragen.'));
    return;
  }
  enqueue([{ id: uid('t'), name: w.options.command.trim(), direction: 'command', serverId: w.serverId, folder: '', source: '', target: '', size: 1, done: 0, state: 'queued', watchId: w.id }]);
}

/** Deletes chosen in "Ordner abgleichen" (server files removed, local ones to the trash). */
/** Comparing two local folders: copies files to their exact targets, replacing older ones. */
export async function copyLocalFiles(pairs: Array<[string, string]>) {
  if (!pairs.length) return;
  try {
    await backend.localCopyFiles(pairs);
    pairs.forEach(([, to]) => { invalidate('local', '', parent(to)); addLog('ok', $t('Beim Abgleich kopiert: {0}', to)); });
    bump();
    showToast(pairs.length === 1 ? $t('1 Datei kopiert.') : $t('{0} Dateien kopiert.', pairs.length), 'ok');
  } catch (e) {
    showError(e);
  }
}

export async function syncDeletes(serverId: string, remote: string[], local: string[]) {
  try {
    if (remote.length) {
      await backend.remoteRemove(serverId, remote);
      remote.forEach((p) => { invalidate('remote', serverId, parent(p)); addLog('ok', $t('Beim Abgleich gelöscht: {0}', p), serverId); });
    }
    if (local.length) {
      await backend.localTrash(local);
      local.forEach((p) => { invalidate('local', serverId, parent(p)); addLog('ok', $t('Beim Abgleich in den Papierkorb: {0}', p)); });
    }
    bump();
  } catch (e) {
    showError(e);
  }
}

/** "Jetzt testen" in the watch dialog: runs the command once on the server. */
export async function testCommand(serverId: string, command: string): Promise<{ code: number; output: string } | { error: string }> {
  if (!connected.has(serverId)) {
    const ok = await connectServer(serverId);
    if (!ok) return { error: $t('Keine Verbindung zum Server.') };
  }
  try {
    addLog('info', $t('Befehl testen: {0}', command), serverId);
    const r = await backend.remoteExec(serverId, command);
    addLog(r.code === 0 ? 'ok' : 'error', $t('Test endete mit Code {0}', r.code), serverId, r.output.trim() || undefined);
    return r;
  } catch (e) {
    return { error: toBackendError(e).message };
  }
}

/** Runs a command on the server (own commands from the context menu); connects first when needed. */
export async function runRemoteCommand(serverId: string, command: string): Promise<{ code: number; output: string } | { error: string }> {
  if (!connected.has(serverId)) {
    const ok = await connectServer(serverId);
    if (!ok) return { error: $t('Keine Verbindung zum Server.') };
  }
  try {
    addLog('info', $t('Befehl: {0}', command), serverId);
    const r = await backend.remoteExec(serverId, command);
    addLog(r.code === 0 ? 'ok' : 'error', $t('Befehl endete mit Code {0}', r.code), serverId, r.output.trim() || undefined);
    return r;
  } catch (e) {
    return { error: toBackendError(e).message };
  }
}

/** "Testlauf": tells the user how many files the watch would cover. */
export async function testRun(localPath: string, excludes: string[]) {
  try {
    const files = (await backend.localWalk(localPath)).filter((f) => !isExcluded(f.path.slice(localPath.length + 1), excludes));
    showToast($t('Testlauf: {0} Dateien würden beobachtet. Es wurde nichts übertragen.', files.length));
  } catch (e) {
    showError(e);
  }
}
