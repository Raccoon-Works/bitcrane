/**
 * Panels and dialogs: info column, activity, popovers, search and the dialog in front.
 */

import * as fs from '../backend/mockFs';
import * as live from './live';
import type { PaneSide, Tab } from '../backend/types';

import * as paths from '../util/paths';
import { $t } from '../i18n';
import {
  setState,
  activityExpanded,
  activeTab,
  emptyTab,
  paneShowsServers,
  paneLoc,
  serverById,
  paneEntries,
  showToast,
  panePath,
  LIVE,
  uid,
  getState,
} from './core';
import type { SettingsTab } from '../backend/types';
import type { DialogState, AppState } from './appState';
import { clearSelection, navigate, openServerInNewTab } from './tabs';
import { quickConnect } from './servers';

export const toggleInspector = () => setState((s) => ({ inspectorOpen: !s.inspectorOpen }));
export const toggleActivity = () => setState((s) => ({ activityOpen: !activityExpanded(s) }));
export const togglePopover = () => setState((s) => ({ popoverOpen: !s.popoverOpen, appMenu: null }));

export const openDialog = (dialog: DialogState) => {
  // The settings are a tab of their own, not a dialog.
  if (dialog?.type === 'settings') return openSettingsTab(dialog.tab);
  setState({ dialog, popoverOpen: false, contextMenu: null, appMenu: null, menuBarWindowOpen: false });
};

/** Opens the settings tab (or brings it to the front) on the given area. */
function openSettingsTab(section: SettingsTab = 'general') {
  const s = getState();
  const close = { dialog: null, popoverOpen: false, contextMenu: null, appMenu: null, menuBarWindowOpen: false };
  const existing = s.tabs.find((t) => t.settings);
  if (existing) {
    setState({
      ...close,
      activeTabId: existing.id,
      tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, settings: section } : t)),
    });
    return;
  }
  const from = activeTab(s);
  const tab: Tab = { ...emptyTab(from && !from.leftServerId ? from.localPath : '~'), settings: section };
  const at =
    Math.max(
      0,
      s.tabs.findIndex((t) => t.id === s.activeTabId),
    ) + 1;
  setState({
    ...close,
    tabs: [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)],
    activeTabId: tab.id,
    selection: clearSelection(),
  });
}

/** Switches the area shown in the settings tab. */
export function setSettingsSection(section: SettingsTab) {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.settings ? { ...t, settings: section } : t)) }));
}
export const closeDialog = () => setState({ dialog: null });
/** What the search field searches: this computer, a server's files, or the server list. */
export function searchTarget(s: AppState = getState()): {
  side: PaneSide;
  kind: 'local' | 'server' | 'servers';
  name: string;
} {
  const side = s.search.trim() ? s.searchSide : s.focusSide;
  const t = activeTab(s);
  if (paneShowsServers(side, t)) return { side, kind: 'servers', name: '' };
  const [ls, sid] = paneLoc(side, t);
  return ls === 'local'
    ? { side, kind: 'local', name: '' }
    : { side, kind: 'server', name: serverById(sid, s)?.name ?? '' };
}

export const setSearch = (search: string) => {
  // A new search starts in the focused half; while text is in the field it stays there.
  setState((s) => ({ search, searchSide: s.search.trim() ? s.searchSide : s.focusSide }));
  pruneSelection();
  if (getState().deepSearchOn) scheduleDeepSearch();
};

/** Drops selected names that a filter just hid, so actions never touch files the user cannot see. */
function pruneSelection() {
  const next = { ...getState().selection };
  let changed = false;
  for (const side of ['local', 'remote'] as PaneSide[]) {
    const visible = new Set(paneEntries(side).map((e) => e.name));
    const names = next[side].names.filter((n) => visible.has(n));
    if (names.length !== next[side].names.length) {
      next[side] = { ...next[side], names };
      changed = true;
    }
  }
  if (changed) setState({ selection: next });
}

/** Walk results per folder, reused for a minute while typing. */
const walkCache = new Map<
  string,
  { at: number; items: Array<{ path: string; relative: string; size: number; mtime: number }> }
>();
let deepTimer: number | undefined;
let deepRun = 0;

export function setDeepSearch(on: boolean) {
  setState({ deepSearchOn: on, ...(on ? {} : { deepSearch: null, searchContent: false }) });
  if (on) {
    if (!getState().search.trim()) showToast($t('Suche in Unterordnern an: einen Namen ins Suchfeld tippen.'));
    scheduleDeepSearch();
  }
}

