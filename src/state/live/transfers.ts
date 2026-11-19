/**
 * The transfer queue of the real backend: starting, limiting, retrying and
 * finishing transfers.
 */
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { getState, showToast, uid, serverById, subscribeStore, setState } from '../core';
import { ruleFor } from '../rules';
import { isExcluded } from '../syncPlan';
import { addLog } from '../log';
import { $t } from '../../i18n';
import { basename, insideArchive, join, parent, relFolder } from '../../util/paths';
import { showError } from '../errors';
import { type Transfer, type PaneSide, type FileEntry } from '../../backend/types';
import { type WalkItem, toBackendError, type TransferOptions, type BackendError } from '../../backend/api';
import { enqueue, skippedText } from '../transfers';
import {
  handleRemoteError,
  connected,
  connecting,
  failed,
  connectServer,
  markOffline,
  timeTolerance,
} from './connections';
import { removeEntries } from './fileOps';
import { editUploaded } from './editing';
import { invalidate, bump, readFolder, statEntry } from './listing';

/** Left out by the general "auslassen" settings or by the server's transfer rule. */
function skippedByRules(relative: string, size: number, serverId = ''): boolean {
  const { skipPatterns, skipLargerMb } = getState().settings;
  const rule = serverId ? ruleFor(serverId) : undefined;
  const limit = rule?.skipLargerMb ?? skipLargerMb;
  return (
    isExcluded(relative, skipPatterns) ||
    (!!rule && isExcluded(relative, rule.excludes)) ||
    (limit > 0 && size > limit * 1024 * 1024)
  );
}

function reportSkipped(n: number, serverId: string) {
  if (!n) return;
  addLog(
    'info',
    $t('{0} {1} nach den Regeln zum Auslassen nicht übertragen', n, n === 1 ? $t('Datei') : $t('Dateien')),
    serverId,
  );
  showToast(
    $t('{0} {1} ausgelassen (Einstellungen › Übertragungen).', n, n === 1 ? $t('Datei wurde') : $t('Dateien wurden')),
  );
}

/** Uploads local files or folders (selected names in `localDir`) to `remoteDir`. */
export async function uploadNames(serverId: string, localDir: string, remoteDir: string, names: string[]) {
  // Inside an archive opened like a folder: extract the entries first, then upload those.
  if (insideArchive(join(localDir, names[0] ?? ''))) {
    try {
      const [dir, extracted] = await backend.archiveExtractTemp(names.map((n) => join(localDir, n)));
      return uploadNames(serverId, dir, remoteDir, extracted);
    } catch (e) {
      showError(e);
      return { ids: [] as string[], skipped: 0 };
    }
  }
  return queueNames(names, {
    direction: 'up',
    serverId,
    walk: (n) => backend.localWalk(join(localDir, n)),
    walkFailed: showError,
    targetDir: remoteDir,
    target: (f) => join(remoteDir, remoteRel(serverId, f.relative)),
  });
}

/** Uploads files and folders given as native paths (dropped from the Finder / Explorer). */
export async function uploadNativePaths(serverId: string, nativePaths: string[], remoteDir: string) {
  const byParent = new Map<string, string[]>();
  for (const n of nativePaths) {
    const ui = await backend.pathToUi(n);
    const dir = parent(ui);
    byParent.set(dir, [...(byParent.get(dir) ?? []), basename(ui)]);
  }
  for (const [dir, names] of byParent) await uploadNames(serverId, dir, remoteDir, names);
}

/**
 * Path below an upload target folder (with the server's names, see `WalkItem.relative`) as it
 * is stored on the server: in the composed Unicode form (NFC) unless the server keeps names as they are. macOS
 * hands out some names decomposed ("u" plus a combining diaeresis), which Linux
 * and Windows servers treat as a different name than the same word typed there.
 */
export function remoteRel(serverId: string, rel: string): string {
  return serverById(serverId)?.keepNameForm ? rel : rel.normalize('NFC');
}

