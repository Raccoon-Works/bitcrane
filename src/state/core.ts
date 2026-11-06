/**
 * The store of the Bitcrane user interface: the initial state, the plumbing
 * (a small external store with subscribe/getSnapshot, consumed through
 * `useStore`), the helpers that derive values from the state, and toasts.
 * The state's shape is in appState.ts; the user actions live in one module
 * per area (see store.ts).
 *
 * In the browser prototype every action talks to the mock file systems in
 * `backend/mockFs.ts` and a timer simulates transfer progress, connection
 * drops and folder watch events. In the app (`LIVE`), actions delegate to
 * `live.ts`, which calls the Rust core and receives progress through events.
 */
import { useSyncExternalStore } from 'react';
import { isTauri } from '../backend/api';
import * as fs from '../backend/mockFs';
import * as live from './live';
import type { FileEntry, PaneSide, Server, Tab, Watch } from '../backend/types';
import { describeFile } from '../util/format';
import * as paths from '../util/paths';
import { $t, LANG } from '../i18n';
import type { AppState, SidebarSection, SortKey, ViewMode } from './appState';
import { defaultToolbar, detectPlatform, detectTheme } from './defaults';
import { sampleServers, sampleTransfers, sampleWatches } from './demoData';
import { updateTab } from './tabs';
import { closePaneServer } from './watches';
import { updateSettings } from './settings';

/** True inside the desktop app: real files and real servers instead of the demo data. */
export const LIVE = isTauri;

export function initialState(): AppState {
  const servers = LIVE ? [] : sampleServers();
  return {
    platform: detectPlatform(),
    terminals: [],
    tunnels: [],
    explorerFolders: {},
    theme: detectTheme(),
    palette: 'auto',
    firstRun: false,
    servers,
    tabs: LIVE
      ? []
      : [
          {
            id: 'tab1',
            serverId: 'ob',
            localPath: servers[0].localStart,
            remotePath: servers[0].remoteStart,
            back: [],
            forward: [],
          },
          { id: 'tab2', serverId: '', localPath: '~', remotePath: '', back: [], forward: [] },
        ],
    activeTabId: LIVE ? '' : 'tab1',
    watches: LIVE ? [] : sampleWatches(),
    transfers: LIVE ? [] : sampleTransfers(),
    selection: LIVE
      ? { local: { names: [], cursor: -1, anchor: -1 }, remote: { names: [], cursor: -1, anchor: -1 } }
      : { local: { names: ['app.py'], cursor: 3, anchor: 3 }, remote: { names: [], cursor: -1, anchor: -1 } },
    focusSide: 'local',
    inspectorOpen: false,
    activityOpen: false,
    activityFilter: 'all',
    compareDirs: false,
    afterQueue: 'none',
    transferRule: '',
    cloudAvailable: { dropbox: !LIVE, onedrive: !LIVE },
    popoverOpen: false,
    menuBarWindowOpen: false,
    appMenu: null,
    dialog: null,
    contextMenu: null,
    renaming: null,
    renamingGroup: null,
    pathEdit: null,
    folderSizes: {},
    edits: [],
    clipboard: null,
    search: '',
    searchSide: 'local',
    deepSearchOn: false,
    searchContent: false,
    deepSearch: null,
    toolbar: [...defaultToolbar],
    toolbarLabels: 'icons',
    settings: {
      runInBackground: true,
      showMenuBarIcon: true,
      startAtLogin: false,
      defaultDelay: 2,
      defaultExcludes: ['.git', '__pycache__', '.DS_Store', '*.log', '*.tmp'],
      defaultMirrorDeletes: false,
      notify: 'errors',
      soundOnError: true,
      soundOnDone: false,
      dockProgress: true,
      themeSetting: 'system',
      showHidden: true,
      confirmDelete: true,
      parallel: 2,
      language: LANG,
      startLocal: '~',
      startServer: '',
      fileDoubleClick: 'open',
      uploadFilePerms: '',
      uploadDirPerms: '',
      cloudAsked: false,
      serverGroups: [],
      splitRatio: 0.5,
      serverSourcesWidth: 200,
      activityHeight: 240,
      uploadTempName: true,
      keepMtime: true,
      existingFiles: 'ask',
      existingDownload: 'ask',
      bandwidthLimit: 0,
      autoRetry: true,
      updateMode: 'auto',
      skipUnchanged: true,
      skipPatterns: ['.DS_Store', 'Thumbs.db', 'desktop.ini'],
      skipLargerMb: 0,
      // The prototype shows one example rule, used by "Webshop · Live".
      rules: LIVE
        ? []
        : [
            {
              id: 'rule-app',
              name: 'Python-App',
              excludes: ['venv', '__pycache__', '*.log', '.git'],
              filePerms: '644',
              dirPerms: '755',
              existingUp: 'overwrite',
              keepOldVersion: true,
            },
          ],
      autoReconnect: true,
      keepAlive: true,
      readSshConfig: true,
      writeLog: false,
      watchTemplates: [],
      showPerms: false,
      sort: { local: { key: 'name', dir: 1 }, remote: { key: 'name', dir: 1 } },
      swapSides: false,
      editorApp: '',
      editorByExt: {},
      shortcuts: {},
      columns: { mtime: true, size: true },
      logLevel: 'normal',
      recentAddresses: [],
      serverDefaults: {},
      syncFavorites: [],
      sftpLinks: false,
      viewMode: { local: 'list', remote: 'list' },
    },
    offline: {},
    conflicts: [],
    fsRev: 0,
    now: Date.now(),
    toast: null,
    speed: 0,
    drives: [],
    places: [
      { name: 'Alex', path: '~' },
      { name: 'Projekte', path: '~/Projekte' },
      { name: 'Schreibtisch', path: '~/Schreibtisch' },
      { name: 'Downloads', path: '~/Downloads' },
    ],
    homeName: 'Alex',
    update: null,
    dropHint: null,
    expanded: { local: [], remote: [] },
  };
}

