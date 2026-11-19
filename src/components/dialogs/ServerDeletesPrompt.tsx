/**
 * "Auch auf dem Server löschen?": files of a watch with "Lokal Gelöschtes auch auf dem Server löschen"
 * were deleted on this computer. Files deleted while it is open join the list.
 */
import { answerServerDeletes, serverById, useStore } from '../../state/store';
import { basename } from '../../util/paths';
import { $t } from '../../i18n';
import { ConfirmDialog } from './ConfirmDialog';

export function ServerDeletesPrompt() {
  const d = useStore((s) => s.serverDeletes[0]);
  const server = useStore((s) => (d ? serverById(d.serverId, s)?.name : undefined));
  if (!d) return null;
  const one = d.targets.length === 1;
  return (
    <ConfirmDialog
      title={
        one
          ? $t('„{0}“ auch auf dem Server löschen?', basename(d.targets[0]))
          : $t('{0} Dateien auch auf dem Server löschen?', d.targets.length)
      }
      text={$t(
        'Auf diesem Computer im Ordner der Überwachung „{0}“ gelöscht. Auf dem Server „{1}“ lässt sich das Löschen nicht rückgängig machen.',
        d.watchName,
        server ?? '',
      )}
      confirm={$t('Auf dem Server löschen')}
      danger
      detail={d.targets.join('\n')}
      run={() => answerServerDeletes(d.watchId, true)}
      onCancel={() => answerServerDeletes(d.watchId, false)}
    />
  );
}
