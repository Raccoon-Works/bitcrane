/**
 * Saved servers: adding, editing, grouping, import and export, passwords.
 */

import * as live from './live';
import type { PaneSide, Server } from '../backend/types';
import { isCloudProtocol } from '../backend/types';
import { $t } from '../i18n';
import {
  state,
  setState,
  LIVE,
  showToast,
  serverById,
  uid,
  openServerIn,
  activeTab,
  watchForLocal,
  panePath,
} from './core';
import type { AppState } from './appState';
import { openServer } from './tabs';
import { openDialog } from './panels';
import { updateSettings } from './settings';
import { closePaneServer, simulateLocalChange } from './watches';

export function saveServer(server: Server, connect: boolean) {
  const exists = state.servers.some((x) => x.id === server.id);
  setState((s) => ({
    servers: exists ? s.servers.map((x) => (x.id === server.id ? server : x)) : [...s.servers, server],
    dialog: null,
    firstRun: false,
  }));
  if (connect && LIVE) {
    if (exists) void live.disconnectServer(server.id).then(() => openServer(server.id));
    else openServer(server.id);
  } else if (connect) {
    // Cloud services have no fingerprint to confirm (the prototype connects them at once).
    if (!exists && !isCloudProtocol(server.protocol)) {
      openDialog({
        type: 'fingerprint',
        mode: 'new',
        serverId: server.id,
        key: { host: server.host, algorithm: 'ED25519', fingerprint: fakeFingerprint(server.host) },
      });
    } else openServer(server.id);
  } else showToast($t('„{0}“ gespeichert.', server.name), 'ok');
}

/** Server list drag: puts a server before another one (and into that one's group). */
export function moveServer(id: string, beforeId: string | null, group: string) {
  setState((s) => {
    const moving = s.servers.find((x) => x.id === id);
    if (!moving || id === beforeId) return {};
    const rest = s.servers.filter((x) => x.id !== id);
    const at = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1;
    const moved = { ...moving, group };
    if (at < 0) {
      // Behind the last server of the group (or at the end).
      let last = -1;
      rest.forEach((x, i) => {
        if (!x.temporary && x.group.trim() === group.trim()) last = i;
      });
      return { servers: last < 0 ? [...rest, moved] : [...rest.slice(0, last + 1), moved, ...rest.slice(last + 1)] };
    }
    return { servers: [...rest.slice(0, at), moved, ...rest.slice(at)] };
  });
}

/* Server groups (the folder button at the bottom of the server list, after Transmit). */

/** All group names: those of saved servers plus empty ones created by the user. */
export function serverGroupNames(s: AppState = state): string[] {
  const names = new Set([
    ...s.servers.filter((x) => !x.temporary).map((x) => x.group.trim()),
    ...(s.settings.serverGroups ?? []),
  ]);
  names.delete('');
  return [...names].sort((a, b) => a.localeCompare(b, 'de'));
}

/** "Neue Gruppe": an empty group whose name is edited right away. */
export function addServerGroup() {
  const taken = new Set(serverGroupNames());
  let name = $t('Neue Gruppe');
  for (let i = 2; taken.has(name); i++) name = $t('Neue Gruppe {0}', i);
  updateSettings({ serverGroups: [...(state.settings.serverGroups ?? []), name] });
  setState({ renamingGroup: name, contextMenu: null });
}

/** Renames a group for all its servers; an existing name merges both groups. */
export function renameServerGroup(from: string, to: string) {
  const name = to.trim();
  setState({ renamingGroup: null });
  if (!name || name === from) return;
  setState((s) => ({
    servers: s.servers.map((x) => (x.group.trim() === from ? { ...x, group: name } : x)),
    settings: {
      ...s.settings,
      serverGroups: [...new Set((s.settings.serverGroups ?? []).map((g) => (g === from ? name : g)))],
    },
  }));
}

/** "Gruppe auflösen": the servers stay, just without a group. */
export function removeServerGroup(name: string) {
  setState((s) => ({
    servers: s.servers.map((x) => (x.group.trim() === name ? { ...x, group: '' } : x)),
    settings: { ...s.settings, serverGroups: (s.settings.serverGroups ?? []).filter((g) => g !== name) },
    contextMenu: null,
  }));
}

