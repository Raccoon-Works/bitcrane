/**
 * Small window of the menu bar icon (Mac) or the notification area icon
 * (Windows). Shows the watches and the last uploads while the main window
 * may be closed.
 */
import { AlertTriangle, ArrowUp, Pause, Play, Settings, SquareTerminal } from './glyphs';
import { useEffect, useRef } from 'react';
import { openDialog, pauseAllWatches, setState, toggleWatch, useStore } from '../state/store';
import { formatAgo } from '../util/format';
import { BMark } from './icons';
import { $t } from '../i18n';

export function MenuBarWindow() {
  const open = useStore((s) => s.menuBarWindowOpen);
  const platform = useStore((s) => s.platform);
  const watches = useStore((s) => s.watches);
  const transfers = useStore((s) => s.transfers);
  const servers = useStore((s) => s.servers);
  const now = useStore((s) => s.now);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest('.menubar-extra') && !t.closest('.proto-bar')) setState({ menuBarWindowOpen: false });
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setState({ menuBarWindowOpen: false });
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  if (!open) return null;
  const active = watches.filter((w) => w.state !== 'paused').length;
  const paused = watches.length - active;
  const recent = transfers.filter((t) => t.state !== 'queued').slice(-5).reverse();
  const k = (mac: string, win: string) => (platform === 'mac' ? mac : win);

  return (
    <div ref={ref} className={`tray-window is-${platform}`} role="dialog" aria-label="Bitcrane">
      <div className="tray-head">
        {platform === 'mac' ? <BMark variant="macApp" size={30} /> : <BMark variant="winApp" size={26} />}
        <span className="col-text flex-1"><span className="strong">Bitcrane</span><span className="small muted">{active} {active === 1 ? $t('Überwachung') : $t('Überwachungen')} {$t('aktiv')}{paused ? $t(', {0} pausiert', paused) : ''}</span></span>
        <button type="button" className="icon-btn" aria-label={$t('Einstellungen')} onClick={() => openDialog({ type: 'settings', tab: 'watch' })}><Settings size={15} strokeWidth={1.5} /></button>
      </div>
      {watches.map((w) => (
        <div key={w.id} className="tray-watch">
          <span className={`pill-dot tone-${w.state === 'active' ? 'accent' : w.state === 'waiting' ? 'warn' : 'muted'}`} />
          <span className="col-text flex-1">
            <span className="strong-500">{w.name}</span>
            <span className="small muted ellipsis">{w.state === 'paused' ? $t('Pausiert seit {0}', formatAgo(w.lastTime, now).replace('vor ', '')) : `${w.localPath} → ${servers.find((x) => x.id === w.serverId)?.name ?? ''}`}</span>
          </span>
          <button type="button" className="icon-btn round" aria-label={w.state === 'paused' ? $t('Fortsetzen') : $t('Pausieren')} onClick={() => toggleWatch(w.id)}>{w.state === 'paused' ? <Play size={12} strokeWidth={2} /> : <Pause size={12} strokeWidth={2} />}</button>
        </div>
      ))}
      <div className="tray-section">
        <span className="caption-strong">{$t('Zuletzt hochgeladen')}</span>
        {recent.map((t) => (
          <div key={t.id} className="tray-recent">
            {t.direction === 'command' ? <SquareTerminal size={12} strokeWidth={1.75} className="tone-accent" aria-hidden="true" /> : t.state === 'error' ? <AlertTriangle size={12} strokeWidth={1.75} className="tone-danger" aria-hidden="true" /> : <ArrowUp size={12} strokeWidth={2} className={t.state === 'done' ? 'tone-ok' : 'tone-accent'} aria-hidden="true" />}
            <span className={`mono small flex-1 ellipsis${t.state === 'error' ? ' tone-danger' : t.direction === 'command' ? ' tone-accent' : ''}`}>{t.direction === 'command' ? `$ ${t.name}` : `${t.folder}/${t.name}`}</span>
            <span className="small muted">{t.state === 'error' ? $t('Fehler') : t.state === 'running' ? $t('läuft, {0} %', Math.round((t.done / Math.max(1, t.size)) * 100)) : t.finishedAt ? formatAgo(t.finishedAt, now) : ''}</span>
          </div>
        ))}
      </div>
      <div className="menu-sep" />
      <button type="button" className="menu-item is-hl" onClick={() => setState({ menuBarWindowOpen: false })}><span className="flex-1">{$t('Bitcrane öffnen')}</span><span className="menu-key">{k('⌘O', 'Strg+O')}</span></button>
      <button type="button" className="menu-item" onClick={() => openDialog({ type: 'watchSetup' })}><span className="flex-1">{$t('Neue Überwachung …')}</span><span className="menu-key">{k('⌘U', 'Strg+U')}</span></button>
      <button type="button" className="menu-item" onClick={pauseAllWatches}><span className="flex-1">{$t('Alle Überwachungen pausieren')}</span></button>
      <button type="button" className="menu-item" onClick={() => setState({ menuBarWindowOpen: false })}><span className="flex-1">{$t('Bitcrane beenden')}</span><span className="menu-key">{k('⌘Q', '')}</span></button>
    </div>
  );
}