/* ------------------------------------------------------------------------ */
/* Store plumbing                                                           */
/* ------------------------------------------------------------------------ */

let state: AppState = initialState();
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

/** Replaces parts of the state and notifies subscribers. */
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function subscribeStore(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** React hook: selects a slice of the state and re-renders when it changes. */
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribeStore, () => selector(state));
}

let idCounter = 0;
export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

/* ------------------------------------------------------------------------ */
/* Derived helpers                                                          */
/* ------------------------------------------------------------------------ */

export function activeTab(s: AppState = state): Tab | undefined {
  return s.tabs.find((t) => t.id === s.activeTabId);
}

export function serverById(id: string, s: AppState = state): Server | undefined {
  return s.servers.find((x) => x.id === id);
}

/** Path shown by a pane of the active tab. */
export function panePath(side: PaneSide, s: AppState = state): string {
  const t = activeTab(s);
  if (!t) return side === 'local' ? '~' : '/';
  return side === 'local' ? t.localPath : t.remotePath;
}

/**
 * Where a pane's files are, as [side for file operations, server id]. The
 * right half always shows the tab's server. The left half shows this computer,
 * or in server-to-server mode a second server and then behaves like a server pane.
 */
export function paneLoc(side: PaneSide, t: Tab | undefined = activeTab()): [PaneSide, string] {
  if (!t) return [side, ''];
  if (side === 'local' && t.leftServerId) return ['remote', t.leftServerId];
  if (side === 'remote' && t.rightLocal && !t.serverId) return ['local', ''];
  return [side, t.serverId];
}

/**
 * True when a half shows the server list instead of files (Transmit's
 * connection panel): the right half while the tab has no server yet, or
 * either half after the user switched it there.
 */
export function paneShowsServers(side: PaneSide, t: Tab | undefined = activeTab()): boolean {
  if (!t) return side === 'remote';
  if (side === 'remote' && !t.serverId && !t.rightLocal) return true;
  return !!t.serverList?.[side];
}

/** Switches a half between its files and the server list. */
export function setPaneServerList(side: PaneSide, on: boolean) {
  const t = activeTab();
  if (!t) return;
  // Without a server the right half has no files to go back to.
  if (!on && side === 'remote' && !t.serverId && !t.rightLocal) return;
  updateTab({ serverList: { ...t.serverList, [side]: on } });
  setState({ focusSide: side, contextMenu: null });
}

