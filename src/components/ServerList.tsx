/**
 * Server list inside a half (after Transmit 5's connection panel): the saved
 * servers with their groups, "Zuletzt verbunden" and saved comparisons, and a
 * second tab "Schnell verbinden" with a small form. A double click (or Enter)
 * connects the server right in this half.
 */
import { ArrowLeft, Plus, SquareTerminal, X, Zap } from './glyphs';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowsClockwise, ClockCounterClockwise, FolderSimple, GlobeHemisphereWest, FolderSimplePlus, DownloadSimple, Globe, Lightning, Plus as PlusP, Stack } from '@phosphor-icons/react';
import { isCloudProtocol, type PaneSide, type Protocol, type Server } from '../backend/types';
import { addCloudService } from '../state/cloud';
import { tauriBackend as backend } from '../backend/tauriBackend';
import {
  activeTab, addServerGroup, getState, importSshConfig, LIVE, moveServer, renameServerGroup, serverGroupNames, openDialog, openServerIn, openSyncFavorite, quickConnect, setLeftServer,
  setPaneServerList, setRightLocal, setState, updateSettings, useStore,
} from '../state/store';
import { formatAgo } from '../util/format';
import { BMark } from './icons';
import { scheduleLabel } from '../state/scheduler';
import { CloudServicesIcon, CloudTile, LocalTile, ServerTile, type CloudService } from './ServerTile';
import { ResizeHandle } from './ResizeHandle';
import { Button, IconButton, Select, TextField } from './ui';
import { $t } from '../i18n';

/** Address shown next to a server name ("user@host" plus a port other than the default). */
export function addressOf(x: Server): string {
  // Cloud services: the signed-in account.
  if (isCloudProtocol(x.protocol)) return x.user || x.host;
  // S3: bucket and service; the access key is no user name worth showing.
  if (x.protocol === 's3') return `${x.s3Bucket ? `${x.s3Bucket} · ` : ''}${x.host}`;
  const defaults: Record<string, number> = { sftp: 22, ftp: 21, ftps: x.implicitTls ? 990 : 21, webdav: x.davHttps === false ? 80 : 443 };
  const port = x.port !== defaults[x.protocol ?? 'sftp'] ? `:${x.port}` : '';
  return `${x.user ? `${x.user}@` : ''}${x.host}${port}`;
}

/** Short address for the list: the host (and a port other than the default); the user is in the tooltip. */
export function hostOf(x: Server): string {
  if (isCloudProtocol(x.protocol) || x.protocol === 's3') return addressOf(x);
  const full = addressOf(x);
  return full.includes('@') ? full.slice(full.lastIndexOf('@') + 1) : full;
}

/**
 * Reordering servers by dragging. Dropping on the upper half of a server puts
 * the dragged one before it, on the lower half after it; it joins that group.
 */
function useServerDrag() {
  const [drag, setDrag] = useState<{ id: string; target: string | null; after: boolean; group: string } | null>(null);
  const moved = useRef(false);
  const begin = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const startY = e.clientY;
    moved.current = false;
    let current: { target: string | null; after: boolean; group: string } | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved.current && Math.abs(ev.clientY - startY) < 5) return;
      moved.current = true;
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-server-id], [data-server-group]');
      if (!el) { current = null; setDrag({ id, target: null, after: false, group: '\u0000' }); return; }
      if (el.dataset.serverId) {
        const r = el.getBoundingClientRect();
        current = { target: el.dataset.serverId, after: ev.clientY > r.top + r.height / 2, group: el.dataset.group ?? '' };
      } else current = { target: null, after: true, group: el.dataset.serverGroup ?? '' };
      setDrag({ id, ...current });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-dragging-server');
      const c = current;
      if (moved.current && c) {
        const servers = getState().servers.filter((x) => !x.temporary && x.group.trim() === c.group.trim() && x.id !== id);
        let before: string | null = c.target;
        if (c.target && c.after) {
          const i = servers.findIndex((x) => x.id === c.target);
          before = servers[i + 1]?.id ?? null;
        }
        moveServer(id, before, c.group);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.classList.add('is-dragging-server');
  };
  /** True right after a drag, so the click that ends it does not select. */
  const wasDrag = () => { const m = moved.current; moved.current = false; return m; };
  return { drag, begin, wasDrag };
}

