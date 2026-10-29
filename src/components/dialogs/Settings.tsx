/**
 * Settings window with tabs: Allgemein, Überwachung, Übertragungen,
 * Verbindungen, Darstellung, Erweitert. Changes apply immediately.
 */
import { ArrowUpDown, Eye, Radio, Settings as Gear, Shield, SlidersHorizontal, SunMoon, X, Plus, Keyboard } from '../glyphs';
import { useState, type ReactNode } from 'react';
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialogPicker } from '@tauri-apps/plugin-dialog';
import { tauriBackend as backend } from '../../backend/tauriBackend';
import type { CloudPlace, KnownHost } from '../../backend/api';
import { runSync, setSyncFolder, setSyncPassword, syncStatus } from '../../state/sync';
import { closeDialog, getState, LIVE, newRuleId, openExternal, offerCloudPlaces, openDialog, removeRule, saveRule, setThemeSetting, updateSettings, useStore, ZOOM_STEPS, type CustomCommand, type ExistingRule, type SettingsTab, type TransferRule } from '../../state/store';
import { ListChecks } from '@phosphor-icons/react';
import { checkForUpdates, startUpdateChecks } from '../../state/updates';
import { newCommandId } from '../../state/tools';
import { ACTIONS, conflictsWith, formatCombo, keysFor, recordCombo } from '../../state/keys';
import { WatchIcon } from '../icons';
import { Button, Select, Switch, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

const CLI_GUIDE_URL = 'https://github.com/Raccoon-Works/bitcrane/blob/main/docs/cli.md';

/** Where the program lives, for `bitcrane upload …` in scripts (cli.rs). */
function CliRow() {
  const [exe, setExe] = useState('');
  useEffect(() => {
    if (LIVE) void invoke<string>('cli_path').then(setExe).catch(() => undefined);
  }, []);
  return (
    <Row label={$t('Kommandozeile')} note={<>{$t('Für Skripte: Übertragungen mit gespeicherten Servern, ohne Fenster.')} {exe && <span className="mono">{exe}</span>}</>}>
      <span className="row-inline">
        {exe && <Button small onClick={() => void navigator.clipboard?.writeText(exe)}>{$t('Pfad kopieren')}</Button>}
        <Button small onClick={() => openExternal(CLI_GUIDE_URL)}>{$t('Anleitung')}</Button>
      </span>
    </Row>
  );
}

function Row({ label, note, children, column }: { label: string; note?: ReactNode; children?: ReactNode; column?: boolean }) {
  return (
    <div className={`set-row${column ? ' is-column' : ''}`}>
      <div className="col-text flex-1">
        <span>{label}</span>
        {note && <span className="small muted">{note}</span>}
      </div>
      {children}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set-group" aria-label={title}>
      <span className="caption-strong">{title}</span>
      <div className="set-card">{children}</div>
    </section>
  );
}

const existingOptions: Array<{ value: ExistingRule; label: string }> = [
  { value: 'ask', label: $t('Nachfragen') }, { value: 'overwrite', label: $t('Überschreiben') }, { value: 'newer', label: $t('Nur wenn neuer') },
  { value: 'keepBoth', label: $t('Beide behalten') }, { value: 'skip', label: $t('Überspringen') },
];

/** Editable list of patterns as chips. */
function Chips({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const add = () => { if (draft?.trim() && !values.includes(draft.trim())) onChange([...values, draft.trim()]); };
  return (
    <div className="chips">
      {values.map((x) => (
        <span key={x} className="chip mono">{x}<button type="button" aria-label={$t('Muster {0} entfernen', x)} onClick={() => onChange(values.filter((y) => y !== x))}><X size={10} strokeWidth={2.4} /></button></span>
      ))}
      {draft !== null ? (
        <input className="chip-input mono" autoFocus value={draft} aria-label={$t('Neues Muster')} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { add(); setDraft(''); } if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); } }}
          onBlur={() => { add(); setDraft(null); }} />
      ) : (
        <button type="button" className="chip-add" aria-label={$t('Muster hinzufügen')} onClick={() => setDraft('')}><Plus size={12} strokeWidth={2} /></button>
      )}
    </div>
  );
}

/** One action per row; "Ändern" records the next key combination. */
function KeysSettings() {
  const platform = useStore((st) => st.platform);
  const own = useStore((st) => st.settings.shortcuts);
  const [recording, setRecording] = useState<string | null>(null);
  const [warn, setWarn] = useState('');
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecording(null); return; }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        updateSettings({ shortcuts: { ...getState().settings.shortcuts, [recording]: '' } });
        setRecording(null);
        return;
      }
      const combo = recordCombo(e, platform);
      if (!combo) return;
      // Without ⌘/Strg/Alt only function keys make sense (letters are for jumping to files).
      if (!/^(Mod|Ctrl|Alt)\+/.test(combo) && !/^F\d/.test(combo)) { setWarn($t('Bitte mit ⌘, ⌥ oder ⌃ kombinieren (unter Windows mit Strg oder Alt).')); return; }
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
  const reset = (id: string) => { const n = { ...own }; delete n[id]; updateSettings({ shortcuts: n }); };
  return (
    <>
      <p className="small muted">{$t('Auf „Ändern“ klicken und die neue Tastenkombination drücken. Entf entfernt das Kürzel, Esc bricht ab.')}{warn && <span className="tone-warn"> {warn}</span>}</p>
      {groups.map((g) => (
        <Group key={g} title={g}>
          {ACTIONS.filter((a) => a.group === g).map((a) => {
            const keys = keysFor(a.id, platform);
            const changed = own[a.id] !== undefined;
            return (
              <div key={a.id} className="set-row">
                <span className="flex-1">{a.label}</span>
                {recording === a.id
                  ? <span className="kbd-recording small">{$t('Tasten drücken …')}</span>
                  : keys.length ? keys.map((k) => <kbd key={k}>{formatCombo(k, platform)}</kbd>) : <span className="small muted">{$t('kein Kürzel')}</span>}
                {changed && recording !== a.id && <Button small variant="ghost" onClick={() => reset(a.id)}>{$t('Standard')}</Button>}
                <Button small onClick={() => { setWarn(''); setRecording(recording === a.id ? null : a.id); }}>{recording === a.id ? $t('Abbrechen') : $t('Ändern')}</Button>
              </div>
            );
          })}
        </Group>
      ))}
      {Object.keys(own).length > 0 && <Button onClick={() => updateSettings({ shortcuts: {} })}>{$t('Alle zurücksetzen')}</Button>}
    </>
  );
}

