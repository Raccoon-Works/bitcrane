/**
 * File operations on this computer and on servers through the backend.
 */
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { $t } from '../../i18n';
import { type PaneSide } from '../../backend/types';
import { invalidate, bump } from './listing';
import { showToast, serverById, getState } from '../core';
import { addLog } from '../log';
import { toBackendError, type WalkItem } from '../../backend/api';
import { handleRemoteError, homeOf } from './connections';
import { showError } from '../errors';
import { basename, join, parent } from '../../util/paths';
import { updateSettings } from '../settings';

/** Paths for a log line: up to three, then "und N weitere". */
function pathsText(paths: string[]): string {
  if (paths.length <= 3) return paths.join(', ');
  return $t('{0} und {1} weitere', paths.slice(0, 3).join(', '), paths.length - 3);
}

/**
 * Runs a file operation, refreshes the folder and reports the outcome. With
 * `logText` the operation is also written to the protocol (Ansicht > Protokoll),
 * like WinSCP and FileZilla record every change made on a server.
 */
async function run(
  side: PaneSide,
  serverId: string,
  dir: string,
  op: () => Promise<unknown>,
  okText?: string,
  logText?: string,
): Promise<boolean> {
  const sid = side === 'remote' ? serverId : undefined;
  try {
    await op();
    invalidate(side, serverId, dir);
    bump();
    if (okText) showToast(okText, 'ok');
    if (logText) addLog('ok', logText, sid);
    return true;
  } catch (e) {
    const err = toBackendError(e);
    if (side === 'remote') handleRemoteError(serverId, err);
    if (logText) addLog('error', `${logText}: ${err.message}`, sid, err.detail);
    showError(err, { serverId: sid, log: logText ? 'done' : true });
    invalidate(side, serverId, dir);
    bump();
    return false;
  }
}

export function renameEntry(side: PaneSide, serverId: string, dir: string, oldName: string, newName: string) {
  const path = join(dir, oldName);
  return run(
    side,
    serverId,
    dir,
    () => (side === 'local' ? backend.localRename(path, newName) : backend.remoteRename(serverId, path, newName)),
    undefined,
    $t('Umbenannt: {0} → {1}', path, newName),
  );
}

export function makeFolder(side: PaneSide, serverId: string, dir: string, name: string) {
  const path = join(dir, name);
  return run(
    side,
    serverId,
    dir,
    () => (side === 'local' ? backend.localMkdir(path) : backend.remoteMkdir(serverId, path)),
    undefined,
    $t('Ordner angelegt: {0}', path),
  );
}

/** "Neue Datei": an empty file in the folder. */
export function makeFile(side: PaneSide, serverId: string, dir: string, name: string) {
  const path = join(dir, name);
  return run(
    side,
    serverId,
    dir,
    () => (side === 'local' ? backend.localNewFile(path) : backend.remoteNewFile(serverId, path)),
    undefined,
    $t('Datei angelegt: {0}', path),
  );
}

/** Folder of the server's recycle bin (absolute), or undefined when the server has none. */
export function serverTrash(serverId: string): string | undefined {
  const rel = serverById(serverId)?.trashDir?.trim();
  if (!rel) return undefined;
  return rel.startsWith('/') ? rel.replace(/\/+$/, '') : join(homeOf(serverId) ?? '/', rel);
}

/** Moves entries into the server's recycle bin; a name already there gets the date and time added. */
async function trashOnServer(serverId: string, dir: string, names: string[], trash: string) {
  // Usually the bin exists already; any real problem shows in the moves that follow.
  await backend.remoteMkdir(serverId, trash).catch(() => undefined);
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-');
  for (const n of names) {
    const name = basename(n);
    let target = join(trash, name);
    if (
      await backend.remoteStat(serverId, target).then(
        () => true,
        () => false,
      )
    ) {
      const dot = name.lastIndexOf('.');
      target = join(trash, dot > 0 ? `${name.slice(0, dot)} (${stamp})${name.slice(dot)}` : `${name} (${stamp})`);
    }
    await backend.remoteMove(serverId, join(dir, n), target);
  }
  invalidate('remote', serverId, trash);
}

