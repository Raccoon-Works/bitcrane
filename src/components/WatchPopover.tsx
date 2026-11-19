/**
 * Overview of all folder watches, opened from the watch button in the
 * toolbar. Scales in from the button (origin-aware, 150 ms ease-out).
 */
import { useEffect, useRef } from 'react';
import type { Watch } from '../backend/types';
import {
  askDeleteWatch,
  openDialog,
  openWatchFolders,
  setState,
  toggleWatch,
  updateSettings,
  useStore,
  watchRoute,
  watchStatus,
} from '../state/store';
import { formatAgo } from '../util/format';
import { Button, Switch } from './ui';
import { $t } from '../i18n';

/** Pause or resume, edit and delete one watch. */
export function WatchActions({ w, apart }: { w: Watch; apart?: boolean }) {
  const remove = (
    <Button small variant={apart ? 'ghost' : 'secondary'} onClick={() => askDeleteWatch(w)}>
      {$t('Löschen')}
    </Button>
  );
  return (
    <>
      {/* `apart` (the narrow popover card): Löschen on the left, away from the everyday buttons. */}
      {apart && remove}
      {apart && <span className="flex-1" />}
      <Button
        small
        title={
          w.state === 'paused'
            ? $t(
                'Beobachtet den Ordner wieder. Mit „Beim Start abgleichen“ wird hochgeladen, was sich inzwischen geändert hat.',
              )
            : $t('Lädt nichts mehr hoch, bis du fortsetzt. Die Einstellungen bleiben erhalten.')
        }
        onClick={() => toggleWatch(w.id)}
      >
        {w.state === 'paused' ? $t('Fortsetzen') : $t('Pausieren')}
      </Button>
      <Button small onClick={() => openDialog({ type: 'watchSetup', editId: w.id })}>
        {$t('Bearbeiten')}
      </Button>
      {!apart && remove}
    </>
  );
}

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
        <Button variant="primary" small onClick={() => openDialog({ type: 'watchSetup' })}>
          {$t('Neue Überwachung')}
        </Button>
      </div>
      {watches.length === 0 && (
        <p className="empty-note">
          {$t(
            'Noch keine Überwachung. Mit einer Überwachung lädt Bitcrane jede Änderung in einem Ordner automatisch hoch.',
          )}
        </p>
      )}
      {watches.map((w) => {
        const { text: stateText, tone } = watchStatus(w);
        return (
          <div key={w.id} className="watch-card">
            <div className="watch-card-head">
              <span className={`pill-dot tone-${tone}`} />
              <button type="button" className="watch-name" onClick={() => openWatchFolders(w.id)}>
                {w.name}
              </button>
              <span className={`small tone-${tone}`}>{stateText}</span>
            </div>
            <span className="watch-path mono">
              {watchRoute(
                w,
                servers.find((x) => x.id === w.serverId),
              )}
            </span>
            {/* The last upload has a line of its own: beside three buttons it would be cut to a few letters. */}
            <span className="watch-path small">
              {w.lastFile ? `${w.lastFile} · ${formatAgo(w.lastTime, now)}` : $t('noch nichts hochgeladen')}
            </span>
            <div className="watch-card-foot">
              <WatchActions w={w} apart />
            </div>
          </div>
        );
      })}
      <div className="popover-foot">
        <span className="small muted flex-1">{$t('Läuft auch bei geschlossenem Fenster weiter')}</span>
        <Switch
          checked={background}
          onChange={(v) => updateSettings({ runInBackground: v })}
          label={$t('Im Hintergrund weiterlaufen')}
        />
      </div>
    </div>
  );
}