/** The subfolder setting before the content search turned it on. */
let deepBeforeContent = false;

/**
 * "Im Inhalt suchen" (ForkLift, Commander One, WinSCP "grep"): finds text inside
 * files below the folder, on this computer and on SSH servers. Turns on the
 * search in subfolders as well.
 */
export function setSearchContent(on: boolean) {
  // Content search turns on the subfolders; turning it off restores what was set before.
  if (on && !getState().searchContent) deepBeforeContent = getState().deepSearchOn;
  setState({ searchContent: on, deepSearchOn: on ? true : deepBeforeContent, deepSearch: null });
  if (on && !getState().search.trim()) showToast($t('Suche im Inhalt an: einen Text ins Suchfeld tippen.'));
  scheduleDeepSearch();
}

function scheduleDeepSearch() {
  window.clearTimeout(deepTimer);
  const q = getState().search.trim();
  if (!q || (getState().searchContent && q.length < 2)) {
    setState({ deepSearch: null });
    return;
  }
  // Searching in content reads files, so it waits a little longer for the typing to stop.
  deepTimer = window.setTimeout(
    () => void (getState().searchContent ? runContentSearch(q) : runDeepSearch(q)),
    getState().searchContent ? 600 : 300,
  );
}

async function runContentSearch(query: string) {
  const t = activeTab();
  if (!t) return;
  const side = getState().searchSide;
  if (paneShowsServers(side, t)) return;
  const base = panePath(side);
  const run = ++deepRun;
  const loc = paneLoc(side, t);
  setState({ deepSearch: { side, base, query, loading: true, results: [], more: false, content: true } });
  try {
    const max = 300;
    const hits = !LIVE
      ? fs
          .walkFiles(...loc, base)
          .filter((f) => f.path.toLowerCase().includes(query.toLowerCase().slice(0, 2)))
          .slice(0, 12)
          .map((f, i) => ({
            path: f.path,
            rel: f.path.slice(base.length + 1),
            size: f.entry.size,
            mtime: f.entry.mtime,
            line: `… ${query} …`,
            lineNo: i + 3,
          }))
      : await live.grep(...loc, base, query, max + 1);
    if (run !== deepRun) return;
    const visible = hits.filter(
      (h) => getState().settings.showHidden || !h.rel.split('/').some((seg) => seg.startsWith('.')),
    );
    setState({
      deepSearch: {
        side,
        base,
        query,
        loading: false,
        results: visible.slice(0, max),
        more: hits.length > max,
        content: true,
      },
    });
  } catch (e) {
    if (run !== deepRun) return;
    setState({
      deepSearch: {
        side,
        base,
        query,
        loading: false,
        results: [],
        more: false,
        error: (e as { message?: string })?.message ?? String(e),
        content: true,
      },
    });
  }
}

async function runDeepSearch(query: string) {
  const t = activeTab();
  if (!t) return;
  const side = getState().searchSide;
  if (paneShowsServers(side, t)) return;
  const base = panePath(side);
  const run = ++deepRun;
  const loc = paneLoc(side, t);
  const key = `${loc[0]}|${loc[0] === 'remote' ? loc[1] : ''}|${base}`;
  setState((s) => ({
    deepSearch: {
      side,
      base,
      query,
      loading: true,
      results: s.deepSearch?.side === side && s.deepSearch.base === base ? s.deepSearch.results : [],
      more: false,
    },
  }));
  try {
    let cached = walkCache.get(key);
    if (!cached || Date.now() - cached.at > 60_000) {
      const items = LIVE
        ? await live.walkFiles(...loc, base)
        : fs.walkFiles(...loc, base).map((f) => ({
            path: f.path,
            relative: paths.basename(base) + f.path.slice(base.length),
            size: f.entry.size,
            mtime: f.entry.mtime,
          }));
      cached = { at: Date.now(), items };
      walkCache.set(key, cached);
    }
    if (run !== deepRun) return;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = cached.items
      // Walk results start with the walked folder's own name.
      .map((i) => ({ path: i.path, rel: i.relative.split('/').slice(1).join('/'), size: i.size, mtime: i.mtime }))
      .filter(
        (i) =>
          (getState().settings.showHidden || !i.rel.split('/').some((seg) => seg.startsWith('.'))) &&
          words.every((w) => i.rel.toLowerCase().includes(w)),
      )
      // Matches in the file name first, then by path.
      .sort(
        (a, b) =>
          Number(!paths.basename(a.rel).toLowerCase().includes(words[0])) -
            Number(!paths.basename(b.rel).toLowerCase().includes(words[0])) || a.rel.localeCompare(b.rel, 'de'),
      );
    setState({ deepSearch: { side, base, query, loading: false, results: all.slice(0, 500), more: all.length > 500 } });
  } catch (e) {
    if (run !== deepRun) return;
    setState({
      deepSearch: {
        side,
        base,
        query,
        loading: false,
        results: [],
        more: false,
        error: (e as { message?: string })?.message ?? String(e),
      },
    });
  }
}

