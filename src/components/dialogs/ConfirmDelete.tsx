/**
 * Confirmation before deleting: says whether the entries go to a recycle bin
 * (this computer, the server's own one, a cloud service) or are gone for good.
 */
import { isCloudProtocol, type PaneSide } from '../../backend/types';
import { serverTrash } from '../../state/live';
import { activeTab, closeDialog, deleteNames, LIVE, paneLoc, panePath, serverById, useStore } from '../../state/store';
import { Trash2 } from '../glyphs';
import { Button } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function ConfirmDelete({ side, names }: { side: PaneSide; names: string[] }) {
  const tab = useStore((s) => activeTab(s));
  const [ls, sid] = paneLoc(side, tab);
  const remote = ls === 'remote';
  const srv = useStore((s) => (remote ? serverById(sid, s) : undefined));
  const what = names.length === 1 ? `„${names[0]}“` : $t('{0} Objekte', names.length);
  // A server with its own recycle bin (WinSCP): the entries are moved there, unless they already are in it.
  const trash = remote ? (LIVE ? serverTrash(sid) : srv?.trashDir) : undefined;
  const dir = useStore((s) => panePath(side, s));
  const holdsTrash =
    !!trash &&
    names.some((n) => {
      const p = `${dir.replace(/\/$/, '')}/${n}`;
      return trash === p || trash.startsWith(p + '/');
    });
  const toTrash = !!trash && !holdsTrash && dir !== trash && !dir.startsWith(trash + '/');
  // Dropbox, Google Drive and OneDrive keep deleted files for a while (restorable on their website).
  const cloud = remote && isCloudProtocol(srv?.protocol);
  return (
    <Dialog
      label={$t('Löschen bestätigen')}
      title={
        toTrash
          ? $t('{0} in den Papierkorb auf dem Server legen?', what)
          : cloud
            ? $t('{0} löschen?', what)
            : remote
              ? $t('{0} vom Server löschen?', what)
              : $t('{0} in den Papierkorb legen?', what)
      }
      subtitle={
        toTrash
          ? $t(
              'Sie kommen in den Ordner {0} auf {1} und lassen sich von dort zurückholen.',
              trash,
              srv?.name ?? $t('dem Server'),
            )
          : cloud
            ? $t(
                '{0} bewahrt gelöschte Dateien eine Zeit lang auf; auf der Website des Dienstes lassen sie sich wiederherstellen.',
                srv?.name ?? '',
              )
            : remote
              ? $t(
                  'Auf {0} gibt es keinen Papierkorb. Gelöschte Dateien sind dort endgültig weg.',
                  srv?.name ?? $t('dem Server'),
                )
              : $t('Du kannst sie aus dem Papierkorb wiederherstellen.')
      }
      icon={
        <span className="icon-tile tone-danger">
          <Trash2 size={20} strokeWidth={1.75} />
        </span>
      }
      width={480}
      footer={
        <>
          <span className="flex-1" />
          <Button autoFocus onClick={closeDialog}>
            {$t('Abbrechen')}
          </Button>
          <Button variant="danger" onClick={() => deleteNames(side, names)}>
            {cloud ? $t('Löschen') : remote && !toTrash ? $t('Endgültig löschen') : $t('In den Papierkorb')}
          </Button>
        </>
      }
    >
      {names.length > 1 && (
        <ul className="delete-list small">
          {names.slice(0, 6).map((n) => (
            <li key={n}>{n}</li>
          ))}
          {names.length > 6 && (
            <li>
              {$t('… und')} {names.length - 6} {$t('weitere')}
            </li>
          )}
        </ul>
      )}
    </Dialog>
  );
}
