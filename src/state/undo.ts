/**
 * Undo of file operations (rename, move, delete to the trash, new folders).
 */
import { showError } from './errors';

import { invoke } from '@tauri-apps/api/core';
import * as fs from '../backend/mockFs';
import * as live from './live';
import type { PaneSide, Server, Watch } from '../backend/types';

import * as paths from '../util/paths';
import { seal, unseal, type Sealed } from '../util/crypto';
import { $t } from '../i18n';
import { showToast, LIVE, setState, activeTab, panePath, paneLoc, state, type Settings, setLeftServer } from './core';
import { openDialog, closeDialog } from './panels';
import { openServer, navigate, updateTab, clearSelection } from './tabs';
import { editPath } from './fileOps';

/**
 * "Widerrufen" for file actions (ForkLift): renaming, moving on this computer
 * and new files and folders can be taken back with ⌘Z / Ctrl+Z, the last one
 * first. Deleting is not on the list: on this computer it goes to the trash
 * (put back from there), on a server it is final and asked for beforehand.
 */
interface UndoEntry { label: string; run: () => Promise<unknown> | void }
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
  void Promise.resolve(e.run()).then((ok) => { if (ok !== false) showToast($t('Widerrufen: {0}', e.label), 'ok'); });
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
      for (const [from, to] of pairs) if (await live.renameEntry(...loc, dir, from, to)) { ok++; done.push([from, to]); }
      if (done.length) pushUndo({ label: $t('{0} Objekte umbenannt', done.length), run: async () => { for (const [from, to] of [...done].reverse()) await renameAt(...loc, dir, to, from); } });
      showToast(ok === pairs.length ? $t('{0} Objekte umbenannt.', ok) : $t('{0} von {1} umbenannt.', ok, pairs.length), ok === pairs.length ? 'ok' : 'error');
      if (state.activeTabId === t.id && panePath(side) === dir) setState((s) => ({ selection: { ...s.selection, [side]: { names: pairs.map((p) => p[1]), cursor: -1, anchor: -1 } } }));
    })();
    return;
  }
  for (const [from, to] of pairs) fs.rename(...paneLoc(side, t), paths.join(dir, from), to);
  const loc = paneLoc(side, t);
  pushUndo({ label: $t('{0} Objekte umbenannt', pairs.length), run: async () => { for (const [from, to] of [...pairs].reverse()) await renameAt(...loc, dir, to, from); } });
  setState((s) => ({ fsRev: s.fsRev + 1, selection: { ...s.selection, [side]: { names: pairs.map((p) => p[1]), cursor: -1, anchor: -1 } } }));
  showToast($t('{0} Objekte umbenannt.', pairs.length), 'ok');
}

/** Contents of an export file ("Einstellungen exportieren"). */
interface ExportFile {
  format: 'bitcrane-export';
  version: 1 | 2;
  servers?: Server[];
  watches?: Watch[];
  settings?: Partial<Settings>;
  /** Version 2, encrypted: the payload above (plus secrets) sealed with a password. */
  encrypted?: Sealed;
  /** Only inside an encrypted file: keychain entries (account -> secret). */
  secrets?: Record<string, string>;
}

/** "Server und Überwachungen exportieren …": asks for the options first. */
export function exportConfig() {
  openDialog({ type: 'exportConfig' });
}

