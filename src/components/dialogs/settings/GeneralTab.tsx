/**
 * Settings › Allgemein: language, tray symbol, updates, start, editor and the
 * command line, followed by the Mac permissions and the sync between computers.
 */
import { useEffect, useState } from 'react';
import { tauriBackend as backend } from '../../../backend/tauriBackend';
import { chooseFolder, chooseProgram } from '../../../backend/dialogs';
import { EDITOR_DEFAULTS } from '../../../state/editor';
import { checkForUpdates, startUpdateChecks } from '../../../state/updates';
import { LIVE, offerCloudPlaces, openExternal, updateSettings, useStore } from '../../../state/store';
import { Button, Select, Switch, TextField } from '../../ui';
import { $t, LANGUAGES } from '../../../i18n';
import { MacPermissions } from './MacPermissions';
import { SyncSettings } from './SyncSettings';
import { Group, Row } from './parts';

const CLI_GUIDE_URL = 'https://github.com/Raccoon-Works/bitcrane/blob/main/docs/cli.md';

/** Where the program lives, for `bitcrane upload …` in scripts (cli.rs). */
function CliRow() {
  const [exe, setExe] = useState('');
  useEffect(() => {
    if (LIVE)
      void backend
        .cliPath()
        .then(setExe)
        .catch(() => undefined);
  }, []);
  return (
    <Row
      label={$t('Kommandozeile')}
      note={
        <>
          {$t('Für Skripte: Übertragungen mit gespeicherten Servern, ohne Fenster.')}{' '}
          {exe && <span className="mono">{exe}</span>}
        </>
      }
    >
      <span className="row-inline">
        {exe && (
          <Button small onClick={() => void navigator.clipboard?.writeText(exe)}>
            {$t('Pfad kopieren')}
          </Button>
        )}
        <Button small onClick={() => openExternal(CLI_GUIDE_URL)}>
          {$t('Anleitung')}
        </Button>
      </span>
    </Row>
  );
}

/** Program name without folder and extension, e.g. "Visual Studio Code". */
const appName = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.(app|exe)$/i, '');

