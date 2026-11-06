/**
 * Settings › Darstellung: theme, zoom, file list, toolbar and window layout.
 */
import { Eye } from '../../glyphs';
import {
  currentZoom,
  defaultZoom,
  openDialog,
  setState,
  setThemeSetting,
  updateSettings,
  useStore,
  ZOOM_STEPS,
} from '../../../state/store';
import { Button, Segmented, Select, Switch } from '../../ui';
import { $t } from '../../../i18n';
import { TOOLBAR_LOOKS } from '../ToolbarCustomize';
import { Group, Row } from './parts';

/** Zoom steps as a row of points (Spotify): smaller on the left, larger on the right. */
function ZoomPicker({ value, standard }: { value: number; standard: number }) {
  const near = ZOOM_STEPS.reduce((b, z) => (Math.abs(z - value) < Math.abs(b - value) ? z : b), ZOOM_STEPS[0]);
  return (
    <div className="zoom-picker" role="radiogroup" aria-label={$t('Zoom')}>
      <div className="zoom-ends">
        <span>{$t('Kleiner')}</span>
        <span>{$t('Größer')}</span>
      </div>
      <div className="zoom-track">
        {ZOOM_STEPS.map((z) => (
          <button
            key={z}
            type="button"
            role="radio"
            aria-checked={z === near}
            className={`zoom-step${z === near ? ' is-on' : ''}${z === standard ? ' is-default' : ''}`}
            title={z === standard ? $t('Standard') : undefined}
            onClick={() => updateSettings({ zoom: z })}
          >
            <span className="zoom-dot" />
            <span className="zoom-label">{Math.round(z * 100)} %</span>
          </button>
        ))}
      </div>
      {near !== standard && (
        <div className="zoom-reset">
          <Button small onClick={() => updateSettings({ zoom: standard })}>
            {$t('Zurücksetzen')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function AppearanceSettings() {
  const s = useStore((st) => st.settings);
  const platform = useStore((st) => st.platform);
  const toolbarLabels = useStore((st) => st.toolbarLabels);
  const mac = platform === 'mac';
  return (
    <Group title={$t('Darstellung')}>
      <Row label={$t('Erscheinungsbild')}>
        <Select
          value={s.themeSetting}
          onChange={(v) => setThemeSetting(v)}
          label={$t('Erscheinungsbild')}
          options={[
            { value: 'system', label: $t('Wie das System') },
            { value: 'dark', label: $t('Dunkel') },
            { value: 'light', label: $t('Hell') },
          ]}
        />
      </Row>
      <Row
        label={$t('Dunkle Farben')}
        note={$t(
          '„Mitternacht“ ist fast schwarz mit hellblauen Akzenten; die andere Wahl folgt den Farben des Systems.',
        )}
      >
        <Select<'midnight' | 'system'>
          value={s.darkPalette === 'system' ? 'system' : 'midnight'}
          onChange={(v) => updateSettings({ darkPalette: v })}
          label={$t('Dunkle Farben')}
          options={[
            { value: 'midnight', label: $t('Mitternacht') },
            { value: 'system', label: mac ? $t('Wie macOS') : $t('Wie Windows') },
          ]}
        />
      </Row>
      <Row
        label={$t('Zoom')}
        note={
          mac
            ? $t('Alles im Fenster größer oder kleiner, auch mit ⌘ + Plus/Minus, ⌘ + 0 setzt zurück.')
            : $t('Alles im Fenster größer oder kleiner, auch mit Strg + Plus/Minus, Strg + 0 setzt zurück.')
        }
      >
        <span />
      </Row>
      <ZoomPicker value={currentZoom()} standard={defaultZoom()} />
      <Row
        label={$t('Dateisymbole des Systems')}
        note={
          mac
            ? $t('Statt der farbigen Bitcrane-Symbole die Symbole von macOS zeigen.')
            : $t('Statt der farbigen Bitcrane-Symbole die Symbole von Windows zeigen.')
        }
      >
        <Switch
          checked={!!s.systemIcons}
          onChange={(v) => updateSettings({ systemIcons: v })}
          label={$t('Dateisymbole des Systems')}
        />
      </Row>
      <Row
        label={$t('Vorschaubilder für Bilder auf dem Server')}
        note={$t(
          'In der Symbolansicht wird dafür jedes Bild bis 10 MB vom Server geladen. Bei langsamen Verbindungen oder vielen Fotos dauert das.',
        )}
      >
        <Switch
          checked={!!s.remoteThumbs}
          onChange={(v) => updateSettings({ remoteThumbs: v })}
          label={$t('Vorschaubilder für Bilder auf dem Server')}
        />
      </Row>
      <Row label={$t('Versteckte Dateien zeigen')}>
        <Switch
          checked={s.showHidden}
          onChange={(v) => updateSettings({ showHidden: v })}
          label={$t('Versteckte Dateien zeigen')}
        />
      </Row>
      {/* Windows only: protected system items (hidden + system attribute); the Mac has no such files in the home folder. */}
      {!mac && (
        <Row
          label={$t('Geschützte Systemdateien zeigen')}
          note={$t(
            'Wie im Explorer standardmäßig aus, z. B. „Anwendungsdaten“ oder „Eigene Dateien“ im Benutzerordner.',
          )}
        >
          <Switch
            checked={!!s.showSystem}
            onChange={(v) => updateSettings({ showSystem: v })}
            label={$t('Geschützte Systemdateien zeigen')}
          />
        </Row>
      )}
      <Row
        label={$t('Eintrag „..“ zum übergeordneten Ordner')}
        note={$t(
          'Ganz oben in der Liste, wie in WinSCP und Total Commander. Unter Windows standardmäßig an, auf dem Mac aus.',
        )}
      >
        <Switch
          checked={s.parentRow ?? platform === 'win'}
          onChange={(v) => updateSettings({ parentRow: v })}
          label={$t('Eintrag „..“ zum übergeordneten Ordner')}
        />
      </Row>
      <Row
        label={$t('Spalte „Geändert“')}
        note={$t('Spalten lassen sich auch mit einem Rechtsklick auf die Spaltenköpfe ein- und ausblenden.')}
      >
        <Switch
          checked={s.columns.mtime}
          onChange={(v) => updateSettings({ columns: { ...s.columns, mtime: v } })}
          label={$t('Spalte Geändert')}
        />
      </Row>
      <Row label={$t('Spalte „Rechte“')}>
        <Switch checked={s.showPerms} onChange={(v) => updateSettings({ showPerms: v })} label={$t('Spalte Rechte')} />
      </Row>
      <Row label={$t('Spalte „Größe“')}>
        <Switch
          checked={s.columns.size}
          onChange={(v) => updateSettings({ columns: { ...s.columns, size: v } })}
          label={$t('Spalte Größe')}
        />
      </Row>
      <Row
        label={$t('Zeilenhöhe')}
        note={$t('„Kompakt“ zeigt mehr Dateien auf einmal und passt besser in kleine Fenster.')}
      >
        <Segmented<'standard' | 'compact'>
          label={$t('Zeilenhöhe')}
          value={s.density ?? 'standard'}
          onChange={(v) => updateSettings({ density: v })}
          options={[
            { value: 'standard', label: $t('Standard') },
            { value: 'compact', label: $t('Kompakt') },
          ]}
        />
      </Row>
      <Row
        label={$t('Werkzeugleiste')}
        note={$t(
          'Mit Beschriftung stehen kurze Namen unter den Symbolen. Welche Symbole erscheinen, legst du unter „Anpassen“ fest.',
        )}
      >
        <Select
          value={toolbarLabels}
          onChange={(v) => setState({ toolbarLabels: v })}
          label={$t('Werkzeugleiste')}
          options={TOOLBAR_LOOKS()}
        />
        <Button small onClick={() => openDialog({ type: 'toolbar' })}>
          {$t('Anpassen …')}
        </Button>
      </Row>
      <Row
        label={$t('Seitenleiste')}
        note={$t(
          'Favoriten, zuletzt verwendete Ordner, Geräte, Freigaben und Tags links im Fenster. Aus: die Orte-Leisten über den Hälften.',
        )}
      >
        <Switch
          checked={s.sidebar !== false}
          onChange={(v) => updateSettings({ sidebar: v })}
          label={$t('Seitenleiste')}
        />
      </Row>
      <Row
        label={$t('Hälften untereinander')}
        note={$t('Für schmale Fenster: die beiden Hälften übereinander statt nebeneinander.')}
      >
        <Switch
          checked={!!s.stackHalves}
          onChange={(v) => updateSettings({ stackHalves: v })}
          label={$t('Hälften untereinander')}
        />
      </Row>
      <Row
        label={$t('Nur eine Hälfte')}
        note={$t(
          'Zeigt nur die aktive Hälfte. Die andere bleibt Ziel beim Übertragen und lässt sich jederzeit einblenden.',
        )}
      >
        <Switch
          checked={!!s.singleHalf}
          onChange={(v) => updateSettings({ singleHalf: v })}
          label={$t('Nur eine Hälfte')}
        />
      </Row>
      <Row
        label={$t('Git-Status in Ordnern dieses Computers')}
        note={$t(
          'Zeigt in Git-Projekten geänderte Dateien und den Zweig mit Commit, Pull und Push. Braucht ein installiertes Git.',
        )}
      >
        <Switch
          checked={s.gitStatus !== false}
          onChange={(v) => updateSettings({ gitStatus: v })}
          label={$t('Git-Status')}
        />
      </Row>
      <Row label={$t('Bewegung')} note={$t('Folgt der Systemeinstellung „Bewegung reduzieren“.')}>
        <span className="small muted">
          <Eye size={13} strokeWidth={1.5} aria-hidden="true" /> {$t('automatisch')}
        </span>
      </Row>
    </Group>
  );
}