/** Downloads remote files or folders (names in `remoteDir`) into `localDir`. */
export function downloadNames(serverId: string, remoteDir: string, localDir: string, names: string[]) {
  return queueNames(names, {
    direction: 'down',
    serverId,
    walk: (n) => backend.remoteWalk(serverId, join(remoteDir, n)),
    walkFailed: (e) => remoteFailed(serverId, e),
    targetDir: localDir,
    target: (f) => join(localDir, f.localRelative),
  });
}

/** Server to server: copies files or folders (names in `fromDir` on one server) into `toDir` on another. */
export function crossNames(fromServerId: string, fromDir: string, serverId: string, toDir: string, names: string[]) {
  return queueNames(names, {
    direction: 'cross',
    serverId,
    sourceServerId: fromServerId,
    walk: (n) => backend.remoteWalk(fromServerId, join(fromDir, n)),
    walkFailed: (e) => remoteFailed(fromServerId, e),
    targetDir: toDir,
    target: (f) => join(toDir, remoteRel(serverId, f.relative)),
  });
}

function remoteFailed(serverId: string, e: unknown) {
  const err = toBackendError(e);
  handleRemoteError(serverId, err);
  showError(err);
}

/**
 * Walks each of `names` and queues one transfer per file, leaving out what the rules of the target
 * server exclude. Returns the queue entries and how many files were left out.
 */
async function queueNames(
  names: string[],
  how: {
    direction: 'up' | 'down' | 'cross';
    /** The server the files go to or come from (its rules apply). */
    serverId: string;
    sourceServerId?: string;
    walk: (name: string) => Promise<WalkItem[]>;
    walkFailed: (e: unknown) => void;
    targetDir: string;
    target: (f: WalkItem) => string;
  },
) {
  const items: Transfer[] = [];
  let skipped = 0;
  for (const n of names) {
    let walk: WalkItem[];
    try {
      walk = await how.walk(n);
    } catch (e) {
      how.walkFailed(e);
      continue;
    }
    for (const f of walk) {
      if (skippedByRules(f.relative, f.size, how.serverId)) {
        skipped++;
        continue;
      }
      const target = how.target(f);
      items.push({
        id: uid('t'),
        name: basename(f.path),
        direction: how.direction,
        ...(how.sourceServerId ? { sourceServerId: how.sourceServerId } : {}),
        serverId: how.serverId,
        folder: relFolder(how.targetDir, target),
        source: f.path,
        target,
        size: f.size,
        done: 0,
        state: 'queued',
        manual: true,
      });
    }
  }
  const queued = enqueue(items);
  if (items.length > 1) showToast($t('{0} Dateien in der Warteschlange.', items.length));
  reportSkipped(skipped, how.serverId);
  return { ids: queued.map((x) => x.id), skipped };
}

/**
 * "Verschieben" between this computer and a server, or between two servers:
 * the files are transferred first and the originals removed only once every
 * file arrived without an error (on this computer into the recycle bin).
 */
export async function moveAcross(from: string, fromDir: string, names: string[], to: string, toDir: string) {
  const queued = !from
    ? await uploadNames(to, fromDir, toDir, names)
    : !to
      ? await downloadNames(from, fromDir, toDir, names)
      : await crossNames(from, fromDir, to, toDir, names);
  if (!queued.ids.length) return;
  if (queued.skipped) {
    showToast($t('Einige Dateien werden nach den Regeln ausgelassen; die Originale bleiben deshalb erhalten.'));
    return;
  }
  const ids = new Set(queued.ids);
  const arrived = new Set<string>();
  const stop = subscribeStore(() => {
    const mine = getState().transfers.filter((t) => ids.has(t.id));
    // A file left out because the target was the same counts as arrived; one left out because a
    // different file is there does not, and its original stays.
    for (const t of mine) if (t.state === 'done' && (!t.skipped || t.skipped === 'unchanged')) arrived.add(t.id);
    const failed = mine.some((t) => t.state === 'error' || (t.skipped && t.skipped !== 'unchanged'));
    // A transfer removed from the list before it arrived was cancelled.
    const gone = [...ids].some((id) => !arrived.has(id) && !mine.some((t) => t.id === id));
    if (failed || gone) {
      stop();
      showToast(
        $t('Nicht alle Dateien sind angekommen; die Originale bleiben erhalten.'),
        'error',
        $t('Einzelheiten unter Übertragungen.'),
      );
      return;
    }
    if (arrived.size < ids.size) return;
    stop();
    void removeEntries(from ? 'remote' : 'local', from, fromDir, names);
  });
}

