/**
 * Settings › Erweitert: own commands for server files, the log and links to
 * the system (sftp links, SSH configuration).
 */
import { Plus, Radio, X } from '../../glyphs';
import { tauriBackend as backend } from '../../../backend/tauriBackend';
import { showError } from '../../../state/errors';
import { LIVE, openDialog, updateSettings, useStore, type CustomCommand } from '../../../state/store';
import { newCommandId } from '../../../state/tools';
import { Button, IconButton, Switch, TextField } from '../../ui';
import { $t } from '../../../i18n';
import { Group, Row } from './parts';

/** Stable empty list: a new [] on every render would redraw the store endlessly. */
const NO_COMMANDS: CustomCommand[] = [];

/**
 * "Eigene Befehle" (WinSCP "Custom commands"): own commands in the context
 * menu of server files. Laid out like the terminal snippets: an explanation
 * row, one row per command, and the add button in its own row.
 */
function CustomCommands() {
  const list = useStore((st) => st.settings.customCommands) ?? NO_COMMANDS;
  const save = (next: CustomCommand[]) => updateSettings({ customCommands: next });
  const set = (id: string, patch: Partial<CustomCommand>) =>
    save(list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  return (
    <>
      <div className="set-row">
        <div className="col-text flex-1">
          <span className="small muted">
            {$t(
              'Erscheinen im Rechtsklick-Menü von Dateien auf SFTP-Servern und laufen dort im Ordner der Datei. Die Ausgabe steht im Protokoll.',
            )}
          </span>
          <span className="small muted">
            {$t('Platzhalter:')} <code>{'{file}'}</code> {$t('Pfad der Datei (bei mehreren einmal je Datei)')},{' '}
            <code>{'{files}'}</code> {$t('alle Pfade')}, <code>{'{name}'}</code> {$t('nur der Name')},{' '}
            <code>{'{dir}'}</code> {$t('der Ordner')}
          </span>
        </div>
      </div>
      {list.map((c) => (
        <div key={c.id} className="set-row snippet-row">
          <TextField
            label={$t('Name im Menü')}
            value={c.name}
            onChange={(v) => set(c.id, { name: v })}
            placeholder={$t('Name im Menü')}
            className="snippet-name"
          />
          <TextField
            label={$t('Befehl')}
            value={c.command}
            onChange={(v) => set(c.id, { command: v })}
            placeholder="unzip -o {file}"
            mono
            className="flex-1"
          />
          <IconButton label={$t('Entfernen')} onClick={() => save(list.filter((x) => x.id !== c.id))}>
            <X size={14} strokeWidth={1.75} />
          </IconButton>
        </div>
      ))}
      <div className="set-row">
        <Button small onClick={() => save([...list, { id: newCommandId(), name: '', command: '' }])}>
          <Plus size={13} strokeWidth={2} /> {$t('Befehl hinzufügen')}
        </Button>
      </div>
    </>
  );
}

export function AdvancedSettings() {
  const s = useStore((st) => st.settings);
  const mac = useStore((st) => st.platform) === 'mac';
  return (
    <>
      <Group title={$t('Eigene Befehle')}>
        <CustomCommands />
      </Group>
      <Group title={$t('Erweitert')}>
        <Row
          label={$t('Protokoll für die Fehlersuche')}
          note={$t(
            'Verbindungen, Übertragungen und Fehler mit Uhrzeit. Bitcrane zeigt es immer an; auf Wunsch auch als Datei.',
          )}
        >
          <Button small onClick={() => openDialog({ type: 'log' })}>
            {$t('Protokoll öffnen …')}
          </Button>
        </Row>
        <Row
          label={$t('Protokoll zusätzlich in eine Datei schreiben')}
          note={LIVE ? $t('Hilft, wenn etwas schiefgeht und du es jemandem zeigen möchtest.') : undefined}
        >
          <span className="row-inline">
            {LIVE && s.writeLog && (
              <Button
                small
                variant="ghost"
                onClick={() =>
                  void backend
                    .logPath()
                    .then((p) => backend.localReveal(p))
                    .catch((e) => showError(e))
                }
              >
                {$t('Datei zeigen')}
              </Button>
            )}
            <Switch
              checked={s.writeLog}
              onChange={(v) => updateSettings({ writeLog: v })}
              label={$t('Protokoll in Datei schreiben')}
            />
          </span>
        </Row>
        <Row
          label={$t('Ausführlich protokollieren')}
          note={$t(
            'Schreibt auch jeden Einzelschritt mit (gelesene Ordner, jede Übertragung, Änderungen in Überwachungen). Nur zur Fehlersuche.',
          )}
        >
          <Switch
            checked={s.logLevel === 'detail'}
            onChange={(v) => updateSettings({ logLevel: v ? 'detail' : 'normal' })}
            label={$t('Ausführlich protokollieren')}
          />
        </Row>
        <Row
          label={$t('sftp-Links mit Bitcrane öffnen')}
          note={
            mac
              ? $t(
                  'Ein Klick auf einen Link wie sftp://benutzer@server/pfad öffnet ihn in Bitcrane. Welches Programm solche Links bekommt, entscheidet macOS; ausgeschaltet ignoriert Bitcrane sie.',
                )
              : $t(
                  'Ein Klick auf einen Link wie sftp://benutzer@server/pfad öffnet ihn in Bitcrane. Eingeschaltet meldet sich Bitcrane bei Windows als Programm für solche Links an.',
                )
          }
        >
          <Switch
            checked={s.sftpLinks}
            onChange={(v) => updateSettings({ sftpLinks: v })}
            label={$t('sftp-Links mit Bitcrane öffnen')}
          />
        </Row>
        <Row
          label={$t('SSH-Konfiguration lesen')}
          note={$t(
            'Kurznamen aus ~/.ssh/config funktionieren in „Schnell verbinden“, und neue Server lassen sich von dort übernehmen.',
          )}
        >
          <Switch
            checked={s.readSshConfig}
            onChange={(v) => updateSettings({ readSshConfig: v })}
            label={$t('SSH-Konfiguration lesen')}
          />
        </Row>
        <Row label={$t('Änderungen in überwachten Ordnern')}>
          <span className="small muted" title={mac ? 'FSEvents' : 'ReadDirectoryChangesW'}>
            <Radio size={13} strokeWidth={1.5} aria-hidden="true" /> {$t('meldet das System sofort')}
          </span>
        </Row>
      </Group>
    </>
  );
}
