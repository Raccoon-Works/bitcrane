/**
 * Server list inside a half (after Transmit 5's connection panel): the saved
 * servers with their groups, "Zuletzt verbunden" and saved comparisons, and a
 * second tab "Schnell verbinden" with a small form. A double click (or Enter)
 * connects the server right in this half.
 */
import { ArrowLeft, X } from './glyphs';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowsClockwise,
  ClockCounterClockwise,
  FolderSimple,
  GlobeHemisphereWest,
  SidebarSimple,
  FolderSimplePlus,
  DownloadSimple,
  Globe,
  Lightning,
  Plus as PlusP,
  Stack,
} from '@phosphor-icons/react';
import { isCloudProtocol, type PaneSide, type Protocol, type Server } from '../backend/types';
import { addCloudService } from '../state/cloud';

import {
  activeTab,
  addServerGroup,
  getState,
  importSshConfig,
  LIVE,
  renameServerGroup,
  serverGroupNames,
  openDialog,
  openServerIn,
  openSyncFavorite,
  setLeftServer,
  setPaneServerList,
  setRightLocal,
  setState,
  updateSettings,
  useStore,
} from '../state/store';
import { formatAgo } from '../util/format';

import { scheduleLabel } from '../state/scheduler';
import { CloudServicesIcon, CloudTile, LocalTile, ServerTile, type CloudService } from './ServerTile';
import { ResizeHandle } from './ResizeHandle';
import { IconButton } from './ui';
import { $t } from '../i18n';
import { addressOf, hostOf } from '../util/serverAddress';
import { isSftp } from '../util/protocols';
import { QuickForm } from './QuickForm';
import { Welcome } from './ServerListWelcome';
import { useServerDrag } from './useServerDrag';

export function ServerList({ side }: { side: PaneSide }) {
  const [tab, setTab] = useState<'servers' | 'quick'>('servers');
  const sourcesHidden = useStore((s) => !!s.settings.serverSourcesHidden);
  const t = useStore((s) => activeTab(s));
  // Back to the files: possible unless the right half has no server yet.
  const canGoBack = !!t && (side === 'local' || !!t.serverId || !!t.rightLocal);
  return (
    <div className="server-panel">
      <div className="server-panel-head">
        <span className="server-panel-side">
          {/* A small globe in the corner marks the connection card (Transmit). */}
          <span className="server-panel-mark" aria-hidden="true">
            <GlobeHemisphereWest size={18} weight="fill" />
          </span>
          {tab === 'servers' && (
            <IconButton
              label={sourcesHidden ? $t('Gruppen einblenden') : $t('Gruppen ausblenden')}
              active={!sourcesHidden}
              onClick={() => updateSettings({ serverSourcesHidden: !sourcesHidden })}
            >
              <SidebarSimple size={17} />
            </IconButton>
          )}
          {canGoBack && (
            <IconButton label={$t('Zurück zu den Dateien')} onClick={() => setPaneServerList(side, false)}>
              <ArrowLeft size={15} strokeWidth={1.75} />
            </IconButton>
          )}
        </span>
        <div role="tablist" aria-label={$t('Verbinden')} className="server-panel-tabs">
          {/* Two ways, two colours (Transmit): saved servers in Bitcrane blue, quick connect in green. */}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'servers'}
            className={`tab-servers${tab === 'servers' ? ' is-on' : ''}`}
            onClick={() => setTab('servers')}
          >
            <Globe size={18} weight="duotone" aria-hidden="true" />
            {$t('Server')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'quick'}
            className={`tab-quick${tab === 'quick' ? ' is-on' : ''}`}
            onClick={() => setTab('quick')}
          >
            <Lightning size={18} weight="fill" aria-hidden="true" />
            {$t('Schnell verbinden')}
          </button>
        </div>
        <span className="server-panel-side is-right">
          {/* Close the server list (WinSCP's login window can be closed too): the half then shows this computer. */}
          <IconButton
            label={
              side === 'remote'
                ? $t('Serverliste schließen, Ordner dieses Computers zeigen')
                : $t('Serverliste schließen')
            }
            onClick={() => (side === 'remote' ? setRightLocal() : setPaneServerList('local', false))}
          >
            <X size={16} strokeWidth={2} />
          </IconButton>
        </span>
      </div>
      {tab === 'servers' ? <Servers side={side} onQuick={() => setTab('quick')} /> : <QuickForm side={side} />}
      {tab === 'servers' && <ServerFoot />}
    </div>
  );
}

/** What the right column of the server list shows (left column of Transmit's connection panel). */
type Source = 'all' | 'recent' | 'syncs' | 'cloud' | `g:${string}`;

