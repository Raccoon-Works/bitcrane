/**
 * A file exists at the target already: compares both versions and asks what
 * to do, optionally for every further conflict of the same run.
 */
import { useState } from 'react';
import type { ConflictChoice } from '../../backend/types';
import { openDialog, resolveConflict, useStore } from '../../state/store';
import { formatDate, formatSize } from '../../util/format';
import { AlertTriangle, Info } from '../glyphs';
import { FileGlyph } from '../icons';
import { Button, Checkbox } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

type ConflictOption = { value: ConflictChoice; title: string; note: string };

export function ConflictDialog() {
  // A fresh form per conflict, so an answer never carries over to the next file.
  const id = useStore((s) => s.conflicts[0]?.transferId);
  return <ConflictForm key={id ?? ''} />;
}

function ConflictForm() {
  const conflict = useStore((s) => s.conflicts[0]);
  const platform = useStore((s) => s.platform);
  const servers = useStore((s) => s.servers);
  const [choice, setChoice] = useState<ConflictChoice>('keepServer');
  const [all, setAll] = useState(false);
  if (!conflict) return null;
  const srv = servers.find((x) => x.id === conflict.serverId);
  const down = conflict.direction === 'down';
  // Server to server: "your version" is the copy on the source server.
  const source = conflict.cross ? servers.find((x) => x.id === conflict.sourceServerId) : undefined;
  const here = source ? source.name : platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC');
  const tag = down ? $t('Server') : source ? source.name : platform === 'mac' ? $t('Mac') : 'PC';
  const renamed = conflict.name.replace(/(\.[^.]+)?$/, (ext) => ` (${tag})${ext}`);
  const remoteNewer = conflict.remoteTime - conflict.localTime > 1000;
  const localNewer = conflict.localTime - conflict.remoteTime > 1000;
  const serverName = srv?.name ?? $t('Server');
  const options: ConflictOption[] = down
    ? [
        {
          value: 'keepServer',
          title: $t('Datei auf diesem Rechner behalten'),
          note: $t('Die Server-Version wird diesmal nicht heruntergeladen.'),
        },
        {
          value: 'replace',
          title: $t('Ersetzen'),
          note: $t('Die Server-Version überschreibt die Datei auf diesem Rechner.'),
        },
        {
          value: 'keepBoth',
          title: $t('Beide behalten'),
          note: $t('Die Server-Version wird als „{0}“ daneben gespeichert.', renamed),
        },
      ]
    : (
        [
          {
            value: 'keepServer',
            title: $t('Server-Datei behalten'),
            note: $t('Deine Version wird diesmal nicht hochgeladen.'),
          },
          {
            value: 'replace',
            title: $t('Ersetzen'),
            note: remoteNewer
              ? $t('Deine Version überschreibt die neuere Datei auf dem Server.')
              : $t('Deine Version überschreibt die Datei auf dem Server.'),
          },
          {
            value: 'keepBoth',
            title: $t('Beide behalten'),
            note: $t('Deine Version wird als „{0}“ daneben hochgeladen.', renamed),
          },
          {
            value: 'download',
            title: $t('Server-Version herunterladen'),
            note: $t('Holt die Datei vom Server auf diesen Rechner, bevor du weiterarbeitest.'),
          },
        ] satisfies ConflictOption[]
      ).filter((o) => !(conflict.cross && o.value === 'download'));
  const card = (label: string, size: number, time: number, newer: boolean) => (
    <div className={`compare-card${newer ? ' is-newer' : ''}`}>
      <span className="row-between">
        <span className="caption-strong">{label}</span>
        {newer && <span className="badge-warn">{$t('neuer')}</span>}
      </span>
      <span className="row-inline">
        <FileGlyph size={22} name={conflict.name} />
        <span className="col-text">
          <span className="strong-500">{conflict.name}</span>
          <span className="small muted">
            {formatSize(size)} · {formatDate(time)}
          </span>
        </span>
      </span>
    </div>
  );
  return (
    <Dialog
      label={$t('Datei gibt es schon')}
      title={
        down
          ? $t('„{0}“ gibt es auf diesem Rechner schon', conflict.name)
          : $t('„{0}“ gibt es auf dem Server schon', conflict.name)
      }
      subtitle={
        down
          ? $t('Von: {0}, {1}', serverName, conflict.remoteFolder)
          : $t('Ziel: {0}, {1}', serverName, conflict.remoteFolder)
      }
      width={640}
      onClose={() => resolveConflict('keepServer', false)}
      footer={
        <>
          <Checkbox
            checked={all}
            onChange={setAll}
            label={$t('Für alle weiteren Fälle übernehmen{0}', conflict.more ? ` (${conflict.more})` : '')}
            disabled={!conflict.more}
          />
          <span className="flex-1" />
          <Button onClick={() => openDialog({ type: 'diff', transferId: conflict.transferId })}>
            {$t('Unterschiede zeigen')}
          </Button>
          <Button variant="primary" onClick={() => resolveConflict(choice, all)}>
            {$t('Weiter')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        {conflict.reason !== 'exists' ? (
          <div className="notice tone-warn-notice">
            <AlertTriangle size={15} strokeWidth={1.75} className="tone-warn" aria-hidden="true" />
            <span>
              {$t('Die Datei auf dem Server ist')} <strong className="tone-warn">{$t('neuer')}</strong>{' '}
              {$t('als deine. Jemand hat sie dort geändert.')}
              {conflict.watchName
                ? $t(' Die Überwachung „{0}“ wartet auf deine Entscheidung.', conflict.watchName)
                : ''}
            </span>
          </div>
        ) : (
          <div className="notice">
            <Info size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{$t('Am Ziel liegt schon eine Datei mit diesem Namen. Was soll passieren?')}</span>
          </div>
        )}
        <div className="compare">
          {card(here, conflict.localSize, conflict.localTime, localNewer)}
          {card(conflict.cross ? serverName : $t('Server'), conflict.remoteSize, conflict.remoteTime, remoteNewer)}
        </div>
        <div role="radiogroup" aria-label={$t('Was soll passieren?')} className="radio-list">
          {options.map((o) => (
            <label key={o.value} className={`radio-row${choice === o.value ? ' is-on' : ''}`}>
              <input type="radio" name="conflict" checked={choice === o.value} onChange={() => setChoice(o.value)} />
              <span className="radio-dot" aria-hidden="true" />
              <span className="col-text">
                <span className="strong-500">{o.title}</span>
                <span className="small muted">{o.note}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