/** Transfers currently handled by the backend. */
const active = new Set<string>();
/** Transfers for which a cancel was sent. */
const cancelling = new Set<string>();
/** Transfers that already passed the "server copy is newer" / "exists" check. */
export const forcedLive = new Set<string>();
/**
 * Watches whose post-upload command runs once their batch is done, with the uploads of that batch:
 * only those decide, so an old failed upload still in the list does not hold the command back.
 */
const pendingCommand = new Map<string, Set<string>>();

/** Queues the uploads of a watch and runs its command once they are through. */
export function enqueueForCommand(watchId: string, items: Transfer[]) {
  const ids = pendingCommand.get(watchId) ?? new Set<string>();
  enqueue(items).forEach((t) => ids.add(t.id));
  pendingCommand.set(watchId, ids);
}
let bytesThisSecond = 0;
const lastDone = new Map<string, number>();

/** Bytes moved since the last call (called once a second for the speed shown). */
export function takeBytesMoved(): number {
  const n = bytesThisSecond;
  bytesThisSecond = 0;
  return n;
}

function patchTransfer(id: string, patch: Partial<Transfer>) {
  setState((s) => ({ transfers: s.transfers.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
}

function removeTransfer(id: string) {
  setState((s) => ({ transfers: s.transfers.filter((x) => x.id !== id) }));
}

/** "644" -> 0o644; empty or invalid -> undefined (leave the permissions to the server). */
function octal(text: string | undefined): number | undefined {
  const t = (text ?? '').trim();
  return /^[0-7]{3,4}$/.test(t) ? parseInt(t, 8) : undefined;
}

/** Options for one transfer from the settings and the transfer's watch. */
function transferOptions(tr: Transfer): TransferOptions {
  const s = getState();
  const w = tr.watchId ? s.watches.find((x) => x.id === tr.watchId) : undefined;
  const share = Math.max(1, s.settings.parallel);
  // The transfer rule of the watch or the server comes first, then the general settings.
  const rule = ruleFor(tr.serverId, tr.watchId, s);
  return {
    tempName: s.settings.uploadTempName,
    keepMtime: s.settings.keepMtime,
    resume: true,
    // "Standard-Rechte" in the settings; a watch with "Rechte setzen" falls back to 644/755.
    filePerms:
      octal(rule?.filePerms) ?? octal(s.settings.uploadFilePerms) ?? (w?.options.setPermissions ? 0o644 : undefined),
    dirPerms:
      octal(rule?.dirPerms) ?? octal(s.settings.uploadDirPerms) ?? (w?.options.setPermissions ? 0o755 : undefined),
    keepVersions: rule?.keepOldVersion || w?.options.keepOldVersion ? KEEP_VERSIONS : 0,
    // The overall limit is shared between the parallel transfers.
    limitKbps: limitFor(
      tr.direction === 'down'
        ? (s.settings.bandwidthLimitDown ?? s.settings.bandwidthLimit)
        : s.settings.bandwidthLimit,
      share,
    ),
  };
}

/**
 * "Nach dem Herunterladen öffnen" (Transmit): opens downloaded files with
 * their usual program. At most five within ten seconds, so downloading a
 * whole folder does not open dozens of windows.
 */
const openedRecently: number[] = [];
function openAfterDownload(path: string) {
  if (!getState().settings.openAfterDownload) return;
  const now = Date.now();
  while (openedRecently.length && now - openedRecently[0] > 10000) openedRecently.shift();
  if (openedRecently.length >= 5) return;
  openedRecently.push(now);
  backend.localOpen(path).catch((e) => showError(e));
}

/** "Im Inhalt suchen": files below `base` containing `query` (this computer or an SSH server). */
export function grep(side: PaneSide, serverId: string, base: string, query: string, max: number) {
  return side === 'local' ? backend.localGrep(base, query, max) : backend.remoteGrep(serverId, base, query, max);
}

/** One transfer's share of a limit in KB/s (0 = unlimited). */
function limitFor(total: number, share: number): number {
  return total > 0 ? Math.max(1, Math.floor(total / share)) : 0;
}

/** Number of older versions kept per file ("Ältere Version auf dem Server behalten"). */
const KEEP_VERSIONS = 5;

let pumpScheduled = false;
/** Starts queued transfers and stops ones the user paused or removed. */
export function pump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  queueMicrotask(() => {
    pumpScheduled = false;
    const s = getState();
    for (const id of active) {
      const tr = s.transfers.find((x) => x.id === id);
      if ((!tr || tr.state !== 'running') && !cancelling.has(id)) {
        cancelling.add(id);
        // Removed: throw the partial file away. Paused: keep it to continue later.
        void backend.cancel(id, !tr);
      }
    }
    let slots = Math.max(0, s.settings.parallel - active.size);
    // Running transfers per server, for servers with their own limit ("Gleichzeitige Übertragungen").
    const perServer = new Map<string, number>();
    const count = (id: string) => perServer.set(id, (perServer.get(id) ?? 0) + 1);
    for (const id of active) {
      const tr = s.transfers.find((x) => x.id === id);
      if (!tr) continue;
      count(tr.serverId);
      if (tr.sourceServerId) count(tr.sourceServerId);
    }
    const full = (id: string) => {
      const max = serverById(id, s)?.maxTransfers;
      return !!max && (perServer.get(id) ?? 0) >= max;
    };
    // A file changed again while its upload runs is queued anew; it starts once that upload is
    // through, as both would write the same temporary file.
    const target = (t: Transfer) => `${t.direction === 'down' ? '' : t.serverId}\u0000${t.target}`;
    const busyTargets = new Set(
      [...active].flatMap((id) => {
        const t = s.transfers.find((x) => x.id === id);
        return t && t.direction !== 'command' ? [target(t)] : [];
      }),
    );
    for (const tr of s.transfers) {
      if (slots <= 0) break;
      if (tr.state !== 'queued' || s.offline[tr.serverId] || (tr.sourceServerId && s.offline[tr.sourceServerId]))
        continue;
      if (full(tr.serverId) || (tr.sourceServerId && full(tr.sourceServerId))) continue;
      if (tr.direction !== 'command' && busyTargets.has(target(tr))) continue;
      // Server to server needs both connections.
      const needed = tr.sourceServerId ? [tr.serverId, tr.sourceServerId] : [tr.serverId];
      const missing = needed.filter((id) => !connected.has(id));
      if (missing.length) {
        for (const id of missing) if (!connecting.has(id) && !failed.has(id)) void connectServer(id);
        continue;
      }
      slots--;
      if (tr.direction !== 'command') busyTargets.add(target(tr));
      count(tr.serverId);
      if (tr.sourceServerId) count(tr.sourceServerId);
      void start(tr);
    }
  });
}

/** Deletes partial files of transfers the user removed from the list. */
export function discardRemoved(prev: Transfer[], next: Transfer[]) {
  const still = new Set(next.map((t) => t.id));
  for (const t of prev) {
    if (still.has(t.id) || active.has(t.id) || t.direction === 'command' || t.state === 'done' || t.state === 'queued')
      continue;
    if ((t.direction === 'up' || t.direction === 'cross') && !connected.has(t.serverId)) continue;
    // Server to server keeps its partial file on the target server, like an upload.
    if (t.direction === 'cross') void backend.discardPartial(t.serverId, 'up', '', t.target);
    else
      void backend.discardPartial(
        t.serverId,
        t.direction,
        t.direction === 'up' ? t.source : t.target,
        t.direction === 'up' ? t.target : t.source,
      );
  }
}

function verb(tr: Transfer) {
  return tr.direction === 'up'
    ? $t('Hochgeladen')
    : tr.direction === 'cross'
      ? $t('Übertragen')
      : $t('Heruntergeladen');
}

async function start(queued: Transfer) {
  // The checks below may change the transfer (another name when both are kept): from then on the
  // current entry is used.
  let tr = queued;
  active.add(tr.id);
  lastDone.set(tr.id, tr.done);
  patchTransfer(tr.id, { state: 'running', error: undefined, errorDetail: undefined, hold: undefined });
  try {
    if (tr.direction === 'command') {
      addLog('info', $t('Befehl: {0}', tr.name), tr.serverId);
      const res = await backend.remoteExec(tr.serverId, tr.name);
      const output = res.output.trim();
      if (res.code === 0) {
        patchTransfer(tr.id, { state: 'done', done: tr.size, finishedAt: Date.now(), output });
        addLog('ok', $t('Befehl fertig: {0}', tr.name), tr.serverId, output || undefined);
      } else {
        patchTransfer(tr.id, {
          state: 'error',
          error: $t('Befehl endete mit Code {0}', res.code),
          errorDetail: output || undefined,
          output,
        });
        addLog('error', $t('Befehl endete mit Code {0}: {1}', res.code, tr.name), tr.serverId, output || undefined);
      }
      return;
    }
    if (await preflight(tr)) return;
    // Paused or removed while the checks above ran: the core had no transfer to stop then, so it
    // is not started now.
    const now = getState().transfers.find((x) => x.id === tr.id);
    if (now?.state !== 'running') {
      addLog('info', now ? $t('Pausiert: {0}', tr.target) : $t('Abgebrochen: {0}', tr.target), tr.serverId);
      return;
    }
    tr = now;
    addLog(
      'debug',
      `${tr.direction === 'up' ? $t('Lade hoch') : tr.direction === 'cross' ? $t('Übertrage von {0}', serverById(tr.sourceServerId ?? '')?.name ?? '') : $t('Lade herunter')}: ${tr.source} → ${tr.target}`,
      tr.serverId,
    );
    const onProgress = (done: number) => {
      bytesThisSecond += Math.max(0, done - (lastDone.get(tr.id) ?? 0));
      lastDone.set(tr.id, done);
      const cur = getState().transfers.find((x) => x.id === tr.id);
      if (cur?.state === 'running') patchTransfer(tr.id, { done });
    };
    const opts = transferOptions(tr);
    const size =
      tr.direction === 'up'
        ? await backend.upload(tr.id, tr.serverId, tr.source, tr.target, opts, onProgress)
        : tr.direction === 'cross'
          ? await backend.cross(tr.id, tr.sourceServerId ?? '', tr.source, tr.serverId, tr.target, opts, onProgress)
          : await backend.download(tr.id, tr.serverId, tr.source, tr.target, opts, onProgress);
    patchTransfer(tr.id, { state: 'done', done: size, size, finishedAt: Date.now() });
    addLog('ok', `${verb(tr)}: ${tr.target}`, tr.serverId);
    if (tr.editMtime !== undefined) editUploaded(tr);
    if (tr.direction === 'down' && tr.manual) openAfterDownload(tr.target);
    const side: PaneSide = tr.direction === 'down' ? 'local' : 'remote';
    invalidate(side, tr.serverId, parent(tr.target));
    bump();
  } catch (e) {
    const err = toBackendError(e);
    const cur = getState().transfers.find((x) => x.id === tr.id);
    if (err.kind === 'cancelled') {
      // Paused: the partial file stays and the transfer continues from there.
      addLog('info', cur ? $t('Pausiert: {0}', tr.target) : $t('Abgebrochen: {0}', tr.target), tr.serverId);
    } else if (err.kind === 'connectionLost' || err.kind === 'notConnected') {
      patchTransfer(tr.id, { state: 'queued' });
      addLog('warn', $t('Verbindung unterbrochen bei {0}; wird fortgesetzt.', tr.name), tr.serverId, err.detail);
      if (tr.sourceServerId) {
        // Server to server: find out which of the two connections broke.
        for (const id of [tr.sourceServerId, tr.serverId]) {
          if (!(await backend.isConnected(id))) markOffline(id);
        }
      } else markOffline(tr.serverId);
    } else if (cur && scheduleRetry(tr, err)) {
      // Temporary problem: try again in a few seconds (up to three times).
    } else if (cur) {
      const detail =
        err.kind === 'permissionDenied'
          ? $t(
              'Der Server verweigert das Schreiben in {0} (Permission denied). Prüfe die Ordnerrechte oder den Besitzer auf dem Server.',
              parent(tr.target),
            )
          : err.detail;
      patchTransfer(tr.id, { state: 'error', error: err.message, errorDetail: detail });
      addLog('error', `${tr.name}: ${err.message}`, tr.serverId, detail);
      stopWatchOnError(tr, err.message);
    }
  } finally {
    active.delete(tr.id);
    cancelling.delete(tr.id);
    lastDone.delete(tr.id);
    afterTransfer(tr);
    pump();
  }
}

/** Errors that will not go away by trying again. */
const PERMANENT: BackendError['kind'][] = ['permissionDenied', 'notFound', 'alreadyExists', 'authFailed'];

/** Schedules an automatic retry; false when it is not worth one (or retries are used up). */
function scheduleRetry(tr: Transfer, err: BackendError): boolean {
  const s = getState();
  const tries = tr.retries ?? 0;
  if (!s.settings.autoRetry || tries >= 3 || PERMANENT.includes(err.kind) || tr.direction === 'command') return false;
  patchTransfer(tr.id, {
    state: 'paused',
    error: $t('Neuer Versuch gleich ({0} von 3)', tries + 1),
    retries: tries + 1,
    hold: 'retry',
  });
  addLog(
    'warn',
    $t('{0}: {1} – neuer Versuch in 5 Sekunden ({2} von 3)', tr.name, err.message, tries + 1),
    tr.serverId,
    err.detail,
  );
  window.setTimeout(() => {
    const cur = getState().transfers.find((x) => x.id === tr.id);
    if (cur?.state === 'paused' && cur.hold === 'retry')
      patchTransfer(tr.id, { state: 'queued', error: undefined, hold: undefined });
  }, 5000);
  return true;
}

/** "Bei Fehlern weitermachen" switched off: an error pauses the watch. */
function stopWatchOnError(tr: Transfer, message: string) {
  const w = tr.watchId ? getState().watches.find((x) => x.id === tr.watchId) : undefined;
  if (!w || w.options.continueOnError || w.state === 'paused') return;
  setState((s) => ({ watches: s.watches.map((x) => (x.id === w.id ? { ...x, state: 'paused' } : x)) }));
  showToast(
    $t('Überwachung „{0}“ angehalten: {1}, {2}', w.name, tr.name, message),
    'error',
    $t('Nach dem Beheben die Überwachung wieder starten.'),
  );
  addLog('warn', $t('Überwachung „{0}“ nach einem Fehler angehalten.', w.name), w.serverId);
}

async function statOrNull(side: PaneSide, serverId: string, path: string): Promise<FileEntry | null> {
  try {
    return await statEntry(side, serverId, path);
  } catch {
    return null;
  }
}

/**
 * Checks before writing. Returns true when the transfer must not run now:
 * skipped (rule for existing files, "nur vorhandene"), or waiting for the
 * user in the conflict dialog.
 */
async function preflight(tr: Transfer): Promise<boolean> {
  const s = getState();
  const watch = tr.watchId ? s.watches.find((w) => w.id === tr.watchId) : undefined;
  if (forcedLive.has(tr.id) || tr.decided) return false;
  const targetSide: PaneSide = tr.direction === 'down' ? 'local' : 'remote';
  const sourceSide: PaneSide = tr.direction === 'up' ? 'local' : 'remote';
  // Server to server: the source is on another server than the target.
  const sourceServer = tr.sourceServerId ?? tr.serverId;

  // Saved in the editor: warn if someone changed the server file since it was opened.
  if (tr.editMtime !== undefined) {
    const remote = await statOrNull('remote', tr.serverId, tr.target);
    const local = await statOrNull('local', tr.serverId, tr.source);
    if (remote && local && remote.mtime - tr.editMtime > 1000) {
      askConflict(tr, 'newer', local, remote);
      return true;
    }
    return false;
  }

  if (watch) {
    if (!watch.options.onlyExisting && !watch.options.warnIfServerNewer) return false;
    const remote = await statOrNull('remote', tr.serverId, tr.target);
    if (!remote) {
      if (watch.options.onlyExisting) {
        removeTransfer(tr.id);
        addLog('info', $t('Nicht hochgeladen (nur vorhandene Dateien): {0}', tr.target), tr.serverId);
        return true;
      }
      return false;
    }
    if (!watch.options.warnIfServerNewer) return false;
    const local = await statOrNull('local', tr.serverId, tr.source);
    // SFTP stores whole seconds; allow for that rounding.
    if (!local || remote.mtime - local.mtime <= timeTolerance(tr.serverId)) return false;
    askConflict(tr, 'newer', local, remote, watch.name);
    return true;
  }

  if (!tr.manual) return false;
  const tRule = ruleFor(tr.serverId, undefined, s);
  const rule =
    tr.direction === 'down'
      ? (tRule?.existingDown ?? s.settings.existingDownload)
      : (tRule?.existingUp ?? s.settings.existingFiles);
  if (rule === 'overwrite' && !s.settings.skipUnchanged) return false;
  const target = await statOrNull(targetSide, tr.serverId, tr.target);
  if (!target || target.kind === 'dir') return false;
  const source = await statOrNull(sourceSide, sourceServer, tr.source);
  if (!source) return false;
  const skip = (skipped: NonNullable<Transfer['skipped']>) => {
    patchTransfer(tr.id, { state: 'done', done: 0, finishedAt: Date.now(), skipped });
    addLog('info', $t('Übersprungen ({0}): {1}', skippedText(skipped), tr.target), tr.serverId);
    return true;
  };
  // Same size and modification time: the file is already there.
  if (
    s.settings.skipUnchanged &&
    source.size === target.size &&
    Math.abs(source.mtime - target.mtime) <= timeTolerance(tr.serverId)
  )
    return skip('unchanged');
  if (rule === 'overwrite') return false;
  if (rule === 'skip') return skip('exists');
  if (rule === 'keepBoth') {
    // Keep the existing file and store this one next to it under a free name.
    const names = new Set(
      (await readFolder(targetSide, tr.serverId, parent(tr.target)).catch(() => [])).map((e) => e.name),
    );
    const dot = tr.name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [tr.name.slice(0, dot), tr.name.slice(dot)] : [tr.name, ''];
    let n = 2;
    let free = `${stem} ${n}${ext}`;
    while (names.has(free)) free = `${stem} ${++n}${ext}`;
    patchTransfer(tr.id, { name: free, target: join(parent(tr.target), free), decided: true });
    addLog('info', $t('Gibt es schon, wird als „{0}“ daneben gespeichert', free), tr.serverId);
    return false;
  }
  if (rule === 'newer') return source.mtime - target.mtime > timeTolerance(tr.serverId) ? false : skip('notNewer');
  const local = tr.direction === 'down' ? target : source;
  const remote = tr.direction === 'down' ? source : target;
  askConflict(
    tr,
    remote.mtime - local.mtime > timeTolerance(tr.serverId) && tr.direction !== 'down' ? 'newer' : 'exists',
    local,
    remote,
  );
  return true;
}

function askConflict(
  tr: Transfer,
  reason: 'newer' | 'exists',
  local: FileEntry,
  remote: FileEntry,
  watchName?: string,
) {
  const direction: 'up' | 'down' = tr.direction === 'down' ? 'down' : 'up';
  setState((st) => ({
    conflicts: st.conflicts.some((c) => c.transferId === tr.id)
      ? st.conflicts
      : [
          ...st.conflicts,
          {
            transferId: tr.id,
            name: tr.name,
            serverId: tr.serverId,
            direction,
            reason,
            cross: tr.direction === 'cross',
            sourceServerId: tr.sourceServerId,
            remoteFolder: parent(tr.direction === 'down' ? tr.source : tr.target),
            localSize: local.size,
            localTime: local.mtime,
            remoteSize: remote.size,
            remoteTime: remote.mtime,
            watchName,
            more: 0,
          },
        ].map((c, i, arr) => ({ ...c, more: arr.length - 1 - i })),
    dialog: st.dialog ?? { type: 'conflict' },
    transfers: st.transfers.map((x) =>
      x.id === tr.id ? { ...x, state: 'paused', error: $t('Wartet auf Entscheidung'), hold: 'conflict' } : x,
    ),
  }));
}

/** Updates the watch status and runs the post-upload command after a batch. */
function afterTransfer(tr: Transfer) {
  if (!tr.watchId) return;
  const s = getState();
  const w = s.watches.find((x) => x.id === tr.watchId);
  if (!w) return;
  const cur = s.transfers.find((x) => x.id === tr.id);
  if (cur?.state === 'done' && tr.direction === 'up' && !cur.skipped) {
    setState((st) => ({
      watches: st.watches.map((x) =>
        x.id === w.id ? { ...x, lastFile: cur.name, lastTime: cur.finishedAt ?? Date.now() } : x,
      ),
    }));
  }
  const ids = pendingCommand.get(w.id);
  if (!ids) return;
  // Uploads removed from the list count as through.
  const batch = s.transfers.filter((x) => ids.has(x.id));
  const busy = batch.some((x) => x.state === 'running' || x.state === 'queued' || x.state === 'paused');
  if (!busy) {
    pendingCommand.delete(w.id);
    const failed = batch.filter((x) => x.state === 'error').length;
    const command = w.options.commandEnabled ? w.options.command.trim() : '';
    if (command && failed) {
      addLog(
        'warn',
        $t('Befehl nach dem Hochladen übersprungen, {0} Dateien sind fehlgeschlagen: {1}', failed, command),
        w.serverId,
      );
    } else if (command) {
      enqueue([
        {
          id: uid('t'),
          name: command,
          direction: 'command',
          serverId: w.serverId,
          folder: '',
          source: '',
          target: '',
          size: 1,
          done: 0,
          state: 'queued',
          watchId: w.id,
        },
      ]);
    }
  }
}

/** Conflict answer "Server-Version herunterladen": download the server copy instead. */
export function downloadInstead(tr: Transfer) {
  setState((s) => ({
    transfers: s.transfers.map((x) =>
      x.id === tr.id
        ? {
            ...x,
            direction: 'down',
            source: tr.target,
            target: tr.source,
            state: 'queued',
            done: 0,
            error: undefined,
            hold: undefined,
            decided: true,
            watchId: undefined,
          }
        : x,
    ),
  }));
  pump();
}