/** Copy of a server with all settings (not the stored password); opens it for editing. */
export function duplicateServer(id: string) {
  const srv = serverById(id);
  if (!srv) return;
  const copy: Server = {
    ...srv,
    id: uid('srv'),
    name: $t('{0} Kopie', srv.name),
    online: false,
    temporary: false,
    lastUsed: undefined,
    bookmarks: srv.bookmarks?.map((b) => ({ ...b })),
  };
  setState((s) => {
    const at = s.servers.findIndex((x) => x.id === id);
    return { servers: [...s.servers.slice(0, at + 1), copy, ...s.servers.slice(at + 1)], contextMenu: null };
  });
  openDialog({ type: 'serverEdit', serverId: copy.id });
}

/** Keeps a quick connection as a saved server. */
export function keepServer(id: string) {
  const srv = serverById(id);
  if (!srv) return;
  setState((s) => ({
    servers: s.servers.map((x) => (x.id === id ? { ...x, temporary: false } : x)),
    contextMenu: null,
  }));
  showToast($t('„{0}“ gespeichert.', srv.name), 'ok');
}

export function deleteServer(id: string) {
  const removed = serverById(id);
  if (LIVE) {
    void live.disconnectServer(id);
    if (removed)
      void live.forgetSecrets(
        removed,
        state.servers.filter((x) => x.id !== id),
      );
  }
  setState((s) => {
    const servers = s.servers.filter((x) => x.id !== id);
    let tabs = s.tabs
      .filter((t) => t.serverId !== id)
      .map((t) => (t.leftServerId === id ? { ...t, leftServerId: undefined, localPath: '~' } : t));
    // Every tab showed the removed server: open the first remaining one instead.
    if (!tabs.length && servers[0])
      tabs = [
        {
          id: uid('tab'),
          serverId: servers[0].id,
          localPath: servers[0].localStart || '~',
          remotePath: servers[0].remoteStart,
          back: [],
          forward: [],
        },
      ];
    return {
      servers,
      tabs,
      activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : (tabs[0]?.id ?? ''),
    };
  });
}

export function newServerTemplate(): Server {
  const d = state.settings.serverDefaults;
  return {
    id: uid('srv'),
    name: '',
    mono: '',
    color: 'gray',
    host: '',
    port: 22,
    user: '',
    auth: 'auto',
    keyPath: '~/.ssh/id_ed25519',
    group: '',
    localStart: '~',
    remoteStart: '',
    online: false,
    ...d,
    proxy: d.proxy ? { ...d.proxy } : undefined,
  };
}

/** Builds a deterministic, realistic-looking SHA256 host key fingerprint. */
export function fakeFingerprint(host: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let h = 2166136261;
  let out = '';
  for (let i = 0; i < 43; i++) {
    h ^= host.charCodeAt(i % Math.max(1, host.length)) + i * 31;
    h = Math.imul(h, 16777619) >>> 0;
    out += chars[h % 64];
  }
  return 'SHA256:' + out;
}

/** "sftp://user@host:port" from the quick-connect field. */
/**
 * "Schnell verbinden". A password typed into the form is used for this connection;
 * it is kept in the system keychain only when the server is saved ("Zu Servern hinzufügen").
 */
/**
 * Accepts what people type in a terminal as well: "ssh user@host",
 * "ssh -p 2222 user@host" and ssh:// become the usual user@host:port.
 */
export function normalizeSshAddress(address: string): string {
  let a = address.trim().replace(/^ssh:\/\//i, '');
  const cmd = a.match(/^ssh\s+(.*)$/i);
  if (!cmd) return a;
  let port = '';
  const words: string[] = [];
  const parts = cmd[1].trim().split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '-p' && parts[i + 1]) port = parts[++i];
    else if (/^-p\d+$/.test(parts[i])) port = parts[i].slice(2);
    else if (parts[i] === '-l' && parts[i + 1]) words.unshift(`${parts[++i]}@`);
    // Options with a value (key file, jump host, -o …): skipped together with it.
    else if (/^-[bcDEeFIiJLlmOoQRSWw]$/.test(parts[i])) i++;
    else if (!parts[i].startsWith('-')) words.push(parts[i]);
  }
  a = words.join('');
  return port && !/:\d+(\/|$)/.test(a) ? `${a}:${port}` : a;
}