export function ServerList({ side }: { side: PaneSide }) {
  const [tab, setTab] = useState<'servers' | 'quick'>('servers');
  const t = useStore((s) => activeTab(s));
  // Back to the files: possible unless the right half has no server yet.
  const canGoBack = !!t && (side === 'local' || !!t.serverId || !!t.rightLocal);
  return (
    <div className="server-panel">
      <div className="server-panel-head">
        <span className="server-panel-side">
          {/* A small globe in the corner marks the connection card (Transmit). */}
          <span className="server-panel-mark" aria-hidden="true"><GlobeHemisphereWest size={18} weight="fill" /></span>
          {canGoBack && (
            <IconButton label={$t('Zurück zu den Dateien')} onClick={() => setPaneServerList(side, false)}><ArrowLeft size={15} strokeWidth={1.75} /></IconButton>
          )}
        </span>
        <div role="tablist" aria-label={$t('Verbinden')} className="server-panel-tabs">
          {/* Two ways, two colours (Transmit): saved servers in Bitcrane blue, quick connect in green. */}
          <button type="button" role="tab" aria-selected={tab === 'servers'} className={`tab-servers${tab === 'servers' ? ' is-on' : ''}`} onClick={() => setTab('servers')}>
            <Globe size={18} weight="duotone" aria-hidden="true" />{$t('Server')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'quick'} className={`tab-quick${tab === 'quick' ? ' is-on' : ''}`} onClick={() => setTab('quick')}>
            <Lightning size={18} weight="fill" aria-hidden="true" />{$t('Schnell verbinden')}
          </button>
        </div>
        <span className="server-panel-side is-right">
          {/* Close the server list (WinSCP's login window can be closed too): the half then shows this computer. */}
          <IconButton label={side === 'remote' ? $t('Serverliste schließen, Ordner dieses Computers zeigen') : $t('Serverliste schließen')}
            onClick={() => (side === 'remote' ? setRightLocal() : setPaneServerList('local', false))}>
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
  const [selected, setSelected] = useState<string | null>(null);
  const { drag, begin, wasDrag } = useServerDrag();
  const saved = servers.filter((x) => !x.temporary);
  const groupList = allGroups.split('\n').filter(Boolean);
  const q = filter.trim().toLowerCase();
  // "Verlauf": quick connections and the servers used last.
  const recent = useMemo(() => servers.filter((x) => x.temporary || x.lastUsed).sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0)).slice(0, 12), [servers]);
  // A search always looks through all servers.
  const view: Source = q ? 'all' : source.startsWith('g:') && !groupList.includes(source.slice(2)) ? 'all' : source;
  const cloudAvailable = useStore((s) => s.cloudAvailable);
  const cloudServers = saved.filter((x) => isCloudProtocol(x.protocol));
  const shown = view === 'cloud' ? [] : view === 'recent' ? recent
    : view.startsWith('g:') ? saved.filter((x) => x.group.trim() === view.slice(2))
    : q ? saved.filter((x) => `${x.name} ${x.host} ${x.user} ${x.group}`.toLowerCase().includes(q)) : saved;
  const leftOnServer = side === 'local' && !!t?.leftServerId;
  // The right half can show this computer too (two local halves, Total Commander).
  const rightCanBeLocal = side === 'remote';
  // Servers set to open as a terminal (SSH only) get their terminal tab; the files stay in the context menu.
  const open = (id: string) => {
    const srv = getState().servers.find((x) => x.id === id);
    if (srv?.openAs === 'terminal' && (!srv.protocol || srv.protocol === 'sftp')) void import('../state/terminal').then((m) => m.openServerTerminal(id));
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
      onKeyDown={(e) => { if (e.key === 'Enter') setSource(id); }}
      onDoubleClick={() => { if (group) setState({ renamingGroup: group }); }}
      onContextMenu={(e) => { if (!group) return; e.preventDefault(); setState({ contextMenu: { x: e.clientX, y: e.clientY, side, names: [], kind: 'serverGroup', group } }); }}
      title={group ? $t('Doppelklick zum Umbenennen') : undefined}
    >
      <span className="source-icon">{icon}</span>
      <span className="source-name ellipsis">{group && renamingGroup === group ? <GroupNameInput name={group} /> : label}</span>
      {count > 0 && <span className="source-count">{count}</span>}
    </div>
  );

  const row = (srv: Server) => {
    const state = offline[srv.id] ? $t('Verbindung unterbrochen') : srv.online ? $t('verbunden') : $t('nicht verbunden');
    const sub = view === 'recent' ? (srv.temporary ? `${hostOf(srv)} · ${$t('nicht gespeichert')}` : `${hostOf(srv)} · ${formatAgo(srv.lastUsed ?? 0, now)}`) : hostOf(srv);
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
        onPointerDown={(e) => { if (!q && !srv.temporary && view !== 'recent') begin(e, srv.id); }}
        onClick={() => { if (!wasDrag()) setSelected(srv.id); }}
        onDoubleClick={() => open(srv.id)}
        onKeyDown={(e) => { if (e.key === 'Enter') open(srv.id); }}
        onContextMenu={(e) => menuFor(e, srv.id)}
      >
        {/* One calm line as in Transmit: symbol, name, and the address quietly on the right. */}
        <ServerTile server={srv} size={20} />
        <span className="server-row-name ellipsis">{srv.name}</span>
        {(srv.online || offline[srv.id]) && <span className={`server-row-lamp${offline[srv.id] ? ' is-warn' : ''}`} title={state} />}
        <span className="server-row-sub ellipsis">{sub}</span>
        <span className="vh">, {state}</span>
      </div>
    );
  };

  // "Hinzufügen" rows of the cloud services: sign in through the browser.
  const cloudAddRow = (c: (typeof CLOUD_SERVICES)[number]) => {
    // Google Drive works with the user's own app key (asked for on the first double click).
    const ready = !!c.protocol && (c.protocol === 'dropbox' || c.protocol === 'onedrive' ? cloudAvailable[c.protocol] || !LIVE : true);
    const add = () => { if (c.protocol) void addCloudService(c.protocol); };
    return (
      <div key={`add-${c.id}`} role="option" aria-selected={false} aria-disabled={!ready} tabIndex={ready ? 0 : -1} className={`server-row${ready ? '' : ' is-preview'}`}
        title={ready ? $t('Doppelklick: bei {0} anmelden', c.name) : $t('Kommt mit einem der nächsten Updates.')}
        onDoubleClick={add} onKeyDown={(e) => { if (e.key === 'Enter') add(); }}>
        <CloudTile service={c.id} size={20} />
        <span className="server-row-name ellipsis">{c.name}</span>
        <span className="server-row-sub ellipsis">{ready ? $t('Doppelklick: anmelden') : $t('bald')}</span>
      </div>
    );
  };

  return (
    <div className="server-split">
      <div className="server-sources" role="listbox" aria-label={$t('Gruppen')} style={{ width: sourcesWidth }}>
        {sourceItem('all', $t('Alle Server'), <Stack size={22} weight="fill" />, saved.length, '')}
        {groupList.map((g) => sourceItem(`g:${g}`, g, <FolderSimple size={22} weight="fill" />, saved.filter((x) => x.group.trim() === g).length, g))}
        <span className="source-sep" />
        {sourceItem('recent', $t('Verlauf'), <ClockCounterClockwise size={22} weight="bold" />, 0)}
        {!q && sourceItem('cloud', $t('Cloud-Dienste'), <CloudServicesIcon size={22} />, cloudServers.length)}
        {syncFavorites.length > 0 && sourceItem('syncs', $t('Abgleiche'), <ArrowsClockwise size={22} weight="duotone" />, syncFavorites.length)}
      </div>
      <ResizeHandle orientation="vertical" label={$t('Breite der Gruppenspalte (ziehen, Doppelklick: zurücksetzen)')} value={sourcesWidth} min={140} max={360} step={10}
        toValue={(start, d) => start + d} onChange={(v) => updateSettings({ serverSourcesWidth: Math.round(v) })} onReset={() => updateSettings({ serverSourcesWidth: 200 })} className="sources-handle" />
      <div className="server-body" role="listbox" aria-label={$t('Server')}>
        {leftOnServer && view === 'all' && (
          // The left half can go back to this computer from here.
          <div role="option" aria-selected={false} tabIndex={0} className="server-row" title={$t('Doppelklick: links wieder diesen Computer zeigen')}
            onDoubleClick={() => { setLeftServer(''); setPaneServerList('local', false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { setLeftServer(''); setPaneServerList('local', false); } }}>
            <LocalTile size={20} />
            <span className="server-row-name">{platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC')}</span>
          </div>
        )}
        {welcome && <Welcome onQuick={onQuick} />}
        {rightCanBeLocal && view === 'all' && !q && !welcome && (
          <div role="option" aria-selected={false} tabIndex={0} className="server-row" title={$t('Doppelklick: rechts Ordner dieses Computers zeigen (zwei lokale Hälften)')}
            onDoubleClick={() => setRightLocal()} onKeyDown={(e) => { if (e.key === 'Enter') setRightLocal(); }}>
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
            const leftName = f.leftServerId ? servers.find((x) => x.id === f.leftServerId)?.name ?? $t('Server fehlt') : here;
            const rightName = f.rightLocal ? here : srv?.name ?? $t('Server fehlt');
            return (
              <div key={f.id} role="option" aria-selected={false} tabIndex={0} className="server-row" title={`${leftName}: ${f.local} ↔ ${rightName}: ${f.remote}`}
                onDoubleClick={() => openSyncFavorite(f.id)} onKeyDown={(e) => { if (e.key === 'Enter') openSyncFavorite(f.id); }}>
                <span className="server-glyph"><ArrowsClockwise size={20} weight="duotone" /></span>
                <span className="server-row-name ellipsis">{f.name}</span>
                <span className="server-row-sub ellipsis" title={f.lastResult ? `${$t('Zuletzt')}: ${f.lastResult}` : undefined}>{`${leftName} ↔ ${rightName}`}{f.schedule ? ` · ${scheduleLabel(f)}` : ''}</span>
                <button type="button" className="server-row-remove" aria-label={$t('Abgleich {0} entfernen', f.name)} onClick={() => updateSettings({ syncFavorites: syncFavorites.filter((x) => x.id !== f.id) })}><X size={12} strokeWidth={2} /></button>
              </div>
            );
          })
          : shown.map(row)}
        {view === 'cloud' && cloudServers.map(row)}
        {view === 'cloud' && cloudServers.length > 0 && <div className="server-subhead" role="presentation">{$t('Weitere hinzufügen')}</div>}
        {view === 'cloud' && CLOUD_SERVICES.map(cloudAddRow)}
        {!shown.length && !welcome && view !== 'syncs' && view !== 'cloud' && (
          <p className="server-empty">{q ? $t('Kein Server passt zu „{0}“.', filter) : view.startsWith('g:') ? $t('Diese Gruppe ist leer. Server aus „Alle Server“ hierher ziehen.') : $t('Noch nichts verbunden.')}</p>
        )}
      </div>
    </div>
  );
}

