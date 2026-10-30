/**
 * One half of the main window: this computer or a server, or the server list
 * while the half has nothing connected (layout after Transmit 5).
 *
 * Top to bottom: places bar, path bar (location button, breadcrumbs, view
 * switch, eject), column header, files as a list (folders open in place with
 * the triangle, like the Finder) or as icons, footer.
 *
 * Keyboard: arrows, type-to-select, Enter/⌘↓ to open, ⌘↑/Alt+↑ to go up,
 * → and ← open and close a folder in the list. Multi-selection with Shift/⌘,
 * inline rename, context menu, and drag & drop between the two halves.
 */
import { ArrowLeft, ArrowRight, ChevronDown, CornerDownRight, Download, Link2, Loader2, Lock, PlugZap, WifiOff } from './glyphs';
import { isVaultListing, unlockVault } from '../state/vault';
import { ArrowElbowLeftUp, GitBranch, CaretDown, CaretRight, CaretUp, CaretUpDown, EjectSimple, SlidersHorizontal, ListBullets, Plugs, SquaresFour, Columns, TerminalWindow } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { FileEntry, PaneSide } from '../backend/types';
import { activeTab, canGoUp, getState, hiddenCount, kindOf, moveToOtherHalf, setIconSize, paneLoc, askDelete, editPath, activateEntry, folderSizeKey, openDialog, revealSearchResult, toggleSyncBrowse, clearPaneSelection, clickRow, commitRename, download, goUp, submitPath, isOffline, jumpTo, listEntries, moveCursor, navigate, paneEntries, paneStatus, reconnect, selectAll, setSort, type SortKey, setFocusSide, setState, startRename, toggleInspector, upload, useStore, watchForLocal, paneOnServer, paneShowsServers, setViewMode, toggleExpand, closePaneServer, folderRows, loadFolder } from '../state/store';
import { PlacesBar } from './PlacesBar';
import { ServerList } from './ServerList';
import { formatDate, formatSize, permsToText } from '../util/format';
import { beginRowDrag } from '../util/dragDrop';
import { crumbs as crumbsFor } from '../util/paths';
import { FileGlyph, FolderGlyph, typeIconFor } from './icons';
import { Thumb } from './Thumb';
import * as paths from '../util/paths';
import { LocalTile, ServerTile } from './ServerTile';
import { Button, IconButton } from './ui';
import { $t } from '../i18n';
import { compareMarks, selectDifferences, toggleCompareDirs, type CompareMark } from '../state/tools';
import { GIT_LABEL, gitMark, useGit } from '../state/git';
import { tagCss, useTags } from '../state/tags';


/** Symbol size of the icons view per size step. */
const ICON_PX = [48, 72, 100, 136];

function RenameInput({ side, name: full }: { side: PaneSide; name: string }) {
  // Rows inside opened folders carry a relative path; only the last part is edited.
  const name = full.slice(full.lastIndexOf('/') + 1);
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the name without the extension, like Finder and Explorer.
    const dot = name.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [name]);
  return (
    <input
      ref={ref}
      className="rename-input"
      value={value}
      aria-label={$t('Neuer Name')}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commitRename(side, full, value);
        if (e.key === 'Escape') setState({ renaming: null });
      }}
      onBlur={() => commitRename(side, full, value)}
    />
  );
}

/** ⌘L: the path as a text field. Enter goes there, Escape keeps the folder. */
function PathInput({ side, path }: { side: PaneSide; path: string }) {
  const [value, setValue] = useState(path);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const back = () => document.querySelector<HTMLElement>(`.pane[data-side="${side}"] [role="listbox"]`)?.focus();
  return (
    <input
      ref={ref}
      className="path-input mono"
      value={value}
      spellCheck={false}
      aria-label={paneOnServer(side) ? $t('Pfad auf dem Server') : $t('Pfad auf diesem Computer')}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { submitPath(side, value); back(); }
        if (e.key === 'Escape') { setState({ pathEdit: null }); back(); }
      }}
      onBlur={() => setState({ pathEdit: null })}
    />
  );
}

