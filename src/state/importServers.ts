/**
 * Servers from other programs: finding those saved in FileZilla, WinSCP,
 * Cyberduck, PuTTY and the SSH configuration, reading an exported file and
 * taking the chosen ones over. The browser prototype offers invented ones.
 */
import type { ImportedServer } from '../backend/api';
import { tauriBackend as backend } from '../backend/tauriBackend';
import { chooseFile } from '../backend/dialogs';
import type { Server } from '../backend/types';
import { $t } from '../i18n';
import { activeTab, getState, LIVE, setState, showToast, uid } from './core';
import { DEMO_IMPORT_FILE, DEMO_IMPORTS, sampleServers } from './demoData';
import { openDialog } from './panels';
import { monoFor } from './servers';
import { openServerIn } from './tabs';

/**
 * Same server = same protocol, user, host, port and key file; host and user
 * without regard to case (two entries with different keys are kept).
 */
export const serverKey = (s: {
  host: string;
  port: number;
  user: string;
  protocol?: string;
  keyPath?: string;
  auth?: string;
}) =>
  `${s.protocol ?? 'sftp'}|${s.user.toLowerCase()}@${s.host.toLowerCase()}:${s.port}|${s.auth === 'key' ? (s.keyPath ?? '') : ''}`;

/** The servers saved in other programs on this computer, and the programs they come from. */
export function findImportable(): Promise<{ servers: ImportedServer[]; sources: string[] }> {
  return LIVE ? backend.importFind() : Promise.resolve(DEMO_IMPORTS);
}

/** Lets the user pick an exported server file and reads it; null when cancelled. */
export async function readImportFile(): Promise<ImportedServer[] | null> {
  if (!LIVE) return [DEMO_IMPORT_FILE];
  const path = await chooseFile($t('Exportierte Server wählen'), {
    filters: [
      { name: $t('Server-Export'), extensions: ['transmitservers', 'xml', 'ini', 'duck', 'json'] },
      { name: $t('Alle Dateien'), extensions: ['*'] },
    ],
  });
  return path ? backend.importFile(path) : null;
}

/** Adds servers found in other programs (from the import window). */
export function importServers(list: ImportedServer[]) {
  // No colour (it is optional, see ServerTile); servers already there, or twice in the list, are skipped.
  const seen = new Set(
    getState()
      .servers.filter((x) => !x.temporary)
      .map(serverKey),
  );
  list = list.filter((s) => {
    const k = serverKey(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!list.length) {
    setState({ dialog: null });
    showToast($t('Diese Server sind schon vorhanden.'));
    return;
  }
  const created: Server[] = list.map((s) => ({
    id: uid('srv'),
    name: s.name,
    mono: monoFor(s.name),
    color: 'gray',
    host: s.host,
    port: s.port,
    user: s.user,
    auth: s.protocol === 'sftp' ? s.auth : 'password',
    keyPath: s.keyPath ?? '~/.ssh/id_ed25519',
    group: s.group,
    localStart: s.localDir ?? '~',
    remoteStart: s.remoteDir ?? '',
    online: false,
    protocol: s.protocol,
    implicitTls: s.implicitTls || undefined,
    // WebDAV from Cyberduck: plain http only on port 80.
    ...(s.protocol === 'webdav' ? { davHttps: s.port !== 80 } : {}),
  }));
  // ProxyJump names refer to other entries of the SSH configuration.
  const all = [...getState().servers, ...created];
  list.forEach((s, i) => {
    if (!s.jump) return;
    const j = all.find((x) => x.name === s.jump || x.host === s.jump);
    if (j && j.id !== created[i].id) created[i].jumpServerId = j.id;
  });
  // Offered on the first start: the servers only go into the list; connecting stays the user's choice.
  const dialog = getState().dialog;
  const firstStart = dialog?.type === 'import' && !!dialog.firstStart;
  setState((st) => ({ servers: [...st.servers, ...created], dialog: null, firstRun: false }));
  showToast(
    created.length === 1 ? $t('„{0}“ übernommen.', created[0].name) : $t('{0} Server übernommen.', created.length),
    'ok',
  );
  const t = activeTab();
  if (!firstStart && (!t || !t.serverId) && created[0]) openServerIn('remote', created[0].id);
}

/** Adds the SSH-config servers on the welcome screen. */
export function importSshConfig() {
  if (LIVE) {
    openDialog({ type: 'import' });
    return;
  }
  const servers = sampleServers()
    .slice(0, 3)
    .map((x) => ({ ...x, online: false }));
  setState({ servers, firstRun: false });
  showToast($t('3 Server aus der SSH-Konfiguration übernommen.'), 'ok');
}