/** Inline name field of a group title (after "Neue Gruppe" or a double click). */
function GroupNameInput({ name }: { name: string }) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input ref={ref} className="rename-input group-input" value={value} aria-label={$t('Name der Gruppe')} spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') renameServerGroup(name, value); if (e.key === 'Escape') setState({ renamingGroup: null }); }}
      onBlur={() => renameServerGroup(name, value)} />
  );
}

/** Bottom bar of the server list (Transmit): add a server, add a group, take over servers. */
function ServerFoot() {
  return (
    <div className="server-foot">
      <IconButton label={$t('Server hinzufügen')} tipBelow={false} onClick={() => openDialog({ type: 'serverEdit' })}><PlusP size={20} weight="bold" /></IconButton>
      <IconButton label={$t('Neue Gruppe')} tipBelow={false} onClick={addServerGroup}><FolderSimplePlus size={20} weight="duotone" /></IconButton>
      <IconButton label={$t('Server aus anderen Programmen übernehmen')} tipBelow={false} onClick={importSshConfig}><DownloadSimple size={20} weight="bold" /></IconButton>
    </div>
  );
}

/** No servers yet: the first steps (the old welcome screen, now inside the half). */
function Welcome({ onQuick }: { onQuick: () => void }) {
  const [found, setFound] = useState(LIVE ? 0 : 3);
  useEffect(() => {
    if (LIVE) backend.importFind().then((r) => setFound(r.servers.length)).catch(() => undefined);
  }, []);
  return (
    <div className="server-welcome">
      <BMark variant="brand" size={72} />
      <h2 className="headline">{$t('Willkommen bei Bitcrane')}</h2>
      <p className="muted center">{$t('Verbinde dich mit einem Server. Danach kannst du einen Ordner überwachen lassen.')}</p>
      <div className="server-welcome-actions">
        <Button variant="primary" onClick={() => openDialog({ type: 'serverEdit' })}><Plus size={14} strokeWidth={2} aria-hidden="true" />{$t('Server hinzufügen')}</Button>
        <Button onClick={onQuick}><Zap size={14} strokeWidth={1.75} aria-hidden="true" />{$t('Schnell verbinden')}</Button>
        {/* The number of servers found elsewhere is a small badge, so the label stays short. */}
        <Button onClick={importSshConfig} title={found > 0 ? (found === 1 ? $t('1 Server aus anderen Programmen übernehmen') : $t('{0} Server aus anderen Programmen übernehmen', found)) : undefined}>
          <SquareTerminal size={14} strokeWidth={1.75} aria-hidden="true" />{$t('Aus anderen Programmen')}
          {found > 0 && <span className="count-badge" aria-label={found === 1 ? $t('1 Server gefunden') : $t('{0} Server gefunden', found)}>{found}</span>}
        </Button>
      </div>
    </div>
  );
}

