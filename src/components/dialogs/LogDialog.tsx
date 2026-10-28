/**
 * "Protokoll": the connection log for troubleshooting. Shows the newest
 * entries first, can be filtered to problems and copied as text.
 */
import { AlertTriangle, CheckCircle2, Dot, Info, XCircle } from '../glyphs';
import { useState, useSyncExternalStore } from 'react';
import { clearLog, formatLogLine, getLog, subscribeLog, type LogEntry } from '../../state/log';
import { closeDialog, showToast } from '../../state/store';
import { Button, Segmented } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

const ICONS = {
  debug: <Dot size={14} strokeWidth={3} className="muted" aria-label={$t('Einzelschritt')} />,
  info: <Info size={14} strokeWidth={1.75} className="muted" aria-label={$t('Info')} />,
  ok: <CheckCircle2 size={14} strokeWidth={1.75} className="tone-ok" aria-label={$t('Erfolg')} />,
  warn: <AlertTriangle size={14} strokeWidth={1.75} className="tone-warn" aria-label={$t('Warnung')} />,
  error: <XCircle size={14} strokeWidth={1.75} className="tone-danger" aria-label={$t('Fehler')} />,
};

function time(t: number) {
  return new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function LogDialog() {
  const entries = useSyncExternalStore(subscribeLog, getLog);
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const [open, setOpen] = useState<number | null>(null);
  const list: LogEntry[] = (filter === 'all' ? entries : entries.filter((e) => e.level === 'warn' || e.level === 'error')).slice().reverse();
  const copy = () => {
    const text = entries.map(formatLogLine).join('\n');
    navigator.clipboard?.writeText(text).then(() => showToast($t('Protokoll kopiert.'), 'ok')).catch(() => showToast($t('Kopieren nicht möglich.'), 'error'));
  };
  return (
    <Dialog
      label={$t('Protokoll')}
      title={$t('Protokoll')}
      subtitle={$t('Verbindungen, Übertragungen, Befehle und Fehler dieser Sitzung, das Neueste oben.')}
      width={820}
      maxHeight={680}
      footer={<><Button variant="ghost" onClick={clearLog}>{$t('Leeren')}</Button><span className="flex-1" /><Button onClick={copy}>{$t('Alles kopieren')}</Button><Button variant="primary" onClick={closeDialog}>{$t('Fertig')}</Button></>}
    >
      <div className="form-stack">
        <Segmented<'all' | 'problems'> label={$t('Anzeigen')} value={filter} onChange={setFilter} options={[{ value: 'all', label: $t('Alles') }, { value: 'problems', label: $t('Nur Probleme') }]} />
        <div className="log-list" role="list">
          {!list.length && <p className="muted small log-empty">{$t('Noch keine Einträge.')}</p>}
          {list.map((e, i) => (
            <div key={`${e.time}-${i}`} role="listitem" className={`log-row is-${e.level}`}>
              <button type="button" className="log-main" aria-expanded={e.detail ? open === i : undefined} onClick={() => setOpen(open === i ? null : i)} disabled={!e.detail}>
                {ICONS[e.level]}
                <span className="log-time mono">{time(e.time)}</span>
                <span className="log-source">{e.source}</span>
                <span className="log-text">{e.text}</span>
                {e.detail && <span className="small muted">{open === i ? 'weniger' : $t('Details')}</span>}
              </button>
              {e.detail && open === i && <pre className="log-detail mono">{e.detail}</pre>}
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
