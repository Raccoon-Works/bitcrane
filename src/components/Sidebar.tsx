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
import { X, CaretDown, ClockCounterClockwise, Desktop, Network } from '@phosphor-icons/react';
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { NetworkHost } from '../backend/api';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Place } from '../backend/types';
import { $t, LOCALE } from '../i18n';
import {
  LIVE,
  removeRecent,
  activeTab,
  editLocalPlaces,
  localPlaces,
  moveSidebarSection,
  drivesOf,
  openDialog,
  openLocalIn,
  setState,
  sidebarOrder,
  toggleSidebarCollapsed,
  useStore,
  type SidebarSection,
} from '../state/store';
import { TAG_COLORS, tagName } from '../state/tags';
import { DriveIcon, PLACE_ICON as ICON, PlaceIcon } from './placeIcons';
import { driveLabel, favoriteLabels } from '../util/placeLabel';
import * as paths from '../util/paths';

/**
 * Favourites as shown: a folder reached by two paths (e.g. ~/Dropbox and its
 * target in ~/Library/CloudStorage) appears once.
 */
function useShownPlaces(places: Place[]): Array<{ place: Place; label: string }> {
  const [real, setReal] = useState<Record<string, string>>({});
  // Resolved again only when the set of paths changes, not when a place is renamed.
  const key = places.map((p) => p.path).join('\n');
  useEffect(() => {
    if (!LIVE || !key) return;
    const list = key.split('\n');
    let live = true;
    void backend.localRealPaths(list).then((r) => {
      if (live) setReal(Object.fromEntries(list.map((p, i) => [p, r[i] ?? p])));
    });
    return () => {
      live = false;
    };
  }, [key]);
  const seen = new Set<string>();
  const unique = places.filter((p) => {
    const target = real[p.path] ?? p.path;
    if (seen.has(target)) return false;
    seen.add(target);
    return true;
  });
  return favoriteLabels(unique);
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
function useNetworkHosts(enabled: boolean): NetworkHost[] {
  const [hosts, setHosts] = useState<NetworkHost[]>([]);
  useEffect(() => {
    if (!enabled) return;
    if (!LIVE) {
      setHosts([{ name: 'NAS Keller', host: 'nas-keller.local' }]);
      return;
    }
    let live = true;
    const run = () =>
      void backend.networkHosts().then((h) => {
        if (live) setHosts(h);
      });
    run();
    const t = window.setInterval(run, 120000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
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
  const drives = useStore((s) => drivesOf(s));
  const dropHere = useStore((s) => !!s.dropHint?.sidebar);
  const homeName = useStore((s) => s.homeName);
  const savedOrder = useStore((s) => s.settings.sidebarOrder);
  const order = useMemo(() => sidebarOrder(savedOrder), [savedOrder]);
  const collapsed = useStore((s) => s.settings.sidebarCollapsed ?? NONE);
  const hidden = useStore((s) => s.settings.sidebarHidden ?? NONE);
  const mac = platform === 'mac';
  const devices = drives.filter((d) => !d.network);
  const mounted = drives.filter((d) => d.network);
  const netHosts = useNetworkHosts(!hidden.includes('shares'));
  // Computers in the network that are not mounted already.
  const others = netHosts.filter((h) => !mounted.some((m) => m.name.toLowerCase() === h.name.toLowerCase()));
  // Recent folders that are not favourites already, newest first.
  const recent = (recentAll ?? []).filter((p) => !places.some((x) => x.path === p) && p !== '~').slice(0, 5);
  // Favourite drag (reordering): which favourite and before which one it would go.
  const [favDrag, setFavDrag] = useState<{ path: string; before: string | null } | null>(null);
  const favMoved = useRef(false);
  const beginFavDrag = (e: React.PointerEvent, path: string) => {
    if (e.button !== 0) return;
    const y0 = e.clientY;
    favMoved.current = false;
    let current: { path: string; before: string | null } | null = null;
    const move = (ev: PointerEvent) => {
      if (!favMoved.current && Math.abs(ev.clientY - y0) < 5) return;
      favMoved.current = true;
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>(
        '[data-fav-path]',
      );
      let before: string | null = current?.before ?? null;
      if (el) {
        const target = el.dataset.favPath!;
        const r = el.getBoundingClientRect();
        const list = places.map((p) => p.path).filter((p) => p !== path);
        before = ev.clientY < r.top + r.height / 2 ? target : (list[list.indexOf(target) + 1] ?? null);
        if (target === path) before = current?.before ?? null;
      }
      current = { path, before };
      setFavDrag(current);
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      if (favMoved.current && current) editLocalPlaces(current.path, { before: current.before });
      setFavDrag(null);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  };

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
  const open = (path: string) => openLocalIn(focus, path);

  const item = (
    key: string,
    icon: React.ReactNode,
    label: string,
    path: string | null,
    onClick: () => void,
    extra: Partial<React.ButtonHTMLAttributes<HTMLButtonElement>> = {},
    trailing?: React.ReactNode,
  ) => (
    <button
      key={key}
      type="button"
      className={`side-item${path !== null && activeLocal === path ? ' is-active' : ''}`}
      title={path ?? label}
      onClick={onClick}
      {...extra}
    >
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
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>(
        '[data-section]',
      );
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

  const section = (
    id: SidebarSection,
    body: React.ReactNode,
    extra: Partial<React.HTMLAttributes<HTMLDivElement>> = {},
  ) => {
    const folded = collapsed.includes(id);
    const marker = drag?.moved && drag.id !== id && drag.before === id;
    return (
      <div
        key={id}
        data-section={id}
        {...extra}
        className={`side-group${folded ? ' is-folded' : ''}${marker ? ' is-drop-before' : ''}${drag?.moved && drag.id === id ? ' is-dragged' : ''}`}
      >
        <button
          type="button"
          className="side-title"
          aria-expanded={!folded}
          title={$t('Klicken: ein- oder ausklappen, ziehen: verschieben')}
          onPointerDown={(e) => beginDrag(e, id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleSidebarCollapsed(id);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setState({ contextMenu: { x: e.clientX, y: e.clientY, side: focus, names: [], kind: 'sidebarSection' } });
          }}
        >
          <span className="ellipsis">{TITLES[id]()}</span>
          <CaretDown size={11} weight="bold" className="side-caret" aria-hidden="true" />
        </button>
        {!folded && body}
      </div>
    );
  };

  const sections: Record<SidebarSection, React.ReactNode> = {
    favorites: section(
      'favorites',
      <>
        {shown.map(({ place: p, label }) =>
          item(
            `p:${p.path}`,
            <PlaceIcon place={p} />,
            label,
            p.path,
            () => {
              if (!favMoved.current) open(p.path);
              favMoved.current = false;
            },
            {
              onContextMenu: (e) => {
                e.preventDefault();
                setState({
                  contextMenu: {
                    x: e.clientX,
                    y: e.clientY,
                    side: focus,
                    names: [],
                    kind: 'sidebarPlace',
                    place: p.path,
                  },
                });
              },
              onPointerDown: (e) => beginFavDrag(e, p.path),
              ...({ 'data-fav-path': p.path } as object),
              className: `side-item${activeLocal === p.path ? ' is-active' : ''}${favDrag && favDrag.before === p.path && favDrag.path !== p.path ? ' is-drop-before' : ''}${favDrag?.path === p.path ? ' is-dragged' : ''}`,
            },
          ),
        )}
        {favDrag && favDrag.before === null && <div className="side-drop-end" />}
        {places.length === 0 && <div className="side-empty">{$t('Ordner hierher ziehen')}</div>}
      </>,
      { 'data-sidebar-favs': '' } as Partial<React.HTMLAttributes<HTMLDivElement>>,
    ),
    recent:
      recent.length > 0
        ? section(
            'recent',
            recent.map((p) => {
              // Two recent folders with the same name ("Applications" and "~/Applications") show where they are.
              // A drive root shows the drive's name as under "Geräte" ("C: WINDOWS 11 PRO").
              const drive = /^[A-Z]:\/?$/i.test(p)
                ? drives.find((d) => d.path.replace(/\/$/, '').toUpperCase() === p.replace(/\/$/, '').toUpperCase())
                : undefined;
              const base = drive ? driveLabel(drive, mac) : paths.basename(p) || p;
              const twin = recent.some((o) => o !== p && (paths.basename(o) || o) === base);
              const where = paths.parent(p);
              return item(
                `r:${p}`,
                <ClockCounterClockwise {...ICON} />,
                twin ? `${base} – ${where === '~' ? homeName : where}` : base,
                p,
                () => open(p),
                {
                  onContextMenu: (e) => {
                    e.preventDefault();
                    setState({
                      contextMenu: {
                        x: e.clientX,
                        y: e.clientY,
                        side: focus,
                        names: [],
                        kind: 'sidebarRecent',
                        place: p,
                      },
                    });
                  },
                },
                // A small × on hover takes the folder off the list (the folder itself stays).
                <span
                  className="side-remove"
                  role="button"
                  tabIndex={-1}
                  aria-label={$t('Aus „Zuletzt verwendet“ entfernen')}
                  title={$t('Aus „Zuletzt verwendet“ entfernen')}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRecent(p);
                  }}
                >
                  <X size={12} weight="bold" />
                </span>,
              );
            }),
          )
        : null,
    devices: section(
      'devices',
      devices.map((d, i) =>
        item(
          `d:${d.path}:${d.name}`,
          <DriveIcon drive={d} first={i === 0} />,
          driveLabel(d, mac),
          d.path,
          () => open(d.path),
          {},
          d.free !== undefined ? (
            <span className="side-free" title={$t('{0} frei', shortSize(d.free))}>
              {shortSize(d.free)}
            </span>
          ) : undefined,
        ),
      ),
    ),
    shares:
      mounted.length + others.length > 0
        ? section(
            'shares',
            <>
              {mounted.map((d) =>
                item(`n:${d.path}:${d.name}`, <Network {...ICON} />, d.name, d.path, () => open(d.path)),
              )}
              {others.map((h) =>
                item(
                  `h:${h.host}`,
                  <Desktop {...ICON} />,
                  h.name,
                  null,
                  () =>
                    openDialog({
                      type: 'serverEdit',
                      preset: { name: h.name, host: h.host, port: 445, protocol: 'smb' },
                    }),
                  { title: $t('{0} über SMB verbinden …', h.name) },
                ),
              )}
            </>,
          )
        : null,
    tags: mac
      ? section(
          'tags',
          TAG_COLORS.map((c) =>
            item(
              `t:${c.color}`,
              <span className="tag-dot side-tag" style={{ background: c.css }} />,
              tagName(c),
              null,
              () => openDialog({ type: 'tagFiles', name: tagName(c), color: c.color }),
            ),
          ),
        )
      : null,
  };

  return (
    <nav
      className={`sidebar${dropHere ? ' is-drop-favs' : ''}${drag?.moved ? ' is-sorting' : ''}`}
      aria-label={$t('Seitenleiste')}
    >
      {order.filter((id) => !hidden.includes(id)).map((id) => sections[id])}
      {drag?.moved && drag.before === null && <div className="side-drop-end" />}
    </nav>
  );
}

const NONE: SidebarSection[] = [];
