/**
 * "Neue Überwachung" / edit a watch (⌘U / Strg+U).
 *
 * Short by default: name, folders, server and the four most important
 * options are visible; everything else sits under "Weitere Optionen".
 * The button row always stays visible.
 */
import { ArrowRight, ChevronRight, Eye, Plus, X } from '../glyphs';
import { useState } from 'react';
import type { WatchOptions } from '../../backend/types';
import { invoke } from '@tauri-apps/api/core';
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import {
  activeTab, closeDialog, defaultWatchOptions, deleteWatch, getState, LIVE, openDialog, panePath, saveWatch, showToast, testRunWatch, updateSettings, useStore,
} from '../../state/store';
import { FolderPicker, SubfolderChooser } from '../FolderPicker';
import { testCommand } from '../../state/live';
import { WatchIcon } from '../icons';
import { ServerTile } from '../ServerTile';
import { Button, Checkbox, Select, Switch, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

const templates: Record<string, string[]> = {
  python: ['.git', '__pycache__', '.DS_Store', '*.log', '*.tmp', '.venv'],
  web: ['.git', 'node_modules', '.DS_Store', '*.log', '.cache'],
  none: [],
};

/** Brings a typed folder into the form watch events use ("~/x", forward slashes, no trailing slash). */
async function normaliseLocalPath(typed: string): Promise<string> {
  let p = typed.trim().replace(/\\/g, '/');
  if (LIVE) p = await invoke<string>('path_to_ui', { path: p }).catch(() => p);
  return p.length > 1 && !/^[A-Za-z]:\/$/.test(p) ? p.replace(/\/+$/, '') : p;
}

export function WatchSetup({ editId }: { editId?: string }) {
  const platform = useStore((s) => s.platform);
  const servers = useStore((s) => s.servers).filter((x) => !x.temporary);
  const existing = useStore((s) => s.watches.find((w) => w.id === editId));
  const defaults = getState().settings;
  const tab = activeTab();

  const [name, setName] = useState(existing?.name ?? '');
  // Server to server: the left half is not a folder on this computer.
  const [localPath, setLocalPath] = useState(existing?.localPath ?? (tab?.leftServerId ? '~' : panePath('local')));
  const [serverId, setServerId] = useState(existing?.serverId ?? tab?.serverId ?? servers[0]?.id ?? '');
  const sshServer = (() => { const p = servers.find((x) => x.id === serverId)?.protocol; return !p || p === 'sftp'; })();
  const [remotePath, setRemotePath] = useState(existing?.remotePath ?? panePath('remote'));
  const [opts, setOpts] = useState<WatchOptions>(existing?.options ?? { ...defaultWatchOptions, delay: defaults.defaultDelay, mirrorDeletes: defaults.defaultMirrorDeletes });
  const [excludes, setExcludes] = useState<string[]>(existing?.excludes ?? defaults.defaultExcludes);
  // Transfer rule: '' = the server's rule, 'none' = no rule, else a rule id (settings > Regeln).
  const [ruleId, setRuleId] = useState<string>(existing?.ruleId ?? '');
  const rules = useStore((s) => s.settings.rules ?? []);
  const serverRule = useStore((s) => { const id = s.servers.find((x) => x.id === serverId)?.ruleId; return (s.settings.rules ?? []).find((r) => r.id === id)?.name ?? ''; });
  const [newPattern, setNewPattern] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [tried, setTried] = useState(false);
  const [subfolders, setSubfolders] = useState<string[]>(existing?.subfolders ?? []);
  const [picker, setPicker] = useState(false);
  const [cmdTest, setCmdTest] = useState<null | 'running' | { ok: boolean; title: string; output?: string }>(null);

  /** Runs the post-upload command once on the chosen server and shows its output. */
  const runCommandTest = async () => {
    const cmd = opts.command.trim();
    if (!LIVE) {
      setCmdTest({ ok: true, title: $t('„{0}“ lief ohne Fehler (Prototyp, simuliert).', cmd) });
      return;
    }
    setCmdTest('running');
    const r = await testCommand(serverId, cmd);
    if ('error' in r) setCmdTest({ ok: false, title: r.error });
    else setCmdTest({ ok: r.code === 0, title: r.code === 0 ? $t('Lief ohne Fehler.') : $t('Endete mit Code {0}.', r.code), output: r.output.trim() || undefined });
  };
  const homeName = useStore((s) => s.homeName);
  const userTemplates = useStore((s) => s.settings.watchTemplates);

  /** "Auswählen …": the system's folder dialog in the app, the current folder in the prototype. */
  const chooseLocal = async () => {
    if (!LIVE) {
      setLocalPath(panePath('local'));
      return;
    }
    const picked = await openFolderDialog({ directory: true, multiple: false, title: $t('Lokalen Ordner wählen') }).catch(() => null);
    if (typeof picked === 'string') setLocalPath(await invoke<string>('path_to_ui', { path: picked }));
  };

  const saveTemplate = () => {
    const tplName = effectiveName || $t('Vorlage');
    const rest = userTemplates.filter((t) => t.name !== tplName);
    updateSettings({ watchTemplates: [...rest, { name: tplName, excludes, options: { ...opts, command: opts.command } }] });
    showToast($t('Vorlage „{0}“ gespeichert. Du findest sie bei „Vorlage wählen …“.', tplName), 'ok');
  };

  const applyTemplate = (v: string) => {
    if (!v) return;
    if (v.startsWith('user:')) {
      const t = userTemplates.find((x) => x.name === v.slice(5));
      if (t) {
        setExcludes(t.excludes);
        setOpts(t.options);
      }
    } else setExcludes(templates[v]);
  };

  const set = <K extends keyof WatchOptions>(k: K, v: WatchOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));
  const effectiveName = name.trim() || localPath.split('/').filter(Boolean).slice(-2).join(' ');
  const invalidRemote = tried && !remotePath.trim().startsWith('/');
  const changedCount = (['continueOnError', 'onlyExisting', 'onlySelectedSubfolders', 'setPermissions', 'mirrorDeletes', 'keepOldVersion', 'commandEnabled'] as const)
    .filter((k) => opts[k] !== defaultWatchOptions[k]).length + (opts.delay !== defaultWatchOptions.delay ? 1 : 0);

  const submit = () => {
    setTried(true);
    if (!remotePath.trim().startsWith('/')) {
      showToast($t('Der Server-Ordner muss mit / beginnen.'), 'error');
      return;
    }
    void normaliseLocalPath(localPath).then((local) => saveWatch({ id: existing?.id, name: effectiveName, localPath: local, serverId, remotePath: remotePath.trim(), excludes, options: opts, subfolders, ruleId: ruleId || undefined }));
  };

  const footer = (
    <>
      {existing ? (
        <Button variant="link" className="tone-danger-text" onClick={() => openDialog({
          type: 'confirm', danger: true, confirm: $t('Löschen'), title: $t('Überwachung „{0}“ löschen?', existing.name),
          text: $t('Die Einstellungen dieser Überwachung gehen verloren. Dateien auf dem Server und auf diesem Computer bleiben, wie sie sind.'),
          run: () => deleteWatch(existing.id),
        })}>{$t('Überwachung löschen')}</Button>
      ) : (
        <Button variant="link" onClick={saveTemplate}>{$t('Als Vorlage speichern')}</Button>
      )}
      <span className="flex-1" />
      <Button onClick={() => testRunWatch(localPath, excludes)}><Eye size={13} strokeWidth={1.75} aria-hidden="true" />{$t('Testlauf')}</Button>
      <Button onClick={closeDialog}>{$t('Abbrechen')}</Button>
      <Button variant="primary" onClick={submit}>
        {existing ? $t('Sichern') : $t('Überwachung starten')} <span className="btn-key">{platform === 'mac' ? '⌘↩' : 'Strg+Enter'}</span>
      </Button>
    </>
  );

  return (
    <Dialog
      label={existing ? $t('Überwachung bearbeiten') : $t('Neue Überwachung')}
      title={existing ? $t('„{0}“ bearbeiten', existing.name) : $t('Neue Überwachung')}
      subtitle={existing ? $t('Änderungen gelten sofort, ohne die Überwachung neu zu starten.') : $t('Änderungen in einem lokalen Ordner werden automatisch auf den Server hochgeladen.')}
      icon={<span className="icon-tile tone-accent"><WatchIcon size={20} waves={2} /></span>}
      width={760}
      maxHeight={720}
      footer={footer}
    >
      <div
        className="form-stack"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
      >
        <div className="form-grid section-card">
          <label htmlFor="w-name">{$t('Name')}</label>
          <TextField id="w-name" value={name} onChange={setName} placeholder={effectiveName} />

          <label htmlFor="w-local">{$t('Lokaler Ordner')}</label>
          <div className="field-row">
            <TextField id="w-local" mono value={localPath} onChange={setLocalPath} className="flex-1" />
            <Button onClick={() => void chooseLocal()}>{$t('Auswählen …')}</Button>
          </div>

          <label htmlFor="w-server">{$t('Server')}</label>
          <div className="field-row">
            <ServerTile server={servers.find((x) => x.id === serverId)} size={18} />
            <Select id="w-server" value={serverId} onChange={setServerId} options={servers.map((x) => ({ value: x.id, label: x.name }))} />
          </div>

          <label htmlFor="w-remote">{$t('Server-Ordner')}</label>
          <div className="field-row">
            <TextField id="w-remote" mono value={remotePath} onChange={setRemotePath} invalid={invalidRemote} className="flex-1" />
            <Button onClick={() => setPicker(!picker)} aria-expanded={picker}>{$t('Durchsuchen …')}</Button>
          </div>
          {picker && (
            <>
              <span />
              <FolderPicker side="remote" serverId={serverId} start={remotePath.trim().startsWith('/') ? remotePath.trim() : panePath('remote')} homeName={homeName}
                onPick={(p) => { setRemotePath(p); setPicker(false); }} onClose={() => setPicker(false)} />
            </>
          )}
          {invalidRemote && <><span /><span className="small tone-danger">{$t('Fehler: Der Server-Ordner muss mit / beginnen.')}</span></>}

          <span>{$t('Richtung')}</span>
          <span className="direction"><ArrowRight size={14} strokeWidth={1.75} className="tone-accent" aria-hidden="true" />{$t('Nur hochladen. Was nur auf dem Server liegt, bleibt unberührt.')}</span>
        </div>

        <section aria-label={$t('Verhalten')} className="form-section">
          <span className="caption-strong">{$t('Verhalten')}</span>
          <div className="section-card list-card">
            <Checkbox checked={opts.includeSubfolders} onChange={(v) => set('includeSubfolders', v)} label={$t('Unterordner einbeziehen')} note={$t('Auch Änderungen in allen Unterordnern hochladen.')} />
            <Checkbox checked={opts.syncOnStart} onChange={(v) => set('syncOnStart', v)} label={$t('Beim Start abgleichen')} note={$t('Einmal alles hochladen, was lokal neuer ist.')} />
            <Checkbox checked={opts.warnIfServerNewer} onChange={(v) => set('warnIfServerNewer', v)} label={$t('Warnen, wenn die Server-Datei neuer ist')} note={$t('Nachfragen statt still überschreiben.')} />
            <Checkbox checked={opts.runInBackground} onChange={(v) => set('runInBackground', v)} label={$t('Im Hintergrund weiterlaufen')} note={$t('Auch bei geschlossenem Fenster.')} />
            <Checkbox checked={opts.startWithApp !== false} onChange={(v) => set('startWithApp', v)} label={$t('Beim Start von Bitcrane automatisch starten')} note={$t('Verbindet sich selbst und überwacht sofort, z. B. nach dem Hochfahren. Aus: bleibt pausiert, bis du sie startest.')} />
          </div>
        </section>

        <section aria-label={$t('Regel')} className="form-section">
          <div className="form-section-head">
            <span className="caption-strong">{$t('Regel')}</span>
            <Select label={$t('Regel für diese Überwachung')} value={ruleId} onChange={setRuleId}
              options={[
                { value: '', label: serverRule ? $t('Wie der Server ({0})', serverRule) : $t('Wie der Server (keine Regel)') },
                { value: 'none', label: $t('Keine Regel') },
                ...rules.map((r) => ({ value: r.id, label: r.name || $t('Ohne Namen') })),
              ]} />
          </div>
          <span className="small muted">{$t('Regeln bündeln Ausschlüsse, Rechte und das Verhalten bei vorhandenen Dateien (Einstellungen › Regeln). Ihre Muster kommen zu den eigenen unten dazu.')}</span>
        </section>

        <section aria-label={$t('Nicht hochladen')} className="form-section">
          <div className="form-section-head">
            <span className="caption-strong">{$t('Nicht hochladen')}</span>
            <Select
              label={$t('Vorlage für Ausschlüsse')}
              value={'' as string}
              onChange={applyTemplate}
              options={[
                { value: '', label: $t('Vorlage wählen …') },
                ...userTemplates.map((t) => ({ value: `user:${t.name}`, label: $t('{0} (eigene Vorlage)', t.name) })),
                { value: 'python', label: $t('Python-Projekt') }, { value: 'web', label: $t('Web-Projekt') }, { value: 'none', label: $t('Leer') },
              ]}
            />
          </div>
          <div className="section-card chips">
            {excludes.map((x) => (
              <span key={x} className="chip mono">
                {x}
                <button type="button" aria-label={$t('Muster {0} entfernen', x)} onClick={() => setExcludes(excludes.filter((y) => y !== x))}><X size={10} strokeWidth={2.4} /></button>
              </span>
            ))}
            {newPattern !== null ? (
              <input
                className="chip-input mono"
                autoFocus
                value={newPattern}
                placeholder="*.bak"
                aria-label={$t('Neues Muster')}
                onChange={(e) => setNewPattern(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newPattern.trim()) { e.preventDefault(); setExcludes([...excludes, newPattern.trim()]); setNewPattern(''); }
                  if (e.key === 'Escape') { e.stopPropagation(); setNewPattern(null); }
                }}
                onBlur={() => { if (newPattern.trim()) setExcludes([...excludes, newPattern.trim()]); setNewPattern(null); }}
              />
            ) : (
              <button type="button" className="chip-add" aria-label={$t('Muster hinzufügen')} title={$t('Muster hinzufügen')} onClick={() => setNewPattern('')}><Plus size={12} strokeWidth={2} /></button>
            )}
          </div>
        </section>

        <section aria-label={$t('Weitere Optionen')} className="section-card disclosure">
          <button type="button" className="disclosure-head" aria-expanded={more} onClick={() => setMore(!more)}>
            <ChevronRight size={13} strokeWidth={2} className={`chev${more ? ' is-open' : ''}`} aria-hidden="true" />
            <span className="strong">{$t('Weitere Optionen')}</span>
            <span className="small muted ellipsis">{$t('Fehler, Löschen, Rechte, Befehl, Wartezeit')}{changedCount ? $t(' · {0} geändert', changedCount) : ''}</span>
          </button>
          {more && (
            <div className="disclosure-body">
              <div className="option-grid">
                <Checkbox checked={opts.continueOnError} onChange={(v) => set('continueOnError', v)} label={$t('Bei Fehlern weitermachen')} note={$t('Ein Fehler hält die Überwachung nicht an; er erscheint in der Aktivität.')} />
                <Checkbox checked={opts.onlyExisting} onChange={(v) => set('onlyExisting', v)} label={$t('Nur vorhandene Dateien aktualisieren')} note={$t('Neue Dateien bleiben lokal, nur bestehende werden ersetzt.')} />
                <Checkbox checked={opts.onlySelectedSubfolders} onChange={(v) => set('onlySelectedSubfolders', v)} label={$t('Nur ausgewählte Unterordner')} note={$t('Statt des ganzen Ordners nur bestimmte Unterordner überwachen.')} />
                {opts.onlySelectedSubfolders && <SubfolderChooser root={localPath} selected={subfolders} onChange={setSubfolders} />}
                <Checkbox checked={opts.setPermissions} onChange={(v) => set('setPermissions', v)} label={$t('Rechte nach dem Hochladen setzen')} note={$t('Zum Beispiel rw-r--r-- für Dateien und rwxr-xr-x für Ordner.')} />
                <Checkbox danger checked={opts.mirrorDeletes} onChange={(v) => set('mirrorDeletes', v)} label={$t('Lokal Gelöschtes auch auf dem Server löschen')} note={$t('Vorsicht: Dateien auf dem Server gehen dabei verloren. Standardmäßig aus.')} />
                <Checkbox checked={opts.keepOldVersion} onChange={(v) => set('keepOldVersion', v)} label={$t('Ältere Version auf dem Server behalten')} note={$t('Vor dem Überschreiben kommt die alte Datei in den versteckten Ordner .bitcrane-versions daneben; die letzten 5 Versionen bleiben.')} />
              </div>

              {!sshServer && <div className="sub-card"><span className="small muted">{$t('Befehle nach dem Hochladen gibt es nur bei SFTP-Servern (über SSH). Dieser Server nutzt')}{' '}{({ webdav: 'WebDAV', smb: 'SMB' } as Record<string, string>)[servers.find((x) => x.id === serverId)?.protocol ?? ''] ?? 'FTP'}.</span></div>}
              {sshServer && <div className="sub-card">
                <div className="row-between">
                  <label htmlFor="w-cmd" className="strong-500">{$t('Nach dem Hochladen einen Befehl auf dem Server ausführen')}</label>
                  <Switch checked={opts.commandEnabled} onChange={(v) => set('commandEnabled', v)} label={$t('Befehl nach dem Hochladen ausführen')} />
                </div>
                <div className="field-row">
                  <TextField id="w-cmd" mono className="flex-1 is-terminal" prefix={<span className="tone-ok">$</span>} value={opts.command} onChange={(v) => set('command', v)} placeholder={$t('pm2 restart meinbot')} />
                  <Button disabled={!opts.command.trim() || cmdTest === 'running'} onClick={() => void runCommandTest()}>{cmdTest === 'running' ? $t('Läuft …') : $t('Jetzt testen')}</Button>
                </div>
                {cmdTest && cmdTest !== 'running' && (
                  <div className={`cmd-result ${cmdTest.ok ? 'is-ok' : 'is-error'}`} ref={(el) => el?.scrollIntoView({ block: 'nearest' })}>
                    <span className="small strong-500">{cmdTest.title}</span>
                    {cmdTest.output && <pre className="mono">{cmdTest.output}</pre>}
                  </div>
                )}
                <span className="small muted">{$t('Läuft einmal, nachdem ein Schub Änderungen fertig hochgeladen ist, und nur, wenn dabei kein Fehler auftrat. Die Ausgabe steht in der Aktivität.')}</span>
              </div>}

              <div className="sub-card row-card">
                <div className="col-text">
                  <span className="strong-500">{$t('Kurz warten, bevor hochgeladen wird')}</span>
                  <span className="small muted">{$t('Sammelt Änderungen, damit keine halb gespeicherten Dateien hochgehen.')}</span>
                </div>
                <input type="range" min={0} max={10} step={1} value={opts.delay} aria-label={$t('Wartezeit in Sekunden')} className="slider" onChange={(e) => set('delay', Number(e.target.value))} />
                <span className="num slider-value">{opts.delay} {$t('Sek.')}</span>
              </div>
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}