export function quickConnect(
  address: string,
  save: boolean,
  auth: 'auto' | 'key' | 'password' = 'auto',
  side?: PaneSide,
  password?: string,
  openAs?: 'terminal',
) {
  address = normalizeSshAddress(address);
  const typed = address.trim().replace(/^sftp:\/\//, '');
  if (typed)
    setState((s) => ({
      settings: {
        ...s.settings,
        recentAddresses: [typed, ...s.settings.recentAddresses.filter((a) => a !== typed)].slice(0, 8),
      },
    }));
  if (LIVE) {
    void live.quickConnect(address, save, password ? 'password' : auth).then((server) => {
      if (!server) return;
      if (openAs && (!server.protocol || server.protocol === 'sftp')) server = { ...server, openAs };
      setState((s) => ({ servers: [...s.servers, server], dialog: null }));
      if (password) live.presetPassword(server.id, password, save);
      // From the "Schnell verbinden" tab of a half: connect right there.
      if (side && !server.openAs) openServerIn(side, server.id);
      else openServer(server.id);
    });
    return;
  }
  const m = address
    .trim()
    .replace(/^sftp:\/\//, '')
    .match(/^(?:([^@]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/);
  if (!m) {
    showToast($t('Adresse nicht erkannt. Beispiel: ubuntu@server.example:22'), 'error');
    return;
  }
  const [, user = 'ubuntu', host, port = '22', path] = m;
  const server: Server = {
    ...newServerTemplate(),
    name: host,
    mono: host.slice(0, 2).toUpperCase(),
    host,
    user,
    port: Number(port),
    color: 'gray',
    remoteStart: path || `/home/${user}`,
    temporary: !save,
    auth: auth === 'auto' ? 'agent' : auth,
    ...(openAs ? { openAs } : {}),
  };
  setState((s) => ({ servers: [...s.servers, server] }));
  if (side === 'local') {
    openServerIn('local', server.id);
    return;
  }
  openDialog({
    type: 'fingerprint',
    mode: 'new',
    serverId: server.id,
    key: { host, algorithm: 'ED25519', fingerprint: fakeFingerprint(host) },
  });
}

/** Passphrase or password typed by the user in the login prompt. */
/**
 * "Abbrechen" in the password prompt: when the server was just being opened
 * and never connected, its half goes back to the server list instead of
 * staying on "Nicht verbunden" with a tab named after the server.
 */
export function cancelSecret(serverId: string) {
  setState({ dialog: null });
  const t = activeTab();
  const srv = serverById(serverId);
  if (!t || !srv || srv.online) return;
  if (t.serverId === serverId) closePaneServer('remote');
  else if (t.leftServerId === serverId) closePaneServer('local');
}

export function submitSecret(serverId: string, secret: string, save: boolean, kind: 'passphrase' | 'password') {
  setState({ dialog: null });
  live.submitSecret(serverId, secret, save, kind);
}

/** "Befehl nach dem Hochladen jetzt ausführen" for the watch of the current folder. */
export function runWatchCommand() {
  const w = watchForLocal(panePath('local')) ?? state.watches[0];
  if (!w) {
    showToast($t('Für diesen Ordner gibt es keine Überwachung.'));
    return;
  }
  if (LIVE) live.runCommandNow(w.id);
  else simulateLocalChange(w.id);
}

export function trustHostKey(serverId: string) {
  const d = state.dialog;
  setState({ dialog: null });
  if (LIVE) {
    if (d?.type === 'fingerprint') live.trustAndConnect(serverId, d.key.fingerprint);
    return;
  }
  openServer(serverId);
}

export function rejectHostKey(serverId: string) {
  const temp = serverById(serverId)?.temporary;
  setState((s) => ({ dialog: null, servers: s.servers.filter((x) => !(x.id === serverId && x.temporary)) }));
  if (temp) {
    // Close the tab the temporary server was opened in.
    setState((s) => {
      const tabs = s.tabs.filter((t) => t.serverId !== serverId);
      return { tabs, activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : (tabs[0]?.id ?? '') };
    });
  }
  showToast($t('Nicht verbunden.'));
}

/** Scenario: the server's host key changed since the last connection. */
export function simulateChangedHostKey() {
  const srv = serverById(activeTab()?.serverId ?? 'ob');
  if (!srv) return;
  openDialog({
    type: 'fingerprint',
    mode: 'changed',
    serverId: srv.id,
    key: {
      host: srv.host,
      algorithm: 'ED25519',
      fingerprint: fakeFingerprint(srv.host + 'neu'),
      previous: fakeFingerprint(srv.host),
    },
  });
}