/** Name of a tab: its server, or "Neuer Tab" while none is chosen. */
export function tabTitle(t: Tab, s: AppState = state): string {
  if (t.settings) return $t('Einstellungen');
  const right = t.serverId ? serverById(t.serverId, s)?.name : undefined;
  const left = t.leftServerId ? serverById(t.leftServerId, s)?.name : undefined;
  if (right && left) return `${left} ↔ ${right}`;
  if (!right && !left && t.rightLocal) return s.platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC');
  return right ?? left ?? $t('Neuer Tab');
}

/** A tab without a server: this computer on the left, the server list on the right. */
export function emptyTab(localPath = '~', right: 'servers' | 'local' | undefined = state.settings.newTabRight): Tab {
  // Setting "Neuer Tab rechts": the server list (default) or this computer (two local halves).
  const local = right === 'local';
  return {
    id: uid('tab'),
    serverId: '',
    localPath,
    remotePath: local ? localPath : '',
    back: [],
    forward: [],
    ...(local ? { rightLocal: true } : {}),
  };
}

/**
 * Two local halves (Total Commander): the right half shows a folder of this
 * computer instead of a server. A server shown there is closed first.
 */
export function setRightLocal(path?: string) {
  const t = activeTab();
  if (!t) return;
  if (t.serverId) closePaneServer('remote');
  const cur = activeTab() ?? t;
  updateTab({
    rightLocal: true,
    serverId: '',
    remotePath: path ?? (cur.rightLocal && cur.remotePath ? cur.remotePath : cur.leftServerId ? '~' : cur.localPath),
    back: [],
    forward: [],
    syncBrowse: undefined,
    serverList: { ...cur.serverList, remote: false },
  });
  setState((s) => ({
    selection: { ...s.selection, remote: { names: [], cursor: -1, anchor: -1 } },
    expanded: { ...s.expanded, remote: [] },
    focusSide: 'remote',
    contextMenu: null,
  }));
}

/**
 * Connects a server into a half (from the server list or "Schnell verbinden").
 * The left half then shows that server (server to server), the right half
 * becomes the tab's server.
 */
export function openServerIn(side: PaneSide, serverId: string) {
  const t = activeTab();
  const srv = serverById(serverId);
  if (!t || !srv) return;
  setState((st) => ({
    servers: st.servers.map((x) => (x.id === serverId ? { ...x, lastUsed: Date.now() } : x)),
    firstRun: false,
  }));
  if (side === 'local') {
    updateTab({ serverList: { ...t.serverList, local: false } });
    setLeftServer(serverId);
    return;
  }
  // Without a start folder the server's home folder is used; it is known only once connected
  // (an already open connection, e.g. of a folder watch, does not report it again).
  const start = srv.remoteStart || (LIVE && live.isConnected(serverId) ? (live.homeOf(serverId) ?? '') : '');
  const linked = linkedStart(srv, start);
  updateTab({
    serverId,
    rightLocal: false,
    remotePath: start,
    back: [],
    forward: [],
    syncBrowse: linked,
    ...(linked ? { localPath: linked.local } : {}),
    serverList: { ...t.serverList, remote: false },
  });
  setState((s) => ({
    selection: { ...s.selection, remote: { names: [], cursor: -1, anchor: -1 } },
    expanded: { ...s.expanded, remote: [] },
    focusSide: 'remote',
  }));
  if (LIVE) {
    if (!live.isConnected(serverId)) live.connectNow(serverId);
  } else {
    setState((s) => ({ servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: true } : x)) }));
    showToast($t('Verbunden mit {0}', srv.name), 'ok');
  }
}

/**
 * "Beim Öffnen synchron blättern" (Transmit: folder linking): the server's local and
 * server start folders as the linked pair, when both are set.
 */
export function linkedStart(srv: Server, remoteStart: string): Tab['syncBrowse'] {
  if (!srv.syncBrowseOnOpen || !srv.localStart || !remoteStart) return undefined;
  return { local: srv.localStart, remote: remoteStart };
}

