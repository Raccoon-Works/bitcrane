/**
 * A new version is available or downloaded: release notes, progress and the
 * choice between installing now and installing when Bitcrane quits.
 */
import { closeDialog, LIVE, useStore } from '../../state/store';
import { installUpdate, useAppVersion } from '../../state/updates';
import { formatSize } from '../../util/format';
import { AlertTriangle, Download, Info } from '../glyphs';
import { Button } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

/** A new version is ready: what changed, then download, install and restart. */
export function UpdateDialog() {
  const update = useStore((s) => s.update);
  const busy = useStore((s) => s.transfers.some((t) => t.state === 'running' || t.state === 'queued'));
  const installed = useAppVersion();
  // The browser prototype has no installed version to compare the new one with.
  const current = LIVE ? installed : '';
  if (!update) return null;
  // A quiet background download looks like "waiting" here, not like a running installation.
  const working = (update.status === 'downloading' && !update.background) || update.status === 'installing';
  const ready = update.status === 'ready';
  const pct = update.total ? Math.min(100, Math.round(((update.done ?? 0) / update.total) * 100)) : undefined;
  return (
    <Dialog
      label={$t('Update')}
      title={$t('Bitcrane {0} ist da', update.version ?? '')}
      subtitle={current ? $t('Installiert ist Version {0}.', current) : undefined}
      icon={
        <span className="icon-tile tone-accent">
          <Download size={20} strokeWidth={1.75} />
        </span>
      }
      width={520}
      onClose={working ? () => undefined : closeDialog}
      footer={
        <>
          <span className="flex-1" />
          {!working && <Button onClick={closeDialog}>{ready ? $t('Beim Beenden') : $t('Später')}</Button>}
          <Button
            variant="primary"
            disabled={working || update.status === 'downloading'}
            onClick={() => void installUpdate()}
          >
            {update.status === 'error'
              ? $t('Erneut versuchen')
              : update.status === 'downloading' && update.background
                ? $t('Wird geladen …')
                : working
                  ? $t('Wird installiert …')
                  : ready
                    ? $t('Jetzt neu starten')
                    : $t('Jetzt aktualisieren')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        {update.notes ? <p className="update-notes">{update.notes}</p> : null}
        {ready && (
          <div className="notice">
            <Info size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {$t(
                'Das Update ist schon geladen. Es wird installiert, wenn du Bitcrane beendest, oder jetzt mit einem Neustart.',
              )}
            </span>
          </div>
        )}
        {busy && !working && (
          <div className="notice">
            <Info size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{$t('Laufende Übertragungen werden unterbrochen und nach dem Neustart fortgesetzt.')}</span>
          </div>
        )}
        {working && (
          <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="progress">
              <div
                className="progress-fill"
                style={{ width: `${pct ?? (update.status === 'installing' ? 100 : 5)}%` }}
              />
            </div>
            <span className="small muted">
              {update.status === 'installing'
                ? $t('Wird installiert, Bitcrane startet gleich neu …')
                : update.total
                  ? $t('{0} von {1}', formatSize(update.done ?? 0), formatSize(update.total))
                  : $t('Wird geladen …')}
            </span>
          </div>
        )}
        {update.status === 'error' && (
          <div className="notice tone-warn-notice">
            <AlertTriangle size={15} strokeWidth={1.75} className="tone-warn" aria-hidden="true" />
            <span>
              {$t('Das Update konnte nicht installiert werden. Bitcrane läuft in der bisherigen Version weiter.')}
            </span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
