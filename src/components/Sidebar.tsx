/**
 * Sidebar of the window (Finder, ForkLift, Transmit): favourite folders,
 * drives, saved servers and, on the Mac, Finder tags. A click acts on the
 * active half, which is marked with an accent line, so it is always clear
 * where a folder or server will open. It replaces the places bars above the
 * halves and can be hidden (View menu, Cmd+Alt+S / Ctrl+Alt+S).
 */
import { HardDrives, House, Desktop, DownloadSimple, FileText, FolderSimple, Cloud } from '@phosphor-icons/react';
import type { Place } from '../backend/types';
import { $t } from '../i18n';
import { LIVE, activeTab, navigate, openPlace, openServerIn, setRightLocal, showToast, useStore } from '../state/store';
import { TAG_COLORS, tagName } from '../state/tags';
import { BrandLogo, isBrandService } from './BrandLogo';
import { placeLabel } from './PlacesBar';
import { ServerTile } from './ServerTile';

function PlaceIcon({ place }: { place: Place }) {
  const last = place.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const props = { size: 17, weight: 'duotone', 'aria-hidden': true } as const;
  if (isBrandService(place.cloud)) return <BrandLogo service={place.cloud} size={15} />;
  if (place.cloud) return <Cloud {...props} />;
  if (place.path === '~') return <House {...props} />;
  if (last === 'desktop' || last === 'schreibtisch') return <Desktop {...props} />;
  if (last === 'downloads') return <DownloadSimple {...props} />;
  if (last === 'documents' || last === 'dokumente') return <FileText {...props} />;
  return <FolderSimple {...props} />;
}

export function Sidebar() {
  const platform = useStore((s) => s.platform);
  const focus = useStore((s) => s.focusSide);
  const tab = useStore((s) => activeTab(s));
  const places = useStore((s) => s.settings.localPlaces ?? s.places);
  const servers = useStore((s) => s.servers);
  const liveDrives = useStore((s) => s.drives);
  // The browser prototype has no real drives; it shows typical ones.
  const drives: Place[] = LIVE ? liveDrives : platform === 'mac'
    ? [{ name: 'Macintosh HD', path: '~' } as Place, { name: 'USB-Stick', path: '~/Downloads' } as Place]
    : [{ name: 'C:', path: '~' } as Place, { name: 'D:', path: '~/Downloads' } as Place];
  const localPath = tab ? (focus === 'local' ? tab.localPath : tab.remotePath) : '';
  const activeServer = tab ? (focus === 'local' ? tab.leftServerId : tab.serverId) : '';

  /** Opens a folder of this computer in the active half. */
  const openLocal = (path: string) => {
    if (focus === 'local') openPlace(path);
    else if (tab?.rightLocal && !tab.serverId) navigate('remote', path);
    else setRightLocal(path);
  };

  const item = (key: string, icon: React.ReactNode, label: string, active: boolean, onClick: () => void, title?: string, trailing?: React.ReactNode) => (
    <button key={key} type="button" className={`side-item${active ? ' is-active' : ''}`} title={title ?? label} onClick={onClick}>
      <span className="side-icon">{icon}</span>
      <span className="ellipsis">{label}</span>
      {trailing}
    </button>
  );

  const shown = servers.filter((x) => !x.temporary || x.online);
  return (
    <nav className="sidebar" aria-label={$t('Seitenleiste')}>
      <div className="side-group">
        <div className="side-title">{$t('Favoriten')}</div>
        {places.map((p) => item(`p:${p.path}`, <PlaceIcon place={p} />, placeLabel(p), !activeServer && localPath === p.path, () => openLocal(p.path), p.path))}
      </div>
      <div className="side-group">
        <div className="side-title">{platform === 'mac' ? $t('Orte') : $t('Laufwerke')}</div>
        {drives.map((d) => item(`d:${d.path}:${d.name}`, <HardDrives size={17} weight="duotone" aria-hidden="true" />, d.name, false, () => openLocal(d.path), d.path))}
      </div>
      {shown.length > 0 && (
        <div className="side-group">
          <div className="side-title">{$t('Server')}</div>
          {shown.map((x) => item(`s:${x.id}`, <ServerTile server={x} size={18} />, x.name, activeServer === x.id, () => openServerIn(focus, x.id), x.name,
            x.online ? <span className="side-online" title={$t('verbunden')} /> : undefined))}
        </div>
      )}
      {platform === 'mac' && (
        <div className="side-group">
          <div className="side-title">{$t('Tags')}</div>
          {TAG_COLORS.map((c) => item(`t:${c.color}`, <span className="tag-dot side-tag" style={{ background: c.css }} />, tagName(c), false,
            () => showToast($t('Dateien mit dem Tag „{0}“ suchen kommt mit dem fertigen Ausbau.', tagName(c)))))}
        </div>
      )}
    </nav>
  );
}
