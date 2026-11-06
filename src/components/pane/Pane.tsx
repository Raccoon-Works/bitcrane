/**
 * One half of the main window: this computer or a server, or the server list
 * while the half has nothing connected (layout after Transmit 5).
 *
 * Top to bottom: places bar, path bar (location button, breadcrumbs, view
 * switch, eject), column header, files as a list (folders open in place with
 * the triangle, like the Finder), as icons or in columns, footer.
 *
 * Keyboard: arrows, type-to-select, Enter/⌘↓ to open, ⌘↑/Alt+↑ to go up,
 * → and ← open and close a folder in the list. Multi-selection with Shift/⌘,
 * inline rename, context menu, and drag & drop between the two halves.
 */
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { PaneSide } from '../../backend/types';
import {
  activeTab,
  canGoUp,
  clearPaneSelection,
  getState,
  listEntries,
  paneEntries,
  paneLoc,
  paneShowsServers,
  paneStatus,
  placesFor,
  setFocusSide,
  setIconSize,
  setState,
  useStore,
  watchForLocal,
} from '../../state/store';
import { compareMarks } from '../../state/tools';
import { useGit } from '../../state/git';
import { useTags } from '../../state/tags';
import { isVaultListing } from '../../state/vault';
import { PlacesBar } from '../PlacesBar';
import { ServerList } from '../ServerList';
import { swatch } from '../serverColors';
import { $t } from '../../i18n';
import { ColumnHeader } from './ColumnHeader';
import { ColumnView } from './ColumnView';
import { DeepResults } from './DeepResults';
import { FileItem, ParentRow, type ItemContext } from './ListRows';
import { ListStatus } from './ListStatus';
import { PaneFooter } from './PaneFooter';
import { PaneHead } from './PaneHead';
import { OfflineNotice, VaultNotice } from './PaneNotices';
import { useFreeSpace } from './useFreeSpace';
import { useListKeyboard } from './useListKeyboard';
import { useVirtualRows } from './useVirtualRows';

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
  const showPerms = useStore((s) => s.settings.showPerms);
  const columns = useStore((s) => s.settings.columns);
  const folderSizes = useStore((s) => s.folderSizes);
  const deep = useStore((s) =>
    s.deepSearchOn && s.search.trim() && s.searchSide === side && s.deepSearch?.side === side ? s.deepSearch : null,
  );
  const sort = useStore((s) => s.settings.sort[side]);
  const dropHint = useStore((s) =>
    s.dropHint?.side === side && !s.dropHint.place && !s.dropHint.addPlace ? s.dropHint.name : null,
  );
  const viewMode = useStore((s) => s.settings.viewMode[side]);
  // Icons view size step (0 … 3): symbol size and tile width.
  const iconStep = useStore((s) => s.settings.iconSize?.[side] ?? 0);
  const expanded = useStore((s) => s.expanded[side]);
  const showServers = useStore((s) => paneShowsServers(side, activeTab(s)));
  const parentRowOn = useStore((s) => s.settings.parentRow);
  const listRef = useRef<HTMLDivElement>(null);
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

  const path = tab ? (side === 'local' ? tab.localPath : tab.remotePath) : '';
  const server = onServer ? servers.find((x) => x.id === sid) : undefined;
  // Only a half on a server has an entry in `offline`.
  const offline = !!offlineInfo;
  const entries = useMemo(
    () => paneEntries(side),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the listing is read from the store; these values say when it changed
    [side, path, fsRev, search, showHidden, tab?.serverId, tab?.leftServerId, sort, viewMode, expanded, showServers],
  );
  // A Cryptomator vault: its folder shows the encrypted files plus a way to unlock it.
  const isVault = useMemo(() => isVaultListing(entries.map((e) => e.name)), [entries]);
  const openSet = useMemo(() => new Set(expanded), [expanded]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the status is read from the store; these values say when it changed
  const status = useMemo(() => paneStatus(side), [side, path, fsRev, tab?.serverId, tab?.leftServerId]);

  // "nur Server" tags: remote entries that are missing in the paired local folder.
  const watch = useStore((s) => (tab && !tab.leftServerId ? watchForLocal(tab.localPath, s) : undefined));
  const paired =
    !!watch &&
    !!tab &&
    watch.serverId === tab.serverId &&
    watch.remotePath + tab.localPath.slice(watch.localPath.length) === tab.remotePath;
  const otherNames = useMemo(() => {
    if (!paired || !tab) return null;
    const other = listEntries(
      side === 'local' ? 'remote' : 'local',
      tab.serverId,
      side === 'local' ? tab.remotePath : tab.localPath,
    );
    return other ? new Set(other.map((e) => e.name)) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the other half is read from the store; these values say when it changed
  }, [paired, tab?.localPath, tab?.remotePath, fsRev, side]);

  // Entries currently being uploaded (local side) or downloaded (remote side).
  const busy = useMemo(() => {
    const set = new Set<string>();
    for (const t of transfers) {
      if (t.state !== 'running' && t.state !== 'queued') continue;
      // Where the file comes from: this computer, the tab's server or (server to server) the source server.
      const from =
        t.direction === 'up'
          ? ''
          : t.direction === 'down'
            ? t.serverId
            : t.direction === 'cross'
              ? (t.sourceServerId ?? '')
              : null;
      const p = from === place ? t.source : '';
      if (p.startsWith(path + '/')) set.add(p.slice(path.length + 1).split('/')[0]);
    }
    return set;
  }, [transfers, place, path]);

  const { virtual, rowsRef, rowH, firstRow, lastRow } = useVirtualRows(
    listRef,
    viewMode === 'list' && !deep,
    entries.length,
    sel.cursor,
  );

  // "Verzeichnisse vergleichen" (WinSCP): marks for what differs from the other half.
  const compareOn = useStore((s) => s.compareDirs);
  const marks = useMemo(
    () => (compareOn ? compareMarks(side) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the marks are read from the store; these values say when it changed
    [compareOn, side, fsRev, tab?.localPath, tab?.remotePath, tab?.serverId, tab?.leftServerId, tab?.rightLocal],
  );

  const sidebarOn = useStore((s) => s.settings.sidebar !== false);
  const hasPlaces = useStore((s) => placesFor(side, s, activeTab(s)).length > 0);
  const freeSpace = useFreeSpace(path, !onServer && !!path, fsRev);
  // Column view (Finder, ForkLift); a search through subfolders shows its results as a list.
  const colView = viewMode === 'columns' && !deep;
  const icons = viewMode === 'icons';
  // Git working copies on this computer: changed files and the branch (ForkLift).
  const gitOn = useStore((s) => s.settings.gitStatus !== false);
  const git = useGit(path, !onServer && gitOn && !!path);
  // Finder tags (Mac, this computer).
  const tags = useTags(path, !onServer && !!path && platform === 'mac');
  const onKeyDown = useListKeyboard({
    side,
    listRef,
    entries,
    sel,
    renaming: !!renaming,
    icons,
    colView,
    openSet,
    path,
    platform,
  });
  // All hooks stay above the early returns below, so their order never changes.

  if (!tab) return null;

  if (showServers) {
    return (
      <section
        data-side={side}
        className={`pane is-servers${focusSide === side ? ' is-focused' : ''}`}
        aria-label={$t('Server')}
        onMouseDown={() => setFocusSide(side)}
      >
        <ServerList side={side} />
      </section>
    );
  }

  const ctx: ItemContext = {
    side,
    ls,
    sid,
    path,
    sel,
    focused: focusSide === side,
    dropHint,
    marks,
    renaming,
    otherNames,
    busy,
    openSet,
    macLocal: platform === 'mac' && !onServer,
    offline,
    icons,
    colView,
    iconStep,
    columns,
    showPerms,
    folderSizes,
    tags,
    git,
    serverToServer: !!tab.leftServerId,
    listRef,
  };
  const items = (list: typeof entries, from = 0) =>
    list.map((entry, i) => <FileItem key={entry.name} ctx={ctx} entry={entry} index={from + i} />);

  // A server with its own colour (e.g. red for a live server) tints its half's path bar (WinSCP, FileZilla).
  const srvColor = onServer && server?.color && server.color !== 'gray' ? swatch[server.color] : undefined;
  return (
    <section
      data-side={side}
      className={`pane${focusSide === side ? ' is-focused' : ''}${dropHint === '' ? ' is-drop' : ''}${srvColor ? ' has-srv-color' : ''} icon-step-${iconStep}`}
      style={
        {
          '--cols':
            [
              columns.mtime && '124px',
              columns.kind && '120px',
              showPerms && '84px',
              columns.owner && '84px',
              columns.size && '76px',
            ]
              .filter(Boolean)
              .join(' ') || '0px',
          ...(srvColor ? { '--srv-color': srvColor } : {}),
        } as CSSProperties
      }
      aria-label={onServer ? $t('Server') : $t('Lokal')}
    >
      {/* With the sidebar, only halves showing a server keep their own places (that server's folders),
          and only once there are some: an empty bar would push this half's list below the other one.
          Places are added with the folder's context menu or Gehe zu > Ordner zu den Orten hinzufügen. */}
      {(!sidebarOn || (onServer && hasPlaces)) && <PlacesBar side={side} />}
      <PaneHead
        side={side}
        tab={tab}
        path={path}
        onServer={onServer}
        server={server}
        offline={offline}
        connecting={!!status.connecting}
        git={git}
        viewMode={viewMode}
        colView={colView}
        iconStep={iconStep}
      />
      {!icons && !colView && <ColumnHeader side={side} />}

      {offlineInfo && <OfflineNotice serverId={sid} info={offlineInfo} />}

      {!offline && isVault && <VaultNotice side={side} />}

      <div
        ref={listRef}
        role="listbox"
        aria-label={onServer ? $t('Dateien auf dem Server') : $t('Dateien lokal')}
        aria-multiselectable="true"
        tabIndex={0}
        className={`list${icons ? ' is-icons' : ''}${colView ? ' is-columns' : ''}${offline ? ' is-dim' : ''}`}
        onFocus={() => setFocusSide(side)}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('icon-grid'))
            clearPaneSelection(side);
        }}
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
        {!deep &&
          !icons &&
          !colView &&
          !search &&
          !status.notConnected &&
          !status.error &&
          (parentRowOn ?? platform === 'win') &&
          canGoUp(side) && <ParentRow side={side} listRef={listRef} />}
        <ListStatus
          side={side}
          tab={tab}
          path={path}
          status={status}
          server={server}
          serverId={sid}
          empty={entries.length === 0}
          search={search}
          deep={!!deep}
          bothLocal={bothLocal}
          offline={offline}
        />
        {deep && <DeepResults side={side} deep={deep} listRef={listRef} />}
        {colView && (
          <ColumnView side={side} path={path} entries={entries} selected={sel.names} listRef={listRef}>
            {items(entries)}
          </ColumnView>
        )}
        {!deep && !colView && icons && <div className="icon-grid">{items(entries)}</div>}
        {!deep && !colView && !icons && !virtual && items(entries)}
        {virtual && (
          <div ref={rowsRef} className="rows-virtual" style={{ height: entries.length * rowH }}>
            <div style={{ transform: `translateY(${firstRow * rowH}px)` }}>
              {items(entries.slice(firstRow, lastRow), firstRow)}
            </div>
          </div>
        )}
      </div>

      <PaneFooter
        side={side}
        tab={tab}
        status={status}
        entries={entries}
        search={search}
        selectedCount={sel.names.length}
        marks={marks}
        otherNames={otherNames}
        freeSpace={freeSpace}
        bothLocal={bothLocal}
        offline={offline}
      />
    </section>
  );
}
