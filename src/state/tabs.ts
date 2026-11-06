/**
 * Tabs and navigation: opening servers, folders and files, history, the two halves.
 */
import { showError } from './errors';

import { tauriBackend as backend } from '../backend/tauriBackend';
import * as live from './live';
import type { PaneSide, Tab, Watch } from '../backend/types';

import * as paths from '../util/paths';
import { $t } from '../i18n';
import {
  setState,
  state,
  LIVE,
  serverById,
  uid,
  linkedStart,
  showToast,
  activeTab,
  openServerIn,
  emptyTab,
  paneLoc,
  isOffline,
  paneShowsServers,
  listEntries,
  panePath,
  paneEntries,
  isDirEntry,
} from './core';
import type { PaneSelection, AppState, TransferRule } from './appState';
import { openDialog } from './panels';
import { deleteServer } from './servers';
import { releaseServers } from './watches';
import { updateSettings } from './settings';
import { openWithDefaultApp, editorFor } from './fileOps';
import { upload, download } from './transfers';

export function clearSelection(): Record<PaneSide, PaneSelection> {
  return { local: { names: [], cursor: -1, anchor: -1 }, remote: { names: [], cursor: -1, anchor: -1 } };
}

export function selectTab(id: string) {
  setState({
    activeTabId: id,
    selection: clearSelection(),
    renaming: null,
    search: '',
    popoverOpen: false,
    expanded: { local: [], remote: [] },
  });
  const t = state.tabs.find((x) => x.id === id);
  if (LIVE && t) {
    if (t.leftServerId && t.serverId) live.autoConnectPair(t.serverId, t.leftServerId);
    else if (t.leftServerId) live.autoConnect(t.leftServerId);
    else if (t.serverId) live.autoConnect(t.serverId);
  }
}

/** Opens a server in a new tab, or switches to its existing tab. */
/** Opens another tab for a server, even when one is already open. */
export function openServerInNewTab(serverId: string) {
  const srv = serverById(serverId);
  if (!srv) return;
  if (srv.openAs === 'terminal' && (!srv.protocol || srv.protocol === 'sftp')) {
    void import('./terminal').then((m) => m.openServerTerminal(serverId));
    return;
  }
  const tab: Tab = {
    id: uid('tab'),
    serverId,
    localPath: srv.localStart || '~',
    remotePath: srv.remoteStart,
    back: [],
    forward: [],
    syncBrowse: linkedStart(srv, srv.remoteStart),
  };
  setState((s) => ({
    tabs: [...s.tabs, tab],
    activeTabId: tab.id,
    selection: clearSelection(),
    firstRun: false,
    contextMenu: null,
  }));
  if (LIVE && !live.isConnected(serverId)) live.connectNow(serverId);
}

/** Asks before removing a saved server; its watches are removed as well. */
export function askRemoveServer(id: string) {
  const srv = serverById(id);
  if (!srv) return;
  const watches = state.watches.filter((w) => w.serverId === id);
  openDialog({
    type: 'confirm',
    danger: true,
    confirm: $t('Entfernen'),
    title: $t('„{0}“ entfernen?', srv.name),
    text: watches.length
      ? watches.length === 1
        ? $t(
            'Auch die Überwachung {0} wird entfernt. Dateien auf dem Server und auf diesem Computer bleiben, wie sie sind.',
            `„${watches[0].name}“`,
          )
        : $t(
            'Auch die {0} Überwachungen {1} werden entfernt. Dateien auf dem Server und auf diesem Computer bleiben, wie sie sind.',
            watches.length,
            watches.map((w) => `„${w.name}“`).join(', '),
          )
      : $t('Dateien auf dem Server und auf diesem Computer bleiben, wie sie sind.'),
    run: () => {
      deleteServer(id);
      setState((s) => ({ watches: s.watches.filter((w) => w.serverId !== id) }));
      showToast($t('„{0}“ entfernt.', srv.name));
    },
  });
}

