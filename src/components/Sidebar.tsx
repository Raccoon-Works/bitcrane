/**
 * Sidebar of the window (Finder, ForkLift): this computer only. Favourite
 * folders, the folders opened last, devices (disks, USB sticks), network
 * shares and, on the Mac, Finder tags. A click opens in the active half, which
 * is marked with an accent line. Servers keep their own small places bar above
 * their half, because those folders belong to one server.
 *
 * - Sections fold with a click on their heading (the arrow shows on hover),
 *   move by dragging the heading, and can be hidden (right click on a heading).
 * - Devices show their free space; "Freigaben" lists mounted shares and the
 *   computers in the network that offer SMB (a click sets up the connection).
 * - A folder dragged from a half onto "Favoriten" becomes a favourite.
 * - Right click on a favourite: open, copy path, move up or down, remove.
 * - Hidden and shown with the View menu (Cmd+Ctrl+S on the Mac, Ctrl+B on Windows).
 */
import { CaretDown, ClockCounterClockwise, Cloud, Desktop, DownloadSimple, FileText, FolderSimple, HardDrive, HardDrives, House, Usb, Network } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Place } from '../backend/types';
import { $t, LOCALE } from '../i18n';
import { LIVE, activeTab, getState, localPlaces, moveSidebarSection, navigate, openDialog, openPlace, setRightLocal, setState, sidebarOrder, toggleSidebarCollapsed, useStore, type SidebarSection } from '../state/store';
import { TAG_COLORS, tagName } from '../state/tags';
import { BrandLogo, isBrandService } from './BrandLogo';
import { placeLabel } from './PlacesBar';
import * as paths from '../util/paths';

const ICON = { size: 16, weight: 'regular', 'aria-hidden': true } as const;

function PlaceIcon({ place }: { place: Place }) {
  const last = place.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (isBrandService(place.cloud)) return <BrandLogo service={place.cloud} size={14} />;
  if (place.cloud) return <Cloud {...ICON} />;
  if (place.path === '~') return <House {...ICON} />;
  if (last === 'desktop' || last === 'schreibtisch') return <Desktop {...ICON} />;
  if (last === 'downloads') return <DownloadSimple {...ICON} />;
  if (last === 'documents' || last === 'dokumente') return <FileText {...ICON} />;
  return <FolderSimple {...ICON} />;
}

/** Start disk, other disks and removable drives look different (Finder). */
function DriveIcon({ drive, first }: { drive: Place; first: boolean }) {
  if (first) return <HardDrive {...ICON} />;
  if (/usb|stick/i.test(drive.name)) return <Usb {...ICON} />;
  return <HardDrives {...ICON} />;
}

/** Typical drives for the browser prototype, which has no real ones. */
function mockDrives(mac: boolean): Place[] {
  return mac
    ? [{ name: 'Macintosh HD', path: '~' }, { name: 'USB-Stick', path: '~/Downloads' }, { name: 'iMac von Elna', path: '~/Projekte/newsbot', network: true }]
    : [{ name: 'C:', path: '~' }, { name: 'D:', path: '~/Downloads' }, { name: 'Z: (NAS)', path: '~/Projekte/newsbot', network: true }];
}

/** Account part of a cloud folder's name ("GoogleDrive-name@example.com" → "name"). */
function accountOf(place: Place): string {
  const folder = place.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  if (!place.cloud || !folder.includes('-')) return '';
  return folder.slice(folder.indexOf('-') + 1).split('@')[0];
}

/**
 * Favourites as shown: a folder reached by two paths (e.g. ~/Dropbox and its
 * target in ~/Library/CloudStorage) appears once; two accounts of the same
 * service keep both entries and are told apart by the account name.
 */
