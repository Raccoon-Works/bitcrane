/**
 * Settings › Übertragungen: parallel transfers, existing files, speed limits,
 * what to skip and how uploads are written.
 */
import { updateSettings, useStore } from '../../../state/store';
import { Select, Switch } from '../../ui';
import { $t } from '../../../i18n';
import { existingOptions, permOptions } from './options';
import { Chips, Group, Row } from './parts';

/** Speed limits offered for uploads and downloads, in KB/s (0 = unlimited). */
const SPEEDS = [0, 256, 512, 1024, 2048, 5120, 10240, 25600, 51200].map((n) => ({
  value: String(n),
  label: n === 0 ? $t('Unbegrenzt') : n >= 1024 ? `${n / 1024} MB/s` : `${n} KB/s`,
}));

export function TransferSettings() {
  const s = useStore((st) => st.settings);
  return (
    <>
      <Group title={$t('Übertragungen')}>
        <Row label={$t('Gleichzeitige Übertragungen')}>
          <Select
            value={String(s.parallel)}
            onChange={(v) => updateSettings({ parallel: Number(v) })}
            label={$t('Gleichzeitige Übertragungen')}
            options={[1, 2, 3, 4, 6].map((n) => ({ value: String(n), label: String(n) }))}
          />
        </Row>
        <Row
          label={$t('Beim Hochladen, wenn die Datei auf dem Server schon existiert')}
          note={$t('Gilt für das Hochladen von Hand. Überwachungen laden geänderte Dateien immer hoch.')}
        >
          <Select
            value={s.existingFiles}
            onChange={(v) => updateSettings({ existingFiles: v })}
            label={$t('Beim Hochladen, wenn die Datei schon existiert')}
            options={existingOptions}
          />
        </Row>
        <Row label={$t('Beim Herunterladen, wenn die Datei hier schon existiert')}>
          <Select
            value={s.existingDownload}
            onChange={(v) => updateSettings({ existingDownload: v })}
            label={$t('Beim Herunterladen, wenn die Datei schon existiert')}
            options={existingOptions}
          />
        </Row>
        <Row
          label={$t('Nach dem Herunterladen öffnen')}
          note={$t(
            'Heruntergeladene Dateien öffnen sich mit ihrem üblichen Programm. Gilt für Downloads von Hand, nicht für den Abgleich.',
          )}
        >
          <Switch
            checked={!!s.openAfterDownload}
            onChange={(v) => updateSettings({ openAfterDownload: v || undefined })}
            label={$t('Nach dem Herunterladen öffnen')}
          />
        </Row>
        <Row
          label={$t('Unveränderte Dateien überspringen')}
          note={$t(
            'Liegt am Ziel schon eine Datei mit gleicher Größe und gleicher Änderungszeit, wird sie nicht noch einmal übertragen.',
          )}
        >
          <Switch
            checked={s.skipUnchanged}
            onChange={(v) => updateSettings({ skipUnchanged: v })}
            label={$t('Unveränderte Dateien überspringen')}
          />
        </Row>
        <Row
          label={$t('Ruhezustand verhindern, solange übertragen wird')}
          note={$t('Der Bildschirm darf ausgehen, der Rechner schläft aber erst ein, wenn alles fertig ist.')}
        >
          <Switch
            checked={s.keepAwake !== false}
            onChange={(v) => updateSettings({ keepAwake: v })}
            label={$t('Ruhezustand verhindern')}
          />
        </Row>
        <Row
          label={$t('Bei Fehlern automatisch erneut versuchen')}
          note={$t('Bis zu drei Versuche im Abstand von 5 Sekunden, nicht bei fehlenden Rechten.')}
        >
          <Switch
            checked={s.autoRetry}
            onChange={(v) => updateSettings({ autoRetry: v })}
            label={$t('Automatisch erneut versuchen')}
          />
        </Row>
        <Row label={$t('Hochladen begrenzen')} note={$t('Gilt für alle Uploads zusammen, auch von Server zu Server.')}>
          <Select
            value={String(s.bandwidthLimit)}
            onChange={(v) => updateSettings({ bandwidthLimit: Number(v) })}
            label={$t('Hochladen begrenzen')}
            options={SPEEDS}
          />
        </Row>
        <Row label={$t('Herunterladen begrenzen')} note={$t('Gilt für alle Downloads zusammen.')}>
          <Select
            value={String(s.bandwidthLimitDown ?? s.bandwidthLimit)}
            onChange={(v) => updateSettings({ bandwidthLimitDown: Number(v) })}
            label={$t('Herunterladen begrenzen')}
            options={SPEEDS}
          />
        </Row>
      </Group>
      <Group title={$t('Beim Übertragen von Hand auslassen')}>
        <Row label={$t('Namen und Muster')} column>
          <Chips values={s.skipPatterns} onChange={(v) => updateSettings({ skipPatterns: v })} placeholder="*.tmp" />
        </Row>
        <Row label={$t('Größere Dateien auslassen')}>
          <Select
            value={String(s.skipLargerMb)}
            onChange={(v) => updateSettings({ skipLargerMb: Number(v) })}
            label={$t('Größere Dateien auslassen')}
            options={[0, 10, 100, 500, 1000, 5000].map((n) => ({
              value: String(n),
              label: n === 0 ? $t('Nie') : n >= 1000 ? $t('über {0} GB', n / 1000) : $t('über {0} MB', n),
            }))}
          />
        </Row>
      </Group>
      <Group title={$t('Beim Hochladen')}>
        <Row
          label={$t('Erst unter einem Zwischennamen hochladen')}
          note={$t(
            'Die Datei heißt erst nach dem vollständigen Upload richtig. So läuft nie eine halbe Datei auf dem Server, und abgebrochene Uploads können dort weitermachen, wo sie aufgehört haben.',
          )}
        >
          <Switch
            checked={s.uploadTempName}
            onChange={(v) => updateSettings({ uploadTempName: v })}
            label={$t('Zwischenname')}
          />
        </Row>
        <Row
          label={$t('Änderungszeit übernehmen')}
          note={$t('Die Datei am Ziel bekommt dieselbe Änderungszeit wie das Original.')}
        >
          <Switch
            checked={s.keepMtime}
            onChange={(v) => updateSettings({ keepMtime: v })}
            label={$t('Änderungszeit übernehmen')}
          />
        </Row>
        <Row
          label={$t('Rechte für hochgeladene Dateien')}
          note={$t('Gilt für SFTP und FTP. Webserver erwarten meist 644 für Dateien und 755 für Ordner.')}
        >
          <Select
            value={s.uploadFilePerms}
            onChange={(v) => updateSettings({ uploadFilePerms: v })}
            label={$t('Rechte für hochgeladene Dateien')}
            options={permOptions(['644', '664', '640', '600'])}
          />
        </Row>
        <Row label={$t('Rechte für neue Ordner')}>
          <Select
            value={s.uploadDirPerms}
            onChange={(v) => updateSettings({ uploadDirPerms: v })}
            label={$t('Rechte für neue Ordner')}
            options={permOptions(['755', '775', '750', '700'], true)}
          />
        </Row>
      </Group>
    </>
  );
}
