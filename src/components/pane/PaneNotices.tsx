/**
 * Boxes above the list of a half: a dropped connection with its next retry,
 * and a Cryptomator vault that can be unlocked.
 */
import type { PaneSide } from '../../backend/types';
import { reconnect, setState, useStore, type AppState } from '../../state/store';
import { unlockVault } from '../../state/vault';
import { Lock, WifiOff } from '../glyphs';
import { Button } from '../ui';
import { $t } from '../../i18n';

/** What continues once the connection is back: a watch or queued transfers (said only when it applies). */
function WaitingNote({ serverId }: { serverId: string }) {
  const watching = useStore((st) => st.watches.some((w) => w.serverId === serverId && w.state !== 'paused'));
  const queued = useStore((st) =>
    st.transfers.some((t) => t.serverId === serverId && (t.state === 'queued' || t.state === 'running')),
  );
  if (watching)
    return (
      <> {$t('Die Überwachung sammelt weiter: wartende Dateien werden hochgeladen, sobald die Verbindung steht.')}</>
    );
  if (queued) return <> {$t('Wartende Übertragungen laufen weiter, sobald die Verbindung steht.')}</>;
  return null;
}

export function OfflineNotice({ serverId, info }: { serverId: string; info: AppState['offline'][string] }) {
  const now = useStore((s) => s.now);
  return (
    <div role="alert" className="offline-box">
      <span className="offline-title">
        <WifiOff size={16} strokeWidth={1.5} aria-hidden="true" />
        {$t('Verbindung unterbrochen')}
      </span>
      <span className="small text-2">
        {$t(
          'Neuer Versuch in {0} Sek. ({1} von 10).',
          Math.max(1, Math.ceil((info.nextRetry - now) / 1000)),
          info.attempt,
        )}
        <WaitingNote serverId={serverId} />
      </span>
      <span className="row-buttons">
        <Button variant="primary" onClick={() => reconnect(serverId)}>
          {$t('Jetzt verbinden')}
        </Button>
        <Button onClick={() => setState({ dialog: { type: 'log' } })}>{$t('Protokoll')}</Button>
      </span>
    </div>
  );
}

export function VaultNotice({ side }: { side: PaneSide }) {
  return (
    <div role="note" className="offline-box">
      <span className="offline-title tone-accent">
        <Lock size={16} aria-hidden="true" />
        {$t('Cryptomator-Tresor')}
      </span>
      <span className="small text-2">
        {$t(
          'Die Dateien in diesem Ordner sind verschlüsselt. Entsperrt zeigt Bitcrane sie im Klartext, in einem eigenen Tab.',
        )}
      </span>
      <span className="row-buttons">
        <Button variant="primary" onClick={() => unlockVault(side)}>
          {$t('Entsperren …')}
        </Button>
      </span>
    </div>
  );
}