export function removeEntries(side: PaneSide, serverId: string, dir: string, names: string[]) {
  const paths = names.map((n) => join(dir, n));
  const trash = side === 'remote' ? serverTrash(serverId) : undefined;
  // Inside the recycle bin itself, or for a folder that contains it, deleting removes for good.
  const holdsTrash = !!trash && paths.some((p) => trash === p || trash.startsWith(p + '/'));
  if (trash && !holdsTrash && dir !== trash && !dir.startsWith(trash + '/')) {
    const what = names.length === 1 ? `„${names[0]}“` : $t('{0} Objekte', names.length);
    return run(
      side,
      serverId,
      dir,
      () => trashOnServer(serverId, dir, names, trash),
      $t('{0} in den Papierkorb auf dem Server gelegt.', what),
      $t('In den Papierkorb auf dem Server gelegt: {0}', pathsText(paths)),
    );
  }
  const what = names.length === 1 ? `„${names[0]}“` : $t('{0} Objekte', names.length);
  // Deleting a folder on a server removes every file one by one and can take a while:
  // say that it is running, the result replaces this message.
  if (side === 'remote') showToast($t('{0} wird gelöscht …', what), 'info', undefined, true);
  return run(
    side,
    serverId,
    dir,
    () => (side === 'local' ? backend.localTrash(paths) : backend.remoteRemove(serverId, paths)),
    side === 'local' ? $t('{0} in den Papierkorb gelegt.', what) : $t('{0} gelöscht.', what),
    side === 'local' ? $t('In den Papierkorb gelegt: {0}', pathsText(paths)) : $t('Gelöscht: {0}', pathsText(paths)),
  ).then((ok) => {
    // Deleted folders of this computer leave "Zuletzt verwendet" too.
    const recent = getState().settings.recentDirs;
    if (ok && side === 'local' && recent?.some((r) => paths.some((p) => r === p || r.startsWith(p + '/')))) {
      updateSettings({ recentDirs: recent.filter((r) => !paths.some((p) => r === p || r.startsWith(p + '/'))) });
    }
    return ok;
  });
}

const copiedText = (names: string[]) =>
  names.length === 1 ? $t('Kopiert als „{0}“.', names[0]) : $t('{0} Objekte kopiert.', names.length);

/** Copies on the server (⌘C, ⌘V in the same half). */
export async function copyOnServer(serverId: string, fromDir: string, names: string[], toDir: string) {
  let made: string[] = [];
  const ok = await run(
    'remote',
    serverId,
    toDir,
    async () => {
      made = await backend.remoteCopy(
        serverId,
        names.map((n) => join(fromDir, n)),
        toDir,
      );
    },
    undefined,
    $t('Kopiert: {0} → {1}', pathsText(names.map((n) => join(fromDir, n))), toDir),
  );
  if (ok) showToast(copiedText(made), 'ok');
}

/**
 * Moves entries of a folder into another folder of the same place: on this
 * computer with a move, on a server with renames (drag onto a folder,
 * "Neuer Ordner mit Auswahl"). Returns false when nothing could be moved.
 */
export async function moveInto(
  side: PaneSide,
  serverId: string,
  fromDir: string,
  names: string[],
  toDir: string,
): Promise<boolean> {
  if (side === 'local') return !!(await moveLocal(fromDir, names, toDir));
  let moved = 0;
  const ok = await run(
    'remote',
    serverId,
    fromDir,
    async () => {
      for (const n of names) {
        await backend.remoteMove(serverId, join(fromDir, n), join(toDir, basename(n)));
        moved++;
      }
    },
    undefined,
    $t('Verschoben: {0} → {1}', pathsText(names.map((n) => join(fromDir, n))), toDir),
  );
  invalidate('remote', serverId, toDir);
  for (const n of names) if (n.includes('/')) invalidate('remote', serverId, parent(join(fromDir, n)));
  bump();
  if (moved)
    showToast(moved === 1 ? $t('„{0}“ verschoben.', basename(names[0])) : $t('{0} Objekte verschoben.', moved), 'ok');
  return ok;
}