export function openServer(serverId: string, files = false) {
  // Servers set to open as a terminal (SSH only): a terminal tab instead of the files.
  const target = serverById(serverId);
  if (!files && target?.openAs === 'terminal' && (!target.protocol || target.protocol === 'sftp')) {
    void import('./terminal').then((m) => m.openServerTerminal(serverId));
    return;
  }
  setState((st) => ({ servers: st.servers.map((x) => (x.id === serverId ? { ...x, lastUsed: Date.now() } : x)) }));
  const s = state;
  const existing = s.tabs.find((t) => t.serverId === serverId);
  if (existing) {
    selectTab(existing.id);
    if (LIVE) live.connectNow(serverId);
    return;
  }
  // A tab without a server takes it (like choosing it in that tab's server list).
  const cur = activeTab();
  if (cur && !cur.serverId) {
    openServerIn('remote', serverId);
    return;
  }
  const srv = serverById(serverId);
  if (!srv) return;
  const tab: Tab = {
    id: uid('tab'),
    serverId,
    localPath: srv.localStart || '~',
    remotePath: srv.remoteStart,
    back: [],
    forward: [],
    syncBrowse: linkedStart(srv, srv.remoteStart),
  };
  if (LIVE) {
    setState({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      selection: clearSelection(),
      expanded: { local: [], remote: [] },
      firstRun: false,
    });
    if (!live.isConnected(serverId)) live.connectNow(serverId);
    return;
  }
  setState({
    tabs: [...s.tabs, tab],
    activeTabId: tab.id,
    selection: clearSelection(),
    servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: true } : x)),
  });
  showToast($t('Verbunden mit {0}', srv.name), 'ok');
}

/** "+": a new tab with this computer on the left and the server list on the right. */
export function newTab() {
  const t = activeTab();
  const tab = emptyTab(t && !t.leftServerId ? t.localPath : '~');
  setState((s) => ({
    tabs: [...s.tabs, tab],
    activeTabId: tab.id,
    selection: clearSelection(),
    expanded: { local: [], remote: [] },
    contextMenu: null,
  }));
}

/** Closes a tab; the last one becomes a new, empty tab (like WinSCP). */
export function closeTab(id: string) {
  const s = state;
  const idx = s.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  let tabs = s.tabs.filter((t) => t.id !== id);
  if (!tabs.length) tabs = [emptyTab(s.tabs[idx].leftServerId ? '~' : s.tabs[idx].localPath)];
  const activeTabId = s.activeTabId === id ? tabs[Math.max(0, Math.min(idx - 1, tabs.length - 1))].id : s.activeTabId;
  setState({
    tabs,
    activeTabId,
    selection: s.activeTabId === id ? clearSelection() : s.selection,
    expanded: s.activeTabId === id ? { local: [], remote: [] } : s.expanded,
  });
  releaseServers([s.tabs[idx]]);
}

/** "Andere Tabs schließen" (ForkLift): keeps only the given tab. */
export function closeOtherTabs(id: string) {
  const keep = state.tabs.find((t) => t.id === id);
  if (!keep) return;
  const closed = state.tabs.filter((t) => t.id !== id);
  setState((s) => ({
    tabs: [keep],
    activeTabId: id,
    selection: s.activeTabId === id ? s.selection : clearSelection(),
    contextMenu: null,
  }));
  releaseServers(closed);
}

/** Closes the tabs to the right of the given one. */
export function closeTabsRight(id: string) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tabs = state.tabs.slice(0, idx + 1);
  const closed = state.tabs.slice(idx + 1);
  const activeTabId = tabs.some((t) => t.id === state.activeTabId) ? state.activeTabId : id;
  setState((s) => ({
    tabs,
    activeTabId,
    selection: activeTabId === s.activeTabId ? s.selection : clearSelection(),
    contextMenu: null,
  }));
  releaseServers(closed);
}

/** "Tab duplizieren": the same folders (and server) in a new tab next to it. */
export function duplicateTab(id: string) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  const t = state.tabs[idx];
  if (!t || t.settings) return;
  const copy: Tab = { ...t, id: uid('tab'), back: [], forward: [] };
  setState((s) => ({
    tabs: [...s.tabs.slice(0, idx + 1), copy, ...s.tabs.slice(idx + 1)],
    activeTabId: copy.id,
    selection: clearSelection(),
    contextMenu: null,
  }));
}

export function updateTab(patch: Partial<Tab>) {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, ...patch } : t)) }));
}