export function GeneralSettings() {
  const s = useStore((st) => st.settings);
  const mac = useStore((st) => st.platform) === 'mac';
  const servers = useStore((st) => st.servers);
  const prefs = { ...EDITOR_DEFAULTS, ...s.editorPrefs };

  /** Picks a program (an .app on the Mac, an .exe on Windows). */
  const pickProgram = async (): Promise<string | null> => {
    if (!LIVE) return mac ? '/Applications/Visual Studio Code.app' : $t('C:/Program Files/Microsoft VS Code/Code.exe');
    return chooseProgram($t('Editor wählen'), mac);
  };
  const chooseEditor = async () => {
    const app = await pickProgram();
    if (app) updateSettings({ editorApp: app });
  };
  const [extDraft, setExtDraft] = useState('');
  const addExtEditor = async () => {
    const ext = `.${extDraft
      .trim()
      .replace(/^\*?\./, '')
      .toLowerCase()}`;
    if (ext === '.') return;
    const app = await pickProgram();
    if (app) {
      updateSettings({ editorByExt: { ...s.editorByExt, [ext]: app } });
      setExtDraft('');
    }
  };
  /** "Beim Start öffnen": folder of this computer for the left half. */
  const pickStartFolder = async () => {
    const picked = await chooseFolder($t('Ordner beim Start'));
    if (picked) updateSettings({ startLocal: picked });
  };

  return (
    <>
      <Group title={$t('Allgemein')}>
        <Row label={$t('Sprache')} note={$t('Gilt ab dem nächsten Start.')}>
          <Select
            value={s.language}
            onChange={(v) => updateSettings({ language: v })}
            label={$t('Sprache')}
            options={LANGUAGES.map((l) => ({ value: l.id, label: l.name }))}
          />
        </Row>
        <Row
          label={mac ? $t('Symbol in der Menüleiste zeigen') : $t('Symbol im Infobereich zeigen')}
          note={$t(
            'Zeigt den Zustand und ein Menü mit Servern, Überwachungen und Einstellungen, auch ohne geöffnetes Fenster. Aus: Bitcrane ist dann nur über das Programmsymbol erreichbar.',
          )}
        >
          <Switch
            checked={s.showMenuBarIcon}
            onChange={(v) => updateSettings({ showMenuBarIcon: v })}
            label={$t('Symbol zeigen')}
          />
        </Row>
        <Row
          label={mac ? $t('Schnellaktion im Finder') : $t('Eintrag im Explorer-Kontextmenü')}
          note={
            mac
              ? $t('Rechtsklick auf Dateien › Schnellaktionen › „Mit Bitcrane hochladen“.')
              : $t(
                  'Rechtsklick auf Dateien › „Mit Bitcrane hochladen“ (unter Windows 11 in „Weitere Optionen anzeigen“).',
                )
          }
        >
          <Switch
            checked={s.shellIntegration !== false}
            onChange={(v) => updateSettings({ shellIntegration: v })}
            label={$t('Mit Bitcrane hochladen')}
          />
        </Row>
        <CliRow />
        <Row
          label={$t('Updates')}
          note={
            s.updateMode === 'auto'
              ? $t('Neue Versionen werden im Hintergrund geladen und beim Beenden installiert.')
              : s.updateMode === 'notify'
                ? $t('Beim Start und alle paar Stunden. Installiert wird erst, wenn du zustimmst.')
                : $t('Nur wenn du „Jetzt suchen“ klickst.')
          }
        >
          <span className="row-inline">
            <Button small onClick={() => void checkForUpdates(true)}>
              {$t('Jetzt suchen')}
            </Button>
            <Select
              value={s.updateMode}
              onChange={(v) => {
                updateSettings({ updateMode: v });
                startUpdateChecks();
              }}
              label={$t('Updates')}
              options={[
                { value: 'auto', label: $t('Automatisch installieren') },
                { value: 'notify', label: $t('Nur Bescheid sagen') },
                { value: 'off', label: $t('Nicht suchen') },
              ]}
            />
          </span>
        </Row>
        <Row
          label={$t('Beim Start öffnen')}
          note={
            s.startServer
              ? $t('Links dieser Ordner, rechts der Server; Bitcrane verbindet sich gleich.')
              : $t('Links dieser Ordner, rechts die Serverliste.')
          }
        >
          <span className="row-inline">
            <TextField
              label={$t('Ordner beim Start')}
              value={s.startLocal}
              onChange={(v) => updateSettings({ startLocal: v })}
              placeholder="~"
              mono
              className="start-folder"
            />
            {LIVE && (
              <Button small onClick={() => void pickStartFolder()}>
                {$t('Wählen …')}
              </Button>
            )}
            <Select
              value={s.startServer && servers.some((x) => x.id === s.startServer) ? s.startServer : ''}
              onChange={(v) => updateSettings({ startServer: v })}
              label={$t('Server beim Start')}
              options={[
                { value: '', label: $t('Ohne Server') },
                ...servers.filter((x) => !x.temporary).map((x) => ({ value: x.id, label: x.name })),
              ]}
            />
          </span>
        </Row>
        <Row
          label={$t('Tabs vom letzten Mal wieder öffnen')}
          note={$t(
            'Beim Start öffnen sich die Tabs, die beim Beenden offen waren; der Server des vorderen Tabs verbindet sich gleich. Gespeicherte Tab-Sätze: Ablage › Arbeitsbereiche.',
          )}
        >
          <Switch
            checked={!!s.restoreTabs}
            onChange={(v) => updateSettings({ restoreTabs: v })}
            label={$t('Tabs vom letzten Mal wieder öffnen')}
          />
        </Row>
        <Row
          label={$t('Neuer Tab: rechte Hälfte')}
          note={$t(
            '„Dieser PC“ bzw. „Dieser Mac“ zeigt in beiden Hälften Ordner dieses Computers, zum Hin- und Herkopieren wie im Total Commander.',
          )}
        >
          <Select
            value={s.newTabRight ?? 'servers'}
            onChange={(v) => updateSettings({ newTabRight: v as 'servers' | 'local' })}
            label={$t('Neuer Tab: rechte Hälfte')}
            options={[
              { value: 'servers', label: $t('Serverliste') },
              { value: 'local', label: mac ? $t('Dieser Mac') : $t('Dieser PC') },
            ]}
          />
        </Row>
        <Row
          label={$t('Cloud-Ordner')}
          note={$t('Google Drive, OneDrive, Dropbox, iCloud Drive und Box in die Ortsleiste übernehmen.')}
        >
          <Button small onClick={() => void offerCloudPlaces(true)}>
            {$t('Suchen …')}
          </Button>
        </Row>
        <Row
          label={$t('Doppelklick auf eine Datei')}
          note={
            mac
              ? $t('Ordner öffnen sich immer. ⌘↓ macht dasselbe wie der Doppelklick.')
              : $t('Ordner öffnen sich immer. Enter macht dasselbe wie der Doppelklick.')
          }
        >
          <Select
            value={s.fileDoubleClick}
            onChange={(v) => updateSettings({ fileDoubleClick: v })}
            label={$t('Doppelklick auf eine Datei')}
            options={[
              { value: 'open', label: $t('Öffnen') },
              { value: 'edit', label: $t('Im Editor öffnen') },
              { value: 'transfer', label: $t('In die andere Hälfte übertragen') },
            ]}
          />
        </Row>
        <Row
          label={$t('Vor dem Löschen nachfragen')}
          note={$t(
            'Auf dem Server wird immer nachgefragt. Einen Papierkorb auf dem Server richtest du beim Server ein (bearbeiten).',
          )}
        >
          <Switch
            checked={s.confirmDelete}
            onChange={(v) => updateSettings({ confirmDelete: v })}
            label={$t('Vor dem Löschen nachfragen')}
          />
        </Row>
        <Row
          label={$t('Editor für „Im Editor öffnen“')}
          note={
            s.editorMode === 'external'
              ? s.editorApp || $t('Das Programm, das das System für die Dateiart vorsieht.')
              : $t('Der Editor von Bitcrane: Dateien vom Server und von diesem Computer, Speichern lädt direkt hoch.')
          }
        >
          <span className="row-inline">
            {s.editorMode === 'external' && s.editorApp && (
              <Button small variant="ghost" onClick={() => updateSettings({ editorApp: '' })}>
                {$t('Standard')}
              </Button>
            )}
            {s.editorMode === 'external' && (
              <Button small onClick={() => void chooseEditor()}>
                {s.editorApp ? $t('Ändern …') : $t('Wählen …')}
              </Button>
            )}
            <Select<'builtin' | 'external'>
              value={s.editorMode === 'external' ? 'external' : 'builtin'}
              onChange={(v) => updateSettings({ editorMode: v })}
              label={$t('Editor')}
              options={[
                { value: 'builtin', label: $t('Eingebauter Editor') },
                { value: 'external', label: $t('Programm des Systems') },
              ]}
            />
          </span>
        </Row>
        <Row label={$t('Schriftgröße im Editor')}>
          <Select
            value={String(prefs.fontSize)}
            onChange={(v) => updateSettings({ editorPrefs: { ...prefs, fontSize: Number(v) } })}
            label={$t('Schriftgröße im Editor')}
            options={[11, 12, 13, 14, 15, 16, 18, 20].map((n) => ({ value: String(n), label: `${n} pt` }))}
          />
        </Row>
        <Row
          label={$t('Tabulatorbreite')}
          note={$t('Für neue Dateien; bei bestehenden erkennt der Editor die Einrückung selbst.')}
        >
          <Select
            value={String(prefs.tabSize)}
            onChange={(v) => updateSettings({ editorPrefs: { ...prefs, tabSize: Number(v) } })}
            label={$t('Tabulatorbreite')}
            options={[2, 4, 8].map((n) => ({ value: String(n), label: String(n) }))}
          />
        </Row>
        <Row label={$t('Lange Zeilen umbrechen')}>
          <Switch
            checked={prefs.wrap}
            onChange={(v) => updateSettings({ editorPrefs: { ...prefs, wrap: v } })}
            label={$t('Lange Zeilen umbrechen')}
          />
        </Row>
        {Object.entries(s.editorByExt).map(([ext, app]) => (
          <Row key={ext} label={$t('Dateien {0}', ext)} note={app}>
            <span className="row-inline">
              <span className="small muted">{appName(app)}</span>
              <Button
                small
                variant="ghost"
                onClick={() => {
                  const n = { ...s.editorByExt };
                  delete n[ext];
                  updateSettings({ editorByExt: n });
                }}
              >
                {$t('Entfernen')}
              </Button>
            </span>
          </Row>
        ))}
        <Row
          label={$t('Eigener Editor für eine Dateiart')}
          note={$t('Zum Beispiel .py in einem anderen Programm als .md.')}
        >
          <span className="row-inline">
            <TextField
              label={$t('Dateiendung')}
              value={extDraft}
              onChange={setExtDraft}
              placeholder=".py"
              mono
              className="ext-field"
              onEnter={() => void addExtEditor()}
            />
            <Button small disabled={!extDraft.trim()} onClick={() => void addExtEditor()}>
              {$t('Programm wählen …')}
            </Button>
          </span>
        </Row>
      </Group>
      {mac && <MacPermissions />}
      <SyncSettings />
    </>
  );
}
