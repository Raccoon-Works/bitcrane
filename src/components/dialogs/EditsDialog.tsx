import { reopenEditing, stopEditing, uploadEditingNow } from '../../state/live';
import { closeDialog, useStore } from '../../state/store';
import { formatAgo } from '../../util/format';
import { basename } from '../../util/paths';
import { Button } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

/** "Bearbeitete Dateien": server files open in an editor; each save uploads them. */
export function EditsDialog() {
  const edits = useStore((s) => s.edits);
  const servers = useStore((s) => s.servers);
  const now = useStore((s) => s.now);
  return (
    <Dialog
      label={$t('Bearbeitete Dateien')}
      title={$t('Bearbeitete Dateien')}
      subtitle={$t(
        'Server-Dateien, die im Editor offen sind. Jedes Sichern lädt sie wieder hoch, bis du das Bearbeiten beendest.',
      )}
      width={720}
      maxHeight={600}
      footer={
        <>
          <span className="flex-1" />
          <Button variant="primary" onClick={closeDialog}>
            {$t('Fertig')}
          </Button>
        </>
      }
    >
      {!edits.length && (
        <p className="muted">
          {$t(
            'Gerade ist keine Server-Datei im Editor offen. Mit „Im Editor öffnen“ auf einer Server-Datei beginnt es.',
          )}
        </p>
      )}
      {edits.length > 0 && (
        <div className="edit-list">
          {edits.map((e) => (
            <div key={e.localPath} className="edit-row">
              <span className="col-text flex-1 min-w-0">
                <span className="strong-500 ellipsis">{basename(e.remotePath)}</span>
                <span className="small muted mono ellipsis" title={e.remotePath}>
                  {servers.find((x) => x.id === e.serverId)?.name ?? '?'} · {e.remotePath}
                </span>
                <span className="small muted">
                  {e.lastUpload
                    ? $t('zuletzt hochgeladen {0}', formatAgo(e.lastUpload, now))
                    : $t('seit dem Öffnen nicht gesichert')}
                </span>
              </span>
              <Button small onClick={() => reopenEditing(e.localPath)}>
                {$t('Im Editor zeigen')}
              </Button>
              <Button small onClick={() => uploadEditingNow(e.localPath)}>
                {$t('Jetzt hochladen')}
              </Button>
              <Button small variant="ghost" onClick={() => void stopEditing(e.localPath)}>
                {$t('Beenden')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