/** Navigates one pane to a path and records it for "Zurück". */
export function navigate(side: PaneSide, path: string, record = true) {
  const t = activeTab();
  if (!t) return;
  const [ls, sid] = paneLoc(side, t);
  if (ls === 'remote' && isOffline(sid)) {
    showToast($t('Keine Verbindung zum Server.'), 'error');
    return;
  }
  const current = side === 'local' ? t.localPath : t.remotePath;
  if (current === path) return;
  const patch: Partial<Tab> = side === 'local' ? { localPath: path } : { remotePath: path };
  if (record) {
    patch.back = [...t.back, { side, path: current }];
    patch.forward = [];
  }
  // Synchronized browsing: the other side goes to the matching folder.
  const sb = t.syncBrowse;
  const base = sb ? (side === 'local' ? sb.local : sb.remote) : '';
  let other: PaneSide | null = null;
  if (sb && (path === base || path.startsWith(base === '/' ? '/' : base + '/'))) {
    other = side === 'local' ? 'remote' : 'local';
    const rel = path.slice(base.length).replace(/^\//, '');
    const otherBase = side === 'local' ? sb.remote : sb.local;
    const otherPath = rel ? paths.join(otherBase, rel) : otherBase;
    if (other === 'local') patch.localPath = otherPath;
    else patch.remotePath = otherPath;
  } else if (sb) {
    // Left the shared folders: synchronized browsing ends.
    patch.syncBrowse = undefined;
    showToast($t('Synchron blättern beendet: der Ordner liegt außerhalb der verbundenen Ordner.'));
  }
  updateTab(patch);
  if (ls === 'local') rememberRecentDir(path);
  setState((s) => ({
    selection: {
      ...s.selection,
      [side]: { names: [], cursor: 0, anchor: 0 },
      ...(other ? { [other]: { names: [], cursor: -1, anchor: -1 } } : {}),
    },
    expanded: { ...s.expanded, [side]: [], ...(other ? { [other]: [] } : {}) },
    focusSide: side,
    renaming: null,
  }));
}

/** Folders of this computer opened last, newest first (sidebar "Zuletzt verwendet"). */
function rememberRecentDir(path: string) {
  const cur = state.settings.recentDirs ?? [];
  if (cur[0] === path) return;
  updateSettings({ recentDirs: [path, ...cur.filter((p) => p !== path)].slice(0, 12) });
}

/** "Synchron blättern" on or off for the current tab (starts from the folders shown now). */
export function toggleSyncBrowse() {
  const t = activeTab();
  if (!t) return;
  if (t.syncBrowse) {
    updateTab({ syncBrowse: undefined });
    showToast($t('Synchron blättern aus.'));
  } else {
    updateTab({ syncBrowse: { local: t.localPath, remote: t.remotePath } });
    showToast($t('Synchron blättern an: Ordnerwechsel auf einer Seite gilt auch für die andere.'));
  }
}

export function goBack() {
  const t = activeTab();
  if (!t || !t.back.length) return;
  const last = t.back[t.back.length - 1];
  const current = last.side === 'local' ? t.localPath : t.remotePath;
  updateTab({
    back: t.back.slice(0, -1),
    forward: [...t.forward, { side: last.side, path: current }],
    ...(last.side === 'local' ? { localPath: last.path } : { remotePath: last.path }),
  });
  setState((s) => ({
    selection: { ...s.selection, [last.side]: { names: [], cursor: 0, anchor: 0 } },
    focusSide: last.side,
  }));
}

export function goForward() {
  const t = activeTab();
  if (!t || !t.forward.length) return;
  const next = t.forward[t.forward.length - 1];
  const current = next.side === 'local' ? t.localPath : t.remotePath;
  updateTab({
    forward: t.forward.slice(0, -1),
    back: [...t.back, { side: next.side, path: current }],
    ...(next.side === 'local' ? { localPath: next.path } : { remotePath: next.path }),
  });
}

/** Entries of the folder shown that are hidden by the settings (status line "2 versteckt", like WinSCP). */
export function hiddenCount(side: PaneSide, s: AppState = state): number {
  const t = activeTab(s);
  if (!t || paneShowsServers(side, t)) return 0;
  const list = listEntries(...paneLoc(side, t), panePath(side, s)) ?? [];
  return list.filter(
    (e) =>
      (!s.settings.showSystem && (e.hidden ?? 0) >= 2) ||
      (!s.settings.showHidden && (e.name.startsWith('.') || !!e.hidden)),
  ).length;
}

/**
 * Rule in effect for a server, or for a watch (its own choice, else its server's).
 * Undefined = the general settings.
 */
export function ruleFor(
  serverId: string,
  watchId?: string,
  s: AppState = state,
  useChoice = true,
): TransferRule | undefined {
  const rules = s.settings.rules ?? [];
  // Transfers by hand follow the rule chosen in the activity area (WinSCP "Transfer settings"), if any.
  if (!watchId && useChoice && s.transferRule)
    return s.transferRule === 'none' ? undefined : rules.find((r) => r.id === s.transferRule);
  const w = watchId ? s.watches.find((x) => x.id === watchId) : undefined;
  if (w?.ruleId === 'none') return undefined;
  const id = w?.ruleId ?? s.servers.find((x) => x.id === serverId)?.ruleId;
  return id ? rules.find((r) => r.id === id) : undefined;
}

/** Excludes of a watch together with those of its rule. */
export function watchExcludes(w: Watch, s: AppState = state): string[] {
  const r = ruleFor(w.serverId, w.id, s);
  return r?.excludes.length ? [...new Set([...w.excludes, ...r.excludes])] : w.excludes;
}

/** Adds, changes or removes a rule; servers and watches using a removed rule fall back. */
export function saveRule(rule: TransferRule) {
  setState((s) => {
    const list = s.settings.rules ?? [];
    return {
      settings: {
        ...s.settings,
        rules: list.some((r) => r.id === rule.id) ? list.map((r) => (r.id === rule.id ? rule : r)) : [...list, rule],
      },
    };
  });
}

export function removeRule(id: string) {
  setState((s) => ({
    settings: { ...s.settings, rules: (s.settings.rules ?? []).filter((r) => r.id !== id) },
    servers: s.servers.map((x) => (x.ruleId === id ? { ...x, ruleId: undefined } : x)),
    watches: s.watches.map((w) => (w.ruleId === id ? { ...w, ruleId: undefined } : w)),
  }));
}

export function newRuleId(): string {
  return uid('rule');
}

/** True when the folder shown has a parent to go up to (for the ".." row). */
export function canGoUp(side: PaneSide): boolean {
  const path = panePath(side);
  return !!path && paths.parent(path) !== path;
}

export function goUp(side: PaneSide) {
  const path = panePath(side);
  const up = paths.parent(path);
  if (up !== path) {
    navigate(side, up);
    // Put the cursor on the folder we came from.
    const entries = paneEntries(side);
    const idx = entries.findIndex((e) => e.name === paths.basename(path));
    if (idx >= 0)
      setState((s) => ({
        selection: { ...s.selection, [side]: { names: [entries[idx].name], cursor: idx, anchor: idx } },
      }));
  }
}

/** Opens a folder entry; files are opened "im Editor" (simulated). */
export function openEntry(side: PaneSide, name: string) {
  const path = paths.join(panePath(side), name);
  const t = activeTab();
  if (!t) return;
  const [ls] = paneLoc(side, t);
  if (isDirEntry(...paneLoc(side, t), path)) navigate(side, path);
  // zip and tar on this computer open like a folder (ForkLift); "Mit Standardprogramm öffnen" is in the context menu.
  else if (ls === 'local' && LIVE && paths.isArchiveName(name)) navigate(side, path);
  else if (LIVE) {
    // Local files open with their default program; server files in the editor (uploaded on save).
    if (ls === 'local') live.openLocal(path);
    else openInEditor(side, name);
  } else
    showToast(
      ls === 'local'
        ? $t('„{0}“ wird im Standard-Programm geöffnet.', name)
        : $t('„{0}“ wird geladen und im Editor geöffnet. Änderungen gehen beim Sichern zurück auf den Server.', name),
    );
}

/**
 * Double click, Enter (Windows) or ⌘↓ on a row. Folders open; files do what
 * "Doppelklick auf eine Datei" says (Transmit: open, edit or transfer).
 */
/** Folders the Finder shows as one item (apps, bundles, Photos libraries …). */
const PACKAGE_EXT =
  /\.(app|bundle|framework|plugin|kext|prefPane|saver|appex|xpc|pkg|mpkg|photoslibrary|musiclibrary|tvlibrary|imovielibrary|fcpbundle|rtfd|pages|numbers|key|playground|xcodeproj|xcworkspace|scptd|workflow)$/i;

/** True for a package folder on the Mac's own disk (shown and opened like a file, "Paketinhalt zeigen" goes in). */
export function isPackage(side: PaneSide, entry: { name: string; kind: string }, s: AppState = state): boolean {
  if (s.platform !== 'mac' || entry.kind !== 'dir') return false;
  const t = activeTab(s);
  if (!t || paneLoc(side, t)[0] !== 'local') return false;
  return PACKAGE_EXT.test(entry.name);
}

/** "Paketinhalt zeigen": opens a package folder like a normal folder. */
export function showPackageContents(side: PaneSide, name: string) {
  setState({ contextMenu: null });
  navigate(side, paths.join(panePath(side), name));
}

export function activateEntry(side: PaneSide, name: string) {
  const t = activeTab();
  if (!t) return;
  // A package (app, Photos library …) opens like in the Finder instead of being entered.
  if (isPackage(side, { name, kind: 'dir' }) && isDirEntry(...paneLoc(side, t), paths.join(panePath(side), name))) {
    openWithDefaultApp(side, name);
    return;
  }
  const path = paths.join(panePath(side), name);
  const mode = state.settings.fileDoubleClick;
  if (isDirEntry(...paneLoc(side, t), path) || mode === 'open') {
    openEntry(side, name);
    return;
  }
  if (mode === 'edit') {
    openInEditor(side, name);
    return;
  }
  // Transfer into the folder shown by the other half.
  if (side === 'local') {
    if (!t.serverId) {
      showToast($t('Rechts ist noch kein Server verbunden.'));
      return;
    }
    upload([name]);
  } else download([name]);
}

/** "Im Editor öffnen": local files directly, server files as a working copy that is uploaded on save. */
export function openInEditor(side: PaneSide, name: string) {
  const t = activeTab();
  if (!t) return;
  const path = paths.join(panePath(side), name);
  setState({ contextMenu: null });
  const [ls, sid] = paneLoc(side, t);
  // The built-in editor, unless a program of the system is chosen (in general or for this kind of file).
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  if (state.settings.editorMode !== 'external' && !(ext && state.settings.editorByExt[ext])) {
    void import('./editor').then((m) => m.openFile(ls === 'local' ? '' : sid, path));
    return;
  }
  if (!LIVE) {
    showToast(
      ls === 'local'
        ? $t('„{0}“ wird im Editor geöffnet.', name)
        : $t('„{0}“ wird geladen und im Editor geöffnet. Änderungen gehen beim Sichern zurück auf den Server.', name),
    );
    return;
  }
  if (ls === 'local') live.openLocal(path, editorFor(path));
  else void live.editRemote(sid, path);
}

/** "Terminal öffnen": an SSH session in the server folder, or a local terminal in the local folder. */
export function openTerminal(side: PaneSide = state.focusSide) {
  const t = activeTab();
  const [ls, sid] = paneLoc(side, t);
  const onServer = ls === 'remote';
  const srv = onServer ? serverById(sid) : undefined;
  setState({ contextMenu: null });
  if (onServer && srv?.protocol && srv.protocol !== 'sftp') {
    showToast($t('Ein Terminal auf dem Server gibt es nur bei SFTP-Servern (über SSH).'));
    return;
  }
  if (!LIVE) {
    showToast(
      onServer
        ? $t('Terminal mit {0} wird geöffnet.', srv?.name ?? $t('dem Server'))
        : $t('Terminal im lokalen Ordner wird geöffnet.'),
    );
    return;
  }
  const home = t?.leftServerId ? '~' : panePath('local');
  const target =
    onServer && srv
      ? {
          host: srv.host,
          port: srv.port,
          user: srv.user,
          keyPath: srv.auth === 'key' ? srv.keyPath : undefined,
          remotePath: panePath(side),
          localPath: home,
          app: state.settings.externalTerminal,
        }
      : { localPath: home, app: state.settings.externalTerminal };
  void backend.openTerminal(target).catch((e) => showError(e));
}