/** True when the pane shows a server (the right half, or the left one in server-to-server mode). */
export const paneOnServer = (side: PaneSide, t: Tab | undefined = activeTab()) => paneLoc(side, t)[0] === 'remote';

/** Server to server: shows a server in the left half, or this computer again (''). */
export function setLeftServer(serverId: string) {
  const t = activeTab();
  if (!t) return;
  const srv = serverId ? serverById(serverId) : undefined;
  if (serverId && !srv) return;
  if ((t.leftServerId ?? '') === serverId) {
    setState({ contextMenu: null });
    return;
  }
  // An empty path is filled with the server's home folder once connected.
  const localPath = srv
    ? srv.remoteStart || (LIVE ? (live.isConnected(srv.id) ? (live.homeOf(srv.id) ?? '') : '') : '/')
    : state.servers.find((x) => x.id === t.serverId)?.localStart || '~';
  setState((s) => ({
    tabs: s.tabs.map((x) =>
      x.id === t.id ? { ...x, leftServerId: srv?.id, localPath, back: [], forward: [], syncBrowse: undefined } : x,
    ),
    selection: { ...s.selection, local: { names: [], cursor: -1, anchor: -1 } },
    contextMenu: null,
  }));
  if (srv && LIVE && !live.isConnected(srv.id)) live.connectNow(srv.id);
  if (srv && !LIVE)
    setState((s) => ({ servers: s.servers.map((x) => (x.id === srv.id ? { ...x, online: true } : x)) }));
}

/** Folder listing: mock file system, or the live listing cache (undefined until loaded). */
export function listEntries(side: PaneSide, serverId: string, path: string): FileEntry[] | undefined {
  return LIVE ? live.cachedList(side, serverId, path) : fs.list(side, serverId, path);
}

/** Single entry by path, or undefined when unknown. */
export function statEntry(side: PaneSide, serverId: string, path: string): FileEntry | undefined {
  return LIVE ? live.cachedStat(side, serverId, path) : fs.stat(side, serverId, path);
}

/** True when the path is a folder. */
export function isDirEntry(side: PaneSide, serverId: string, path: string): boolean {
  return LIVE ? live.cachedStat(side, serverId, path)?.kind === 'dir' : fs.isDir(side, serverId, path);
}

/** Loading / error / connection state of a pane (live mode only). */
export function paneStatus(
  side: PaneSide,
  s: AppState = state,
): {
  loading: boolean;
  error?: string;
  hint?: string;
  missing?: boolean;
  notConnected?: boolean;
  connecting?: boolean;
} {
  if (!LIVE) return { loading: false };
  const t = activeTab(s);
  if (!t) return { loading: false };
  const [ls, sid] = paneLoc(side, t);
  if (ls === 'remote' && !live.isConnected(sid))
    return { loading: false, notConnected: true, connecting: live.isConnecting(sid) };
  return live.listingStatus(ls, sid, panePath(side, s));
}

/** Sections of the sidebar in their default order. */
export const SIDEBAR_SECTIONS: SidebarSection[] = ['favorites', 'recent', 'devices', 'shares', 'tags'];

/** Sidebar sections in the user's order (new sections are added at their default place). */
export function sidebarOrder(s: AppState = state): SidebarSection[] {
  const saved = (s.settings.sidebarOrder ?? []).filter((x) => SIDEBAR_SECTIONS.includes(x));
  const missing = SIDEBAR_SECTIONS.filter((x) => !saved.includes(x));
  return [...saved, ...missing];
}

/** Moves a sidebar section before another one (null: to the end). */
export function moveSidebarSection(id: SidebarSection, before: SidebarSection | null) {
  const rest = sidebarOrder().filter((x) => x !== id);
  const i = before === null ? rest.length : Math.max(0, rest.indexOf(before));
  updateSettings({ sidebarOrder: [...rest.slice(0, i), id, ...rest.slice(i)] });
}

