/**
 * SSH tunnels (port forwarding) of a server, run by src-tauri/src/forward.rs.
 * Which tunnels a server has is part of the server (Server.forwards); which
 * are running right now is `tunnels` in the store. Tunnels use the server's
 * open connection and end when it is closed.
 */
import { invoke } from '@tauri-apps/api/core';
import type { PortForward } from '../backend/types';
import { $t } from '../i18n';
import { addLog } from './log';
import { getState, LIVE, serverById, setState, showToast } from './store';

/** Short description, e.g. "localhost:5433 → db:5432" or "SOCKS localhost:1080". */
export function describeForward(f: PortForward): string {
  const bind = `${f.bindHost === '127.0.0.1' ? 'localhost' : f.bindHost}:${f.bindPort}`;
  if (f.kind === 'dynamic') return `SOCKS ${bind}`;
  const dest = `${f.destHost}:${f.destPort}`;
  return f.kind === 'local' ? `${bind} → ${dest}` : `${$t('Server')} ${bind} → ${dest}`;
}

export async function refreshForwards() {
  if (!LIVE) return;
  const ids = await invoke<string[]>('forward_active').catch(() => []);
  setState({ tunnels: ids });
}

export async function startForward(serverId: string, f: PortForward): Promise<boolean> {
  const srv = serverById(serverId);
  if (!LIVE) {
    setState((s) => ({ tunnels: [...s.tunnels.filter((x) => x !== f.id), f.id] }));
    return true;
  }
  try {
    await invoke('forward_start', { serverId, spec: { id: f.id, kind: f.kind, bindHost: f.bindHost, bindPort: f.bindPort, destHost: f.destHost, destPort: f.destPort } });
    addLog('ok', $t('Tunnel gestartet: {0}', describeForward(f)), serverId);
    return true;
  } catch (e) {
    const msg = (e as { message?: string }).message ?? String(e);
    addLog('error', $t('Tunnel {0}: {1}', describeForward(f), msg), serverId);
    showToast($t('Tunnel von {0}: {1}', srv?.name ?? '', msg), 'error');
    return false;
  } finally {
    await refreshForwards();
  }
}

export async function stopForward(f: PortForward) {
  if (LIVE) await invoke('forward_stop', { id: f.id }).catch(() => undefined);
  setState((s) => ({ tunnels: s.tunnels.filter((x) => x !== f.id) }));
  await refreshForwards();
}

/** After connecting: the tunnels marked "beim Verbinden starten". */
export async function startAutoForwards(serverId: string) {
  const list = serverById(serverId)?.forwards?.filter((f) => f.auto) ?? [];
  for (const f of list) if (!getState().tunnels.includes(f.id)) await startForward(serverId, f);
}
