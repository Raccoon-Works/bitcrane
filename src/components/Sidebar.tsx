/**
 * Sidebar of the window (Finder, ForkLift): this computer only. Favourite
 * folders, the folders opened last, devices (disks, USB sticks), network
 * shares and, on the Mac, Finder tags. A click opens in the active half, which
 * is marked with an accent line. Servers keep their own small places bar above
 * their half, because those folders belong to one server.
 *
 * - A folder dragged from a half onto "Favoriten" becomes a favourite.
 * - Right click on a favourite: open, copy path, move up or down, remove.
 * - Hidden and shown with the View menu (Cmd+Ctrl+S on the Mac, Ctrl+B on Windows).
 */
import { ClockCounterClockwise, Cloud, Desktop, DownloadSimple, FileText, FolderSimple, HardDrive, HardDrives, House, Usb, Network } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import type { Place } from '../backend/types';
import { $t } from '../i18n';
import { LIVE, activeTab, localPlaces, navigate, openDialog, openPlace, setRightLocal, setState, useStore } from '../state/store';
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

export function Sidebar() {
  const platform = useStore((s) => s.platform);
  const focus = useStore((s) => s.focusSide);
  const tab = useStore((s) => activeTab(s));
  const places = useStore((s) => localPlaces(s));
  const shown = useShownPlaces(places);
  const recentAll = useStore((s) => s.settings.recentDirs);
  const liveDrives = useStore((s) => s.drives);
  const width = useStore((s) => s.settings.sidebarWidth ?? 200);
  const dropHere = useStore((s) => !!s.dropHint?.sidebar);
  const mac = platform === 'mac';
  const drives = LIVE ? liveDrives : mockDrives(mac);
  const devices = drives.filter((d) => !d.network);
  const shares = drives.filter((d) => d.network);
  // Recent folders that are not favourites already, newest first.
  const recent = (recentAll ?? []).filter((p) => !places.some((x) => x.path === p) && p !== '~').slice(0, 5);

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

  const item = (key: string, icon: React.ReactNode, label: string, path: string | null, onClick: () => void, extra: Partial<React.ButtonHTMLAttributes<HTMLButtonElement>> = {}) => (
    <button key={key} type="button" className={`side-item${path !== null && activeLocal === path ? ' is-active' : ''}`} title={path ?? label} onClick={onClick} {...extra}>
      <span className="side-icon">{icon}</span>
      <span className="ellipsis">{label}</span>
    </button>
  );

  return (
    <nav className="sidebar" aria-label={$t('Seitenleiste')} style={{ width }}>
      <div className={`side-group${dropHere ? ' is-drop' : ''}`} data-sidebar-favs="">
        <div className="side-title">{$t('Favoriten')}</div>
        {shown.map(({ place: p, label }) => item(`p:${p.path}`, <PlaceIcon place={p} />, label, p.path, () => open(p.path), {
          onContextMenu: (e) => { e.preventDefault(); setState({ contextMenu: { x: e.clientX, y: e.clientY, side: focus, names: [], kind: 'sidebarPlace', place: p.path } }); },
        }))}
        {places.length === 0 && <div className="side-empty">{$t('Ordner hierher ziehen')}</div>}
      </div>
      {recent.length > 0 && (
        <div className="side-group">
          <div className="side-title">{$t('Zuletzt verwendet')}</div>
          {recent.map((p) => item(`r:${p}`, <ClockCounterClockwise {...ICON} />, paths.basename(p) || p, p, () => open(p)))}
        </div>
      )}
      <div className="side-group">
        <div className="side-title">{$t('Geräte')}</div>
        {devices.map((d, i) => item(`d:${d.path}:${d.name}`, <DriveIcon drive={d} first={i === 0} />, d.name, d.path, () => open(d.path)))}
      </div>
      {shares.length > 0 && (
        <div className="side-group">
          <div className="side-title">{$t('Freigaben')}</div>
          {shares.map((d) => item(`n:${d.path}:${d.name}`, <Network {...ICON} />, d.name, d.path, () => open(d.path)))}
        </div>
      )}
      {mac && (
        <div className="side-group">
          <div className="side-title">{$t('Tags')}</div>
          {TAG_COLORS.map((c) => item(`t:${c.color}`, <span className="tag-dot side-tag" style={{ background: c.css }} />, tagName(c), null,
            () => openDialog({ type: 'tagFiles', name: tagName(c), color: c.color })))}
        </div>
      )}
    </nav>
  );
}