/** Folds or unfolds a sidebar section. */
export function toggleSidebarCollapsed(id: SidebarSection) {
  const cur = state.settings.sidebarCollapsed ?? [];
  updateSettings({ sidebarCollapsed: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
}

/** Shows or hides a sidebar section. */
export function toggleSidebarHidden(id: SidebarSection) {
  const cur = state.settings.sidebarHidden ?? [];
  updateSettings({ sidebarHidden: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  setState({ contextMenu: null });
}

/**
 * Entries of any folder of a half, filtered and sorted like the half itself
 * (column view: the folder above and the folder chosen). Undefined until read.
 */
export function folderRows(side: PaneSide, dir: string, s: AppState = state): FileEntry[] | undefined {
  const t = activeTab(s);
  if (!t) return undefined;
  const loc = paneLoc(side, t);
  let list = listEntries(...loc, dir);
  if (!list) return undefined;
  if (!s.settings.showSystem) list = list.filter((e) => (e.hidden ?? 0) < 2);
  if (!s.settings.showHidden) list = list.filter((e) => !e.name.startsWith('.') && !e.hidden);
  return sortEntries(list, s.settings.sort[side]);
}

/** Reads a folder of a half when it is not cached yet (call from effects, not while rendering). */
export function loadFolder(side: PaneSide, dir: string) {
  const t = activeTab();
  if (t && LIVE) live.requestListing(...paneLoc(side, t), dir);
}

/**
 * Rows of a pane: the folder's entries, sorted and filtered (hidden files, the
 * search), and below each opened folder (triangle in the list) its entries
 * indented. Rows of opened folders carry their path relative to the folder
 * shown as `name` (e.g. "routes/cart.py") and their nesting level as `depth`.
 */
export function paneEntries(side: PaneSide, s: AppState = state): FileEntry[] {
  const t = activeTab(s);
  if (!t || paneShowsServers(side, t)) return [];
  const loc = paneLoc(side, t);
  const base = panePath(side, s);
  const open = new Set(s.settings.viewMode[side] === 'list' ? s.expanded[side] : []);
  const q = s.searchSide === side ? s.search.trim().toLowerCase() : '';
  const level = (rel: string, depth: number): FileEntry[] => {
    let list = listEntries(...loc, rel ? paths.join(base, rel) : base) ?? [];
    // Protected system items (e.g. Windows' old "Anwendungsdaten" junctions) stay out like in Explorer;
    // dot files and items marked hidden follow "Versteckte Dateien zeigen".
    if (!s.settings.showSystem) list = list.filter((e) => (e.hidden ?? 0) < 2);
    if (!s.settings.showHidden) list = list.filter((e) => !e.name.startsWith('.') && !e.hidden);
    list = sortEntries(list, s.settings.sort[side]);
    const out: FileEntry[] = [];
    for (const e of list) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      const opened = e.kind === 'dir' && open.has(name);
      // The search filter shows matching rows and keeps opened folders with matches inside.
      const inner = opened ? level(name, depth + 1) : [];
      if (!q || e.name.toLowerCase().includes(q) || inner.length) out.push({ ...e, name, depth }, ...inner);
    }
    return out;
  };
  return level('', 0);
}

/** Opens or closes a folder in place (triangle in the list view). */
export function toggleExpand(side: PaneSide, rel: string) {
  const t = activeTab();
  if (!t) return;
  const cur = state.expanded[side];
  const open = cur.includes(rel);
  // Closing a folder also closes the folders inside it.
  const next = open ? cur.filter((x) => x !== rel && !x.startsWith(`${rel}/`)) : [...cur, rel];
  setState((s) => ({ expanded: { ...s.expanded, [side]: next } }));
  if (!open && LIVE) live.requestListing(...paneLoc(side, t), paths.join(panePath(side), rel));
}

/** Switches a half between list, icons and columns. */
export function setViewMode(side: PaneSide, mode: ViewMode) {
  setState((s) => ({ settings: { ...s.settings, viewMode: { ...s.settings.viewMode, [side]: mode } } }));
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** Kind of an entry for the "Art" column ("Ordner", "PNG-Bild" …). */
export const kindOf = (e: FileEntry) => describeFile(e.name.slice(e.name.lastIndexOf('/') + 1), e.kind);

/** Sorts a listing; folders always come first, names break ties. */
function sortEntries(list: FileEntry[], order: { key: SortKey; dir: 1 | -1 }): FileEntry[] {
  const byName = (a: FileEntry, b: FileEntry) => collator.compare(a.name.replace(/^\./, ''), b.name.replace(/^\./, ''));
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    let c = 0;
    if (order.key === 'mtime') c = a.mtime - b.mtime;
    else if (order.key === 'size') c = a.size - b.size;
    else if (order.key === 'perms') c = a.perms.localeCompare(b.perms);
    else if (order.key === 'kind') c = collator.compare(kindOf(a), kindOf(b));
    else if (order.key === 'owner') c = collator.compare(a.owner ?? '', b.owner ?? '');
    return (c || byName(a, b)) * order.dir;
  });
}

/** Click on a column header: sort by it, a second click reverses. */
export function setSort(side: PaneSide, key: SortKey) {
  setState((s) => {
    const cur = s.settings.sort[side];
    const next = { key, dir: (cur.key === key ? -cur.dir : key === 'name' ? 1 : -1) as 1 | -1 };
    return { settings: { ...s.settings, sort: { ...s.settings.sort, [side]: next } } };
  });
}

/** Zoom steps of the window, like a browser. */
export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2];

/** Standard zoom: Mac programs are more compact than Windows ones, so the Mac starts at 90 %. */
export function defaultZoom(s: AppState = state): number {
  return s.platform === 'mac' ? 0.9 : 1;
}

/** The zoom in use: the user's choice, or the standard of the system. */
export function currentZoom(s: AppState = state): number {
  return s.settings.zoom ?? defaultZoom(s);
}

/** Strg + Plus / Minus / 0: one zoom step larger, smaller, or back to the standard. */
export function stepZoom(dir: 1 | -1 | 0) {
  const cur = currentZoom();
  // Nearest step to the current zoom, then one step in the wanted direction.
  const at = ZOOM_STEPS.reduce((best, z, i) => (Math.abs(z - cur) < Math.abs(ZOOM_STEPS[best] - cur) ? i : best), 0);
  const next = dir === 0 ? defaultZoom() : ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, at + dir))];
  setState((s) => ({ settings: { ...s.settings, zoom: next } }));
  showToast($t('Zoom: {0} %', Math.round(next * 100)));
}