export function Pane({ side }: { side: PaneSide }) {
  const tab = useStore((s) => activeTab(s));
  const platform = useStore((s) => s.platform);
  const fsRev = useStore((s) => s.fsRev);
  // The search filters only the half it was started in.
  const search = useStore((s) => (s.searchSide === side ? s.search : ''));
  const showHidden = useStore((s) => s.settings.showHidden);
  const sel = useStore((s) => s.selection[side]);
  const focusSide = useStore((s) => s.focusSide);
  const renaming = useStore((s) => s.renaming);
  const transfers = useStore((s) => s.transfers);
  const servers = useStore((s) => s.servers);
  // Where this half's files are: this computer, or a server (the right half; the left one in server-to-server mode).
  const [ls, sid] = paneLoc(side, tab);
  const onServer = ls === 'remote';
  // Both halves on this computer (two local halves, Total Commander).
  const bothLocal = !!tab?.rightLocal && !tab.serverId && !tab.leftServerId;
  const place = onServer ? sid : '';
  const offlineInfo = useStore((s) => (onServer ? s.offline[sid] : undefined));
  const now = useStore((s) => s.now);
  const homeName = useStore((s) => s.homeName);
  const showPerms = useStore((s) => s.settings.showPerms);
  const columns = useStore((s) => s.settings.columns);
  const folderSizes = useStore((s) => s.folderSizes);
  const deep = useStore((s) => (s.deepSearchOn && s.search.trim() && s.searchSide === side && s.deepSearch?.side === side ? s.deepSearch : null));
  const pathEdit = useStore((s) => s.pathEdit === side);
  const sort = useStore((s) => s.settings.sort[side]);
  const dropHint = useStore((s) => (s.dropHint?.side === side && !s.dropHint.place && !s.dropHint.addPlace ? s.dropHint.name : null));
  const viewMode = useStore((s) => s.settings.viewMode[side]);
  // Icons view size step (0 … 3): symbol size and tile width.
  const iconStep = useStore((s) => s.settings.iconSize?.[side] ?? 0);
  const expanded = useStore((s) => s.expanded[side]);
  const showServers = useStore((s) => paneShowsServers(side, activeTab(s)));
  const platformWin = useStore((s) => s.platform === 'win');
  const parentRowOn = useStore((s) => s.settings.parentRow);
  const listRef = useRef<HTMLDivElement>(null);
  const typeBuffer = useRef({ text: '', at: 0 });
  const crumbsRef = useRef<HTMLSpanElement>(null);
  // Icons view: Strg + mouse wheel (⌘ on the Mac) makes the symbols larger or smaller, like Explorer.
  // A native listener, because React's wheel listener is passive and could not stop the scrolling.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || getState().settings.viewMode[side] !== 'icons') return;
      e.preventDefault();
      const cur = getState().settings.iconSize?.[side] ?? 0;
      setIconSize(side, cur + (e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // The list element exists only while the half shows files.
  }, [side, showServers]);
  const [crumbsHidden, setCrumbsHidden] = useState(0);

  const path = tab ? (side === 'local' ? tab.localPath : tab.remotePath) : '';
  const server = onServer ? servers.find((x) => x.id === sid) : undefined;
  const offline = onServer && !!offlineInfo;
  // SSH servers get a button for the built-in terminal next to "Trennen".
  const sshPane = useStore((s) => { const id = paneLoc(side)[1]; const p = s.servers.find((x) => x.id === id)?.protocol; return !p || p === 'sftp'; });
  const terminalOpen = useStore((s) => !!s.tabs.find((t) => t.id === s.activeTabId)?.terminal?.open);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entries = useMemo(() => paneEntries(side), [side, path, fsRev, search, showHidden, tab?.serverId, tab?.leftServerId, sort, viewMode, expanded, showServers]);
  // A Cryptomator vault: its folder shows the encrypted files plus a way to unlock it.
  const isVault = useMemo(() => isVaultListing(entries.map((e) => e.name)), [entries]);
  const openSet = useMemo(() => new Set(expanded), [expanded]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const status = useMemo(() => paneStatus(side), [side, path, fsRev, tab?.serverId, tab?.leftServerId]);

  // "nur Server" tags: remote entries that are missing in the paired local folder.
  const watch = tab && !tab.leftServerId ? watchForLocal(tab.localPath) : undefined;
  const paired = !!watch && !!tab && watch.serverId === tab.serverId && watch.remotePath + tab.localPath.slice(watch.localPath.length) === tab.remotePath;
  const otherNames = useMemo(() => {
    if (!paired || !tab) return null;
    const other = listEntries(side === 'local' ? 'remote' : 'local', tab.serverId, side === 'local' ? tab.remotePath : tab.localPath);
    return other ? new Set(other.map((e) => e.name)) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paired, tab?.localPath, tab?.remotePath, fsRev, side]);

  // Entries currently being uploaded (local side) or downloaded (remote side).
  const busy = useMemo(() => {
    const set = new Set<string>();
    for (const t of transfers) {
      if (t.state !== 'running' && t.state !== 'queued') continue;
      // Where the file comes from: this computer, the tab's server or (server to server) the source server.
      const from = t.direction === 'up' ? '' : t.direction === 'down' ? t.serverId : t.direction === 'cross' ? t.sourceServerId ?? '' : null;
      const p = from === place ? t.source : '';
      if (p.startsWith(path + '/')) set.add(p.slice(path.length + 1).split('/')[0]);
    }
    return set;
  }, [transfers, place, path]);

  // Breadcrumbs: start with every level shown and fold one more into "…" while they overflow.
  const crumbPath = tab ? (side === 'local' ? tab.localPath : tab.remotePath) : '';
  useLayoutEffect(() => { setCrumbsHidden(0); }, [crumbPath, homeName]);
  useLayoutEffect(() => {
    const el = crumbsRef.current;
    // Stop when only the current folder is left (plus the "…").
    const visible = el ? el.querySelectorAll('.crumb-wrap').length - (crumbsHidden > 0 ? 1 : 0) : 0;
    if (el && visible > 1 && el.scrollWidth > el.clientWidth + 1) setCrumbsHidden((h) => h + 1);
  });
  useEffect(() => {
    const el = crumbsRef.current?.parentElement;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; setCrumbsHidden(0); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showServers]);

  // Keep the keyboard cursor row visible.
  useEffect(() => {
    if (sel.cursor < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${sel.cursor}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [sel.cursor]);

  // "Verzeichnisse vergleichen" (WinSCP): marks for what differs from the other half.
  const compareOn = useStore((s) => s.compareDirs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const marks = useMemo(() => (compareOn ? compareMarks(side) : null), [compareOn, side, fsRev, tab?.localPath, tab?.remotePath, tab?.serverId, tab?.leftServerId, tab?.rightLocal]);

  if (!tab) return null;

  if (showServers) {
    return (
      <section data-side={side} className={`pane is-servers${focusSide === side ? ' is-focused' : ''}`} aria-label={$t('Server')} onMouseDown={() => setFocusSide(side)}>
        <ServerList side={side} />
      </section>
    );
  }

  // All levels while they fit; when space runs out the first ones fold into "…" (Explorer).
  const allCrumbs = path ? crumbsFor(path, homeName) : [];
  const crumbs = allCrumbs.slice(Math.min(crumbsHidden, Math.max(0, allCrumbs.length - 1)));
  const icons = viewMode === 'icons';
  // Column view (Finder, ForkLift): the folder above, the folder shown, and what the chosen folder holds.
  const colView = viewMode === 'columns' && !deep;
  const parentDir = colView && path && paths.parent(path) !== path ? paths.parent(path) : null;
  const chosen = colView && sel.names.length === 1 ? entries.find((e) => e.name === sel.names[0]) : undefined;
  const childDir = chosen?.kind === 'dir' ? paths.join(path, chosen.name) : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const parentRows = useMemo(() => (parentDir ? folderRows(side, parentDir) : undefined), [side, parentDir, fsRev, showHidden, sort, tab?.serverId, tab?.leftServerId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const childRows = useMemo(() => (childDir ? folderRows(side, childDir) : undefined), [side, childDir, fsRev, showHidden, sort, tab?.serverId, tab?.leftServerId]);
  useEffect(() => { if (parentDir) loadFolder(side, parentDir); }, [side, parentDir]);
  useEffect(() => { if (childDir) loadFolder(side, childDir); }, [side, childDir]);
  const parentColRef = useRef<HTMLDivElement>(null);
  // The folder shown stays in view in the column above it.
  useEffect(() => { parentColRef.current?.querySelector('.is-here')?.scrollIntoView({ block: 'nearest' }); }, [parentDir, parentRows]);
  /** A row of the side columns: the folder above or the chosen folder's contents. */
  const sideRow = (e: FileEntry, here: boolean, onPick: () => void, onOpen: () => void) => (
    <div key={e.name} role="option" aria-selected={here} className={`row${here ? ' is-sel-inactive is-here' : ''}`}
      onMouseDown={(ev) => { if (ev.button === 0) { listRef.current?.focus({ preventScroll: true }); onPick(); } }}
      onDoubleClick={onOpen}>
      <span className="row-bar" />
      <span />
      {e.kind === 'dir' ? <FolderGlyph size={18} /> : <FileGlyph size={18} name={e.name} />}
      <span className="row-name"><span className="ellipsis">{e.name}</span></span>
      {e.kind === 'dir' ? <CaretRight size={11} weight="bold" className="miller-caret" aria-hidden="true" /> : <span />}
    </div>
  );
  // Icons view: arrow keys move by row and column.
  const gridCols = () => {
    const el = listRef.current?.querySelector<HTMLElement>('.icon-grid');
    return el ? Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').length) : 1;
  };

  const watched = !onServer && !!watchForLocal(path);
  // Git working copies on this computer: changed files and the branch (ForkLift).
  const gitOn = useStore((s) => s.settings.gitStatus !== false);
  const git = useGit(path, !onServer && gitOn && !!path);
  // Finder tags (Mac, this computer).
  const isMac = useStore((s) => s.platform === 'mac');
  const tags = useTags(path, !onServer && !!path && isMac);
  const stateLabel = !onServer
    ? (watched ? { text: $t('überwacht'), tone: 'accent' } : null)
    : offline ? { text: $t('getrennt'), tone: 'warn' } : status.connecting ? { text: $t('verbindet'), tone: 'muted' } : server?.online ? { text: $t('verbunden'), tone: 'ok' } : { text: $t('nicht verbunden'), tone: 'muted' };

  const selectedCount = sel.names.length;
  const markLabel: Record<CompareMark, string> = { only: $t('fehlt drüben'), newer: $t('neuer'), older: $t('älter'), size: $t('andere Größe') };
  const hidden = search ? 0 : hiddenCount(side);
  const footText = (() => {
    if (status.notConnected) return '';
    if (status.loading && !entries.length) return $t('Wird gelesen …');
    const n = entries.length;
    // Hidden entries are counted, so nobody wonders where a file went (WinSCP: "2 versteckt").
    const base = `${n} ${n === 1 ? $t('Objekt') : $t('Objekte')}${hidden ? `, ${$t('{0} versteckt', hidden)}` : ''}`;
    if (selectedCount) return $t('{0}, {1} ausgewählt', base, selectedCount);
    if (marks) return marks.size ? $t('{0}, {1} anders als drüben', base, marks.size) : $t('{0}, gleich wie drüben', base);
    if (side === 'remote' && otherNames) {
      const only = entries.filter((e) => !otherNames.has(e.name)).length;
      if (only) return $t('{0}, {1} nur auf dem Server', base, only);
    }
    return base;
  })();

  const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    const cur = entries[sel.cursor];
    if (e.key === 'ArrowDown' && !isMod(e) && !e.altKey) { e.preventDefault(); moveCursor(side, icons ? gridCols() : 1, e.shiftKey); return; }
    if (e.key === 'ArrowUp' && !isMod(e) && !e.altKey) { e.preventDefault(); moveCursor(side, icons ? -gridCols() : -1, e.shiftKey); return; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !isMod(e) && !e.altKey) {
      e.preventDefault();
      const right = e.key === 'ArrowRight';
      if (icons) { moveCursor(side, right ? 1 : -1, e.shiftKey); return; }
      if (colView) {
        // Columns: ← goes to the folder above, → into the chosen folder (Finder).
        if (!right) goUp(side);
        else if (cur?.kind === 'dir') { navigate(side, paths.join(path, cur.name)); clickRow(side, 0, {}); }
        return;
      }
      if (!cur) return;
      // List: → opens a folder in place, ← closes it or jumps to the folder around it (Finder).
      if (right && cur.kind === 'dir' && !openSet.has(cur.name)) toggleExpand(side, cur.name);
      else if (!right && cur.kind === 'dir' && openSet.has(cur.name)) toggleExpand(side, cur.name);
      else if (!right && cur.name.includes('/')) {
        const parentIndex = entries.findIndex((x) => x.name === cur.name.slice(0, cur.name.lastIndexOf('/')));
        if (parentIndex >= 0) clickRow(side, parentIndex, {});
      }
      return;
    }
    if ((e.key === 'ArrowUp' && (isMod(e) || e.altKey)) || (e.key === 'Backspace' && platform === 'win')) { e.preventDefault(); goUp(side); return; }
    if (e.key === 'ArrowDown' && isMod(e) && !e.altKey) { e.preventDefault(); if (cur) activateEntry(side, cur.name); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!cur) return;
      // Mac: Enter renames (Finder). Windows: Enter opens (Explorer).
      if (platform === 'mac') startRename(side, sel.names.length > 1 ? undefined : cur.name);
      else activateEntry(side, cur.name);
      return;
    }
    if (e.key === 'F2') { e.preventDefault(); if (sel.names.length > 1) startRename(side); else if (cur) startRename(side, cur.name); return; }
    if ((e.key === 'Backspace' && isMod(e)) || e.key === 'Delete') { e.preventDefault(); askDelete(side); return; }
    if (e.key.toLowerCase() === 'a' && isMod(e)) { e.preventDefault(); selectAll(side); return; }
    // Space: preview of a file (like Quick Look); on a folder it shows the info column.
    if (e.key === ' ') { e.preventDefault(); if (cur?.kind === 'file') openDialog({ type: 'preview', side }); else toggleInspector(); return; }
    if (e.key === 'Escape') { clearPaneSelection(side); return; }
    if (e.key.length === 1 && !isMod(e) && !e.altKey && /\S/.test(e.key)) {
      const nowMs = Date.now();
      const buf = nowMs - typeBuffer.current.at < 800 ? typeBuffer.current.text + e.key : e.key;
      typeBuffer.current = { text: buf, at: nowMs };
      jumpTo(side, buf);
    }
  };

  const rowClass = (entry: FileEntry, index: number) => {
    const selected = sel.names.includes(entry.name);
    const focused = focusSide === side;
    return [
      'row',
      selected ? (focused ? 'is-sel' : 'is-sel-inactive') : '',
      selected && focused && sel.cursor === index ? 'is-cursor' : '',
      dropHint === entry.name ? 'is-drop' : '',
      marks && (entry.depth ?? 0) === 0 && marks.get(entry.name) ? `cmp-${marks.get(entry.name)}` : '',
    ].join(' ');
  };

  /** One file or folder: a row of the list, or a tile of the icons view. */
  const item = (entry: FileEntry, index: number) => {
    const isRenaming = renaming?.side === side && renaming.name === entry.name;
    const depth = entry.depth ?? 0;
    const onlyHere = depth === 0 && side === 'remote' && otherNames && !otherNames.has(entry.name);
    const isBusy = depth === 0 && busy.has(entry.name);
    const label = entry.name.slice(entry.name.lastIndexOf('/') + 1);
    const isOpen = openSet.has(entry.name);
    const props = {
      role: 'option',
      'aria-selected': sel.names.includes(entry.name),
      'data-index': index,
      'data-dir': entry.kind === 'dir',
      'data-name': entry.name,
      title: icons ? label : undefined,
      onPointerDown: (e: React.PointerEvent) => {
        if (isRenaming || offline || e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
        if ((e.target as HTMLElement).closest('.disclosure')) return;
        beginRowDrag(e, side, sel.names.includes(entry.name) ? sel.names : [entry.name]);
      },
      onMouseDown: (e: React.MouseEvent) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('.disclosure')) return;
        listRef.current?.focus({ preventScroll: true });
        clickRow(side, index, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey });
      },
      onDoubleClick: (e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest('.disclosure')) activateEntry(side, entry.name); },
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        listRef.current?.focus({ preventScroll: true });
        const names = sel.names.includes(entry.name) ? sel.names : [entry.name];
        if (!sel.names.includes(entry.name)) clickRow(side, index, {});
        setState({ contextMenu: { x: e.clientX, y: e.clientY, side, names } });
      },
    } as const;
    const nameEl = isRenaming ? <RenameInput side={side} name={entry.name} /> : <span className={icons ? 'tile-name' : 'ellipsis'}>{label}</span>;
    const link = entry.link !== undefined && !isRenaming && <span className="link-mark" title={$t('Verknüpfung auf {0}', entry.link || $t('ein Ziel, das es nicht mehr gibt'))} aria-label={$t('Verknüpfung')}><CornerDownRight size={11} strokeWidth={2} /></span>;
    const busyTag = isBusy && <span className="tag tag-accent">{tab.leftServerId ? $t('wird übertragen') : side === 'local' ? $t('lädt hoch') : $t('lädt herunter')}</span>;
    if (icons) {
      const ext = entry.kind === 'file' && !typeIconFor(label) && label.includes('.') ? label.slice(label.lastIndexOf('.') + 1).slice(0, 4).toUpperCase() : '';
      return (
        <div key={entry.name} {...props} className={`${rowClass(entry, index).replace('row', 'tile')}`}>
          <span className="tile-icon">
            {entry.kind === 'dir' ? <FolderGlyph size={ICON_PX[iconStep]} /> : <Thumb side={ls} path={paths.join(path, entry.name)} name={label} size={ICON_PX[iconStep]} />}
            {ext && <span className="tile-ext" aria-hidden="true">{ext}</span>}
            {link}
          </span>
          {nameEl}
          {busyTag}
        </div>
      );
    }
    return (
      <div key={entry.name} {...props} className={rowClass(entry, index)} style={{ '--depth': depth } as CSSProperties}>
        <span className="row-bar" />
        {entry.kind === 'dir' && !colView ? (
          <button type="button" tabIndex={-1} className={`disclosure${isOpen ? ' is-open' : ''}`} aria-label={isOpen ? $t('„{0}“ zuklappen', label) : $t('„{0}“ aufklappen', label)} aria-expanded={isOpen}
            onClick={(e) => { e.stopPropagation(); toggleExpand(side, entry.name); }}>
            <CaretRight size={13} weight="bold" aria-hidden="true" />
          </button>
        ) : <span />}
        {entry.kind === 'dir' ? <FolderGlyph size={20} /> : <FileGlyph size={20} name={label} />}
        <span className="row-name">
          {nameEl}
          {link}
          {busyTag}
          {onlyHere && !marks && <span className="tag">{$t('nur Server')}</span>}
          {tags?.[entry.name] && <span className="tag-dots" title={tags[entry.name].map((t) => t.name).join(', ')}>{tags[entry.name].map((t) => <span key={t.name} className="tag-dot" style={{ background: tagCss(t.color) }} />)}</span>}
          {(() => { const g = gitMark(git, path, entry.name, entry.kind === 'dir'); return g ? <span className={`git-mark git-${g === '?' ? 'new' : g === '•' ? 'dir' : g}`} title={`Git: ${GIT_LABEL[g] ?? g}`}>{g === '•' ? '' : g}</span> : null; })()}
          {marks && depth === 0 && marks.get(entry.name) && <span className={`tag cmp-tag is-${marks.get(entry.name)}`}>{markLabel[marks.get(entry.name)!]}</span>}
        </span>
        {colView && (entry.kind === 'dir' ? <CaretRight size={11} weight="bold" className="miller-caret" aria-hidden="true" /> : <span />)}
        {!colView && columns.mtime && <span className="row-sub nowrap">{formatDate(entry.mtime)}</span>}
        {!colView && columns.kind && <span className="row-sub ellipsis">{kindOf(entry)}</span>}
        {!colView && showPerms && <span className="row-sub mono perms-cell">{entry.perms ? permsToText(entry.perms) : ''}</span>}
        {!colView && columns.owner && <span className="row-sub ellipsis">{entry.owner || '–'}</span>}
        {!colView && columns.size && <span className="row-sub num">{entry.kind === 'dir' ? (folderSizes[folderSizeKey(ls, sid, `${path === '/' ? '' : path}/${entry.name}`)] !== undefined ? formatSize(folderSizes[folderSizeKey(ls, sid, `${path === '/' ? '' : path}/${entry.name}`)]) : '–') : formatSize(entry.size)}</span>}
      </div>
    );
  };

  return (
    <section
      data-side={side}
      className={`pane${focusSide === side ? ' is-focused' : ''}${dropHint === '' ? ' is-drop' : ''} icon-step-${iconStep}`}
      style={{ '--cols': [columns.mtime && '124px', columns.kind && '120px', showPerms && '84px', columns.owner && '84px', columns.size && '76px'].filter(Boolean).join(' ') || '0px' } as CSSProperties}
      aria-label={onServer ? $t('Server') : $t('Lokal')}
    >
      <PlacesBar side={side} />
      <div className="pane-head">
        {/* Location button: this computer and its drives, or which server the half shows. */}
        <button type="button" className="pane-source" title={onServer ? `${server?.name ?? ''} · ${$t('Ort wechseln')}` : $t('Laufwerke und Server')} aria-label={$t('Ort wechseln')} aria-haspopup="menu"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setState({ contextMenu: { x: r.left, y: r.bottom + 4, side, names: [], kind: 'paneSource' } }); }}>
          {onServer ? <ServerTile server={server} /> : <LocalTile />}
          <ChevronDown size={11} strokeWidth={2} aria-hidden="true" />
        </button>
        {pathEdit ? <PathInput side={side} path={path} /> : <span className="crumbs" ref={crumbsRef}>
          {allCrumbs.length > crumbs.length && (
            <span className="crumb-wrap">
              <button type="button" className="crumb" title={$t('Übergeordnete Ordner')} aria-haspopup="menu"
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setState({ contextMenu: { x: r.left, y: r.bottom + 4, side, names: [], kind: 'crumbs', place: `h:${allCrumbs.length - crumbs.length}` } }); }}>…</button>
              <CaretRight className="crumb-sep" size={11} weight="bold" aria-hidden="true" />
            </span>
          )}
          {crumbs.map((c, i) => (
            <span key={c.path} className="crumb-wrap">
              {i === crumbs.length - 1 ? (
                // The folder shown, in the accent colour with a menu of the folders above it (Transmit).
                <button type="button" className="crumb is-last" title={c.path} aria-haspopup="menu" disabled={allCrumbs.length < 2}
                  onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setState({ contextMenu: { x: r.left, y: r.bottom + 4, side, names: [], kind: 'crumbs', place: 'all' } }); }}>
                  {c.name}{allCrumbs.length > 1 && <CaretDown size={11} weight="bold" aria-hidden="true" />}
                </button>
              ) : <button type="button" className="crumb" title={c.path} onClick={() => navigate(side, c.path)}>{c.name}</button>}
              {i < crumbs.length - 1 && <CaretRight className="crumb-sep" size={11} weight="bold" aria-hidden="true" />}
            </span>
          ))}
        </span>}
        {/* A click into the free space of the path bar makes it editable (like Explorer). */}
        {!pathEdit ? <span className="flex-1 path-fill" title={$t('Pfad eingeben')} onClick={() => editPath(side)} /> : null}
        {tab.syncBrowse && <button type="button" className="sync-chip" title={$t('Synchron blättern: Ordnerwechsel gilt für beide Seiten. Klicken zum Beenden.')} onClick={toggleSyncBrowse}><Link2 size={12} strokeWidth={2} aria-hidden="true" />{$t('synchron')}</button>}
        {git && (
          <button type="button" className="git-chip" title={$t('Git: Zweig {0}. Klicken für Commit, Pull und Push.', git.branch)}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setState({ contextMenu: { x: r.left, y: r.bottom + 4, side, names: [], kind: 'git' } }); }}>
            <GitBranch size={13} aria-hidden="true" />{git.branch}{git.ahead > 0 && <span> ↑{git.ahead}</span>}{git.behind > 0 && <span> ↓{git.behind}</span>}{Object.keys(git.files).length > 0 && <span className="git-chip-count">{Object.keys(git.files).length}</span>}
          </button>
        )}
        {stateLabel && <span className={`pane-state tone-${stateLabel.tone}`} title={stateLabel.text}><span className="state-dot" /><span className="pane-state-text">{stateLabel.text}</span></span>}
        {/* More columns: the same menu as a right click on the column header (Explorer), here where it can be found. */}
        {/* Icons view: size of the symbols and preview pictures (Windows' sizes, the Finder's slider). */}
        {icons && (
          <input type="range" className="icon-size" min={0} max={3} step={1} value={iconStep} aria-label={$t('Symbolgröße')}
            title={`${$t('Symbolgröße')} (${$t('Strg + Mausrad')})`} onChange={(e) => setIconSize(side, Number(e.target.value))} />
        )}
        {!icons && !colView && (
          <IconButton label={$t('Spalten wählen')} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setState({ contextMenu: { x: r.left, y: r.bottom + 4, side, names: [], kind: 'columns' } }); }}>
            <SlidersHorizontal size={18} weight="bold" />
          </IconButton>
        )}
        <span className="view-switch" role="group" aria-label={$t('Darstellung')}>
          <IconButton label={$t('Liste')} active={viewMode === 'list'} onClick={() => setViewMode(side, 'list')}><ListBullets size={18} weight="bold" /></IconButton>
          <IconButton label={$t('Symbole')} active={icons} onClick={() => setViewMode(side, 'icons')}><SquaresFour size={18} weight="duotone" /></IconButton>
          <IconButton label={$t('Spalten')} active={viewMode === 'columns'} onClick={() => setViewMode(side, 'columns')}><Columns size={18} weight="bold" /></IconButton>
        </span>
        {onServer && sshPane && (
          <IconButton label={$t('SSH-Terminal')} active={terminalOpen} onClick={() => void import('../state/terminal').then((m) => m.toggleTerminal('server'))}>
            <TerminalWindow size={18} weight="bold" />
          </IconButton>
        )}
        {onServer && (
          <IconButton label={$t('Trennen')} onClick={() => closePaneServer(side)}>
            {platform === 'mac' ? <EjectSimple size={18} weight="bold" /> : <Plugs size={18} weight="bold" />}
          </IconButton>
        )}
      </div>
      {!icons && !colView && <div className="col-head" role="row" onContextMenu={(e) => { e.preventDefault(); setState({ contextMenu: { x: e.clientX, y: e.clientY, side, names: [], kind: 'columns' } }); }}>
        {([['name', $t('Name'), ''], ...(columns.mtime ? [['mtime', $t('Geändert'), '']] : []), ...(columns.kind ? [['kind', $t('Art'), '']] : []), ...(showPerms ? [['perms', $t('Rechte'), '']] : []), ...(columns.owner ? [['owner', $t('Besitzer'), '']] : []), ...(columns.size ? [['size', $t('Größe'), 'num']] : [])] as Array<[SortKey, string, string]>).map(([key, label, cls]) => (
          <button key={key} type="button" role="columnheader" className={`col-btn ${cls}${sort.key === key ? ' is-sorted' : ''}`} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} title={$t('Klicken zum Sortieren')} onClick={() => setSort(side, key)}>
            <span className="ellipsis">{label}</span>
            {/* Every column shows that it can sort: the active one with its direction, the others with a quiet double arrow. */}
            {sort.key === key
              ? (sort.dir === 1 ? <CaretUp size={12} weight="bold" aria-hidden="true" /> : <CaretDown size={12} weight="bold" aria-hidden="true" />)
              : <CaretUpDown size={12} weight="bold" className="col-sort-hint" aria-hidden="true" />}
          </button>
        ))}
      </div>}

      {offline && offlineInfo && (
        <div role="alert" className="offline-box">
          <span className="offline-title"><WifiOff size={16} strokeWidth={1.5} aria-hidden="true" />{$t('Verbindung unterbrochen')}</span>
          <span className="small text-2">
            {$t('Neuer Versuch in {0} Sek. ({1} von 10). Die Überwachung sammelt weiter: wartende Dateien werden hochgeladen, sobald die Verbindung steht.', Math.max(1, Math.ceil((offlineInfo.nextRetry - now) / 1000)), offlineInfo.attempt)}
          </span>
          <span className="row-buttons">
            <Button variant="primary" onClick={() => reconnect(sid)}>{$t('Jetzt verbinden')}</Button>
            <Button onClick={() => setState({ dialog: { type: 'log' } })}>{$t('Protokoll')}</Button>
          </span>
        </div>
      )}

      {!offline && isVault && (
        <div role="note" className="offline-box">
          <span className="offline-title tone-accent"><Lock size={16} aria-hidden="true" />{$t('Cryptomator-Tresor')}</span>
          <span className="small text-2">{$t('Die Dateien in diesem Ordner sind verschlüsselt. Entsperrt zeigt Bitcrane sie im Klartext, in einem eigenen Tab.')}</span>
          <span className="row-buttons"><Button variant="primary" onClick={() => unlockVault(side)}>{$t('Entsperren …')}</Button></span>
        </div>
      )}

      <div
        ref={listRef}
        role="listbox"
        aria-label={onServer ? $t('Dateien auf dem Server') : $t('Dateien lokal')}
        aria-multiselectable="true"
        tabIndex={0}
        className={`list${icons ? ' is-icons' : ''}${colView ? ' is-columns' : ''}${offline ? ' is-dim' : ''}`}
        onFocus={() => setFocusSide(side)}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('icon-grid')) clearPaneSelection(side); }}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('icon-grid')) {
            e.preventDefault();
            clearPaneSelection(side);
            setState({ contextMenu: { x: e.clientX, y: e.clientY, side, names: [] } });
          }
        }}
      >
        {/* ".." to the folder above (WinSCP, Total Commander): Windows on by default, the Mac off.
            Always the first row, also above the "Dieser Ordner ist leer" note. */}
        {!deep && !icons && !colView && !search && !status.notConnected && !status.error && (parentRowOn ?? platformWin) && canGoUp(side) && (
          <div role="option" aria-selected={false} className="row parent-row" title={$t('Übergeordneter Ordner (Doppelklick)')}
            onMouseDown={(e) => { if (e.button === 0) { listRef.current?.focus({ preventScroll: true }); clearPaneSelection(side); } }}
            onDoubleClick={() => goUp(side)}>
            <span className="row-bar" />
            <span />
            <span className="parent-glyph"><ArrowElbowLeftUp size={16} weight="bold" aria-hidden="true" /></span>
            <span className="row-name"><span className="ellipsis">..</span></span>
          </div>
        )}
        {!offline && status.notConnected && (
          <div className="empty-list">
            {status.connecting
              ? <span className="row-inline"><Loader2 size={14} strokeWidth={1.75} className="spin" aria-hidden="true" />{$t('Verbinde mit')}{' '}{server?.name ?? $t('dem Server')} …</span>
              : <><span className="row-inline"><PlugZap size={14} strokeWidth={1.75} aria-hidden="true" />{$t('Nicht verbunden')}</span>
                <span className="row-buttons"><Button variant="primary" onClick={() => reconnect(sid)}>{$t('Verbinden')}</Button></span></>}
          </div>
        )}
        {!status.notConnected && status.error && (
          <div className="empty-list">{status.error}<span className="small muted">{path}</span></div>
        )}
        {!status.notConnected && !status.error && status.loading && entries.length === 0 && (
          <div className="empty-list"><span className="row-inline"><Loader2 size={14} strokeWidth={1.75} className="spin" aria-hidden="true" />{$t('Wird gelesen …')}</span></div>
        )}
        {!deep && !status.notConnected && !status.error && !status.loading && entries.length === 0 && (
          <div className="empty-list">{search ? $t('Nichts gefunden für „{0}“.', search) : $t('Dieser Ordner ist leer.')}<span className="small muted">{tab.leftServerId || bothLocal ? $t('Dateien aus der anderen Hälfte hierher ziehen, um sie zu übertragen.') : side === 'remote' ? $t('Dateien von links hierher ziehen, um sie hochzuladen.') : $t('Dateien von rechts hierher ziehen, um sie herunterzuladen.')}</span></div>
        )}
        {deep && (
          <>
            <div className="deep-head" role="presentation">
              {deep.loading ? <><Loader2 size={13} className="spin" aria-hidden="true" />{$t('Suche in Unterordnern von')}{' '}{deep.base} …</> : deep.error ? <span className="tone-danger">{deep.error}</span>
                : <>{deep.results.length ? $t('{0}{1} {2} in Unterordnern', deep.results.length, deep.more ? '+' : '', deep.results.length === 1 ? $t('Treffer') : $t('Treffer')) : $t('Nichts gefunden für „{0}“ in {1} und Unterordnern.', deep.query, deep.base)}</>}
            </div>
            {deep.results.map((r) => (
              <div key={r.path} role="option" aria-selected={false} className="row" title={r.path} onDoubleClick={() => revealSearchResult(side, r.path)}
                onMouseDown={(e) => { if (e.button === 0) listRef.current?.focus({ preventScroll: true }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') revealSearchResult(side, r.path); }} tabIndex={-1}>
                <span className="row-bar" />
                <span />
                <FileGlyph size={20} name={r.rel} />
                <span className="row-name"><span className="ellipsis">{r.rel.split('/').pop()}</span>{r.rel.includes('/') && <span className="result-path ellipsis">{r.rel.split('/').slice(0, -1).join('/')}</span>}</span>
                {columns.mtime && <span className="row-sub nowrap">{formatDate(r.mtime)}</span>}
                {columns.kind && <span className="row-sub" />}
                {showPerms && <span className="row-sub" />}
                {columns.owner && <span className="row-sub" />}
                {columns.size && <span className="row-sub num">{formatSize(r.size)}</span>}
              </div>
            ))}
          </>
        )}
        {!deep && colView && (
          <div className="miller">
            {parentDir && (
              <div className="miller-col is-parent" ref={parentColRef} aria-label={$t('Übergeordneter Ordner')}>
                {(parentRows ?? []).map((e) => sideRow(e, e.name === paths.basename(path), () => { if (e.kind === 'dir' && e.name !== paths.basename(path)) navigate(side, paths.join(parentDir, e.name)); else if (e.kind === 'file') revealSearchResult(side, paths.join(parentDir, e.name)); }, () => activateEntry(side, e.name)))}
              </div>
            )}
            <div className="miller-col is-current" onMouseDown={(e) => { if (e.target === e.currentTarget) clearPaneSelection(side); }}>
              {entries.map((entry, index) => item(entry, index))}
            </div>
            <div className="miller-col is-child">
              {childDir && childRows && childRows.length === 0 && <div className="miller-empty small muted">{$t('Leer')}</div>}
              {childDir && (childRows ?? []).map((e) => sideRow(e, false, () => revealSearchResult(side, paths.join(childDir, e.name)), () => {}))}
              {!childDir && chosen && <div className="miller-empty small muted">{chosen.name}<span>{formatSize(chosen.size)} · {formatDate(chosen.mtime)}</span></div>}
            </div>
          </div>
        )}
        {!deep && !colView && (icons ? <div className="icon-grid">{entries.map((entry, index) => item(entry, index))}</div> : entries.map((entry, index) => item(entry, index)))}
      </div>

      <div className="pane-foot">
        <span className="flex-1">{footText}</span>
        {marks && marks.size > 0 && <Button small variant="ghost" onClick={() => selectDifferences(side)} title={$t('Alles auswählen, was drüben fehlt oder hier neuer ist')}>{$t('Unterschiede auswählen')}</Button>}
        {marks && side === 'remote' && <Button small variant="ghost" onClick={toggleCompareDirs}>{$t('Vergleich beenden')}</Button>}
        {/* Two local halves (Total Commander): copy or move into the other half's folder. */}
        {bothLocal && selectedCount > 0 && (
          <>
            <Button onClick={() => moveToOtherHalf(side)} title={$t('In den Ordner der anderen Hälfte verschieben')}>{$t('Verschieben')}</Button>
            <Button variant="primary" onClick={() => (side === 'local' ? upload() : download())} title={$t('In den Ordner der anderen Hälfte kopieren')}>
              {side === 'local' ? <ArrowRight size={14} strokeWidth={2} aria-hidden="true" /> : <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />}{$t('Kopieren')}
            </Button>
          </>
        )}
        {!bothLocal && side === 'local' && selectedCount > 0 && !!tab.serverId && (
          <Button variant="primary" onClick={() => upload()} disabled={isOffline(tab.serverId) || offline}>
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />{tab.leftServerId ? $t('Übertragen') : $t('Hochladen')}
          </Button>
        )}
        {!bothLocal && side === 'remote' && selectedCount > 0 && !offline && (
          <Button variant="primary" onClick={() => download()}>
            {tab.leftServerId ? <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" /> : <Download size={14} strokeWidth={2} aria-hidden="true" />}{tab.leftServerId ? $t('Übertragen') : $t('Herunterladen')}
          </Button>
        )}
      </div>
    </section>
  );
}
