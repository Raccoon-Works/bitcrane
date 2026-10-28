/**
 * Activity area below the two halves.
 *
 * Compact by default: one line with the current transfer. It expands on
 * request and automatically when a transfer fails. Errors show the cause in
 * plain language plus the actions that solve it.
 */
import { useKeyLabel } from '../state/keys';
import { AlertTriangle, ArrowDown, ArrowLeftRight, ArrowUp, Check, ChevronDown, ChevronUp, Clock, SquareTerminal } from './glyphs';
import type { Transfer } from '../backend/types';
import {
  activeTab, activityExpanded, fixDemoPermissions, isOffline, retryTransfer, setActivityFilter, setState, skipTransfer, toggleActivity, updateSettings, useStore,
} from '../state/store';
import { formatSpeed, formatTime } from '../util/format';
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { getLog, subscribeLog } from '../state/log';
import { ResizeHandle } from './ResizeHandle';
import { Button, IconButton } from './ui';
import { $t } from '../i18n';

export function TransferIcon({ t }: { t: Transfer }) {
  if (t.state === 'error') return <AlertTriangle size={14} strokeWidth={1.75} className="tone-danger" aria-label={$t('Fehler')} />;
  if (t.direction === 'command') return <SquareTerminal size={14} strokeWidth={1.75} className={t.state === 'done' ? 'tone-ok' : 'tone-accent'} aria-hidden="true" />;
  if (t.state === 'done') return <Check size={14} strokeWidth={2} className="tone-ok" aria-label={$t('Fertig')} />;
  if (t.state === 'queued' || t.state === 'paused') return <Clock size={14} strokeWidth={1.75} className="muted" aria-label={$t('Wartet')} />;
  if (t.direction === 'cross') return <ArrowLeftRight size={14} strokeWidth={2} className="tone-accent" aria-label={$t('Überträgt zwischen Servern')} />;
  return t.direction === 'up'
    ? <ArrowUp size={14} strokeWidth={2} className="tone-accent" aria-label={$t('Lädt hoch')} />
    : <ArrowDown size={14} strokeWidth={2} className="tone-accent" aria-label={$t('Lädt herunter')} />;
}

export function Progress({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'ok' | 'danger' }) {
  return (
    <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <span className={`progress-fill tone-bg-${tone}`} style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  );
}

function ActivityRow({ t }: { t: Transfer }) {
  const pct = t.size ? t.done / t.size : 0;
  const onRetry = () => {
    // In the prototype the demo error is "fixed" before retrying.
    fixDemoPermissions();
    retryTransfer(t.id);
  };
  return (
    <div className={`act-row${t.state === 'error' ? ' is-error' : ''}`}>
      <TransferIcon t={t} />
      <span className="act-name">
        <span className="strong-500">{t.name}</span>
        <span className={`small ${t.state === 'error' ? 'tone-danger' : 'muted'} ellipsis`}>
          {t.state === 'error' ? (t.error === 'Keine Schreibrechte' ? $t('{0} im Server-Ordner {1}', t.error, t.folder) : `${t.error} (${t.folder})`) : t.direction === 'command' ? (t.state === 'done' ? $t('Befehl ausgeführt') : $t('Befehl läuft …')) : t.folder}
        </span>
      </span>
      {t.state === 'error' ? (
        <span className="act-actions">
          <Button small onClick={() => setState({ dialog: { type: 'transfers' } })}>{t.error === 'Keine Schreibrechte' ? $t('Rechte prüfen') : $t('Details')}</Button>
          <Button small onClick={() => skipTransfer(t.id)}>{$t('Überspringen')}</Button>
          <Button small variant="primary" onClick={onRetry}>{$t('Wiederholen')}</Button>
        </span>
      ) : (
        <span className="act-progress">
          <Progress value={t.state === 'done' ? 1 : pct} tone={t.state === 'done' ? 'ok' : 'accent'} />
          <span className="small muted act-right">
            {t.state === 'done' ? (t.error ? $t('Übersprungen') : $t('Fertig {0}', t.finishedAt ? formatTime(t.finishedAt) : '')) : t.state === 'queued' ? $t('Wartet') : t.state === 'paused' ? (t.error ?? $t('Pausiert')) : `${Math.round(pct * 100)} %`}
          </span>
        </span>
      )}
    </div>
  );
}

function logTime(t: number) {
  return new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * "Protokoll" in the activity area (like the message log of FileZilla): every
 * connection, transfer, command and error of this session, the newest at the
 * bottom. It follows new entries unless the user scrolled up.
 */
function ActivityLog({ height }: { height: number }) {
  const entries = useSyncExternalStore(subscribeLog, getLog);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);
  return (
    <div ref={ref} className="act-log selectable" role="log" aria-live="polite" style={{ height }}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {!entries.length && <span className="small muted empty-act">{$t('Noch keine Einträge.')}</span>}
      {entries.slice(-500).map((e, i) => (
        <div key={`${e.time}-${i}`} className={`act-log-row is-${e.level}`} title={e.detail}>
          <span className="mono act-log-time">{logTime(e.time)}</span>
          <span className="act-log-source">{e.source}</span>
          <span className="act-log-text">{e.text}{e.detail ? <span className="muted"> · {e.detail.split('\n')[0]}</span> : null}</span>
        </div>
      ))}
    </div>
  );
}