/** Opens the folder of a search result and selects the file. */
export function revealSearchResult(side: PaneSide, path: string) {
  const dir = paths.parent(path);
  const name = paths.basename(path);
  setState({ search: '', deepSearch: null });
  navigate(side, dir);
  // Select once the listing is there.
  let tries = 0;
  const pick = () => {
    const entries = paneEntries(side);
    const idx = entries.findIndex((e) => e.name === name);
    if (idx >= 0)
      setState((s) => ({
        selection: { ...s.selection, [side]: { names: [name], cursor: idx, anchor: idx } },
        focusSide: side,
      }));
    else if (++tries < 20) window.setTimeout(pick, 150);
  };
  pick();
}
export const setActivityFilter = (activityFilter: AppState['activityFilter']) =>
  setState({ activityFilter, activityOpen: true });

export function toggleHidden() {
  setState((s) => ({ settings: { ...s.settings, showHidden: !s.settings.showHidden } }));
  pruneSelection();
  showToast(
    getState().settings.showHidden
      ? $t('Versteckte Dateien werden gezeigt.')
      : $t('Versteckte Dateien werden ausgeblendet.'),
  );
}

/**
 * Opens an sftp:// link: a saved server with the same address and user if
 * there is one, otherwise a quick connection. A path that ends in a file
 * opens its folder with the file selected.
 */
export function openSftpLink(url: string) {
  if (!getState().settings.sftpLinks) {
    showToast(
      $t('Bitcrane öffnet sftp-Links erst, wenn das in den Einstellungen unter „Erweitert“ eingeschaltet ist.'),
    );
    return;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    showToast($t('Link nicht verstanden: {0}', url), 'error');
    return;
  }
  if (u.protocol !== 'sftp:') return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || 22;
  const user = decodeURIComponent(u.username);
  const path = decodeURIComponent(u.pathname || '');
  const srv = getState().servers.find((x) => x.host === host && x.port === port && (!user || x.user === user));
  if (!srv) {
    quickConnect(
      `${user ? `${user}@` : ''}${host}${port !== 22 ? `:${port}` : ''}${path && path !== '/' ? path : ''}`,
      false,
      'auto',
    );
    return;
  }
  openServerInNewTab(srv.id);
  if (path && path !== '/') {
    const isFile = !path.endsWith('/') && /\.[^/]+$/.test(path);
    if (isFile) revealSearchResult('remote', path.replace(/\/+$/, ''));
    else navigate('remote', path.replace(/\/+$/, '') || '/');
  }
}

/** Opens the folders of a saved comparison and shows the comparison. */
export function openSyncFavorite(id: string) {
  const f = getState().settings.syncFavorites.find((x) => x.id === id);
  if (!f || (!f.rightLocal && !serverById(f.serverId)) || (f.leftServerId && !serverById(f.leftServerId))) return;
  const tab: Tab = {
    id: uid('tab'),
    serverId: f.rightLocal ? '' : f.serverId,
    localPath: f.local,
    remotePath: f.remote,
    back: [],
    forward: [],
    ...(f.leftServerId ? { leftServerId: f.leftServerId } : {}),
    ...(f.rightLocal ? { rightLocal: true } : {}),
  };
  setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, selection: clearSelection(), contextMenu: null }));
  for (const sid of [f.rightLocal ? '' : f.serverId, f.leftServerId ?? ''])
    if (sid && LIVE && !live.isConnected(sid)) live.connectNow(sid);
  openDialog({ type: 'compare', favoriteId: id });
}

/** Reads a server folder again (after a change made outside the usual operations). */
export function invalidateRemote(serverId: string, path: string) {
  if (LIVE) live.invalidate('remote', serverId, path);
  setState((s) => ({ fsRev: s.fsRev + 1 }));
}

export function refresh() {
  if (LIVE) live.refreshVisible();
  setState((s) => ({ fsRev: s.fsRev + 1 }));
  showToast($t('Aktualisiert.'));
}
