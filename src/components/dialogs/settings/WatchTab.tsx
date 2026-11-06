/**
 * Settings › Überwachung: running in the background, defaults for new watches
 * and how Bitcrane reports what they did.
 */
import { setSettingsSection, updateSettings, useStore } from '../../../state/store';
import { Button, Select, Switch } from '../../ui';
import { $t } from '../../../i18n';
import { Chips, Group, Row } from './parts';

export function WatchSettings() {
  const s = useStore((st) => st.settings);
  const mac = useStore((st) => st.platform) === 'mac';
  return (
    <>
      <Group title={$t('Hintergrund')}>
        <Row
          label={$t('Im Hintergrund weiterlaufen')}
          note={$t('Überwachungen laufen weiter, wenn das Fenster geschlossen ist.')}
        >
          <Switch
            checked={s.runInBackground}
            onChange={(v) => updateSettings({ runInBackground: v })}
            label={$t('Im Hintergrund weiterlaufen')}
          />
        </Row>
        <Row
          label={mac ? $t('Beim Anmelden am Mac starten') : $t('Mit Windows starten')}
          note={$t('Gespeicherte Überwachungen starten automatisch.')}
        >
          <Switch
            checked={s.startAtLogin}
            onChange={(v) => updateSettings({ startAtLogin: v })}
            label={$t('Beim Anmelden starten')}
          />
        </Row>
        <Row
          label={mac ? $t('Nur in der Menüleiste starten') : $t('Nur im Infobereich starten')}
          note={
            mac
              ? $t('Beim Anmelden öffnet sich kein Fenster; Bitcrane ist über das Symbol in der Menüleiste erreichbar.')
              : $t(
                  'Beim Anmelden öffnet sich kein Fenster; Bitcrane ist über das B im Infobereich bei der Uhr erreichbar.',
                )
          }
        >
          <Switch
            checked={!!s.startHidden}
            disabled={!s.startAtLogin}
            onChange={(v) => updateSettings({ startHidden: v })}
            label={$t('Nur im Infobereich starten')}
          />
        </Row>
      </Group>
      <Group title={$t('Verhalten neuer Überwachungen')}>
        <Row label={$t('Wartezeit vor dem Hochladen')} note={$t('Sammelt schnell aufeinanderfolgende Änderungen.')}>
          <Select
            value={String(s.defaultDelay)}
            onChange={(v) => updateSettings({ defaultDelay: Number(v) })}
            label={$t('Wartezeit')}
            options={[0, 1, 2, 5, 10].map((n) => ({
              value: String(n),
              label: n === 1 ? $t('1 Sekunde') : $t('{0} Sekunden', n),
            }))}
          />
        </Row>
        <Row label={$t('Standardmäßig nicht hochladen')} column>
          <Chips
            values={s.defaultExcludes}
            onChange={(v) => updateSettings({ defaultExcludes: v })}
            placeholder="*.bak"
          />
        </Row>
        <Row
          label={$t('Lokal Gelöschtes auch auf dem Server löschen')}
          note={$t('Gilt nur als Vorgabe; jede Überwachung kann es einzeln ändern.')}
        >
          <Switch
            checked={s.defaultMirrorDeletes}
            onChange={(v) => updateSettings({ defaultMirrorDeletes: v })}
            label={$t('Lokal Gelöschtes löschen')}
          />
        </Row>
      </Group>
      <Group title={$t('Hinweise')}>
        <Row label={$t('Mitteilung bei')}>
          <Select
            value={s.notify}
            onChange={(v) => updateSettings({ notify: v })}
            label={$t('Mitteilung bei')}
            options={[
              { value: 'errors', label: $t('Nur bei Fehlern') },
              { value: 'all', label: $t('Jedem Upload') },
              { value: 'none', label: $t('Nie') },
            ]}
          />
        </Row>
        <Row label={$t('Ton bei Fehlern')} note={$t('Kurzer Systemton, wenn ein Upload fehlschlägt.')}>
          <Switch
            checked={s.soundOnError}
            onChange={(v) => updateSettings({ soundOnError: v })}
            label={$t('Ton bei Fehlern')}
          />
        </Row>
        <Row label={$t('Ton, wenn alles hochgeladen ist')}>
          <Switch
            checked={s.soundOnDone}
            onChange={(v) => updateSettings({ soundOnDone: v })}
            label={$t('Ton bei fertig')}
          />
        </Row>
        <Row
          label={$t('Fortschritt am Programmsymbol zeigen')}
          note={mac ? $t('Balken und Anzahl am Symbol im Dock.') : $t('Balken am Symbol in der Taskleiste.')}
        >
          <Switch
            checked={s.dockProgress}
            onChange={(v) => updateSettings({ dockProgress: v })}
            label={$t('Fortschritt am Programmsymbol')}
          />
        </Row>
      </Group>
      <Group title={$t('Tastenkürzel')}>
        <Row
          label={$t('Kürzel für Überwachungen und alles andere')}
          note={$t('Neue Überwachung, Übersicht, alle pausieren …')}
        >
          <Button small onClick={() => setSettingsSection('keys')}>
            {$t('Tastenkürzel …')}
          </Button>
        </Row>
      </Group>
    </>
  );
}
