/**
 * "Neue Überwachung" / edit a watch (⌘U / Strg+U).
 *
 * Short by default: name, folders, server and the four most important
 * options are visible; everything else sits under "Weitere Optionen".
 * The button row always stays visible.
 */
import { ArrowRight, Eye } from '../glyphs';
import { useState } from 'react';
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { chooseFolder } from '../../backend/dialogs';
import {
  activeTab,
  askDeleteWatch,
  BUILTIN_WATCH_TEMPLATES,
  closeDialog,
  getState,
  LIVE,
  newWatchOptions,
  NO_RULES,
  panePath,
  saveWatch,
  saveWatchTemplate,
  showToast,
  testRunWatch,
  useStore,
} from '../../state/store';
import { explainError } from '../../state/errors';
import { FolderPicker, SubfolderChooser } from '../FolderPicker';
import { testCommand } from '../../state/live';
import { WatchIcon } from '../icons';
import { ServerTile } from '../ServerTile';
import { Button, Select, TextField } from '../ui';
import { Dialog } from './Dialog';
import { WatchBehaviour, WatchCommand, WatchExcludes, WatchMoreOptions } from './WatchFields';
import { useWatchOptions } from './useWatchOptions';
import { $t, LOCALE } from '../../i18n';

/** Brings a typed folder into the form watch events use ("~/x", forward slashes, no trailing slash). */
async function normaliseLocalPath(typed: string): Promise<string> {
  let p = typed.trim().replace(/\\/g, '/');
  if (LIVE) p = await backend.pathToUi(p);
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
  const sshServer = (() => {
    const p = servers.find((x) => x.id === serverId)?.protocol;
    return !p || p === 'sftp';
  })();
  const [remotePath, setRemotePath] = useState(existing?.remotePath ?? panePath('remote'));
  const { opts, set, setOpts } = useWatchOptions(existing?.options ?? newWatchOptions);
  const [excludes, setExcludes] = useState<string[]>(existing?.excludes ?? defaults.defaultExcludes);
  // Transfer rule: '' = the server's rule, 'none' = no rule, else a rule id (settings > Regeln).
  const [ruleId, setRuleId] = useState<string>(existing?.ruleId ?? '');
  const rules = useStore((s) => s.settings.rules) ?? NO_RULES;
  const serverRule = useStore((s) => {
    const id = s.servers.find((x) => x.id === serverId)?.ruleId;
    return (s.settings.rules ?? []).find((r) => r.id === id)?.name ?? '';
  });
  const [tried, setTried] = useState(false);
  const [subfolders, setSubfolders] = useState<string[]>(existing?.subfolders ?? []);
  const [picker, setPicker] = useState(false);
  const [cmdTest, setCmdTest] = useState<null | 'running' | { ok: boolean; title: string; output?: string }>(null);
  // "Testlauf" walks the whole folder; its result belongs to the folder and patterns it was run with.
  const dryRunKey = JSON.stringify([localPath, excludes]);
  const [dryRun, setDryRun] = useState<null | 'running' | { key: string; ok: boolean; title: string }>(null);

  const runDryRun = async () => {
    setDryRun('running');
    try {
      const count = await testRunWatch(await normaliseLocalPath(localPath), excludes);
      setDryRun({
        key: dryRunKey,
        ok: true,
        title:
          count === 1
            ? $t('Testlauf: 1 Datei würde beobachtet. Es wurde nichts übertragen.')
            : $t('Testlauf: {0} Dateien würden beobachtet. Es wurde nichts übertragen.', count.toLocaleString(LOCALE)),
      });
    } catch (e) {
      setDryRun({ key: dryRunKey, ok: false, title: explainError(e).text });
    }
  };

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
    else
      setCmdTest({
        ok: r.code === 0,
        title: r.code === 0 ? $t('Lief ohne Fehler.') : $t('Endete mit Code {0}.', r.code),
        output: r.output.trim() || undefined,
      });
  };
  const homeName = useStore((s) => s.homeName);
  const userTemplates = useStore((s) => s.settings.watchTemplates);

  /** "Auswählen …": the system's folder dialog in the app, the current folder in the prototype. */
  const chooseLocal = async () => {
    if (!LIVE) {
      setLocalPath(panePath('local'));
      return;
    }
    const picked = await chooseFolder($t('Lokalen Ordner wählen'));
    if (picked) setLocalPath(picked);
  };

  const saveTemplate = () => {
    const tplName = effectiveName || $t('Vorlage');
    const replaced = userTemplates.some((t) => t.name === tplName);
    // The chosen subfolders belong to this folder; a template has none, so it never limits to them.
    saveWatchTemplate({ name: tplName, excludes, options: { ...opts, onlySelectedSubfolders: false } });
    showToast(
      replaced
        ? $t('Vorlage „{0}“ überschrieben. Bearbeiten und löschen: Einstellungen › Überwachung.', tplName)
        : $t('Vorlage „{0}“ gespeichert. Du findest sie bei „Vorlage wählen …“.', tplName),
      'ok',
    );
  };

  /** Values of the template menu: "user:<name>" for own templates, "builtin:<id>", "none" to clear the list. */
  const applyTemplate = (v: string) => {
    if (v === 'none') setExcludes([]);
    else if (v.startsWith('user:')) {
      const t = userTemplates.find((x) => x.name === v.slice(5))!;
      setExcludes(t.excludes);
      setOpts(t.options);
    } else if (v.startsWith('builtin:'))
      setExcludes(BUILTIN_WATCH_TEMPLATES.find((x) => x.id === v.slice(8))!.excludes);
  };

  // The last two folder names, without the home sign or a drive letter ("~ bitcrane-test" read oddly).
  const effectiveName =
    name.trim() ||
    localPath
      .split('/')
      .filter((x) => x && x !== '~' && !/^[a-z]:$/i.test(x))
      .slice(-2)
      .join(' ');
  const invalidRemote = tried && !remotePath.trim().startsWith('/');

  const submit = () => {
    setTried(true);
    if (!remotePath.trim().startsWith('/')) {
      showToast($t('Der Server-Ordner muss mit / beginnen.'), 'error');
      return;
    }
    void normaliseLocalPath(localPath).then((local) =>
      saveWatch({
        id: existing?.id,
        name: effectiveName,
        localPath: local,
        serverId,
        remotePath: remotePath.trim(),
        excludes,
        options: opts,
        subfolders,
        ruleId: ruleId || undefined,
      }),
    );
  };

  const footer = (
    <>
      {existing ? (
        <Button variant="link" className="tone-danger-text" onClick={() => askDeleteWatch(existing)}>
          {$t('Überwachung löschen')}
        </Button>
      ) : (
        <Button variant="link" onClick={saveTemplate}>
          {$t('Als Vorlage speichern')}
        </Button>
      )}
      <span className="flex-1" />
      <Button disabled={dryRun === 'running'} onClick={() => void runDryRun()}>
        <Eye size={13} strokeWidth={1.75} aria-hidden="true" />
        {dryRun === 'running' ? $t('Zähle …') : $t('Testlauf')}
      </Button>
      <Button onClick={closeDialog}>{$t('Abbrechen')}</Button>
      <Button variant="primary" onClick={submit}>
        {existing ? $t('Sichern') : $t('Überwachung starten')}{' '}
        <span className="btn-key">{platform === 'mac' ? '⌘↩' : 'Strg+Enter'}</span>
      </Button>
    </>
  );

  return (
    <Dialog
      label={existing ? $t('Überwachung bearbeiten') : $t('Neue Überwachung')}
      title={existing ? $t('„{0}“ bearbeiten', existing.name) : $t('Neue Überwachung')}
      subtitle={
        existing
          ? $t('Änderungen gelten sofort, ohne die Überwachung neu zu starten.')
          : $t('Änderungen in einem lokalen Ordner werden automatisch auf den Server hochgeladen.')
      }
      icon={
        <span className="icon-tile tone-accent">
          <WatchIcon size={20} waves={2} />
        </span>
      }
      width={760}
      maxHeight={720}
      footer={footer}
    >
      <div
        className="form-stack"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
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
            <Select
              id="w-server"
              value={serverId}
              onChange={setServerId}
              options={servers.map((x) => ({ value: x.id, label: x.name }))}
            />
          </div>

          <label htmlFor="w-remote">{$t('Server-Ordner')}</label>
          <div className="field-row">
            <TextField
              id="w-remote"
              mono
              value={remotePath}
              onChange={setRemotePath}
              invalid={invalidRemote}
              className="flex-1"
            />
            <Button onClick={() => setPicker(!picker)} aria-expanded={picker}>
              {$t('Durchsuchen …')}
            </Button>
          </div>
          {picker && (
            <>
              <span />
              <FolderPicker
                side="remote"
                serverId={serverId}
                start={remotePath.trim().startsWith('/') ? remotePath.trim() : panePath('remote')}
                homeName={homeName}
                onPick={(p) => {
                  setRemotePath(p);
                  setPicker(false);
                }}
                onClose={() => setPicker(false)}
              />
            </>
          )}
          {invalidRemote && (
            <>
              <span />
              <span className="small tone-danger">{$t('Fehler: Der Server-Ordner muss mit / beginnen.')}</span>
            </>
          )}

          <span>{$t('Richtung')}</span>
          <span className="direction">
            <ArrowRight size={14} strokeWidth={1.75} className="tone-accent" aria-hidden="true" />
            {$t('Nur hochladen. Was nur auf dem Server liegt, bleibt unberührt.')}
          </span>
        </div>

        <WatchBehaviour opts={opts} set={set} />

        <section aria-label={$t('Regel')} className="form-section">
          <div className="form-section-head">
            <span className="caption-strong">{$t('Regel')}</span>
            <Select
              label={$t('Regel für diese Überwachung')}
              value={ruleId}
              onChange={setRuleId}
              options={[
                {
                  value: '',
                  label: serverRule ? $t('Wie der Server ({0})', serverRule) : $t('Wie der Server (keine Regel)'),
                },
                { value: 'none', label: $t('Keine Regel') },
                ...rules.map((r) => ({ value: r.id, label: r.name || $t('Ohne Namen') })),
              ]}
            />
          </div>
          <span className="small muted">
            {$t(
              'Regeln bündeln Ausschlüsse, Rechte und das Verhalten bei vorhandenen Dateien (Einstellungen › Regeln). Ihre Muster kommen zu den eigenen unten dazu.',
            )}
          </span>
        </section>

        <WatchExcludes
          excludes={excludes}
          onChange={setExcludes}
          choose={
            <Select
              label={$t('Vorlage für Ausschlüsse')}
              value={'' as string}
              onChange={applyTemplate}
              options={[
                { value: '', label: $t('Vorlage wählen …') },
                ...userTemplates.map((t) => ({ value: `user:${t.name}`, label: $t('{0} (eigene Vorlage)', t.name) })),
                ...BUILTIN_WATCH_TEMPLATES.map((t) => ({ value: `builtin:${t.id}`, label: t.label })),
                { value: 'none', label: $t('Leer') },
              ]}
            />
          }
        />

        <WatchMoreOptions
          opts={opts}
          set={set}
          subfolders={<SubfolderChooser root={localPath} selected={subfolders} onChange={setSubfolders} />}
          command={
            sshServer ? (
              <WatchCommand
                opts={opts}
                set={set}
                action={
                  <Button
                    disabled={!opts.command.trim() || cmdTest === 'running'}
                    onClick={() => void runCommandTest()}
                  >
                    {cmdTest === 'running' ? $t('Läuft …') : $t('Jetzt testen')}
                  </Button>
                }
                result={
                  cmdTest &&
                  cmdTest !== 'running' && (
                    <div
                      className={`cmd-result ${cmdTest.ok ? 'is-ok' : 'is-error'}`}
                      ref={(el) => el?.scrollIntoView({ block: 'nearest' })}
                    >
                      <span className="small strong-500">{cmdTest.title}</span>
                      {cmdTest.output && <pre className="mono">{cmdTest.output}</pre>}
                    </div>
                  )
                }
              />
            ) : (
              <div className="sub-card">
                <span className="small muted">
                  {$t('Befehle nach dem Hochladen gibt es nur bei SFTP-Servern (über SSH). Dieser Server nutzt')}{' '}
                  {({ webdav: 'WebDAV', smb: 'SMB' } as Record<string, string>)[
                    servers.find((x) => x.id === serverId)?.protocol ?? ''
                  ] ?? 'FTP'}
                  .
                </span>
              </div>
            )
          }
        />

        {dryRun && dryRun !== 'running' && dryRun.key === dryRunKey && (
          <div
            className={`cmd-result ${dryRun.ok ? 'is-ok' : 'is-error'}`}
            role="status"
            ref={(el) => el?.scrollIntoView({ block: 'nearest' })}
          >
            <span className="small strong-500">{dryRun.title}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
