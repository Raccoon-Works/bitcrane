/**
 * "Server und Überwachungen exportieren / importieren": the export file, plain or sealed with a
 * password (then only the Rust core opens it, src-tauri/src/commands/secrets.rs).
 */
import { showError } from './errors';
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { Sealed } from '../backend/api';
import { chooseFile, chooseSaveTarget } from '../backend/dialogs';
import type { Server, Watch } from '../backend/types';
import { $t } from '../i18n';
import { showToast, LIVE, setState, getState } from './core';
import type { Settings } from './appState';
import { openDialog, closeDialog } from './panels';
import { openServer } from './tabs';
import { isRecord, isServerEntry, watchEntry } from './entries';

/** Contents of an export file ("Einstellungen exportieren"). */
interface ExportFile {
  format: 'bitcrane-export';
  version: 1 | 2;
  servers?: Server[];
  watches?: Watch[];
  settings?: Partial<Settings>;
  /**
   * Version 2, encrypted: the payload above sealed with a password, with the stored secrets of
   * its servers inside if wanted. Only the core opens it (src-tauri/src/commands/secrets.rs).
   */
  encrypted?: Sealed;
}

/** "Server und Überwachungen exportieren …": asks for the options first. */
export function exportConfig() {
  openDialog({ type: 'exportConfig' });
}

/** Writes the export file; with a password it is encrypted and may carry the stored secrets. */
export async function writeExport(password: string, withSecrets: boolean): Promise<boolean> {
  const servers = getState()
    .servers.filter((x) => !x.temporary)
    .map((x) => ({ ...x, online: false }));
  const payload: ExportFile = {
    format: 'bitcrane-export',
    version: 1,
    servers,
    watches: getState().watches,
    settings: { ...getState().settings },
  };
  if (!LIVE) {
    showToast(
      $t(
        'Export: {0} Server und {1} Überwachungen{2} (im Prototyp nicht gespeichert).',
        servers.length,
        getState().watches.length,
        password ? $t(', verschlüsselt') : '',
      ),
    );
    return true;
  }
  const path = await chooseSaveTarget(
    $t('Exportieren'),
    password ? 'bitcrane-export-verschluesselt.json' : 'bitcrane-export.json',
    [{ name: 'Bitcrane', extensions: ['json'] }],
  );
  if (!path) return false;
  try {
    let file: ExportFile = payload;
    let secretCount = 0;
    if (password) {
      const sealed = await backend.exportSeal(payload, password, withSecrets);
      secretCount = sealed.secrets;
      file = { format: 'bitcrane-export', version: 2, encrypted: sealed.encrypted };
    }
    await backend.fileWrite(path, JSON.stringify(file, null, 2));
    showToast(
      $t(
        'Exportiert: {0} Server, {1} Überwachungen{2}.',
        servers.length,
        getState().watches.length,
        password
          ? $t(', verschlüsselt{0}', secretCount ? $t(' mit {0} Passwörtern', secretCount) : '')
          : $t('. Passwörter sind nicht enthalten'),
      ),
      'ok',
    );
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
  const path = await chooseFile($t('Importieren'), { filters: [{ name: 'Bitcrane', extensions: ['json'] }] });
  if (!path) return;
  try {
    const data = JSON.parse(await backend.fileRead(path)) as ExportFile;
    if (data.format !== 'bitcrane-export') throw new Error($t('Das ist keine Exportdatei von Bitcrane.'));
    if (data.encrypted) openDialog({ type: 'importPassword', sealed: data.encrypted });
    else await applyImport(data, 0);
  } catch (e) {
    showError(e);
  }
}

/** Decrypts an encrypted export; false when the password is wrong. */
export async function importSealed(sealed: Sealed, password: string): Promise<boolean> {
  const opened = await backend.importUnseal(sealed, password);
  if (!opened) return false;
  closeDialog();
  await applyImport(opened.data as ExportFile, opened.restored);
  return true;
}

/** Same connection = same protocol, user, address and port (used to avoid duplicates on import). */
function connectionKey(x: { host: string; port: number; user: string; protocol?: string }) {
  return `${x.protocol ?? 'sftp'}|${x.user.toLowerCase()}@${x.host.toLowerCase()}:${x.port}`;
}

/** Takes over the servers, watches and settings of an export file; `restored` secrets went to the keychain. */
async function applyImport(data: ExportFile, restored: number) {
  const merge = <T extends { id: string }>(cur: T[], add: T[]) => [
    ...cur.filter((x) => !add.some((a) => a.id === x.id)),
    ...add,
  ];
  // A server that already exists here under another id (same connection) is not added twice;
  // watches of the imported copy are pointed at the existing server instead.
  const existing = new Map(
    getState()
      .servers.filter((x) => !x.temporary)
      .map((x) => [connectionKey(x), x.id]),
  );
  const remap = new Map<string, string>();
  // The file is outside input: entries without the fields Bitcrane relies on are left out.
  const servers = (Array.isArray(data.servers) ? data.servers : []).filter(isServerEntry).filter((x) => {
    const have = existing.get(connectionKey(x));
    if (have && have !== x.id) {
      remap.set(x.id, have);
      return false;
    }
    return true;
  });
  const watches = (Array.isArray(data.watches) ? data.watches : [])
    .map(watchEntry)
    .filter((w): w is Watch => !!w)
    .map((w) => (remap.has(w.serverId) ? { ...w, serverId: remap.get(w.serverId)! } : w));
  setState((s) => ({
    servers: merge(
      s.servers,
      servers.map((x) => ({ ...x, online: false })),
    ),
    watches: merge(s.watches, watches),
    settings: isRecord(data.settings) ? { ...s.settings, ...data.settings } : s.settings,
    firstRun: false,
  }));
  showToast(
    $t(
      'Importiert: {0} Server, {1} Überwachungen{2}.',
      servers.length,
      watches.length,
      restored
        ? $t(
            ', {0} Passwörter im {1}',
            restored,
            getState().platform === 'mac' ? $t('Schlüsselbund') : $t('Anmeldespeicher'),
          )
        : '',
    ),
    'ok',
  );
  if (!getState().tabs.length && getState().servers[0]) openServer(getState().servers[0].id, true);
}
