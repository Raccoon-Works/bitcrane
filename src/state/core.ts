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
import { useMemo, useSyncExternalStore } from 'react';
import * as fs from '../backend/mockFs';
import * as live from './live';
import type { FileEntry, PaneSide, Server, Tab, Watch } from '../backend/types';
import { $t, LANG } from '../i18n';
import type { AppState, PaneSelection } from './appState';
import { defaultToolbar, detectPlatform, detectTheme } from './defaults';
import { sampleServers, sampleTransfers, sampleWatches } from './demoData';

/**
 * True inside the desktop app: real files and real servers instead of the demo data. Fixed when
 * building (vite.config.ts), so the app's bundle leaves out the demo; the demo's bundle still
 * contains the app's code but never calls it. Only the development server, which serves both,
 * asks at run time whether Tauri is there.
 */
export const LIVE: boolean = __BITCRANE_LIVE__ ?? '__TAURI_INTERNALS__' in window;

/** The selection of a half with nothing selected. */
export function emptySelection(): PaneSelection {
  return { names: [], cursor: -1, anchor: -1 };
}

/** Sidebar places of the prototype. */
const DEMO_PLACES = [
  { name: 'Alex', path: '~' },
  { name: 'Projekte', path: '~/Projekte' },
  { name: 'Schreibtisch', path: '~/Schreibtisch' },
  { name: 'Downloads', path: '~/Downloads' },
];

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
    serverDeletes: [],
    syncReview: [],
    transfers: LIVE ? [] : sampleTransfers(),
    selection: LIVE
      ? { local: emptySelection(), remote: emptySelection() }
      : { local: { names: ['app.py'], cursor: 3, anchor: 3 }, remote: emptySelection() },
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
      locationMenuFavorites: true,
      locationMenuDrives: true,
    },
    offline: {},
    conflicts: [],
    fsRev: 0,
    now: Date.now(),
    toast: null,
    speed: 0,
    drives: [],
    // The app reads its places and the name of the home folder from the system (live/config.ts).
    places: LIVE ? [] : DEMO_PLACES,
    homeName: LIVE ? '~' : 'Alex',
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
 * "Beim Öffnen synchron blättern" (Transmit: folder linking): the server's local and
 * server start folders as the linked pair, when both are set.
 */
export function linkedStart(srv: Server, remoteStart: string): Tab['syncBrowse'] {
  if (!srv.syncBrowseOnOpen || !srv.localStart || !remoteStart) return undefined;
  return { local: srv.localStart, remote: remoteStart };
}

/** True when the pane shows a server (the right half, or the left one in server-to-server mode). */
export const paneOnServer = (side: PaneSide, t: Tab | undefined = activeTab()) => paneLoc(side, t)[0] === 'remote';

/** Folder listing: mock file system, or the live listing cache (undefined until loaded). */
export function listEntries(side: PaneSide, serverId: string, path: string): FileEntry[] | undefined {
  return LIVE ? live.cachedList(side, serverId, path) : fs.list(side, serverId, path);
}

/** The folder listings (`list`) and the state of loading them (`status`), at revision `rev` (`fsRev`). */
export interface Listings {
  rev: number;
  list: typeof listEntries;
  status: typeof paneStatus;
}

/**
 * React hook: the folder listings as a value that changes whenever they do. The listing cache and
 * the connection state live outside the store; `fsRev` says when they changed. Memos that read
 * them go through this value and list it as a dependency.
 */
export function useListings(): Listings {
  const rev = useStore((s) => s.fsRev);
  return useMemo(() => ({ rev, list: listEntries, status: paneStatus }), [rev]);
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
  t: Tab | undefined,
): {
  loading: boolean;
  error?: string;
  hint?: string;
  missing?: boolean;
  notConnected?: boolean;
  connecting?: boolean;
} {
  if (!LIVE || !t) return { loading: false };
  const [ls, sid] = paneLoc(side, t);
  if (ls === 'remote' && !live.isConnected(sid))
    return { loading: false, notConnected: true, connecting: live.isConnecting(sid) };
  return live.listingStatus(ls, sid, side === 'local' ? t.localPath : t.remotePath);
}

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

/** Where a pane's files are for copying: '' for this computer, otherwise the server id. */
export function placeOf(side: PaneSide, t: Tab | undefined = activeTab()): string {
  const [ls, sid] = paneLoc(side, t);
  return ls === 'remote' ? sid : '';
}