export function Activity() {
  const expanded = useStore((s) => activityExpanded(s));
  const transfers = useStore((s) => s.transfers);
  const filter = useStore((s) => s.activityFilter);
  const speed = useStore((s) => s.speed);
  const tab = useStore((s) => activeTab(s));
  const offline = useStore((s) => (tab ? !!s.offline[tab.serverId] : false));
  const errors = transfers.filter((t) => t.state === 'error');
  const running = transfers.filter((t) => t.state === 'running');
  const queued = transfers.filter((t) => t.state === 'queued' || t.state === 'paused');
  const done = transfers.filter((t) => t.state === 'done');
  const key = useKeyLabel()('activity') ?? '';
  const height = useStore((s) => s.settings.activityHeight ?? 240);

  if (!expanded) {
    const current = running[0] ?? queued[0];
    let line;
    if (offline && tab && isOffline(tab.serverId)) {
      line = (
        <>
          <Clock size={14} strokeWidth={1.75} className="tone-warn" aria-hidden="true" />
          <span className="strong tone-warn">{$t('Wartet auf Verbindung')}</span>
          <span className="small muted">{queued.length} {queued.length === 1 ? $t('Datei') : $t('Dateien')} {$t('in der Warteschlange')}</span>
        </>
      );
    } else if (current) {
      const pct = current.size ? current.done / current.size : 0;
      line = (
        <>
          <TransferIcon t={current} />
          <span className="strong">{current.name}</span>
          <span className="small muted ellipsis">{current.folder}</span>
          <span className="compact-bar"><Progress value={pct} /></span>
          <span className="small muted">{Math.round(pct * 100)} %</span>
        </>
      );
    } else {
      const last = done[done.length - 1];
      line = last ? (
        <>
          <Check size={14} strokeWidth={2} className="tone-ok" aria-hidden="true" />
          <span className="strong">{$t('Alles übertragen')}</span>
          <span className="small muted ellipsis">{$t('zuletzt')}{' '}{last.name}{last.finishedAt ? $t(' um {0}', formatTime(last.finishedAt)) : ''}</span>
        </>
      ) : (
        <span className="small muted">{$t('Keine Übertragungen')}</span>
      );
    }
    const restCount = running.length + queued.length - (current ? 1 : 0);
    return (
      <section className="activity is-compact" aria-label={$t('Aktivität')} role="status" aria-live="polite">
        {line}
        <span className="flex-1" />
        <span className="small muted nowrap">
          {[restCount > 0 ? `${restCount} weitere` : '', running.length ? `↑ ${formatSpeed(speed)}` : ''].filter(Boolean).join(' · ')}
        </span>
        <IconButton label={$t('Aktivität aufklappen')} shortcut={key} onClick={toggleActivity} tipBelow={false}><ChevronUp size={14} strokeWidth={2} /></IconButton>
      </section>
    );
  }

  let list: Transfer[];
  if (filter === 'errors') list = errors;
  else if (filter === 'history') list = [...done].reverse();
  else list = [...errors, ...running, ...queued, ...done.slice(-4).reverse()];

  return (
    <section className="activity is-open" aria-label={$t('Aktivität')}>
      {/* Top edge: drag to make the activity area taller or lower (double click: default height). */}
      <ResizeHandle orientation="horizontal" label={$t('Höhe der Aktivität (ziehen, Doppelklick: zurücksetzen)')} value={height} min={120} max={640} step={20}
        toValue={(start, d) => start - d} onChange={(v) => updateSettings({ activityHeight: Math.round(v) })} onReset={() => updateSettings({ activityHeight: 240 })} className="activity-handle" />
      <div className="act-head">
        <span className="strong">{$t('Aktivität')}</span>
        <div role="tablist" className="segmented small-seg">
          <button type="button" role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'is-on' : ''} onClick={() => setActivityFilter('all')}>{$t('Alle')}</button>
          <button type="button" role="tab" aria-selected={filter === 'errors'} className={filter === 'errors' ? 'is-on' : ''} onClick={() => setActivityFilter('errors')}>
            {$t('Fehler')}{' '}{errors.length > 0 && <span className="tone-danger strong">{errors.length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={filter === 'history'} className={filter === 'history' ? 'is-on' : ''} onClick={() => setActivityFilter('history')}>{$t('Verlauf')}</button>
          <button type="button" role="tab" aria-selected={filter === 'log'} className={filter === 'log' ? 'is-on' : ''} onClick={() => setActivityFilter('log')}>{$t('Protokoll')}</button>
        </div>
        <span className="flex-1" />
        {running.length > 0 && <span className="small muted">↑ {formatSpeed(speed)}</span>}
        <Button small variant="ghost" onClick={() => setState({ dialog: { type: 'transfers' } })}>{$t('Alle Übertragungen')}</Button>
        <IconButton label={errors.length ? $t('Zuklappen geht erst, wenn kein Fehler mehr offen ist') : $t('Aktivität zuklappen')} shortcut={key} disabled={errors.length > 0} onClick={toggleActivity} tipBelow={false}><ChevronDown size={14} strokeWidth={2} /></IconButton>
      </div>
      {filter === 'log' ? <ActivityLog height={height} /> : (
        <div className="act-list" role="log" aria-live="polite" style={{ height }}>
          {list.length === 0 && <span className="small muted empty-act">{filter === 'errors' ? $t('Keine Fehler.') : $t('Noch nichts übertragen.')}</span>}
          {list.map((t) => <ActivityRow key={t.id} t={t} />)}
        </div>
      )}
    </section>
  );
}
