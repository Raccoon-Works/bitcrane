/**
 * Connecting and disconnecting servers from the interface: reconnect, disconnect, and closing the
 * connections no tab or watch uses any more.
 */
import * as live from './live';
import type { KnownHost } from '../backend/api';
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { PaneSide, Tab } from '../backend/types';
import { DEMO_KNOWN_HOSTS } from './demoData';
import { $t } from '../i18n';
import { setState, showToast, LIVE, activeTab, paneLoc, getState, emptySelection } from './core';
import { updateTab, setLeftServer } from './tabs';

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
  const s = getState();
  if (s.tabs.some((x) => x.serverId === sid || x.leftServerId === sid)) return true;
  if (s.watches.some((w) => w.serverId === sid && w.state !== 'paused')) return true;
  if (
    s.transfers.some(
      (t) => (t.serverId === sid || t.sourceServerId === sid) && (t.state === 'queued' || t.state === 'running'),
    )
  )
    return true;
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
    if (!getState().servers.find((x) => x.id === sid)?.online) continue;
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
    updateTab({
      serverId: '',
      remotePath: '',
      back: [],
      forward: [],
      syncBrowse: undefined,
      serverList: { ...t.serverList, remote: true },
    });
    setState((s) => ({
      selection: { ...s.selection, remote: emptySelection() },
      expanded: { ...s.expanded, remote: [] },
    }));
  }
  if (!serverStillUsed(sid)) disconnect(sid);
}

/** The prototype's stored fingerprints, so "Vergessen" can take them away. */
let demoKnownHosts = DEMO_KNOWN_HOSTS;

/** Stored host key fingerprints ("host:port"). */
export function knownHosts(): Promise<KnownHost[]> {
  return LIVE ? backend.knownHostsList() : Promise.resolve(demoKnownHosts);
}

/** Forgets a stored fingerprint: the next connection to that host asks again. */
export async function forgetKnownHost(host: string) {
  if (LIVE) await backend.knownHostsRemove(host);
  else demoKnownHosts = demoKnownHosts.filter((x) => x.host !== host);
}

/** Answers the questions of a keyboard-interactive login (null: cancelled). */
export function answerAuthPrompt(id: string, answers: string[] | null) {
  void backend.authPromptAnswer(id, answers);
}