/** Stored host key fingerprints with "Vergessen" (the next connection asks again). */
function KnownHostsList() {
  const [hosts, setHosts] = useState<KnownHost[] | null>(LIVE ? null : [
    { host: 'bots.example:22', fingerprint: 'SHA256:Qm9vdHMtZXhhbXBsZS1maW5nZXJwcmludA' },
    { host: 'web.community.example:22', fingerprint: 'SHA256:V2ViLWNvbW11bml0eS1maW5nZXJwcmlu' },
  ]);
  const load = () => { if (LIVE) backend.knownHostsList().then(setHosts).catch(() => setHosts([])); };
  useEffect(load, []);
  const forget = (host: string) => {
    if (LIVE) void backend.knownHostsRemove(host).then(load);
    else setHosts((h) => (h ?? []).filter((x) => x.host !== host));
  };
  if (!hosts) return <Row label={$t('Wird geladen …')} />;
  if (!hosts.length) return <Row label={$t('Noch keine')} note={$t('Beim ersten Verbinden zu einem Server merkt sich Bitcrane dessen Fingerabdruck.')} />;
  return (
    <>
      {hosts.map((h) => (
        <div key={h.host} className="set-row">
          <div className="col-text flex-1 min-w-0">
            <span className="mono">{h.host}</span>
            <span className="small muted mono ellipsis" title={h.fingerprint}>{h.fingerprint}</span>
          </div>
          <Button small onClick={() => forget(h.host)}>{$t('Vergessen')}</Button>
        </div>
      ))}
    </>
  );
}

/**
 * "Regeln": named transfer rules (like WinSCP's transfer presets). A server
 * uses one for its manual transfers and watches; a watch can choose another.
 * Empty fields keep the general settings of "Übertragungen".
 */