/** Moves files or folders between two folders of this computer (two local halves). */
export async function moveLocal(fromDir: string, names: string[], toDir: string, merge = false) {
  let made: string[] = [];
  const ok = await run(
    'local',
    '',
    toDir,
    async () => {
      made = await backend.localMove(
        names.map((n) => join(fromDir, n)),
        toDir,
        merge,
      );
    },
    undefined,
    $t('Verschoben: {0} → {1}', pathsText(names.map((n) => join(fromDir, n))), toDir),
  );
  invalidate('local', '', fromDir);
  bump();
  if (ok)
    showToast(made.length === 1 ? $t('„{0}“ verschoben.', made[0]) : $t('{0} Objekte verschoben.', made.length), 'ok');
  // The names they got in the target (for undo), or null when it failed.
  return ok ? made : null;
}

/** Copies on this computer. */
export async function copyLocal(fromDir: string, names: string[], toDir: string, merge = false) {
  let made: string[] = [];
  const ok = await run(
    'local',
    '',
    toDir,
    async () => {
      made = await backend.localCopy(
        names.map((n) => join(fromDir, n)),
        toDir,
        merge,
      );
    },
    undefined,
    $t('Kopiert: {0} → {1}', pathsText(names.map((n) => join(fromDir, n))), toDir),
  );
  if (ok && merge) invalidate('local', '', fromDir);
  if (ok) showToast(copiedText(made), 'ok');
}

/** "Link kopieren" (cloud services): a sharing link goes to the clipboard. */
export async function copyShareLink(serverId: string, path: string) {
  try {
    showToast($t('Link wird erstellt …'));
    const url = await backend.remoteShareLink(serverId, path);
    await navigator.clipboard.writeText(url);
    showToast($t('Link kopiert.'), 'ok');
  } catch (e) {
    showError(e);
  }
}

/** "Komprimieren": a zip of the chosen entries next to them (this computer). */
export async function zipLocal(dir: string, names: string[]) {
  let made = '';
  const ok = await run('local', '', dir, async () => {
    made = await backend.localZip(names.map((n) => join(dir, n)));
  });
  if (ok) showToast($t('„{0}“ erstellt.', made), 'ok');
}

/** "Entpacken": the zip's content goes into a new folder next to it (this computer). */
export async function unzipLocal(dir: string, name: string) {
  let made = '';
  const ok = await run('local', '', dir, async () => {
    made = await backend.localUnzip(join(dir, name));
  });
  if (ok) showToast($t('Entpackt nach „{0}“.', made), 'ok');
}

export function changePerms(serverId: string, path: string, perms: string, recursive: boolean) {
  const done = $t('Rechte gesetzt: {0}{1}', perms, recursive ? $t(' (mit Unterordnern)') : '');
  return run(
    'remote',
    serverId,
    parent(path),
    () => backend.remoteChmod(serverId, path, perms, recursive),
    done,
    `${done} – ${path}`,
  );
}

/** All files below a folder (for folder sizes and searching). */
export function walkFiles(side: PaneSide, serverId: string, path: string): Promise<WalkItem[]> {
  return side === 'local' ? backend.localWalk(path) : backend.remoteWalk(serverId, path);
}

export function openUrl(url: string) {
  backend.openUrl(url).catch((e) => showError(e));
}

/** Shows a file of this computer selected in the Finder or Explorer. */
export function revealLocal(path: string) {
  backend.localReveal(path).catch((e) => showError(e));
}

export function openLocal(path: string, app?: string) {
  backend.localOpen(path, app).catch((e) => showError(e));
}
