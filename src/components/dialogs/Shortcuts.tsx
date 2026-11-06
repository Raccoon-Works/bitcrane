/**
 * Overview of the keyboard shortcuts for the current platform, including the
 * ones the user changed in the settings.
 */
import { closeDialog, LIVE, openDialog, useStore } from '../../state/store';
import { ACTIONS, FIXED, formatCombo, keysFor } from '../../state/keys';
import { Button } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function Shortcuts() {
  const platform = useStore((s) => s.platform);
  // keysFor reads the user's shortcuts from the store; subscribing re-renders the list when they change.
  useStore((s) => s.settings.shortcuts);
  // Keyed by action id: a fixed key and a configurable action can share a label ("Vorschau", "Löschen").
  const rows: Array<{ key: string; what: string; keys: string }> = [
    ...ACTIONS.map((a) => ({
      key: a.id,
      what: a.label,
      keys:
        keysFor(a.id, platform)
          .map((k) => formatCombo(k, platform))
          .join('  ') || '–',
    })),
    ...FIXED.map((f) => ({ key: `fixed:${f.label}`, what: f.label, keys: platform === 'mac' ? f.mac : f.win })),
  ];
  return (
    <Dialog
      label={$t('Tastenkürzel')}
      title={$t('Tastenkürzel')}
      subtitle={platform === 'mac' ? $t('Mac') : $t('Windows')}
      width={560}
      maxHeight={680}
      footer={
        <>
          <Button variant="ghost" onClick={() => openDialog({ type: 'settings', tab: 'keys' })}>
            {$t('Ändern …')}
          </Button>
          <span className="flex-1" />
          <Button variant="primary" onClick={closeDialog}>
            {$t('Fertig')}
          </Button>
        </>
      }
    >
      <dl className="shortcut-list">
        {rows.map(({ key, what, keys }) => (
          <div key={key} className="shortcut-row">
            <dt>{what}</dt>
            <dd>
              <kbd>{keys}</kbd>
            </dd>
          </div>
        ))}
      </dl>
      {!LIVE && (
        <p className="small muted">
          {$t(
            'Im Browser fängt der Browser selbst einige Kürzel ab (zum Beispiel ⌘T, ⌘W, ⇧⌘N). Im echten Programm funktionieren sie.',
          )}
        </p>
      )}
    </Dialog>
  );
}
