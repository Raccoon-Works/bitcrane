/**
 * Overview of all folder watches, opened from the watch button in the
 * toolbar. Scales in from the button (origin-aware, 150 ms ease-out).
 */
import { useEffect, useRef } from 'react';
import { openDialog, openWatchFolders, setState, toggleWatch, updateSettings, useStore } from '../state/store';
import { formatAgo } from '../util/format';
import { Button, Switch } from './ui';
import { $t } from '../i18n';

export function WatchPopover() {
  const watches = useStore((s) => s.watches);
  const servers = useStore((s) => s.servers);
  const now = useStore((s) => s.now);
  const background = useStore((s) => s.settings.runInBackground);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Close when clicking outside the popover or pressing Escape.
    const onDown = (e: MouseEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) setState({ popoverOpen: false });
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setState({ popoverOpen: false });
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div ref={ref} role="dialog" aria-label={$t('Überwachungen')} className="popover watch-popover">
      <div className="popover-head">
        <span className="title-text">{$t('Überwachungen')}</span>
        <Button variant="primary" small onClick={() => openDialog({ type: 'watchSetup' })}>{$t('Neue Überwachung')}</Button>
      </div>
      {watches.length === 0 && <p className="empty-note">{$t('Noch keine Überwachung. Mit einer Überwachung lädt Bitcrane jede Änderung in einem Ordner automatisch hoch.')}</p>}
      {watches.map((w) => {
        const srv = servers.find((x) => x.id === w.serverId);
        const stateText = w.state === 'active' ? 'aktiv' : w.state === 'waiting' ? $t('wartet auf Verbindung') : 'pausiert';
        const tone = w.state === 'active' ? 'accent' : w.state === 'waiting' ? 'warn' : 'muted';
        return (
          <div key={w.id} className="watch-card">
            <div className="watch-card-head">
              <span className={`pill-dot tone-${tone}`} />
              <button type="button" className="watch-name" onClick={() => openWatchFolders(w.id)}>{w.name}</button>
              <span className={`small tone-${tone}`}>{stateText}</span>
            </div>
            <span className="watch-path mono">{w.localPath} → {srv?.name ?? $t('Server')}</span>
            <div className="watch-card-foot">
              <span className="small muted flex-1">
                {w.state === 'paused' ? 'pausiert' : w.lastFile ? `${w.lastFile} · ${formatAgo(w.lastTime, now)}` : $t('noch nichts hochgeladen')}
              </span>
              <Button small onClick={() => toggleWatch(w.id)}>{w.state === 'paused' ? $t('Fortsetzen') : $t('Pausieren')}</Button>
              <Button small onClick={() => openDialog({ type: 'watchSetup', editId: w.id })}>{$t('Bearbeiten')}</Button>
            </div>
          </div>
        );
      })}
      <div className="popover-foot">
        <span className="small muted flex-1">{$t('Läuft auch bei geschlossenem Fenster weiter')}</span>
        <Switch checked={background} onChange={(v) => updateSettings({ runInBackground: v })} label={$t('Im Hintergrund weiterlaufen')} />
      </div>
    </div>
  );
}