type QuickProtocol = 'sftp' | 'ftp' | 'ftpes' | 'ftps' | 'davs' | 'dav' | 'smb';
const DEFAULT_PORT: Record<QuickProtocol, number> = { sftp: 22, ftp: 21, ftpes: 21, ftps: 990, davs: 443, dav: 80, smb: 445 };

/**
 * "Schnell verbinden" (Transmit's Quick Connect): protocol, address, user,
 * password and start folder. For SFTP an empty password means SSH agent or key.
 */
function QuickForm({ side }: { side: PaneSide }) {
  const [protocol, setProtocol] = useState<QuickProtocol>('sftp');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const platform = useStore((s) => s.platform);
  const [path, setPath] = useState('');
  const recent = useStore((s) => s.settings.recentAddresses);
  const address = () => {
    const h = host.trim();
    if (!h) return '';
    const p = port.trim() && Number(port) !== DEFAULT_PORT[protocol] ? `:${port.trim()}` : '';
    const dir = path.trim() ? (path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`) : '';
    return `${protocol}://${user.trim() ? `${user.trim()}@` : ''}${h}${p}${dir}`;
  };
  const go = (save: boolean, terminal = false) => {
    const a = address();
    if (!a) return;
    quickConnect(a, save, 'auto', side, password || undefined, terminal ? 'terminal' : undefined);
  };
  // A recent address fills the form again.
  const fill = (a: string) => {
    const m = a.match(/^(?:([a-z]+):\/\/)?(?:([^@]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/i);
    if (!m) return;
    const scheme = (m[1]?.toLowerCase() ?? 'sftp') as QuickProtocol;
    setProtocol(scheme in DEFAULT_PORT ? scheme : 'sftp');
    setUser(m[2] ?? '');
    setHost(m[3] ?? '');
    setPort(m[4] ?? '');
    setPath(m[5] ?? '');
  };
  return (
    <form className="quick-form" onSubmit={(e) => { e.preventDefault(); go(false); }}>
      <span className="quick-icon"><Lightning size={34} weight="fill" /></span>
      <h2 className="headline">{$t('Verbinden über {0}', protocolLabel(protocol))}</h2>
      <div className="quick-grid">
        <label htmlFor="q-proto">{$t('Protokoll#protocol')}</label>
        <Select id="q-proto" value={protocol} onChange={(v) => setProtocol(v as QuickProtocol)} label={$t('Protokoll#protocol')} options={(Object.keys(DEFAULT_PORT) as QuickProtocol[]).map((p) => ({ value: p, label: protocolLabel(p) }))} />
        <label htmlFor="q-host">{$t('Adresse')}</label>
        <span className="quick-host">
          <TextField id="q-host" value={host} onChange={setHost} placeholder="server.example" mono autoFocus />
          <TextField value={port} onChange={(v) => setPort(v.replace(/\D/g, ''))} placeholder={String(DEFAULT_PORT[protocol])} mono className="quick-port" label={$t('Port')} />
        </span>
        <label htmlFor="q-user">{$t('Benutzer')}</label>
        <TextField id="q-user" value={user} onChange={setUser} placeholder={protocol === 'sftp' ? 'ubuntu' : ''} mono />
        <label htmlFor="q-pass">{$t('Passwort')}</label>
        <TextField id="q-pass" type="password" value={password} onChange={setPassword} placeholder={protocol === 'sftp' ? $t('Leer: SSH-Schlüssel oder Agent') : ''} />
        <label htmlFor="q-path">{$t('Startordner')}</label>
        <TextField id="q-path" value={path} onChange={setPath} placeholder={protocol === 'smb' ? '/daten/ordner' : '/var/www'} mono />
      </div>
      <p className="small muted quick-note">{platform === 'mac'
        ? $t('Das Passwort gilt nur für diese Verbindung. Mit „Zu Servern hinzufügen“ wird es im Schlüsselbund gesichert.')
        : $t('Das Passwort gilt nur für diese Verbindung. Mit „Zu Servern hinzufügen“ wird es in der Windows-Anmeldeinformationsverwaltung gesichert.')}</p>
      <div className="quick-buttons">
        <Button onClick={() => go(true)} disabled={!host.trim()}>{$t('Zu Servern hinzufügen')}</Button>
        {/* SSH only: straight into a terminal tab, without the file view. */}
        {protocol === 'sftp' && <Button onClick={() => go(false, true)} disabled={!host.trim()}>{$t('Terminal')}</Button>}
        <Button variant="primary" type="submit" className="btn-go" disabled={!host.trim()}>{$t('Verbinden')}</Button>
      </div>
      {recent.length > 0 && (
        <div className="quick-recent">
          <span className="caption-strong">{$t('Zuletzt eingegeben')}</span>
          {recent.slice(0, 5).map((a) => (
            <button key={a} type="button" className="link small mono" onClick={() => fill(a)}>{a}</button>
          ))}
        </div>
      )}
    </form>
  );
}

function protocolLabel(p: QuickProtocol): string {
  return { sftp: 'SFTP / SSH', ftp: 'FTP', ftpes: $t('FTPS (explizit)'), ftps: $t('FTPS (implizit)'), davs: 'WebDAV (HTTPS)', dav: 'WebDAV (HTTP)', smb: $t('SMB (Windows-Freigabe, NAS)') }[p];
}
