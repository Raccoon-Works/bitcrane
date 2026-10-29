/**
 * Servers as folders in the Windows Explorer (like OneDrive), see
 * `src-tauri/src/mount_win.rs`. Each server with `mountExplorer` gets its own
 * silent connection ("mount:<id>") and a folder under %USERPROFILE%\Bitcrane.
 *
 * The folders follow the server list: switching the option on or off, or
 * removing the server, mounts or unmounts it. When the backend reports that
 * the connection is gone, it is opened again (at most every 20 seconds).
 */
import { listen } from '@tauri-apps/api/event';
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { Server } from '../backend/types';
import { $t } from '../i18n';
import { connectAs } from './live';
import { addLog } from './log';
import { getState, serverById, setState, showToast, subscribeStore } from './store';

interface MountEvent {
  serverId: string;
  kind: 'uploaded' | 'error' | 'connect';
  name: string;
  message: string;
}

const connectionId = (serverId: string) => `mount:${serverId}`;
/** Servers mounted right now, with the settings they were mounted with. */
const mounted = new Map<string, string>();
const busy = new Set<string>();
const lastReconnect = new Map<string, number>();
const lastError = new Map<string, number>();

/** What decides how a server is mounted; a change mounts it again. */
const signature = (srv: Server) => JSON.stringify([srv.name, srv.host, srv.port, srv.user, srv.protocol, srv.remoteStart, srv.smbShare, srv.davPath]);

const errorText = (e: unknown) => (typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e));

/** Starts the Explorer folder of one server. */
async function mount(srv: Server, quiet: boolean): Promise<void> {
  if (busy.has(srv.id)) return;
  busy.add(srv.id);
  try {
    const home = await connectAs(connectionId(srv.id), srv);
    const start = srv.remoteStart && srv.remoteStart.startsWith('/') ? srv.remoteStart : home;
    const folder = await backend.mountStart(connectionId(srv.id), srv.id, srv.name, start);
    mounted.set(srv.id, signature(srv));
    setState((s) => ({ explorerFolders: { ...s.explorerFolders, [srv.id]: folder } }));
    addLog('ok', $t('Im Explorer als Ordner eingebunden: {0}', folder), srv.id);
  } catch (e) {
    const text = $t('{0} konnte nicht im Explorer eingebunden werden: {1}', srv.name, errorText(e));
    addLog('error', text, srv.id);
    if (!quiet) showToast(text, 'error');
  } finally {
    busy.delete(srv.id);
  }
}

/** Takes the folder out of the Explorer; `remove` also deletes the local copies. */
async function unmount(serverId: string, remove: boolean): Promise<void> {
  mounted.delete(serverId);
  const kept = await backend.mountStop(serverId, remove).catch(() => null);
  await backend.disconnect(connectionId(serverId)).catch(() => undefined);
  setState((s) => {
    const next = { ...s.explorerFolders };
    delete next[serverId];
    return { explorerFolders: next };
  });
  if (kept) showToast($t('Der Ordner {0} ist geblieben, weil noch nicht alles hochgeladen war. Du kannst ihn selbst löschen, wenn du ihn nicht mehr brauchst.', kept));
}

/** Brings the mounted folders in line with the server list. */
function reconcile(quiet: boolean) {
  const want = new Map(getState().servers.filter((x) => x.mountExplorer && !x.temporary).map((x) => [x.id, x]));
  for (const id of [...mounted.keys()]) {
    if (!want.has(id)) void unmount(id, true);
  }
  for (const srv of want.values()) {
    if (mounted.get(srv.id) !== signature(srv)) void mount(srv, quiet);
  }
}

/** Switches the Explorer folder of a server on or off (server menu). */
export function setExplorerFolder(serverId: string, on: boolean) {
  setState((s) => ({ servers: s.servers.map((x) => (x.id === serverId ? { ...x, mountExplorer: on || undefined } : x)) }));
}

/** Opens the server's folder in the Explorer. */
export function openExplorerFolder(serverId: string) {
  const folder = getState().explorerFolders[serverId];
  if (folder) void backend.localOpen(folder).catch(() => undefined);
}

/** Windows only: mounts the servers that want it and keeps them in step. */
export async function initMounts() {
  if (getState().platform !== 'win') return;
  await listen<MountEvent>('mount-event', (e) => {
    const ev = e.payload;
    const srv = serverById(ev.serverId);
    if (!srv) return;
    if (ev.kind === 'uploaded') {
      addLog('ok', $t('Aus dem Explorer-Ordner hochgeladen: {0}', ev.name), ev.serverId);
    } else if (ev.kind === 'error') {
      addLog('error', `${ev.name}: ${ev.message}`, ev.serverId);
      // One message per server and minute is enough; details are in the log.
      const now = Date.now();
      if (now - (lastError.get(ev.serverId) ?? 0) > 60_000) {
        lastError.set(ev.serverId, now);
        showToast($t('Explorer-Ordner {0}: {1}', srv.name, `${ev.name}: ${ev.message}`), 'error');
      }
    } else if (ev.kind === 'connect') {
      const now = Date.now();
      if (now - (lastReconnect.get(ev.serverId) ?? 0) < 20_000) return;
      lastReconnect.set(ev.serverId, now);
      void connectAs(connectionId(srv.id), srv).catch((err) => addLog('warn', $t('Explorer-Ordner: keine Verbindung zu {0} ({1})', srv.name, errorText(err)), srv.id));
    }
  });
  reconcile(true);
  let servers = getState().servers;
  subscribeStore(() => {
    const now = getState().servers;
    if (now === servers) return;
    servers = now;
    reconcile(false);
  });
}