/** "Eigene Befehle" (WinSCP "Custom commands"): own commands in the context menu of server files. */
function CustomCommands() {
  const list = useStore((st) => st.settings.customCommands) ?? [];
  const save = (next: CustomCommand[]) => updateSettings({ customCommands: next });
  const set = (id: string, patch: Partial<CustomCommand>) => save(list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  return (
    <>
      <p className="small muted">{$t('Erscheinen im Rechtsklick-Menü von Dateien auf SFTP-Servern und laufen dort im Ordner der Datei. Platzhalter: {file} Pfad der Datei (bei mehreren Dateien einmal je Datei), {files} alle Pfade, {name} nur der Name, {dir} der Ordner. Die Ausgabe steht im Protokoll.')}</p>
      {list.map((c) => (
        <div key={c.id} className="cmd-row">
          <TextField label={$t('Name im Menü')} value={c.name} onChange={(v) => set(c.id, { name: v })} placeholder={$t('Name im Menü')} className="cmd-name" />
          <TextField label={$t('Befehl')} value={c.command} onChange={(v) => set(c.id, { command: v })} placeholder="unzip -o {file}" mono className="flex-1" />
          <Button small variant="ghost" onClick={() => save(list.filter((x) => x.id !== c.id))}>{$t('Entfernen')}</Button>
        </div>
      ))}
      <span className="row-inline">
        <Button small onClick={() => save([...list, { id: newCommandId(), name: $t('Entpacken'), command: 'unzip -o {file}' }])}>{$t('Befehl hinzufügen')}</Button>
      </span>
    </>
  );
}

function RulesSettings() {
  const rules = useStore((st) => st.settings.rules ?? []);
  const servers = useStore((st) => st.servers);
  const watches = useStore((st) => st.watches);
  const [selId, setSelId] = useState<string | null>(rules[0]?.id ?? null);
  const sel = rules.find((r) => r.id === selId) ?? rules[0];
  const add = (from?: TransferRule) => {
    const r: TransferRule = from
      ? { ...from, id: newRuleId(), name: $t('{0} (Kopie)', from.name), excludes: [...from.excludes] }
      : { id: newRuleId(), name: $t('Neue Regel'), excludes: ['.git', '__pycache__', '*.log'] };
    saveRule(r);
    setSelId(r.id);
  };
  const set = <K extends keyof TransferRule>(k: K, v: TransferRule[K]) => { if (sel) saveRule({ ...sel, [k]: v }); };
  const usedBy = sel ? [...servers.filter((x) => x.ruleId === sel.id).map((x) => x.name), ...watches.filter((w) => w.ruleId === sel.id).map((w) => w.name)] : [];
  const inherit = (label: string) => [{ value: '', label: $t('Wie allgemein eingestellt ({0})', label) }];
  const existingLabel = (v: ExistingRule) => existingOptions.find((o) => o.value === v)?.label ?? v;
  const gs = getState().settings;
  return (
    <>
      <p className="small muted">{$t('Eine Regel bündelt Einstellungen fürs Übertragen und gilt für einen Server (Server bearbeiten › Regel) oder eine Überwachung. Leere Felder nehmen die allgemeinen Einstellungen.')}</p>
      <div className="rules-layout">
        <div className="rules-list" role="listbox" aria-label={$t('Regeln')}>
          {rules.map((r) => (
            <button key={r.id} type="button" role="option" aria-selected={r.id === sel?.id} className={`rules-item${r.id === sel?.id ? ' is-sel' : ''}`} onClick={() => setSelId(r.id)}>{r.name || $t('Ohne Namen')}</button>
          ))}
          {!rules.length && <span className="small muted">{$t('Noch keine Regel.')}</span>}
          <span className="row-inline rules-buttons">
            <Button small onClick={() => add()}>{$t('Neue Regel')}</Button>
            {sel && <Button small onClick={() => add(sel)}>{$t('Duplizieren')}</Button>}
          </span>
        </div>
        {sel && (
          <div className="rules-detail">
            <Group title={$t('Regel')}>
              <Row label={$t('Name')}><TextField label={$t('Name der Regel')} value={sel.name} onChange={(v) => set('name', v)} placeholder={$t('z. B. Bot oder Webseite')} /></Row>
              <Row label={$t('Verwendet von')} note={usedBy.length ? usedBy.join(', ') : $t('Noch von keinem Server und keiner Überwachung.')} />
            </Group>
            <Group title={$t('Nie übertragen')}>
              <Row label={$t('Namen und Muster')} note={$t('Kommt zu den allgemeinen Mustern und denen der Überwachung dazu.')} column>
                <Chips values={sel.excludes} onChange={(v) => set('excludes', v)} placeholder="venv" />
              </Row>
              <Row label={$t('Größere Dateien auslassen')}>
                <Select value={sel.skipLargerMb === undefined ? '' : String(sel.skipLargerMb)} onChange={(v) => set('skipLargerMb', v === '' ? undefined : Number(v))} label={$t('Größere Dateien auslassen')}
                  options={[...inherit(gs.skipLargerMb ? `${gs.skipLargerMb} MB` : $t('keine Grenze')), { value: '0', label: $t('Keine Grenze') }, ...[10, 50, 100, 500, 1024].map((n) => ({ value: String(n), label: n >= 1024 ? '1 GB' : `${n} MB` }))]} />
              </Row>
            </Group>
            <Group title={$t('Wenn die Datei schon da ist')}>
              <Row label={$t('Beim Hochladen')}>
                <Select value={sel.existingUp ?? ''} onChange={(v) => set('existingUp', (v || undefined) as ExistingRule | undefined)} label={$t('Beim Hochladen')} options={[...inherit(existingLabel(gs.existingFiles)), ...existingOptions]} />
              </Row>
              <Row label={$t('Beim Herunterladen')}>
                <Select value={sel.existingDown ?? ''} onChange={(v) => set('existingDown', (v || undefined) as ExistingRule | undefined)} label={$t('Beim Herunterladen')} options={[...inherit(existingLabel(gs.existingDownload)), ...existingOptions]} />
              </Row>
              <Row label={$t('Ältere Version auf dem Server behalten')} note={$t('Vor dem Ersetzen wird die alte Datei gesichert (bis zu 5 Versionen).')}><Switch checked={!!sel.keepOldVersion} onChange={(v) => set('keepOldVersion', v)} label={$t('Ältere Version behalten')} /></Row>
            </Group>
            <Group title={$t('Rechte beim Hochladen')}>
              <Row label={$t('Dateien')}><Select value={sel.filePerms ?? ''} onChange={(v) => set('filePerms', v || undefined)} label={$t('Rechte für Dateien')} options={permOptions(['644', '664', '600', '640', '755'])} /></Row>
              <Row label={$t('Ordner')}><Select value={sel.dirPerms ?? ''} onChange={(v) => set('dirPerms', v || undefined)} label={$t('Rechte für Ordner')} options={permOptions(['755', '775', '700', '750'], true)} /></Row>
            </Group>
            <span className="row-inline"><span className="flex-1" /><Button small variant="danger" onClick={() => { removeRule(sel.id); setSelId(null); }}>{$t('Regel löschen')}</Button></span>
          </div>
        )}
      </div>
    </>
  );
}

/** Colour of each settings area's symbol. */
const TAB_COLORS: Record<SettingsTab, string> = {
  general: '#8e8e93', watch: '#2a6de0', transfers: '#e8a600', rules: '#3fbfaa', connections: '#30b158', appearance: '#af52de', keys: '#5ac8fa', advanced: '#ff7a3d',
};

/** Choices for default upload permissions: octal value with its rwx text. */
function permOptions(values: string[], dir = false): Array<{ value: string; label: string }> {
  const rwx = (v: string) => [...v].map((d) => { const n = Number(d); return `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`; }).join('');
  return [{ value: '', label: $t('Wie vom Server vorgegeben') }, ...values.map((v) => ({ value: v, label: `${v} (${dir ? 'd' : '-'}${rwx(v)})` }))];
}

export function SettingsDialog({ tab }: { tab: SettingsTab }) {
  const [current, setCurrent] = useState<SettingsTab>(tab);
  const s = useStore((st) => st.settings);
  const platform = useStore((st) => st.platform);
  const [pattern, setPattern] = useState<string | null>(null);
  const mac = platform === 'mac';
  const tabs: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
    { id: 'general', label: $t('Allgemein'), icon: <Gear size={20} strokeWidth={1.5} /> },
    { id: 'watch', label: $t('Überwachung'), icon: <WatchIcon size={20} waves={2} /> },
    { id: 'transfers', label: $t('Übertragungen'), icon: <ArrowUpDown size={20} strokeWidth={1.5} /> },
    { id: 'rules', label: $t('Regeln'), icon: <ListChecks size={20} /> },
    { id: 'connections', label: $t('Verbindungen'), icon: <Shield size={20} strokeWidth={1.5} /> },
    { id: 'appearance', label: $t('Darstellung'), icon: <SunMoon size={20} strokeWidth={1.5} /> },
    { id: 'keys', label: $t('Tastenkürzel'), icon: <Keyboard size={20} strokeWidth={1.5} /> },
    { id: 'advanced', label: $t('Erweitert'), icon: <SlidersHorizontal size={20} strokeWidth={1.5} /> },
  ];
  const title = tabs.find((t) => t.id === current)?.label ?? $t('Einstellungen');

  /** Picks a program (an .app on the Mac, an .exe on Windows). */
  const pickProgram = async (): Promise<string | null> => {
    if (!LIVE) return mac ? '/Applications/Visual Studio Code.app' : $t('C:/Program Files/Microsoft VS Code/Code.exe');
    const picked = await openDialogPicker({
      multiple: false, directory: false, title: $t('Editor wählen'), defaultPath: mac ? '/Applications' : undefined,
      filters: mac ? [{ name: 'Programme', extensions: ['app'] }] : [{ name: 'Programme', extensions: ['exe'] }],
    }).catch(() => null);
    return typeof picked === 'string' ? invoke<string>('path_to_ui', { path: picked }) : null;
  };
  const chooseEditor = async () => {
    const app = await pickProgram();
    if (app) updateSettings({ editorApp: app });
  };
  const [extDraft, setExtDraft] = useState('');
  const addExtEditor = async () => {
    const ext = `.${extDraft.trim().replace(/^\*?\./, '').toLowerCase()}`;
    if (ext === '.') return;
    const app = await pickProgram();
    if (app) { updateSettings({ editorByExt: { ...s.editorByExt, [ext]: app } }); setExtDraft(''); }
  };
  const appName = (p: string) => p.split('/').pop()?.replace(/\.(app|exe)$/i, '') ?? p;
  const servers = useStore((st) => st.servers);
  /** "Beim Start öffnen": folder of this computer for the left half. */
  const pickStartFolder = async () => {
    const picked = await openDialogPicker({ directory: true, multiple: false, title: $t('Ordner beim Start') }).catch(() => null);
    if (typeof picked === 'string') updateSettings({ startLocal: await invoke<string>('path_to_ui', { path: picked }) });
  };

  return (
    <Dialog label={$t('Einstellungen')} windowLike windowTitle={mac ? title : $t('Einstellungen')} width={780} maxHeight={760} onClose={closeDialog} className="settings-dialog">
      <div role="tablist" aria-label={$t('Bereiche')} className="set-tabs">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === current} className={`set-tab${t.id === current ? ' is-sel' : ''}`} onClick={() => setCurrent(t.id)}>
            {/* Each area has its own colour, as in Transmit's and the Windows settings. */}
            <span className="set-tab-icon" style={{ color: TAB_COLORS[t.id] }}>{t.icon}</span><span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="set-body" role="tabpanel" aria-label={title}>
        {current === 'rules' && <RulesSettings />}
        {current === 'watch' && (
          <>
            <Group title={$t('Hintergrund')}>
              <Row label={$t('Im Hintergrund weiterlaufen')} note={$t('Überwachungen laufen weiter, wenn das Fenster geschlossen ist.')}><Switch checked={s.runInBackground} onChange={(v) => updateSettings({ runInBackground: v })} label={$t('Im Hintergrund weiterlaufen')} /></Row>
              <Row label={mac ? $t('Beim Anmelden am Mac starten') : $t('Mit Windows starten')} note={$t('Gespeicherte Überwachungen starten automatisch.')}><Switch checked={s.startAtLogin} onChange={(v) => updateSettings({ startAtLogin: v })} label={$t('Beim Anmelden starten')} /></Row>
              <Row label={mac ? $t('Nur in der Menüleiste starten') : $t('Nur im Infobereich starten')} note={mac ? $t('Beim Anmelden öffnet sich kein Fenster; Bitcrane ist über das Symbol in der Menüleiste erreichbar.') : $t('Beim Anmelden öffnet sich kein Fenster; Bitcrane ist über das B im Infobereich bei der Uhr erreichbar.')}>
                <Switch checked={!!s.startHidden} disabled={!s.startAtLogin} onChange={(v) => updateSettings({ startHidden: v })} label={$t('Nur im Infobereich starten')} />
              </Row>
            </Group>
            <Group title={$t('Verhalten neuer Überwachungen')}>
              <Row label={$t('Wartezeit vor dem Hochladen')} note={$t('Sammelt schnell aufeinanderfolgende Änderungen.')}>
                <Select value={String(s.defaultDelay)} onChange={(v) => updateSettings({ defaultDelay: Number(v) })} label={$t('Wartezeit')} options={[0, 1, 2, 5, 10].map((n) => ({ value: String(n), label: n === 1 ? $t('1 Sekunde') : $t('{0} Sekunden', n) }))} />
              </Row>
              <Row label={$t('Standardmäßig nicht hochladen')} column>
                <div className="chips">
                  {s.defaultExcludes.map((x) => (
                    <span key={x} className="chip mono">{x}<button type="button" aria-label={$t('Muster {0} entfernen', x)} onClick={() => updateSettings({ defaultExcludes: s.defaultExcludes.filter((y) => y !== x) })}><X size={10} strokeWidth={2.4} /></button></span>
                  ))}
                  {pattern !== null ? (
                    <input className="chip-input mono" autoFocus value={pattern} aria-label={$t('Neues Muster')} placeholder="*.bak" onChange={(e) => setPattern(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && pattern.trim()) { updateSettings({ defaultExcludes: [...s.defaultExcludes, pattern.trim()] }); setPattern(''); } if (e.key === 'Escape') { e.stopPropagation(); setPattern(null); } }}
                      onBlur={() => { if (pattern.trim()) updateSettings({ defaultExcludes: [...s.defaultExcludes, pattern.trim()] }); setPattern(null); }} />
                  ) : (
                    <button type="button" className="chip-add" aria-label={$t('Muster hinzufügen')} onClick={() => setPattern('')}><Plus size={12} strokeWidth={2} /></button>
                  )}
                </div>
              </Row>
              <Row label={$t('Lokal Gelöschtes auch auf dem Server löschen')} note={$t('Gilt nur als Vorgabe; jede Überwachung kann es einzeln ändern.')}><Switch checked={s.defaultMirrorDeletes} onChange={(v) => updateSettings({ defaultMirrorDeletes: v })} label={$t('Lokal Gelöschtes löschen')} /></Row>
            </Group>
            <Group title={$t('Hinweise')}>
              <Row label={$t('Mitteilung bei')}><Select value={s.notify} onChange={(v) => updateSettings({ notify: v })} label={$t('Mitteilung bei')} options={[{ value: 'errors', label: $t('Nur bei Fehlern') }, { value: 'all', label: $t('Jedem Upload') }, { value: 'none', label: $t('Nie') }]} /></Row>
              <Row label={$t('Ton bei Fehlern')} note={$t('Kurzer Systemton, wenn ein Upload fehlschlägt.')}><Switch checked={s.soundOnError} onChange={(v) => updateSettings({ soundOnError: v })} label={$t('Ton bei Fehlern')} /></Row>
              <Row label={$t('Ton, wenn alles hochgeladen ist')}><Switch checked={s.soundOnDone} onChange={(v) => updateSettings({ soundOnDone: v })} label={$t('Ton bei fertig')} /></Row>
              <Row label={$t('Fortschritt am Programmsymbol zeigen')} note={mac ? $t('Balken und Anzahl am Symbol im Dock.') : $t('Balken am Symbol in der Taskleiste.')}><Switch checked={s.dockProgress} onChange={(v) => updateSettings({ dockProgress: v })} label={$t('Fortschritt am Programmsymbol')} /></Row>
            </Group>
            <Group title={$t('Tastenkürzel')}>
              <Row label={$t('Kürzel für Überwachungen und alles andere')} note={$t('Neue Überwachung, Übersicht, alle pausieren …')}><Button small onClick={() => setCurrent('keys')}>{$t('Tastenkürzel …')}</Button></Row>
            </Group>
          </>
        )}
        {current === 'general' && (
          <>
          <Group title={$t('Allgemein')}>
            <Row label={$t('Sprache')} note={$t('Gilt ab dem nächsten Start.')}><Select value={s.language} onChange={(v) => updateSettings({ language: v })} label={$t('Sprache')} options={[{ value: 'de', label: $t('Deutsch') }, { value: 'en', label: $t('English') }]} /></Row>
            <Row label={mac ? $t('Symbol in der Menüleiste zeigen') : $t('Symbol im Infobereich zeigen')} note={$t('Zeigt den Zustand und ein Menü mit Servern, Überwachungen und Einstellungen, auch ohne geöffnetes Fenster. Aus: Bitcrane ist dann nur über das Programmsymbol erreichbar.')}><Switch checked={s.showMenuBarIcon} onChange={(v) => updateSettings({ showMenuBarIcon: v })} label={$t('Symbol zeigen')} /></Row>
            <Row label={mac ? $t('Schnellaktion im Finder') : $t('Eintrag im Explorer-Kontextmenü')} note={mac ? $t('Rechtsklick auf Dateien › Schnellaktionen › „Mit Bitcrane hochladen“.') : $t('Rechtsklick auf Dateien › „Mit Bitcrane hochladen“ (unter Windows 11 in „Weitere Optionen anzeigen“).')}><Switch checked={s.shellIntegration !== false} onChange={(v) => updateSettings({ shellIntegration: v })} label={$t('Mit Bitcrane hochladen')} /></Row>
            <CliRow />
            <Row label={$t('Updates')} note={s.updateMode === 'auto' ? $t('Neue Versionen werden im Hintergrund geladen und beim Beenden installiert.') : s.updateMode === 'notify' ? $t('Beim Start und alle paar Stunden. Installiert wird erst, wenn du zustimmst.') : $t('Nur wenn du „Jetzt suchen“ klickst.')}>
              <span className="row-inline">
                <Button small onClick={() => void checkForUpdates(true)}>{$t('Jetzt suchen')}</Button>
                <Select value={s.updateMode} onChange={(v) => { updateSettings({ updateMode: v }); startUpdateChecks(); }} label={$t('Updates')} options={[{ value: 'auto', label: $t('Automatisch installieren') }, { value: 'notify', label: $t('Nur Bescheid sagen') }, { value: 'off', label: $t('Nicht suchen') }]} />
              </span>
            </Row>
            <Row label={$t('Beim Start öffnen')} note={s.startServer ? $t('Links dieser Ordner, rechts der Server; Bitcrane verbindet sich gleich.') : $t('Links dieser Ordner, rechts die Serverliste.')}>
              <span className="row-inline">
                <TextField label={$t('Ordner beim Start')} value={s.startLocal} onChange={(v) => updateSettings({ startLocal: v })} placeholder="~" mono className="start-folder" />
                {LIVE && <Button small onClick={() => void pickStartFolder()}>{$t('Wählen …')}</Button>}
                <Select value={s.startServer && servers.some((x) => x.id === s.startServer) ? s.startServer : ''} onChange={(v) => updateSettings({ startServer: v })} label={$t('Server beim Start')} options={[{ value: '', label: $t('Ohne Server') }, ...servers.filter((x) => !x.temporary).map((x) => ({ value: x.id, label: x.name }))]} />
              </span>
            </Row>
            <Row label={$t('Tabs vom letzten Mal wieder öffnen')} note={$t('Beim Start öffnen sich die Tabs, die beim Beenden offen waren; der Server des vorderen Tabs verbindet sich gleich. Gespeicherte Tab-Sätze: Ablage › Arbeitsbereiche.')}>
              <Switch checked={!!s.restoreTabs} onChange={(v) => updateSettings({ restoreTabs: v })} label={$t('Tabs vom letzten Mal wieder öffnen')} />
            </Row>
            <Row label={$t('Neuer Tab: rechte Hälfte')} note={$t('„Dieser PC“ bzw. „Dieser Mac“ zeigt in beiden Hälften Ordner dieses Computers, zum Hin- und Herkopieren wie im Total Commander.')}>
              <Select value={s.newTabRight ?? 'servers'} onChange={(v) => updateSettings({ newTabRight: v as 'servers' | 'local' })} label={$t('Neuer Tab: rechte Hälfte')}
                options={[{ value: 'servers', label: $t('Serverliste') }, { value: 'local', label: mac ? $t('Dieser Mac') : $t('Dieser PC') }]} />
            </Row>
            {mac && LIVE && (
              <Row label={$t('Zugriff auf alle Ordner')} note={$t('macOS fragt sonst bei jedem geschützten Ordner einzeln. Mit „Festplattenvollzugriff“ für Bitcrane entfällt das.')}>
                <Button small onClick={() => void invoke('open_full_disk_access').catch(() => undefined)}>{$t('Systemeinstellungen öffnen')}</Button>
              </Row>
            )}
            <Row label={$t('Cloud-Ordner')} note={$t('Google Drive, OneDrive, Dropbox, iCloud Drive und Box in die Ortsleiste übernehmen.')}>
              <Button small onClick={() => void offerCloudPlaces(true)}>{$t('Suchen …')}</Button>
            </Row>
            <Row label={$t('Doppelklick auf eine Datei')} note={mac ? $t('Ordner öffnen sich immer. ⌘↓ macht dasselbe wie der Doppelklick.') : $t('Ordner öffnen sich immer. Enter macht dasselbe wie der Doppelklick.')}>
              <Select value={s.fileDoubleClick} onChange={(v) => updateSettings({ fileDoubleClick: v })} label={$t('Doppelklick auf eine Datei')} options={[{ value: 'open', label: $t('Öffnen') }, { value: 'edit', label: $t('Im Editor öffnen') }, { value: 'transfer', label: $t('In die andere Hälfte übertragen') }]} />
            </Row>
            <Row label={$t('Vor dem Löschen nachfragen')} note={$t('Auf dem Server wird immer nachgefragt, dort gibt es keinen Papierkorb.')}><Switch checked={s.confirmDelete} onChange={(v) => updateSettings({ confirmDelete: v })} label={$t('Vor dem Löschen nachfragen')} /></Row>
            <Row label={$t('Editor für „Im Editor öffnen“')} note={s.editorApp ? s.editorApp : $t('Das Programm, das das System für die Dateiart vorsieht.')}>
              <span className="row-inline">
                {s.editorApp && <Button small variant="ghost" onClick={() => updateSettings({ editorApp: '' })}>{$t('Standard')}</Button>}
                <Button small onClick={() => void chooseEditor()}>{s.editorApp ? $t('Ändern …') : $t('Wählen …')}</Button>
              </span>
            </Row>
            {Object.entries(s.editorByExt).map(([ext, app]) => (
              <Row key={ext} label={$t('Dateien {0}', ext)} note={app}>
                <span className="row-inline">
                  <span className="small muted">{appName(app)}</span>
                  <Button small variant="ghost" onClick={() => { const n = { ...s.editorByExt }; delete n[ext]; updateSettings({ editorByExt: n }); }}>{$t('Entfernen')}</Button>
                </span>
              </Row>
            ))}
            <Row label={$t('Eigener Editor für eine Dateiart')} note={$t('Zum Beispiel .py in einem anderen Programm als .md.')}>
              <span className="row-inline">
                <TextField label={$t('Dateiendung')} value={extDraft} onChange={setExtDraft} placeholder=".py" mono className="ext-field" onEnter={() => void addExtEditor()} />
                <Button small disabled={!extDraft.trim()} onClick={() => void addExtEditor()}>{$t('Programm wählen …')}</Button>
              </span>
            </Row>
          </Group>
          <SyncSettings />
          </>
        )}
        {current === 'transfers' && (
          <>
            <Group title={$t('Übertragungen')}>
              <Row label={$t('Gleichzeitige Übertragungen')}><Select value={String(s.parallel)} onChange={(v) => updateSettings({ parallel: Number(v) })} label={$t('Gleichzeitige Übertragungen')} options={[1, 2, 3, 4, 6].map((n) => ({ value: String(n), label: String(n) }))} /></Row>
              <Row label={$t('Beim Hochladen, wenn die Datei auf dem Server schon existiert')} note={$t('Gilt für das Hochladen von Hand. Überwachungen laden geänderte Dateien immer hoch.')}>
                <Select value={s.existingFiles} onChange={(v) => updateSettings({ existingFiles: v })} label={$t('Beim Hochladen, wenn die Datei schon existiert')} options={existingOptions} />
              </Row>
              <Row label={$t('Beim Herunterladen, wenn die Datei hier schon existiert')}>
                <Select value={s.existingDownload} onChange={(v) => updateSettings({ existingDownload: v })} label={$t('Beim Herunterladen, wenn die Datei schon existiert')} options={existingOptions} />
              </Row>
              <Row label={$t('Unveränderte Dateien überspringen')} note={$t('Liegt am Ziel schon eine Datei mit gleicher Größe und gleicher Änderungszeit, wird sie nicht noch einmal übertragen.')}><Switch checked={s.skipUnchanged} onChange={(v) => updateSettings({ skipUnchanged: v })} label={$t('Unveränderte Dateien überspringen')} /></Row>
              <Row label={$t('Ruhezustand verhindern, solange übertragen wird')} note={$t('Der Bildschirm darf ausgehen, der Rechner schläft aber erst ein, wenn alles fertig ist.')}><Switch checked={s.keepAwake !== false} onChange={(v) => updateSettings({ keepAwake: v })} label={$t('Ruhezustand verhindern')} /></Row>
              <Row label={$t('Bei Fehlern automatisch erneut versuchen')} note={$t('Bis zu drei Versuche im Abstand von 5 Sekunden, nicht bei fehlenden Rechten.')}><Switch checked={s.autoRetry} onChange={(v) => updateSettings({ autoRetry: v })} label={$t('Automatisch erneut versuchen')} /></Row>
              <Row label={$t('Geschwindigkeit begrenzen')} note={$t('Gilt für alle Übertragungen zusammen.')}>
                <Select value={String(s.bandwidthLimit)} onChange={(v) => updateSettings({ bandwidthLimit: Number(v) })} label={$t('Geschwindigkeit begrenzen')} options={[0, 256, 512, 1024, 2048, 5120, 10240].map((n) => ({ value: String(n), label: n === 0 ? $t('Unbegrenzt') : n >= 1024 ? `${n / 1024} MB/s` : `${n} KB/s` }))} />
              </Row>
            </Group>
            <Group title={$t('Beim Übertragen von Hand auslassen')}>
              <Row label={$t('Namen und Muster')} column>
                <Chips values={s.skipPatterns} onChange={(v) => updateSettings({ skipPatterns: v })} placeholder="*.tmp" />
              </Row>
              <Row label={$t('Größere Dateien auslassen')}>
                <Select value={String(s.skipLargerMb)} onChange={(v) => updateSettings({ skipLargerMb: Number(v) })} label={$t('Größere Dateien auslassen')} options={[0, 10, 100, 500, 1000, 5000].map((n) => ({ value: String(n), label: n === 0 ? $t('Nie') : n >= 1000 ? $t('über {0} GB', n / 1000) : $t('über {0} MB', n) }))} />
              </Row>
            </Group>
            <Group title={$t('Beim Hochladen')}>
              <Row label={$t('Erst unter einem Zwischennamen hochladen')} note={$t('Die Datei heißt erst nach dem vollständigen Upload richtig. So läuft nie eine halbe Datei auf dem Server, und abgebrochene Uploads können dort weitermachen, wo sie aufgehört haben.')}><Switch checked={s.uploadTempName} onChange={(v) => updateSettings({ uploadTempName: v })} label={$t('Zwischenname')} /></Row>
              <Row label={$t('Änderungszeit übernehmen')} note={$t('Die Datei am Ziel bekommt dieselbe Änderungszeit wie das Original.')}><Switch checked={s.keepMtime} onChange={(v) => updateSettings({ keepMtime: v })} label={$t('Änderungszeit übernehmen')} /></Row>
              <Row label={$t('Rechte für hochgeladene Dateien')} note={$t('Gilt für SFTP und FTP. Webserver erwarten meist 644 für Dateien und 755 für Ordner.')}>
                <Select value={s.uploadFilePerms} onChange={(v) => updateSettings({ uploadFilePerms: v })} label={$t('Rechte für hochgeladene Dateien')} options={permOptions(['644', '664', '640', '600'])} />
              </Row>
              <Row label={$t('Rechte für neue Ordner')}>
                <Select value={s.uploadDirPerms} onChange={(v) => updateSettings({ uploadDirPerms: v })} label={$t('Rechte für neue Ordner')} options={permOptions(['755', '775', '750', '700'], true)} />
              </Row>
            </Group>
          </>
        )}
        {current === 'connections' && (
          <>
            <Group title={$t('Verbindungen')}>
              <Row label={$t('Bei Verbindungsabbruch neu verbinden')} note={$t('Erst nach 5 Sekunden, dann mit wachsenden Pausen bis zu einer Minute.')}><Switch checked={s.autoReconnect} onChange={(v) => updateSettings({ autoReconnect: v })} label={$t('Neu verbinden')} /></Row>
              <Row label={$t('Verbindung offen halten')} note={$t('Sendet alle 30 Sekunden ein Lebenszeichen. Gilt ab der nächsten Verbindung.')}><Switch checked={s.keepAlive} onChange={(v) => updateSettings({ keepAlive: v })} label={$t('Verbindung offen halten')} /></Row>
            </Group>
            <Group title={$t('Bekannte Fingerabdrücke')}>
              <KnownHostsList />
            </Group>
          </>
        )}
        {current === 'appearance' && (
          <Group title={$t('Darstellung')}>
            <Row label={$t('Erscheinungsbild')}><Select value={s.themeSetting} onChange={(v) => setThemeSetting(v)} label={$t('Erscheinungsbild')} options={[{ value: 'system', label: $t('Wie das System') }, { value: 'dark', label: $t('Dunkel') }, { value: 'light', label: $t('Hell') }]} /></Row>
            <Row label={$t('Zoom')} note={$t('Alles im Fenster größer oder kleiner, auch mit Strg + Plus/Minus, Strg + 0 setzt zurück.')}>
              <Select value={String(s.zoom ?? 1)} onChange={(v) => updateSettings({ zoom: Number(v) })} label={$t('Zoom')} options={ZOOM_STEPS.map((z) => ({ value: String(z), label: `${Math.round(z * 100)} %` }))} />
            </Row>
            <Row label={$t('Dateisymbole des Systems')} note={$t('Statt der farbigen Bitcrane-Symbole die Symbole von Windows bzw. macOS zeigen.')}><Switch checked={!!s.systemIcons} onChange={(v) => updateSettings({ systemIcons: v })} label={$t('Dateisymbole des Systems')} /></Row>
            <Row label={$t('Versteckte Dateien zeigen')}><Switch checked={s.showHidden} onChange={(v) => updateSettings({ showHidden: v })} label={$t('Versteckte Dateien zeigen')} /></Row>
            <Row label={$t('Geschützte Systemdateien zeigen')} note={$t('Wie im Explorer standardmäßig aus, z. B. „Anwendungsdaten“ oder „Eigene Dateien“ im Benutzerordner.')}><Switch checked={!!s.showSystem} onChange={(v) => updateSettings({ showSystem: v })} label={$t('Geschützte Systemdateien zeigen')} /></Row>
            <Row label={$t('Eintrag „..“ zum übergeordneten Ordner')} note={$t('Ganz oben in der Liste, wie in WinSCP und Total Commander. Unter Windows standardmäßig an, auf dem Mac aus.')}><Switch checked={s.parentRow ?? platform === 'win'} onChange={(v) => updateSettings({ parentRow: v })} label={$t('Eintrag „..“ zum übergeordneten Ordner')} /></Row>
            <Row label={$t('Spalte „Geändert“')} note={$t('Spalten lassen sich auch mit einem Rechtsklick auf die Spaltenköpfe ein- und ausblenden.')}><Switch checked={s.columns.mtime} onChange={(v) => updateSettings({ columns: { ...s.columns, mtime: v } })} label={$t('Spalte Geändert')} /></Row>
            <Row label={$t('Spalte „Rechte“')}><Switch checked={s.showPerms} onChange={(v) => updateSettings({ showPerms: v })} label={$t('Spalte Rechte')} /></Row>
            <Row label={$t('Spalte „Größe“')}><Switch checked={s.columns.size} onChange={(v) => updateSettings({ columns: { ...s.columns, size: v } })} label={$t('Spalte Größe')} /></Row>
            <Row label={$t('Bewegung')} note={$t('Folgt der Systemeinstellung „Bewegung reduzieren“.')}><span className="small muted"><Eye size={13} strokeWidth={1.5} aria-hidden="true" /> {$t('automatisch')}</span></Row>
          </Group>
        )}
        {current === 'keys' && <KeysSettings />}
        {current === 'advanced' && (
          <>
          <Group title={$t('Eigene Befehle')}>
            <CustomCommands />
          </Group>
          <Group title={$t('Erweitert')}>
            <Row label={$t('Protokoll für die Fehlersuche')} note={$t('Verbindungen, Übertragungen und Fehler mit Uhrzeit. Bitcrane zeigt es immer an; auf Wunsch auch als Datei.')}>
              <Button small onClick={() => openDialog({ type: 'log' })}>{$t('Protokoll öffnen …')}</Button>
            </Row>
            <Row label={$t('Protokoll zusätzlich in eine Datei schreiben')} note={LIVE ? $t('Hilft, wenn etwas schiefgeht und du es jemandem zeigen möchtest.') : undefined}>
              <span className="row-inline">
                {LIVE && s.writeLog && <Button small variant="ghost" onClick={() => void backend.logPath().then((p) => backend.localReveal(p)).catch(() => undefined)}>{$t('Datei zeigen')}</Button>}
                <Switch checked={s.writeLog} onChange={(v) => updateSettings({ writeLog: v })} label={$t('Protokoll in Datei schreiben')} />
              </span>
            </Row>
            <Row label={$t('Ausführlich protokollieren')} note={$t('Schreibt auch jeden Einzelschritt mit (gelesene Ordner, jede Übertragung, Änderungen in Überwachungen). Nur zur Fehlersuche.')}>
              <Switch checked={s.logLevel === 'detail'} onChange={(v) => updateSettings({ logLevel: v ? 'detail' : 'normal' })} label={$t('Ausführlich protokollieren')} />
            </Row>
            <Row label={$t('sftp-Links mit Bitcrane öffnen')} note={mac ? $t('Ein Klick auf einen Link wie sftp://benutzer@server/pfad öffnet ihn in Bitcrane. Welches Programm solche Links bekommt, entscheidet macOS; ausgeschaltet ignoriert Bitcrane sie.') : $t('Ein Klick auf einen Link wie sftp://benutzer@server/pfad öffnet ihn in Bitcrane. Eingeschaltet meldet sich Bitcrane bei Windows als Programm für solche Links an.')}>
              <Switch checked={s.sftpLinks} onChange={(v) => updateSettings({ sftpLinks: v })} label={$t('sftp-Links mit Bitcrane öffnen')} />
            </Row>
            <Row label={$t('SSH-Konfiguration lesen')} note={$t('Kurznamen aus ~/.ssh/config funktionieren in „Schnell verbinden“, und neue Server lassen sich von dort übernehmen.')}><Switch checked={s.readSshConfig} onChange={(v) => updateSettings({ readSshConfig: v })} label={$t('SSH-Konfiguration lesen')} /></Row>
            <Row label={$t('Überwachungen pro Ordner')}><span className="small muted"><Radio size={13} strokeWidth={1.5} aria-hidden="true" /> {mac ? 'FSEvents' : 'ReadDirectoryChangesW'}</span></Row>
          </Group>
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * "Zwischen Rechnern abgleichen" (after Panic Sync): a folder the user's cloud
 * keeps in step; optional sync password for the passwords (see state/sync.ts).
 */
function SyncSettings() {
  const s = useStore((st) => st.settings);
  const platform = useStore((st) => st.platform);
  const [found, setFound] = useState<CloudPlace[]>([]);
  const [pw, setPw] = useState('');
  // Cloud folders of this computer as quick choices (the same detection as for the places bar).
  useEffect(() => { if (LIVE) void backend.localCloudPlaces().then((l) => setFound(l.filter((c) => c.service !== 'other'))).catch(() => undefined); }, []);
  const choose = async () => {
    const picked = await openDialogPicker({ directory: true, multiple: false, title: $t('Ordner für den Abgleich') }).catch(() => null);
    if (typeof picked === 'string') await setSyncFolder(await invoke<string>('path_to_ui', { path: picked }));
  };
  const status = syncStatus();
  return (
    <Group title={$t('Zwischen Rechnern abgleichen')}>
      <Row label={$t('Ordner für den Abgleich')} note={s.syncFolder
        ? <><span className="mono">{s.syncFolder}</span>{status && <><br /><span className={s.syncError ? 'tone-danger' : ''}>{status}</span></>}</>
        : $t('Server, Gruppen, Regeln und eigene Befehle gleich auf Mac und PC. Wähle einen Ordner, den Dropbox, OneDrive, iCloud Drive oder Google Drive ohnehin abgleicht, und auf dem anderen Rechner denselben.')}>
        <span className="row-inline wrap">
          {!s.syncFolder && found.map((f) => <Button key={f.path} small onClick={() => void setSyncFolder(f.path)}>{f.name}</Button>)}
          {s.syncFolder && <Button small onClick={() => void runSync()}>{$t('Jetzt abgleichen')}</Button>}
          {LIVE && <Button small onClick={() => void choose()}>{s.syncFolder ? $t('Ändern …') : $t('Anderer Ordner …')}</Button>}
          {s.syncFolder && <Button small variant="ghost" onClick={() => void setSyncFolder(null)}>{$t('Aus')}</Button>}
        </span>
      </Row>
      {s.syncFolder && (
        <Row label={$t('Passwörter mit abgleichen')} note={s.syncPasswords
          ? $t('An. Verschlüsselt mit deinem Abgleich-Passwort; das Passwort selbst liegt nur {0}.', platform === 'mac' ? $t('im Schlüsselbund') : $t('in der Anmeldeinformationsverwaltung'))
          : $t('Aus: Passwörter bleiben auf jedem Rechner für sich. Mit einem Abgleich-Passwort (auf allen Rechnern dasselbe) wandern sie verschlüsselt mit.')}>
          {s.syncPasswords
            ? <Button small variant="ghost" onClick={() => void setSyncPassword(null)}>{$t('Ausschalten')}</Button>
            : <span className="row-inline">
              <TextField type="password" value={pw} onChange={setPw} placeholder={$t('Abgleich-Passwort')} label={$t('Abgleich-Passwort')} onEnter={() => { if (pw.length >= 8) { void setSyncPassword(pw); setPw(''); } }} />
              <Button small disabled={pw.length < 8} onClick={() => { void setSyncPassword(pw); setPw(''); }}>{$t('Einschalten')}</Button>
            </span>}
        </Row>
      )}
    </Group>
  );
}
