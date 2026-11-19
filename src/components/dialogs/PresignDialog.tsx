import { Loader2 } from '../glyphs';
import { useEffect, useState } from 'react';
import { toBackendError } from '../../backend/api';
import type { PaneSide } from '../../backend/types';
import {
  activeTab,
  closeDialog,
  getState,
  panePath,
  paneLoc,
  presignedLink,
  showToast,
  updateSettings,
} from '../../state/store';
import { join } from '../../util/paths';
import { Button, Segmented } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

/** Durations offered for an S3 link (SigV4 allows at most seven days). */
const LINK_TIMES: Array<{ value: string; label: string }> = [
  { value: '3600', label: $t('1 Stunde') },
  { value: '86400', label: $t('1 Tag') },
  { value: '259200', label: $t('3 Tage') },
  { value: '604800', label: $t('7 Tage') },
];

/**
 * "Link mit Ablaufdatum" (Transmit "Copy Signed URL", Cyberduck): an S3 file
 * can be downloaded by anyone with the link until it expires. Nothing is
 * stored on the service; the link is signed here with the access key.
 */
export function PresignDialog({ side, name }: { side: PaneSide; name: string }) {
  // The file chosen when the dialog opened: its server and path.
  const [file] = useState(() => {
    const tab = activeTab();
    return tab && { serverId: paneLoc(side, tab)[1], path: join(panePath(side), name) };
  });
  const [secs, setSecs] = useState(() => String(getState().settings.presignSecs ?? 86400));
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!file) return;
    let current = true;
    setLink('');
    setError('');
    presignedLink(file.serverId, file.path, Number(secs)).then(
      (l) => current && setLink(l),
      (e) => current && setError(toBackendError(e).message),
    );
    return () => {
      current = false;
    };
  }, [file, secs]);
  const until = new Date(Date.now() + Number(secs) * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const copy = () =>
    void navigator.clipboard.writeText(link).then(() => {
      showToast($t('Link kopiert.'), 'ok');
      closeDialog();
    });
  return (
    <Dialog
      label={$t('Link mit Ablaufdatum')}
      title={$t('Link für „{0}“', name)}
      subtitle={$t(
        'Jeder mit diesem Link kann die Datei herunterladen, bis er abläuft. Danach funktioniert er nicht mehr.',
      )}
      width={620}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={closeDialog}>{$t('Abbrechen')}</Button>
          <Button variant="primary" disabled={!link} onClick={copy}>
            {$t('Link kopieren')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Segmented
          label={$t('Gültig für')}
          value={secs}
          onChange={(v) => {
            setSecs(v);
            updateSettings({ presignSecs: Number(v) });
          }}
          options={LINK_TIMES}
        />
        <span className="small muted">{$t('Gültig bis {0}', until)}</span>
        {!link && !error && (
          <span className="row-inline muted small">
            <Loader2 size={13} className="spin" aria-hidden="true" />
            {$t('Wird erstellt …')}
          </span>
        )}
        {error && <span className="small tone-danger">{error}</span>}
        {link && <code className="mono break small presign-link">{link}</code>}
      </div>
    </Dialog>
  );
}
