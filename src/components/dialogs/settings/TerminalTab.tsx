/**
 * Settings › Terminal: look and behaviour of the built-in terminal, command
 * suggestions and the snippets.
 */
import { useEffect, useState } from 'react';
import { tauriBackend as backend } from '../../../backend/tauriBackend';
import type { LocalShell } from '../../../backend/api';
import { getState, LIVE, updateSettings, useStore } from '../../../state/store';
import { terminalSettings, type TerminalSettings } from '../../../state/terminal';
import { clearHistory, historyCount } from '../../../state/termSuggest';
import { formatCombo, keysFor } from '../../../state/keys';
import { Button, Select, Switch, TextField } from '../../ui';
import { $t, LOCALE } from '../../../i18n';
import { SchemePicker } from '../../SchemePicker';
import { SnippetSettings } from '../SnippetSettings';
import { Group, Row } from './parts';

/** Settings › Terminal: look of the built-in terminal and the snippets. */
export function TerminalSettingsPage() {
  useStore((s) => s.settings.terminal);
  const externalTerminal = useStore((s) => s.settings.externalTerminal);
  const platform = useStore((s) => s.platform);
  const t = terminalSettings();
  const set = (patch: Partial<TerminalSettings>) =>
    updateSettings({ terminal: { ...getState().settings.terminal, ...patch } });
  const [historyN, setHistoryN] = useState(historyCount);
  const [shells, setShells] = useState<LocalShell[]>(
    LIVE
      ? []
      : platform === 'mac'
        ? [
            { id: 'zsh', name: 'zsh' },
            { id: 'bash', name: 'bash' },
          ]
        : [
            { id: 'pwsh', name: 'PowerShell 7' },
            { id: 'powershell', name: 'Windows PowerShell' },
            { id: 'cmd', name: 'Eingabeaufforderung (cmd)' },
            { id: 'gitbash', name: 'Git Bash' },
          ],
  );
  useEffect(() => {
    if (LIVE) void backend.termShells().then(setShells);
  }, []);
  return (
    <>
      <Group title={$t('Darstellung')}>
        <Row
          column
          label={$t('Farbschema')}
          note={$t(
            '„Automatisch“ folgt Bitcrane hell/dunkel. Einzelne Server können ein eigenes haben (Server bearbeiten), z. B. rot für Produktivserver.',
          )}
        >
          <SchemePicker value={t.scheme} onChange={(v) => set({ scheme: v })} />
        </Row>
        <Row label={$t('Schrift')} note={$t('Mehrere Schriften mit Komma: die erste vorhandene wird genommen.')}>
          <TextField value={t.fontFamily} onChange={(v) => set({ fontFamily: v })} mono className="term-font-field" />
        </Row>
        <Row label={$t('Schriftgröße')}>
          <Select
            value={String(t.fontSize)}
            onChange={(v) => set({ fontSize: Number(v) })}
            label={$t('Schriftgröße')}
            options={[10, 11, 12, 13, 14, 15, 16, 18, 20, 24].map((n) => ({ value: String(n), label: `${n} pt` }))}
          />
        </Row>
        <Row label={$t('Cursor')}>
          <Select<'block' | 'bar' | 'underline'>
            value={t.cursor}
            onChange={(v) => set({ cursor: v })}
            label={$t('Cursor')}
            options={[
              { value: 'block', label: $t('Block') },
              { value: 'bar', label: $t('Strich') },
              { value: 'underline', label: $t('Unterstrich') },
            ]}
          />
        </Row>
        <Row
          label={$t('Beim Markieren kopieren')}
          note={$t('Markierter Text landet sofort in der Zwischenablage, wie in PuTTY.')}
        >
          <Switch
            checked={t.copyOnSelect}
            onChange={(v) => set({ copyOnSelect: v })}
            label={$t('Beim Markieren kopieren')}
          />
        </Row>
        <Row
          label={$t('Im angezeigten Ordner starten')}
          note={$t('Das Terminal beginnt im Ordner, den die Serverhälfte gerade zeigt.')}
        >
          <Switch
            checked={t.startInFolder}
            onChange={(v) => set({ startInFolder: v })}
            label={$t('Im angezeigten Ordner starten')}
          />
        </Row>
      </Group>
      <Group title={$t('Verhalten')}>
        <Row label={$t('Shell auf diesem Computer')} note={$t('Für das Terminal ohne Server.')}>
          <Select
            value={t.localShell}
            onChange={(v) => set({ localShell: v })}
            label={$t('Shell auf diesem Computer')}
            options={[{ value: '', label: $t('Standard') }, ...shells.map((x) => ({ value: x.id, label: $t(x.name) }))]}
          />
        </Row>
        <Row
          label={$t('Externes Terminal')}
          note={$t(
            'Für „Im System-Terminal öffnen“ (Rechtsklick in einer Hälfte). Das Programm muss installiert sein.',
          )}
        >
          <Select
            value={externalTerminal ?? ''}
            onChange={(v) => updateSettings({ externalTerminal: v || undefined })}
            label={$t('Externes Terminal')}
            options={
              platform === 'mac'
                ? [
                    { value: '', label: 'Terminal' },
                    { value: 'iterm', label: 'iTerm2' },
                    { value: 'ghostty', label: 'Ghostty' },
                  ]
                : [
                    { value: '', label: 'Windows Terminal' },
                    { value: 'powershell', label: 'Windows PowerShell' },
                    { value: 'cmd', label: $t('Eingabeaufforderung (cmd)') },
                  ]
            }
          />
        </Row>
        <Row
          label={$t('Rechtsklick')}
          note={$t('Mit Auswahl wird kopiert, sonst eingefügt – wie in PuTTY und Windows Terminal.')}
        >
          <Select<'smart' | 'off'>
            value={t.rightClick}
            onChange={(v) => set({ rightClick: v })}
            label={$t('Rechtsklick')}
            options={[
              { value: 'smart', label: $t('Kopieren oder einfügen') },
              { value: 'off', label: $t('Nichts') },
            ]}
          />
        </Row>
        <Row label={$t('Vor dem Einfügen mehrerer Zeilen fragen')} note={$t('Jede Zeile würde sofort ausgeführt.')}>
          <Switch
            checked={t.pasteWarn}
            onChange={(v) => set({ pasteWarn: v })}
            label={$t('Vor dem Einfügen mehrerer Zeilen fragen')}
          />
        </Row>
        <Row label={$t('Zeilen zum Zurückblättern')}>
          <Select
            value={String(t.scrollback)}
            onChange={(v) => set({ scrollback: Number(v) })}
            label={$t('Zeilen zum Zurückblättern')}
            options={[1000, 5000, 10000, 25000, 50000, 100000].map((n) => ({
              value: String(n),
              label: n.toLocaleString(LOCALE),
            }))}
          />
        </Row>
        <Row
          label={$t('Terminals beim Start wieder öffnen')}
          note={$t(
            'Zusammen mit „Tabs vom letzten Mal wieder öffnen“ (Allgemein); Terminals auf Servern starten, sobald die Verbindung steht.',
          )}
        >
          <Switch
            checked={t.restore}
            onChange={(v) => set({ restore: v })}
            label={$t('Terminals beim Start wieder öffnen')}
          />
        </Row>
      </Group>
      <Group title={$t('Vorschläge')}>
        <Row
          label={$t('Vorschläge beim Tippen')}
          note={$t(
            'Aus dem Verlauf dieses Servers, den Snippets, üblichen Befehlen und den Dateien und Ordnern auf dem Server. ↑/↓ wählt, → übernimmt, Esc schließt die Liste; Tab vervollständigt weiter über die Shell.',
          )}
        >
          <Select<'list' | 'ghost' | 'off'>
            value={t.suggest}
            onChange={(v) => set({ suggest: v })}
            label={$t('Vorschläge beim Tippen')}
            options={[
              { value: 'list', label: $t('Mit Liste') },
              { value: 'ghost', label: $t('Nur ausgegraut') },
              { value: 'off', label: $t('Aus') },
            ]}
          />
        </Row>
        <Row
          label={$t('Gemerkte Befehle')}
          note={$t(
            'Nur auf diesem Computer, höchstens 300 je Server. Befehle mit einem Leerzeichen am Anfang merkt sich Bitcrane nicht, z. B. für Passwörter in der Befehlszeile.',
          )}
        >
          <Button
            small
            disabled={!historyN}
            onClick={() => {
              clearHistory();
              setHistoryN(0);
            }}
          >
            {historyN ? $t('{0} Befehle löschen', String(historyN)) : $t('Keine')}
          </Button>
        </Row>
      </Group>
      <Group title={$t('Snippets')}>
        <SnippetSettings />
      </Group>
      <span className="small muted">
        {$t(
          'Tastenkürzel im Terminal: Kopieren und Einfügen mit {0}. Ein Terminal öffnest du mit dem Terminal-Knopf oben oder {1}; ein Rechtsklick auf den Knopf zeigt die Auswahl (Shell, SSH-Server).',
          platform === 'mac' ? '⌘C / ⌘V' : $t('Strg+C / Strg+V (Strg+C ohne Auswahl bricht ab)'),
          formatCombo(keysFor('terminal', platform)[0] ?? '', platform),
        )}
      </span>
    </>
  );
}
