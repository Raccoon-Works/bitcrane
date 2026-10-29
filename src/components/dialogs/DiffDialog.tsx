/**
 * "Unterschiede zeigen": line differences between the server copy and the
 * local copy of a file in conflict. Opened from the conflict dialog; "Zurück"
 * returns there so the user can decide. "Dateien vergleichen" (after ForkLift)
 * uses the same view for any two files.
 */
import { AlertTriangle, Loader2 } from '../glyphs';
import { useEffect, useMemo, useState } from 'react';
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { toBackendError } from '../../backend/api';
import { closeDialog, LIVE, openDialog, useStore, type CompareRef } from '../../state/store';
import { diffLines, diffStats, toHunks } from '../../util/diff';
import { Button } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

/** Demo texts for the browser prototype. */
const DEMO_SERVER = 'import discord\nfrom discord.ext import commands\n\nPREFIX = "!"\nDEBUG = True\n\nbot = commands.Bot(command_prefix=PREFIX)\n\n@bot.event\nasync def on_ready():\n    print("online")\n\nbot.run(TOKEN)\n';
const DEMO_LOCAL = 'import discord\nfrom discord.ext import commands\n\nPREFIX = "!"\nDEBUG = False\nLOG_LEVEL = "info"\n\nbot = commands.Bot(command_prefix=PREFIX)\n\n@bot.event\nasync def on_ready():\n    print("Taskbot online")\n\nbot.run(TOKEN)\n';

interface Loaded {
  server: string;
  local: string;
  truncated: boolean;
}

export function DiffDialog({ transferId }: { transferId: string }) {
  const transfer = useStore((s) => s.transfers.find((t) => t.id === transferId));
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!transfer) return;
    if (!LIVE) {
      setData({ server: DEMO_SERVER, local: DEMO_LOCAL, truncated: false });
      return;
    }
    let cancelled = false;
    // Uploads go from the local source to the server target, downloads the other way round.
    const [remotePath, localPath] = transfer.direction === 'down' ? [transfer.source, transfer.target] : [transfer.target, transfer.source];
    Promise.all([backend.remoteReadText(transfer.serverId, remotePath), backend.localReadText(localPath)])
      .then(([server, local]) => {
        if (!cancelled) setData({ server: server.text, local: local.text, truncated: server.truncated || local.truncated });
      })
      .catch((e) => {
        if (!cancelled) setError(toBackendError(e).message);
      });
    return () => { cancelled = true; };
    // Load once per transfer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferId]);

  const lines = useMemo(() => (data ? diffLines(data.server, data.local) : []), [data]);
  const hunks = useMemo(() => toHunks(lines), [lines]);
  const stats = diffStats(lines);
  const back = () => openDialog({ type: 'conflict' });

  return (
    <Dialog
      label={$t('Unterschiede')}
      title={$t('Unterschiede in „{0}“', transfer?.name ?? '')}
      subtitle={$t('Rot: nur auf dem Server. Grün: nur in deiner Version auf diesem Rechner.')}
      width={820}
      maxHeight={640}
      onClose={back}
      footer={<><span className="flex-1 small muted">{data && (stats.added || stats.removed) ? $t('{0} Zeilen neu, {1} Zeilen entfernt', stats.added, stats.removed) : ''}</span><Button variant="primary" onClick={back}>{$t('Zurück zur Entscheidung')}</Button></>}
    >
      {!data && !error && <p className="row-inline muted"><Loader2 size={14} strokeWidth={1.75} className="spin" aria-hidden="true" />{$t('Wird geladen …')}</p>}
      {error && <div className="notice tone-warn-notice"><AlertTriangle size={15} strokeWidth={1.75} className="tone-warn" aria-hidden="true" /><span>{error}</span></div>}
      {data && !hunks.length && <p className="muted">{$t('Die beiden Versionen sind inhaltlich gleich; nur das Änderungsdatum unterscheidet sich.')}</p>}
      {data && hunks.length > 0 && <DiffTable hunks={hunks} truncated={data.truncated} />}
    </Dialog>
  );
}

type Hunks = ReturnType<typeof toHunks>;

/** The line-by-line table shared by both windows. */
function DiffTable({ hunks, truncated }: { hunks: Hunks; truncated: boolean }) {
  return (
    <div className="diff" role="table" aria-label={$t('Unterschiede')}>
      {truncated && <div className="diff-skip">{$t('Die Datei ist sehr groß; gezeigt wird nur der Anfang.')}</div>}
      {hunks.map((h, i) => (
        <div key={i} role="rowgroup">
          {h.skipped > 0 && <div className="diff-skip">{h.skipped} {$t('unveränderte')}{' '}{h.skipped === 1 ? $t('Zeile') : $t('Zeilen')}</div>}
          {h.lines.map((l, j) => (
            <div key={j} role="row" className={`diff-line is-${l.op}`}>
              <span className="diff-no" role="cell">{l.oldNo ?? ''}</span>
              <span className="diff-no" role="cell">{l.newNo ?? ''}</span>
              <span className="diff-sign" role="cell" aria-label={l.op === 'add' ? $t('neu') : l.op === 'del' ? $t('entfernt') : $t('gleich')}>{l.op === 'add' ? '+' : l.op === 'del' ? '−' : ''}</span>
              <span className="diff-text" role="cell">{l.text || ' '}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Reads a text file from this computer or a server. */
function readText(ref: CompareRef) {
  return ref.side === 'local' ? backend.localReadText(ref.path) : backend.remoteReadText(ref.serverId, ref.path);
}

/** "Dateien vergleichen": any two text files, each on this computer or a server. */
export function CompareFilesDialog({ a, b }: { a: CompareRef; b: CompareRef }) {
  const [data, setData] = useState<{ a: string; b: string; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!LIVE) {
      setData({ a: DEMO_SERVER, b: DEMO_LOCAL, truncated: false });
      return;
    }
    let cancelled = false;
    Promise.all([readText(a), readText(b)])
      .then(([x, y]) => { if (!cancelled) setData({ a: x.text, b: y.text, truncated: x.truncated || y.truncated }); })
      .catch((e) => { if (!cancelled) setError(toBackendError(e).message); });
    return () => { cancelled = true; };
  }, [a, b]);
  const lines = useMemo(() => (data ? diffLines(data.a, data.b) : []), [data]);
  const hunks = useMemo(() => toHunks(lines), [lines]);
  const stats = diffStats(lines);
  return (
    <Dialog
      label={$t('Dateien vergleichen')}
      title={$t('Dateien vergleichen')}
      subtitle={$t('Rot (−): nur in {0}. Grün (+): nur in {1}.', a.label, b.label)}
      width={820}
      maxHeight={640}
      footer={<><span className="flex-1 small muted">{data && (stats.added || stats.removed) ? $t('{0} Zeilen neu, {1} Zeilen entfernt', stats.added, stats.removed) : ''}</span><Button variant="primary" onClick={closeDialog}>{$t('Fertig')}</Button></>}
    >
      {!data && !error && <p className="row-inline muted"><Loader2 size={14} strokeWidth={1.75} className="spin" aria-hidden="true" />{$t('Wird geladen …')}</p>}
      {error && <div className="notice tone-warn-notice"><AlertTriangle size={15} strokeWidth={1.75} className="tone-warn" aria-hidden="true" /><span>{error}</span></div>}
      {data && !hunks.length && <p className="muted">{$t('Die beiden Dateien sind inhaltlich gleich.')}</p>}
      {data && hunks.length > 0 && <DiffTable hunks={hunks} truncated={data.truncated} />}
    </Dialog>
  );
}