/** Writes the export file; with a password it is encrypted and may carry the stored secrets. */
export async function writeExport(password: string, withSecrets: boolean): Promise<boolean> {
  const servers = state.servers.filter((x) => !x.temporary).map((x) => ({ ...x, online: false }));
  const payload: ExportFile = { format: 'bitcrane-export', version: 1, servers, watches: state.watches, settings: { ...state.settings } };
  if (!LIVE) {
    showToast($t('Export: {0} Server und {1} Überwachungen{2} (im Prototyp nicht gespeichert).', servers.length, state.watches.length, password ? $t(', verschlüsselt') : ''));
    return true;
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({ title: $t('Exportieren'), defaultPath: password ? 'bitcrane-export-verschluesselt.json' : 'bitcrane-export.json', filters: [{ name: 'Bitcrane', extensions: ['json'] }] }).catch(() => null);
  if (!path) return false;
  try {
    let file: ExportFile = payload;
    let secretCount = 0;
    if (password) {
      const secrets = withSecrets ? await live.collectSecrets(servers) : undefined;
      secretCount = secrets ? Object.keys(secrets).length : 0;
      file = { format: 'bitcrane-export', version: 2, encrypted: await seal(JSON.stringify({ ...payload, secrets }), password) };
    }
    await invoke('file_write', { path, text: JSON.stringify(file, null, 2) });
    showToast($t('Exportiert: {0} Server, {1} Überwachungen{2}.', servers.length, state.watches.length, password ? $t(', verschlüsselt{0}', secretCount ? $t(' mit {0} Passwörtern', secretCount) : '') : $t('. Passwörter sind nicht enthalten')), 'ok');
    return true;
  } catch (e) {
    showError(e);
    return false;
  }
}

/** "… importieren": adds servers and watches from an export file (same entries are replaced). */
export async function importConfig() {
  if (!LIVE) {
    showToast($t('Import einer Exportdatei geht im echten Programm.'));
    return;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({ title: $t('Importieren'), multiple: false, directory: false, filters: [{ name: 'Bitcrane', extensions: ['json'] }] }).catch(() => null);
  if (typeof path !== 'string') return;
  try {
    const data = JSON.parse(await invoke<string>('file_read', { path })) as ExportFile;
    if (data.format !== 'bitcrane-export') throw new Error($t('Das ist keine Exportdatei von Bitcrane.'));
    if (data.encrypted) openDialog({ type: 'importPassword', sealed: data.encrypted });
    else await applyImport(data);
  } catch (e) {
    showError(e);
  }
}

/** Decrypts an encrypted export; false when the password is wrong. */
export async function importSealed(sealed: Sealed, password: string): Promise<boolean> {
  let data: ExportFile;
  try {
    data = JSON.parse(await unseal(sealed, password)) as ExportFile;
  } catch {
    return false;
  }
  closeDialog();
  await applyImport(data);
  return true;
}

/** Same connection = same protocol, user, address and port (used to avoid duplicates on import). */
function connectionKey(x: { host: string; port: number; user: string; protocol?: string }) {
  return `${x.protocol ?? 'sftp'}|${x.user.toLowerCase()}@${x.host.toLowerCase()}:${x.port}`;
}

async function applyImport(data: ExportFile) {
  const merge = <T extends { id: string }>(cur: T[], add: T[]) => [...cur.filter((x) => !add.some((a) => a.id === x.id)), ...add];
  // A server that already exists here under another id (same connection) is not added twice;
  // watches of the imported copy are pointed at the existing server instead.
  const existing = new Map(state.servers.filter((x) => !x.temporary).map((x) => [connectionKey(x), x.id]));
  const remap = new Map<string, string>();
  const servers = (data.servers ?? []).filter((x) => {
    const have = existing.get(connectionKey(x));
    if (have && have !== x.id) { remap.set(x.id, have); return false; }
    return true;
  });
  const watches = (data.watches ?? []).map((w) => (remap.has(w.serverId) ? { ...w, serverId: remap.get(w.serverId)! } : w));
  setState((s) => ({
    servers: merge(s.servers, servers.map((x) => ({ ...x, online: false }))),
    watches: merge(s.watches, watches),
    settings: data.settings ? { ...s.settings, ...data.settings } : s.settings,
    firstRun: false,
  }));
  const restored = data.secrets ? await live.restoreSecrets(data.secrets) : 0;
  showToast($t('Importiert: {0} Server, {1} Überwachungen{2}.', servers.length, data.watches?.length ?? 0, restored ? $t(', {0} Passwörter im {1}', restored, state.platform === 'mac' ? $t('Schlüsselbund') : $t('Anmeldespeicher')) : ''), 'ok');
  if (!state.tabs.length && state.servers[0]) openServer(state.servers[0].id, true);
}

/** Opens a local place from the sidebar ("Projekte", "Downloads"). */
/**
 * "Anderer Ordner …" in the location menu: any folder of this computer, chosen
 * in the system's folder dialog (in the prototype the path field opens instead).
 */
export async function pickLocalFolder(side: PaneSide = 'local') {
  setState({ contextMenu: null });
  if (!LIVE) {
    editPath(side);
    return;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title: $t('Ordner öffnen') }).catch(() => null);
  if (typeof picked !== 'string') return;
  const path = await invoke<string>('path_to_ui', { path: picked });
  if (side === 'local' && activeTab()?.leftServerId) setLeftServer('');
  navigate(side, path);
}

export function openPlace(path: string) {
  // Places are on this computer: leave server-to-server mode first.
  if (activeTab()?.leftServerId) setLeftServer('');
  navigate('local', path);
}

/** Opens a watch's folders in the current tab. */
export function openWatchFolders(watchId: string) {
  const w = state.watches.find((x) => x.id === watchId);
  if (!w) return;
  const t = activeTab();
  if (t && t.serverId !== w.serverId) openServer(w.serverId, true);
  updateTab({ leftServerId: undefined, localPath: w.localPath, remotePath: w.remotePath });
  setState({ selection: clearSelection(), popoverOpen: false });
}
