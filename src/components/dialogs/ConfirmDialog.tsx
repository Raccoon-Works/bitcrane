/**
 * A general question with one confirming button, used by actions that need a
 * yes before they run (optionally with a block of detail text).
 */
import { closeDialog } from '../../state/store';
import { Info, Trash2 } from '../glyphs';
import { Button } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function ConfirmDialog({
  title,
  text,
  confirm,
  danger,
  run,
  detail,
  onCancel = closeDialog,
}: {
  title: string;
  text: string;
  confirm: string;
  danger?: boolean;
  run: () => void;
  detail?: string;
  /** Abbrechen, Escape and the close button; the dialog slot is cleared by default. */
  onCancel?: () => void;
}) {
  return (
    <Dialog
      label={title}
      title={title}
      subtitle={text}
      width={480}
      onClose={onCancel}
      icon={
        danger ? (
          <span className="icon-tile tone-danger">
            <Trash2 size={20} strokeWidth={1.75} />
          </span>
        ) : (
          <span className="icon-tile tone-accent">
            <Info size={20} strokeWidth={1.75} />
          </span>
        )
      }
      footer={
        <>
          <span className="flex-1" />
          <Button autoFocus={danger} onClick={onCancel}>
            {$t('Abbrechen')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            autoFocus={!danger}
            onClick={() => {
              closeDialog();
              run();
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      {detail ? <pre className="confirm-detail mono">{detail}</pre> : null}
    </Dialog>
  );
}