/** Icons view: one size step larger or smaller (slider, Strg + mouse wheel). */
export function setIconSize(side: PaneSide, step: number) {
  const v = Math.max(0, Math.min(3, Math.round(step)));
  setState((s) => ({ settings: { ...s.settings, iconSize: { ...s.settings.iconSize, [side]: v } } }));
}

export const togglePermsColumn = () =>
  setState((s) => ({ settings: { ...s.settings, showPerms: !s.settings.showPerms } }));
export const toggleSwapSides = () =>
  setState((s) => ({ settings: { ...s.settings, swapSides: !s.settings.swapSides } }));

/** Watch that covers the given local path, if any. */
export function watchForLocal(path: string, s: AppState = state): Watch | undefined {
  return s.watches.find((w) => path === w.localPath || path.startsWith(w.localPath + '/'));
}

export function isOffline(serverId: string, s: AppState = state): boolean {
  return !!s.offline[serverId];
}

/** True when the activity should be expanded: user choice or an open error. */
export function activityExpanded(s: AppState = state): boolean {
  return s.activityOpen || s.transfers.some((t) => t.state === 'error');
}

/* ------------------------------------------------------------------------ */
/* Toast                                                                    */
/* ------------------------------------------------------------------------ */

let toastTimer: number | undefined;
export function showToast(
  text: string,
  tone: 'info' | 'ok' | 'error' | 'update' = 'info',
  hint?: string,
  sticky = false,
) {
  setState({ toast: { text, tone, hint: hint || undefined } });
  window.clearTimeout(toastTimer);
  // Sticky: stays until the next message replaces it (a running operation reports its end).
  if (sticky) return;
  // Errors stay long enough to read both lines (about 15 characters a second, at least 6 s).
  const ms = tone === 'error' ? Math.min(12000, Math.max(6000, (text.length + (hint?.length ?? 0)) * 70)) : 2600;
  toastTimer = window.setTimeout(() => setState({ toast: null }), ms);
}