/** Cloud services that can be added. */
const CLOUD_SERVICES: Array<{ id: CloudService; protocol?: Protocol; name: string }> = [
  { id: 'dropbox', protocol: 'dropbox', name: 'Dropbox' },
  { id: 'gdrive', protocol: 'gdrive', name: 'Google Drive' },
  { id: 'onedrive', protocol: 'onedrive', name: 'OneDrive' },
];

function Servers({ side, onQuick }: { side: PaneSide; onQuick: () => void }) {
  const servers = useStore((s) => s.servers);
  const offline = useStore((s) => s.offline);
  const now = useStore((s) => s.now);
  const platform = useStore((s) => s.platform);
  const syncFavorites = useStore((s) => s.settings.syncFavorites);
  const t = useStore((s) => activeTab(s));
  // The toolbar search field filters the server list while this half has the focus (Transmit).
  const filter = useStore((s) => (s.searchSide === side ? s.search : ''));
  const allGroups = useStore((s) => serverGroupNames(s).join('\n'));
  const renamingGroup = useStore((s) => s.renamingGroup);
  const [source, setSource] = useState<Source>('all');
  const sourcesWidth = useStore((s) => s.settings.serverSourcesWidth ?? 200);
  const sourcesHidden = useStore((s) => !!s.settings.serverSourcesHidden);
  const [selected, setSelected] = useState<string | null>(null);
  const { drag, begin, wasDrag } = useServerDrag();
  const saved = servers.filter((x) => !x.temporary);
  const groupList = allGroups.split('\n').filter(Boolean);
  const q = filter.trim().toLowerCase();
  // "Verlauf": quick connections and the servers used last.
  const recent = useMemo(
    () =>
      servers
        .filter((x) => x.temporary || x.lastUsed)
        .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
        .slice(0, 12),
    [servers],
  );
  // A search always looks through all servers.
  const view: Source = q ? 'all' : source.startsWith('g:') && !groupList.includes(source.slice(2)) ? 'all' : source;
  const cloudAvailable = useStore((s) => s.cloudAvailable);
  const cloudServers = saved.filter((x) => isCloudProtocol(x.protocol));
  const shown =
    view === 'cloud'
      ? []
      : view === 'recent'
        ? recent
        : view.startsWith('g:')
          ? saved.filter((x) => x.group.trim() === view.slice(2))
          : q
            ? saved.filter((x) => `${x.name} ${x.host} ${x.user} ${x.group}`.toLowerCase().includes(q))
            : saved;
  const leftOnServer = side === 'local' && !!t?.leftServerId;
  // The right half can show this computer too (two local halves, Total Commander).
  const rightCanBeLocal = side === 'remote';
  // Servers set to open as a terminal (SSH only) get their terminal tab; the files stay in the context menu.
  const open = (id: string) => {
    const srv = getState().servers.find((x) => x.id === id);
    if (srv?.openAs === 'terminal' && isSftp(srv))
      void import('../state/terminal').then((m) => m.openServerTerminal(id));
    else openServerIn(side, id);
  };
  const menuFor = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setSelected(id);
    setState({ contextMenu: { x: e.clientX, y: e.clientY, side, names: [], kind: 'server', serverId: id } });
  };

  // Nothing saved yet: the welcome text sits where the list would be; the column on the left stays (Verlauf, Cloud-Dienste).
  const welcome = !saved.length && !recent.length && !q && view === 'all';

  const sourceItem = (id: Source, label: ReactNode, icon: ReactNode, count: number, group?: string) => (
    <div
      key={id}
      role="option"
      aria-selected={view === id}
      tabIndex={0}
      className={`source-item${view === id ? ' is-sel' : ''}${drag && group !== undefined && drag.target === null && drag.group === group ? ' is-drop' : ''}`}
      // Servers dragged onto a group (or "Alle Server") move into it.
      data-server-group={group}
      onClick={() => setSource(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setSource(id);
      }}
      onDoubleClick={() => {
        if (group) setState({ renamingGroup: group });
      }}
      onContextMenu={(e) => {
        if (!group) return;
        e.preventDefault();
        setState({ contextMenu: { x: e.clientX, y: e.clientY, side, names: [], kind: 'serverGroup', group } });
      }}
      title={group ? $t('Doppelklick zum Umbenennen') : undefined}
    >
      <span className="source-icon">{icon}</span>
      <span className="source-name ellipsis">
        {group && renamingGroup === group ? <GroupNameInput name={group} /> : label}
      </span>
      {count > 0 && <span className="source-count">{count}</span>}
    </div>
  );

  const row = (srv: Server) => {
    const state = offline[srv.id]
      ? $t('Verbindung unterbrochen')
      : srv.online
        ? $t('verbunden')
        : $t('nicht verbunden');
    const sub =
      view === 'recent'
        ? srv.temporary
          ? `${hostOf(srv)} · ${$t('nicht gespeichert')}`
          : `${hostOf(srv)} · ${formatAgo(srv.lastUsed ?? 0, now)}`
        : hostOf(srv);
    return (
      <div
        key={srv.id}
        role="option"
        aria-selected={selected === srv.id}
        tabIndex={0}
        data-server-id={srv.id}
        data-group={srv.group.trim()}
        className={`server-row${selected === srv.id ? ' is-sel' : ''}${drag?.id === srv.id ? ' is-dragged' : ''}${drag?.target === srv.id ? (drag.after ? ' drop-after' : ' drop-before') : ''}`}
        title={`${srv.name}\n${(srv.protocol ?? 'sftp').toUpperCase()} · ${addressOf(srv)} · ${state}${srv.note ? `\n${srv.note}` : ''}\n${$t('Doppelklick zum Verbinden')}`}
        onPointerDown={(e) => {
          if (!q && !srv.temporary && view !== 'recent') begin(e, srv.id);
        }}
        onClick={() => {
          if (!wasDrag()) setSelected(srv.id);
        }}
        onDoubleClick={() => open(srv.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') open(srv.id);
        }}
        onContextMenu={(e) => menuFor(e, srv.id)}
      >
        {/* One calm line as in Transmit: symbol, name, and the address quietly on the right. */}
        <ServerTile server={srv} size={20} />
        <span className="server-row-name ellipsis">{srv.name}</span>
        {(srv.online || offline[srv.id]) && (
          <span className={`server-row-lamp${offline[srv.id] ? ' is-warn' : ''}`} title={state} />
        )}
        <span className="server-row-sub ellipsis">{sub}</span>
        <span className="vh">, {state}</span>
      </div>
    );
  };

  // "Hinzufügen" rows of the cloud services: sign in through the browser.
  const cloudAddRow = (c: (typeof CLOUD_SERVICES)[number]) => {
    // Google Drive works with the user's own app key (asked for on the first double click).
    const ready =
      !!c.protocol &&
      (c.protocol === 'dropbox' || c.protocol === 'onedrive' ? cloudAvailable[c.protocol] || !LIVE : true);
    const add = () => {
      if (c.protocol) void addCloudService(c.protocol);
    };
    return (
      <div
        key={`add-${c.id}`}
        role="option"
        aria-selected={false}
        aria-disabled={!ready}
        tabIndex={ready ? 0 : -1}
        className={`server-row${ready ? '' : ' is-preview'}`}
        title={ready ? $t('Doppelklick: bei {0} anmelden', c.name) : $t('Kommt mit einem der nächsten Updates.')}
        onDoubleClick={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add();
        }}
      >
        <CloudTile service={c.id} size={20} />
        <span className="server-row-name ellipsis">{c.name}</span>
        <span className="server-row-sub ellipsis">{ready ? $t('Doppelklick: anmelden') : $t('bald')}</span>
      </div>
    );
  };

  return (
    <div className={`server-split${sourcesHidden ? ' no-sources' : ''}`}>
      <div className="server-sources" role="listbox" aria-label={$t('Gruppen')} style={{ width: sourcesWidth }}>
        {sourceItem('all', $t('Alle Server'), <Stack size={22} weight="fill" />, saved.length, '')}
        {groupList.map((g) =>
          sourceItem(
            `g:${g}`,
            g,
            <FolderSimple size={22} weight="fill" />,
            saved.filter((x) => x.group.trim() === g).length,
            g,
          ),
        )}
        <span className="source-sep" />
        {sourceItem('recent', $t('Verlauf'), <ClockCounterClockwise size={22} weight="bold" />, 0)}
        {!q && sourceItem('cloud', $t('Cloud-Dienste'), <CloudServicesIcon size={22} />, cloudServers.length)}
        {syncFavorites.length > 0 &&
          sourceItem('syncs', $t('Abgleiche'), <ArrowsClockwise size={22} weight="duotone" />, syncFavorites.length)}
      </div>
      <ResizeHandle
        orientation="vertical"
        label={$t('Breite der Gruppenspalte (ziehen, Doppelklick: zurücksetzen)')}
        value={sourcesWidth}
        min={140}
        max={360}
        step={10}
        toValue={(start, d) => start + d}
        onChange={(v) => updateSettings({ serverSourcesWidth: Math.round(v) })}
        onReset={() => updateSettings({ serverSourcesWidth: 200 })}
        className="sources-handle"
      />
      <div className="server-body" role="listbox" aria-label={$t('Server')}>
        {leftOnServer && view === 'all' && (
          // The left half can go back to this computer from here.
          <div
            role="option"
            aria-selected={false}
            tabIndex={0}
            className="server-row"
            title={$t('Doppelklick: links wieder diesen Computer zeigen')}
            onDoubleClick={() => {
              setLeftServer('');
              setPaneServerList('local', false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setLeftServer('');
                setPaneServerList('local', false);
              }
            }}
          >
            <LocalTile size={20} />
            <span className="server-row-name">{platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC')}</span>
          </div>
        )}
        {welcome && <Welcome onQuick={onQuick} />}
        {rightCanBeLocal && view === 'all' && !q && !welcome && (
          <div
            role="option"
            aria-selected={false}
            tabIndex={0}
            className="server-row"
            title={$t('Doppelklick: rechts Ordner dieses Computers zeigen (zwei lokale Hälften)')}
            onDoubleClick={() => setRightLocal()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setRightLocal();
            }}
          >
            <LocalTile size={20} />
            <span className="server-row-name">{platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC')}</span>
            <span className="server-row-sub ellipsis">{$t('Ordner dieses Computers')}</span>
          </div>
        )}
        {view === 'syncs'
          ? syncFavorites.map((f) => {
              const srv = servers.find((x) => x.id === f.serverId);
              // Which places the comparison connects: this computer, a server, or two servers.
              const here = platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC');
              const leftName = f.leftServerId
                ? (servers.find((x) => x.id === f.leftServerId)?.name ?? $t('Server fehlt'))
                : here;
              const rightName = f.rightLocal ? here : (srv?.name ?? $t('Server fehlt'));
              return (
                <div
                  key={f.id}
                  role="option"
                  aria-selected={false}
                  tabIndex={0}
                  className="server-row"
                  title={`${leftName}: ${f.local} ↔ ${rightName}: ${f.remote}`}
                  onDoubleClick={() => openSyncFavorite(f.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') openSyncFavorite(f.id);
                  }}
                >
                  <span className="server-glyph">
                    <ArrowsClockwise size={20} weight="duotone" />
                  </span>
                  <span className="server-row-name ellipsis">{f.name}</span>
                  <span
                    className="server-row-sub ellipsis"
                    title={f.lastResult ? `${$t('Zuletzt')}: ${f.lastResult}` : undefined}
                  >
                    {`${leftName} ↔ ${rightName}`}
                    {f.schedule ? ` · ${scheduleLabel(f)}` : ''}
                  </span>
                  <button
                    type="button"
                    className="server-row-remove"
                    aria-label={$t('Abgleich {0} entfernen', f.name)}
                    onClick={() => updateSettings({ syncFavorites: syncFavorites.filter((x) => x.id !== f.id) })}
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </div>
              );
            })
          : shown.map(row)}
        {view === 'cloud' && cloudServers.map(row)}
        {view === 'cloud' && cloudServers.length > 0 && (
          <div className="server-subhead" role="presentation">
            {$t('Weitere hinzufügen')}
          </div>
        )}
        {view === 'cloud' && CLOUD_SERVICES.map(cloudAddRow)}
        {!shown.length && !welcome && view !== 'syncs' && view !== 'cloud' && (
          <p className="server-empty">
            {q
              ? $t('Kein Server passt zu „{0}“.', filter)
              : view.startsWith('g:')
                ? $t('Diese Gruppe ist leer. Server aus „Alle Server“ hierher ziehen.')
                : $t('Noch nichts verbunden.')}
          </p>
        )}
      </div>
    </div>
  );
}

/** Inline name field of a group title (after "Neue Gruppe" or a double click). */
function GroupNameInput({ name }: { name: string }) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="rename-input group-input"
      value={value}
      aria-label={$t('Name der Gruppe')}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') renameServerGroup(name, value);
        if (e.key === 'Escape') setState({ renamingGroup: null });
      }}
      onBlur={() => renameServerGroup(name, value)}
    />
  );
}

/** Bottom bar of the server list (Transmit): add a server, add a group, take over servers. */
function ServerFoot() {
  return (
    <div className="server-foot">
      <IconButton label={$t('Server hinzufügen')} tipBelow={false} onClick={() => openDialog({ type: 'serverEdit' })}>
        <PlusP size={20} weight="bold" />
      </IconButton>
      <IconButton label={$t('Neue Gruppe')} tipBelow={false} onClick={addServerGroup}>
        <FolderSimplePlus size={20} weight="duotone" />
      </IconButton>
      <IconButton label={$t('Server aus anderen Programmen übernehmen')} tipBelow={false} onClick={importSshConfig}>
        <DownloadSimple size={20} weight="bold" />
      </IconButton>
    </div>
  );
}
