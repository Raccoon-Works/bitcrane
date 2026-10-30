/**
 * Transfers as a separate window: summary figures, then running, failed,
 * waiting (drag to reorder) and finished transfers.
 */
import { ChevronDown, ChevronRight, GripVertical, Pause, Play, X } from '../glyphs';
import { useState } from 'react';
import {
  cancelTransfer, clearFinished, closeDialog, fixDemoPermissions, openDialog, pauseAllTransfers, reorderTransfer, retryTransfer, skipTransfer, toggleTransferPause, useStore,
} from '../../state/store';
import { formatDuration, formatSize, formatSpeed, formatTime } from '../../util/format';
import { Progress, TransferIcon } from '../Activity';
import { Button, Segmented } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

type Filter = 'all' | 'up' | 'down' | 'watch';

export function TransfersDialog() {
  const transfers = useStore((s) => s.transfers);
  const servers = useStore((s) => s.servers);
  const speed = useStore((s) => s.speed);
  const [filter, setFilter] = useState<Filter>('all');
  const [openDone, setOpenDone] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);

  const visible = transfers.filter((t) => filter === 'all' || (filter === 'watch' ? !!t.watchId : t.direction === filter));
  const running = visible.filter((t) => t.state === 'running');
  const errors = visible.filter((t) => t.state === 'error');
  const waiting = visible.filter((t) => t.state === 'queued' || t.state === 'paused');
  const done = visible.filter((t) => t.state === 'done');
  const today = done.length;
  const anyActive = transfers.some((t) => t.state === 'running' || t.state === 'queued');
  // Overall progress and remaining time of everything still to transfer.
  const pending = transfers.filter((t) => (t.state === 'running' || t.state === 'queued') && t.direction !== 'command');
  const totalBytes = pending.reduce((a, t) => a + t.size, 0);
  const doneBytes = pending.reduce((a, t) => a + Math.min(t.done, t.size), 0);
  const remaining = speed > 0 ? (totalBytes - doneBytes) / speed : 0;
  const srvName = (id: string) => servers.find((x) => x.id === id)?.name ?? '';

  // Plain render functions (not components) so rows are not remounted on every progress tick.
  const row = (id: string) => {
    const t = transfers.find((x) => x.id === id)!;
    const pct = t.size ? t.done / t.size : 0;
    const isWaiting = t.state === 'queued' || t.state === 'paused';
    return (
      <div
        key={t.id}
        className={`tr-row${t.state === 'error' ? ' is-error' : ''}${drag === t.id ? ' is-dragging' : ''}`}
        onPointerEnter={() => { if (drag && isWaiting && drag !== t.id) reorderTransfer(drag, t.id); }}
      >
        <span
          className="grip"
          aria-hidden="true"
          onPointerDown={(e) => {
            if (!isWaiting) return;
            e.preventDefault();
            setDrag(t.id);
            // Reordering follows the pointer over other waiting rows until the button is released.
            window.addEventListener('pointerup', () => setDrag(null), { once: true });
          }}
        >
          {isWaiting && <GripVertical size={13} strokeWidth={1.5} />}
        </span>
        <TransferIcon t={t} />
        <span className="tr-name"><span className="strong-500 ellipsis">{t.name}</span><span className="small muted ellipsis">{t.folder}</span></span>
        <span className="small muted ellipsis tr-server">{srvName(t.serverId)}</span>
        <span className="tr-bar"><Progress value={t.state === 'done' ? 1 : t.state === 'error' ? Math.max(pct, 0.3) : pct} tone={t.state === 'done' ? 'ok' : t.state === 'error' ? 'danger' : 'accent'} /></span>
        <span className={`small tr-info ${t.state === 'error' ? 'tone-danger' : 'muted'}`}>
          {t.state === 'error' ? t.error
            : t.state === 'done' && t.error ? t.error
            : t.state === 'done' ? (t.direction === 'command' ? $t('Befehl · {0}', t.finishedAt ? formatTime(t.finishedAt) : '') : `${formatSize(t.size)} · ${t.finishedAt ? formatTime(t.finishedAt) : ''}`)
              : t.state === 'running' ? $t('{0} % · {1} von {2}', Math.round(pct * 100), formatSize(t.done), formatSize(t.size))
                : t.state === 'paused' ? (t.error ?? $t('Pausiert')) : $t('Wartet')}
        </span>
        <span className="tr-actions">
          {(t.state === 'running' || isWaiting) && (
            <button type="button" className="icon-btn" aria-label={t.state === 'paused' ? $t('Fortsetzen') : $t('Pausieren')} onClick={() => toggleTransferPause(t.id)}>{t.state === 'paused' ? <Play size={13} strokeWidth={1.75} /> : <Pause size={13} strokeWidth={1.75} />}</button>
          )}
          {t.state !== 'done' && <button type="button" className="icon-btn" aria-label={$t('Abbrechen')} onClick={() => cancelTransfer(t.id)}><X size={13} strokeWidth={1.75} /></button>}
        </span>
        {t.state === 'error' && (
          <div className="tr-error">
            <span className="small">{t.errorDetail}</span>
            <span className="row-inline">
              <Button small onClick={() => openDialog({ type: 'log' })}>{$t('Protokoll')}</Button>
              <Button small onClick={() => skipTransfer(t.id)}>{$t('Überspringen')}</Button>
              <Button small variant="primary" onClick={() => { fixDemoPermissions(); retryTransfer(t.id); }}>{$t('Wiederholen')}</Button>
            </span>
          </div>
        )}
        {t.direction === 'command' && t.output && t.state === 'done' && <pre className="tr-output mono">{t.output}</pre>}
      </div>
    );
  };

  const group = (title: string, count: number, children: React.ReactNode, tone?: string, aside?: React.ReactNode) =>
    count ? (
      <section className="tr-group" aria-label={title}>
        <div className="tr-group-head"><ChevronDown size={12} strokeWidth={2} aria-hidden="true" /><span className={`strong ${tone ?? ''}`}>{title}</span><span className="muted">{count}</span><span className="flex-1" />{aside}</div>
        {children}
      </section>
    ) : null;

  return (
    <Dialog label={$t('Übertragungen')} windowLike windowTitle={$t('Übertragungen')} width={1000} maxHeight={700} onClose={closeDialog} className="transfers-dialog">
      <div className="tr-top">
        <Segmented<Filter> label={$t('Filter')} value={filter} onChange={setFilter} options={[{ value: 'all', label: $t('Alle') }, { value: 'up', label: $t('Hochladen') }, { value: 'down', label: $t('Herunterladen') }, { value: 'watch', label: $t('Überwachung') }]} />
        <span className="flex-1" />
        {/* Nothing running and nothing paused: no button (it would do nothing). */}
        {(anyActive || transfers.some((t) => t.state === 'paused')) && <Button small onClick={pauseAllTransfers}>{anyActive ? <><Pause size={12} strokeWidth={2} aria-hidden="true" />{$t('Alle pausieren')}</> : <><Play size={12} strokeWidth={2} aria-hidden="true" />{$t('Alle fortsetzen')}</>}</Button>}
      </div>
      <div className="tr-stats">
        <div><span className={`stat${running.length ? ' tone-accent' : ''}`}>{running.length}</span><span className="small muted">{$t('laufen gerade')}</span></div>
        <div><span className="stat">{waiting.length}</span><span className="small muted">{$t('warten')}</span></div>
        <div><span className={`stat${errors.length ? ' tone-danger' : ''}`}>{errors.length}</span><span className="small muted">{$t('Fehler')}</span></div>
        <div><span className={`stat${today ? ' tone-ok' : ''}`}>{today}</span><span className="small muted">{$t('heute fertig')}</span></div>
        <div><span className="stat">{running.length ? formatSpeed(speed) : '–'}</span><span className="small muted">{$t('Geschwindigkeit')}</span></div>
        <div><span className="stat">{totalBytes ? `${Math.floor((doneBytes / totalBytes) * 100)} %` : '–'}</span><span className="small muted">{totalBytes ? $t('von {0}', formatSize(totalBytes)) : $t('gesamt')}</span></div>
        <div><span className="stat">{remaining > 0 ? formatDuration(remaining) : '–'}</span><span className="small muted">{$t('Restzeit')}</span></div>
      </div>
      <div className="tr-list">
        {group($t('Läuft'), running.length, running.map((t) => row(t.id)))}
        {group($t('Fehler'), errors.length, errors.map((t) => row(t.id)), 'tone-danger')}
        {group($t('Wartet'), waiting.length, waiting.map((t) => row(t.id)), undefined, <span className="small muted">{$t('Zum Umsortieren ziehen')}</span>)}
        {done.length > 0 && (
          <section className="tr-group" aria-label={$t('Fertig')}>
            <button type="button" className="tr-group-head is-button" aria-expanded={openDone} onClick={() => setOpenDone(!openDone)}>
              {openDone ? <ChevronDown size={12} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />}
              <span className="strong">{$t('Fertig')}</span><span className="muted">{done.length} {$t('heute')}</span><span className="flex-1" />
              <span className="small link" role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); clearFinished(); }}>{$t('Liste leeren')}</span>
            </button>
            {(openDone ? [...done].reverse() : done.slice(-1)).map((t) => row(t.id))}
          </section>
        )}
        {!visible.length && <p className="muted center pad">{$t('Keine Übertragungen.')}</p>}
      </div>
    </Dialog>
  );
}