function useShownPlaces(places: Place[]): Array<{ place: Place; label: string }> {
  const [real, setReal] = useState<Record<string, string>>({});
  const key = places.map((p) => p.path).join('\n');
  useEffect(() => {
    if (!LIVE || !places.length) return;
    let live = true;
    void invoke<string[]>('local_real_paths', { list: places.map((p) => p.path) })
      .then((r) => { if (live) setReal(Object.fromEntries(places.map((p, i) => [p.path, r[i] ?? p.path]))); })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const seen = new Set<string>();
  const unique = places.filter((p) => {
    const target = real[p.path] ?? p.path;
    if (seen.has(target)) return false;
    seen.add(target);
    return true;
  });
  return unique.map((p) => {
    const label = placeLabel(p);
    const twin = unique.some((o) => o !== p && placeLabel(o) === label);
    const acc = twin ? accountOf(p) : '';
    return { place: p, label: acc ? `${label} (${acc})` : label };
  });
}

/** Free space in a short form ("86 GB", "512 MB"). */
function shortSize(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 1000) return `${(gb / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} TB`;
  if (gb >= 10) return `${Math.round(gb).toLocaleString(LOCALE)} GB`;
  if (gb >= 1) return `${gb.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} GB`;
  return `${Math.round(bytes / 1e6).toLocaleString(LOCALE)} MB`;
}

/** Computers in the network with file shares (Bonjour), searched when the sidebar opens and every two minutes. */
function useNetworkHosts(enabled: boolean): Array<{ name: string; host: string }> {
  const [hosts, setHosts] = useState<Array<{ name: string; host: string }>>([]);
  useEffect(() => {
    if (!enabled) return;
    if (!LIVE) { setHosts([{ name: 'NAS Keller', host: 'nas-keller.local' }]); return; }
    let live = true;
    const run = () => void invoke<Array<{ name: string; host: string }>>('network_hosts').then((h) => { if (live) setHosts(h); }).catch(() => {});
    run();
    const t = window.setInterval(run, 120000);
    return () => { live = false; window.clearInterval(t); };
  }, [enabled]);
  return hosts;
}

const TITLES: Record<SidebarSection, () => string> = {
  favorites: () => $t('Favoriten'),
  recent: () => $t('Zuletzt verwendet'),
  devices: () => $t('Geräte'),
  shares: () => $t('Freigaben'),
  tags: () => $t('Tags'),
};

export function Sidebar() {
  const platform = useStore((s) => s.platform);
  const focus = useStore((s) => s.focusSide);
  const tab = useStore((s) => activeTab(s));
  const places = useStore((s) => localPlaces(s));
  const shown = useShownPlaces(places);
  const recentAll = useStore((s) => s.settings.recentDirs);
  const liveDrives = useStore((s) => s.drives);
  const dropHere = useStore((s) => !!s.dropHint?.sidebar);
  const savedOrder = useStore((s) => s.settings.sidebarOrder);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const order = useMemo(() => sidebarOrder(getState()), [savedOrder]);
  const collapsed = useStore((s) => s.settings.sidebarCollapsed ?? NONE);
  const hidden = useStore((s) => s.settings.sidebarHidden ?? NONE);
  const mac = platform === 'mac';
  const drives = LIVE ? liveDrives : mockDrives(mac);
  const devices = drives.filter((d) => !d.network);
  const mounted = drives.filter((d) => d.network);
  const netHosts = useNetworkHosts(!hidden.includes('shares'));
  // Computers in the network that are not mounted already.
  const others = netHosts.filter((h) => !mounted.some((m) => m.name.toLowerCase() === h.name.toLowerCase()));
  // Recent folders that are not favourites already, newest first.
  const recent = (recentAll ?? []).filter((p) => !places.some((x) => x.path === p) && p !== '~').slice(0, 5);
  // Section drag: which section is moved and where it would go.
  const [drag, setDrag] = useState<{ id: SidebarSection; before: SidebarSection | null; moved: boolean } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  // Folder of this computer shown in the active half (for the highlight).
  const activeLocal = (() => {
    if (!tab) return '';
    if (focus === 'local') return tab.leftServerId ? '' : tab.localPath;
    return tab.rightLocal && !tab.serverId ? tab.remotePath : '';
  })();

  /** Opens a folder of this computer in the active half. */
  const open = (path: string) => {
    if (focus === 'local') openPlace(path);
    else if (tab?.rightLocal && !tab.serverId) navigate('remote', path);
    else setRightLocal(path);
  };

  const item = (key: string, icon: React.ReactNode, label: string, path: string | null, onClick: () => void, extra: Partial<React.ButtonHTMLAttributes<HTMLButtonElement>> = {}, trailing?: React.ReactNode) => (
    <button key={key} type="button" className={`side-item${path !== null && activeLocal === path ? ' is-active' : ''}`} title={path ?? label} onClick={onClick} {...extra}>
      <span className="side-icon">{icon}</span>
      <span className="ellipsis">{label}</span>
      {trailing}
    </button>
  );

  /** Section heading: click folds (arrow shows on hover, Finder), drag moves the section, right click chooses sections. */
  const beginDrag = (e: React.PointerEvent, id: SidebarSection) => {
    if (e.button !== 0) return;
    const y0 = e.clientY;
    setDrag({ id, before: null, moved: false });
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.abs(ev.clientY - y0) < 5) return;
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-section]');
      let before: SidebarSection | null = d.before;
      if (el) {
        const sec = el.dataset.section as SidebarSection;
        const r = el.getBoundingClientRect();
        const list = order.filter((x) => x !== id);
        const idx = list.indexOf(sec);
        before = ev.clientY < r.top + r.height / 2 ? sec : (list[idx + 1] ?? null);
      }
      setDrag({ id, before, moved: true });
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      const d = dragRef.current;
      setDrag(null);
      if (d?.moved) moveSidebarSection(d.id, d.before);
      else toggleSidebarCollapsed(id);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  };

  const section = (id: SidebarSection, body: React.ReactNode, extra: Partial<React.HTMLAttributes<HTMLDivElement>> = {}) => {
    const folded = collapsed.includes(id);
    const marker = drag?.moved && drag.id !== id && drag.before === id;
    return (
      <div key={id} data-section={id} {...extra} className={`side-group${folded ? ' is-folded' : ''}${marker ? ' is-drop-before' : ''}${drag?.moved && drag.id === id ? ' is-dragged' : ''}`}>
        <button type="button" className="side-title" aria-expanded={!folded}
          title={$t('Klicken: ein- oder ausklappen, ziehen: verschieben')}
          onPointerDown={(e) => beginDrag(e, id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSidebarCollapsed(id); } }}
          onContextMenu={(e) => { e.preventDefault(); setState({ contextMenu: { x: e.clientX, y: e.clientY, side: focus, names: [], kind: 'sidebarSection' } }); }}>
          <span className="ellipsis">{TITLES[id]()}</span>
          <CaretDown size={11} weight="bold" className="side-caret" aria-hidden="true" />
        </button>
        {!folded && body}
      </div>
    );
  };

  const sections: Record<SidebarSection, React.ReactNode> = {
    favorites: section('favorites', <>
      {shown.map(({ place: p, label }) => item(`p:${p.path}`, <PlaceIcon place={p} />, label, p.path, () => open(p.path), {
        onContextMenu: (e) => { e.preventDefault(); setState({ contextMenu: { x: e.clientX, y: e.clientY, side: focus, names: [], kind: 'sidebarPlace', place: p.path } }); },
      }))}
      {places.length === 0 && <div className="side-empty">{$t('Ordner hierher ziehen')}</div>}
    </>, { 'data-sidebar-favs': '' } as Partial<React.HTMLAttributes<HTMLDivElement>>),
    recent: recent.length > 0 ? section('recent', recent.map((p) => item(`r:${p}`, <ClockCounterClockwise {...ICON} />, paths.basename(p) || p, p, () => open(p)))) : null,
    devices: section('devices', devices.map((d, i) => item(`d:${d.path}:${d.name}`, <DriveIcon drive={d} first={i === 0} />, d.name, d.path, () => open(d.path), {},
      d.free !== undefined ? <span className="side-free" title={$t('{0} frei', shortSize(d.free))}>{shortSize(d.free)}</span> : undefined))),
    shares: mounted.length + others.length > 0 ? section('shares', <>
      {mounted.map((d) => item(`n:${d.path}:${d.name}`, <Network {...ICON} />, d.name, d.path, () => open(d.path)))}
      {others.map((h) => item(`h:${h.host}`, <Desktop {...ICON} />, h.name, null,
        () => openDialog({ type: 'serverEdit', preset: { name: h.name, host: h.host, port: 445, protocol: 'smb' } }), { title: $t('{0} über SMB verbinden …', h.name) }))}
    </>) : null,
    tags: mac ? section('tags', TAG_COLORS.map((c) => item(`t:${c.color}`, <span className="tag-dot side-tag" style={{ background: c.css }} />, tagName(c), null,
      () => openDialog({ type: 'tagFiles', name: tagName(c), color: c.color })))) : null,
  };

  return (
    <nav className={`sidebar${dropHere ? ' is-drop-favs' : ''}${drag?.moved ? ' is-sorting' : ''}`} aria-label={$t('Seitenleiste')}>
      {order.filter((id) => !hidden.includes(id)).map((id) => sections[id])}
      {drag?.moved && drag.before === null && <div className="side-drop-end" />}
    </nav>
  );
}

const NONE: SidebarSection[] = [];
