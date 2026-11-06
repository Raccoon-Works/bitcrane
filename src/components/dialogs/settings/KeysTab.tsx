/**
 * Settings › Tastenkürzel: the key scheme and one row per action with its
 * shortcut, which can be recorded anew.
 */
import { useEffect, useState } from 'react';
import { getState, updateSettings, useStore } from '../../../state/store';
import { ACTIONS, conflictsWith, formatCombo, keysFor, recordCombo } from '../../../state/keys';
import { Button, Segmented } from '../../ui';
import { $t } from '../../../i18n';
import { Group, Row } from './parts';

/** One action per row; "Ändern" records the next key combination. */
export function KeysSettings() {
  const platform = useStore((st) => st.platform);
  const own = useStore((st) => st.settings.shortcuts);
  const scheme = useStore((st) => st.settings.keyScheme ?? 'standard');
  const [recording, setRecording] = useState<string | null>(null);
  const [warn, setWarn] = useState('');
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        updateSettings({ shortcuts: { ...getState().settings.shortcuts, [recording]: '' } });
        setRecording(null);
        return;
      }
      const combo = recordCombo(e, platform);
      if (!combo) return;
      // Without ⌘/Strg/Alt only function keys make sense (letters are for jumping to files).
      if (!/^(Mod|Ctrl|Alt)\+/.test(combo) && !/^(F\d|Insert$|Numpad)/.test(combo)) {
        setWarn($t('Bitte mit ⌘, ⌥ oder ⌃ kombinieren (unter Windows mit Strg oder Alt).'));
        return;
      }
      const clash = conflictsWith(recording, combo, platform);
      const next = { ...getState().settings.shortcuts, [recording]: combo };
      // The other action loses the combination.
      for (const c of clash) next[c.id] = '';
      updateSettings({ shortcuts: next });
      setWarn(clash.length ? $t('„{0}“ hat jetzt kein Kürzel mehr.', clash.map((c) => c.label).join('“, „')) : '');
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, platform]);
  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  const reset = (id: string) => {
    const n = { ...own };
    delete n[id];
    updateSettings({ shortcuts: n });
  };
  return (
    <>
      <Group title={$t('Belegung')}>
        <Row
          label={$t('Tastenbelegung')}
          note={
            scheme === 'commander'
              ? $t(
                  'Wie WinSCP und Total Commander: F3 Vorschau, F4 Bearbeiten, F5 Kopieren in die andere Hälfte, F6 Verschieben, F7 Neuer Ordner, F8 Löschen, F9 Eigenschaften, Einfg markiert. Aktualisieren mit {0}.',
                  formatCombo('Mod+R', platform),
                )
              : platform === 'mac'
                ? $t('Wie im Finder.')
                : $t('Wie im Explorer: F2 Umbenennen, F5 Aktualisieren, Entf Löschen.')
          }
        >
          <Segmented<'standard' | 'commander'>
            label={$t('Tastenbelegung')}
            value={scheme}
            onChange={(v) => updateSettings({ keyScheme: v })}
            options={[
              { value: 'standard', label: platform === 'mac' ? $t('Finder') : $t('Explorer') },
              { value: 'commander', label: $t('WinSCP / Total Commander') },
            ]}
          />
        </Row>
      </Group>
      <p className="small muted">
        {$t('Auf „Ändern“ klicken und die neue Tastenkombination drücken. Entf entfernt das Kürzel, Esc bricht ab.')}
        {warn && <span className="tone-warn"> {warn}</span>}
      </p>
      {groups.map((g) => (
        <Group key={g} title={g}>
          {ACTIONS.filter((a) => a.group === g).map((a) => {
            const keys = keysFor(a.id, platform);
            const changed = own[a.id] !== undefined;
            return (
              <div key={a.id} className="set-row">
                <span className="flex-1">{a.label}</span>
                {recording === a.id ? (
                  <span className="kbd-recording small">{$t('Tasten drücken …')}</span>
                ) : keys.length ? (
                  keys.map((k) => <kbd key={k}>{formatCombo(k, platform)}</kbd>)
                ) : (
                  <span className="small muted">{$t('kein Kürzel')}</span>
                )}
                {changed && recording !== a.id && (
                  <Button small variant="ghost" onClick={() => reset(a.id)}>
                    {$t('Standard')}
                  </Button>
                )}
                <Button
                  small
                  onClick={() => {
                    setWarn('');
                    setRecording(recording === a.id ? null : a.id);
                  }}
                >
                  {recording === a.id ? $t('Abbrechen') : $t('Ändern')}
                </Button>
              </div>
            );
          })}
        </Group>
      ))}
      {Object.keys(own).length > 0 && (
        <Button onClick={() => updateSettings({ shortcuts: {} })}>{$t('Alle zurücksetzen')}</Button>
      )}
    </>
  );
}
