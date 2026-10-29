/**
 * Small windows for the functions taken over from WinSCP:
 * "Auswählen nach Muster", the countdown before the action after the queue,
 * and "Arbeitsbereiche".
 */
import { useEffect, useMemo, useState } from 'react';
import type { PaneSide, Protocol } from '../../backend/types';
import { cancelCloudSignIn, CLOUD_NAMES, signInToCloud } from '../../state/cloud';
import { closeDialog, finishCopyOrMove, serverById, useStore, type AfterQueue } from '../../state/store';
import { afterQueueLabel, matchingNames, openWorkspace, removeWorkspace, runAfterQueue, saveWorkspace, selectByMask, setAfterQueue, uploadToServer } from '../../state/tools';
import { Button, Checkbox, Segmented, Select, TextField } from '../ui';
import { AlertTriangle, Clock, Cloud, FolderPlus, Lock, Upload } from '../glyphs';
import { createVault } from '../../state/vault';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

/** Remembered between openings, like WinSCP keeps the last mask. */
let lastMask = '';
let lastFolders = false;

/** "Auswählen nach Muster": select or deselect entries whose names match a pattern. */
export function SelectMaskDialog({ side }: { side: PaneSide }) {
  const [mask, setMask] = useState(lastMask);
  const [mode, setMode] = useState<'replace' | 'add' | 'remove'>('replace');
  const [folders, setFolders] = useState(lastFolders);
  const count = useMemo(() => matchingNames(side, mask, folders).length, [side, mask, folders]);
  const apply = () => {
    lastMask = mask;
    lastFolders = folders;
    selectByMask(side, mask, mode, folders);
  };
  return (
    <Dialog
      label={$t('Auswählen nach Muster')}
      title={$t('Auswählen nach Muster')}
      width={460}
      footer={<><span className="small muted">{count === 1 ? $t('1 Eintrag passt') : $t('{0} Einträge passen', count)}</span><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!mask.trim()} onClick={apply}>{mode === 'remove' ? $t('Abwählen') : $t('Auswählen')}</Button></>}
    >
      <div className="form-stack">
        <TextField label={$t('Muster')} value={mask} onChange={setMask} mono autoFocus onEnter={apply} placeholder="*.jpg; *.png" />
        <p className="small muted">{$t('* steht für beliebig viele Zeichen, ? für genau eines. Mehrere Muster mit Semikolon trennen.')}</p>
        <Segmented label={$t('Art der Auswahl')} value={mode} onChange={setMode}
          options={[{ value: 'replace', label: $t('Nur diese') }, { value: 'add', label: $t('Hinzufügen') }, { value: 'remove', label: $t('Abwählen') }]} />
        <Checkbox checked={folders} onChange={setFolders} label={$t('Auch Ordner')} />
      </div>
    </Dialog>
  );
}

const COUNTDOWN = 30;
/** Stable empty list (a new [] in the store selector would re-render forever). */
const NO_WORKSPACES: never[] = [];

/** Shown when the queue ran empty: counts down, then runs the chosen action; can be cancelled. */
export function AfterQueueDialog({ action }: { action: AfterQueue }) {
  const [left, setLeft] = useState(COUNTDOWN);
  useEffect(() => {
    const t = window.setInterval(() => setLeft((n) => n - 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (left <= 0) void runAfterQueue(action);
  }, [left, action]);
  const cancel = () => { setAfterQueue('none'); closeDialog(); };
  return (
    <Dialog
      label={$t('Alle Übertragungen fertig')}
      title={$t('Alle Übertragungen fertig')}
      subtitle={$t('„{0}“ in {1} Sekunden.', afterQueueLabel(action), Math.max(0, left))}
      icon={<span className="icon-tile tone-accent"><Clock size={20} strokeWidth={1.75} /></span>}
      width={440}
      onClose={cancel}
      footer={<><span className="flex-1" /><Button onClick={cancel}>{$t('Abbrechen')}</Button><Button variant="primary" onClick={() => void runAfterQueue(action)}>{$t('Jetzt')}</Button></>}
    >
      <p className="small muted">{action === 'shutdown' || action === 'sleep' ? $t('Offene Programme mit ungesicherten Änderungen können das Ausschalten aufhalten.') : $t('Du kannst es hier noch abbrechen.')}</p>
    </Dialog>
  );
}

/** "Arbeitsbereiche": save the open tabs under a name, open or remove saved ones. */
export function WorkspacesDialog() {
  const list = useStore((s) => s.settings.workspaces) ?? NO_WORKSPACES;
  const tabCount = useStore((s) => s.tabs.length);
  const [name, setName] = useState('');
  const describe = (tabs: Array<{ serverId: string; leftServerId?: string }>) =>
    tabs.map((t) => [t.leftServerId, t.serverId].filter(Boolean).map((id) => serverById(id!)?.name ?? '?').join(' ↔ ') || $t('Dieser Computer')).join(', ');
  return (
    <Dialog label={$t('Arbeitsbereiche')} title={$t('Arbeitsbereiche')} subtitle={$t('Mehrere Tabs auf einmal speichern und später wieder öffnen.')} width={560}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Fertig')}</Button></>}>
      <div className="form-stack">
        <span className="row-inline">
          <TextField label={$t('Name des Arbeitsbereichs')} value={name} onChange={setName} placeholder={$t('z. B. Bots')} onEnter={() => { saveWorkspace(name); setName(''); }} className="flex-1" />
          <Button disabled={!name.trim()} onClick={() => { saveWorkspace(name); setName(''); }}>{tabCount === 1 ? $t('1 Tab speichern') : $t('{0} Tabs speichern', tabCount)}</Button>
        </span>
        {!list.length && <p className="small muted">{$t('Noch kein Arbeitsbereich gespeichert.')}</p>}
        {list.map((w) => (
          <div key={w.id} className="ws-row">
            <span className="ws-text">
              <span className="strong">{w.name}</span>
              <span className="small muted ellipsis">{w.tabs.length === 1 ? $t('1 Tab') : $t('{0} Tabs', w.tabs.length)} · {describe(w.tabs)}</span>
            </span>
            <Button small variant="primary" onClick={() => openWorkspace(w.id, true)}>{$t('Öffnen')}</Button>
            <Button small onClick={() => openWorkspace(w.id, false)}>{$t('Dazu öffnen')}</Button>
            <Button small variant="ghost" onClick={() => removeWorkspace(w.id)}>{$t('Entfernen')}</Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

/** A copied or moved folder already exists in the target: merge into it, or keep both ("… Kopie"). Transmit asks the same. */
export function MergeFoldersDialog({ fromDir, names, toDir, move, clashes }: { fromDir: string; names: string[]; toDir: string; move: boolean; clashes: string[] }) {
  const title = clashes.length === 1 ? $t('Ordner „{0}“ gibt es dort schon', clashes[0]) : $t('{0} Ordner gibt es dort schon', clashes.length);
  return (
    <Dialog label={title} title={title} width={500} icon={<span className="icon-tile tone-accent"><FolderPlus size={20} strokeWidth={1.75} /></span>}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button>
        <Button onClick={() => finishCopyOrMove(fromDir, names, toDir, move, false)}>{$t('Beide behalten')}</Button>
        <Button variant="primary" onClick={() => finishCopyOrMove(fromDir, names, toDir, move, true)}>{$t('Zusammenführen')}</Button></>}>
      <p className="small muted">{$t('Zusammenführen legt den Inhalt in den vorhandenen Ordner. Gleichnamige Dateien werden nicht überschrieben, sondern bleiben beide erhalten („… Kopie“). Beide behalten legt einen zweiten Ordner „… Kopie“ an.')}</p>
    </Dialog>
  );
}

/**
 * Sign-in to a cloud service: Bitcrane opens the service's page in the
 * browser and waits for the answer. Nothing is typed in Bitcrane itself.
 */
export function CloudSignInDialog({ service, serverId }: { service: Protocol; serverId?: string }) {
  const name = CLOUD_NAMES[service] ?? service;
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    void signInToCloud(service, serverId).then((e) => { if (alive && e) setError(e); });
    return () => { alive = false; };
  }, [service, serverId, run]);
  return (
    <Dialog label={$t('Bei {0} anmelden', name)} title={$t('Bei {0} anmelden', name)} width={480} onClose={cancelCloudSignIn}
      icon={<span className="icon-tile tone-accent"><Cloud size={20} strokeWidth={1.75} /></span>}
      footer={<><span className="flex-1" />{error && <Button onClick={() => setRun((n) => n + 1)}>{$t('Noch einmal')}</Button>}<Button onClick={cancelCloudSignIn}>{$t('Abbrechen')}</Button></>}>
      {error
        ? <p className="small tone-danger">{error}</p>
        : <p className="small muted">{$t('Im Browser hat sich die Anmeldeseite von {0} geöffnet. Melde dich dort an und erlaube den Zugriff für Bitcrane. Danach geht es hier von selbst weiter. Bitcrane bekommt dein Passwort nie zu sehen.', name)}</p>}
    </Dialog>
  );
}

/**
 * "Mit Bitcrane hochladen" (Explorer / Finder): which server and which folder
 * the handed-over files go to. Remembers the last choice.
 */
export function UploadToDialog({ paths }: { paths: string[] }) {
  const servers = useStore((s) => s.servers).filter((x) => !x.temporary);
  const last = useStore((s) => s.settings.uploadToLast);
  const first = servers.find((x) => x.id === last?.serverId) ?? servers[0];
  const [serverId, setServerId] = useState(first?.id ?? '');
  const startDir = (id: string) => (last?.serverId === id ? last.dir : serverById(id)?.remoteStart || '/');
  const [dir, setDir] = useState(first ? startDir(first.id) : '/');
  const names = paths.map((p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p);
  const title = names.length === 1 ? $t('„{0}“ hochladen', names[0]) : $t('{0} Objekte hochladen', names.length);
  const go = () => { if (serverId && dir.trim()) void uploadToServer(paths, serverId, dir.trim()); };
  return (
    <Dialog label={title} title={title} subtitle={names.length > 1 ? names.slice(0, 4).join(', ') + (names.length > 4 ? ' …' : '') : undefined} width={500}
      icon={<span className="icon-tile tone-accent"><Upload size={20} strokeWidth={1.75} /></span>}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!serverId || !dir.trim()} onClick={go}>{$t('Hochladen')}</Button></>}>
      {servers.length ? (
        <div className="form-stack">
          <Select label={$t('Server')} value={serverId} onChange={(v) => { setServerId(v); setDir(startDir(v)); }} options={servers.map((x) => ({ value: x.id, label: x.name }))} />
          <TextField label={$t('Ordner auf dem Server')} value={dir} onChange={setDir} mono onEnter={go} />
        </div>
      ) : <p className="small muted">{$t('Noch kein Server gespeichert. Lege zuerst einen Server an.')}</p>}
    </Dialog>
  );
}

/** "Neuer Cryptomator-Tresor": name and password (twice) for a new vault in the current folder. */
export function VaultCreateDialog({ side }: { side: PaneSide }) {
  const [name, setName] = useState($t('Tresor'));
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = repeat.length > 0 && repeat !== password;
  const ok = !!name.trim() && password.length >= 8 && repeat === password && !busy;
  const go = async () => {
    if (!ok) return;
    setBusy(true);
    if (!(await createVault(side, name, password))) setBusy(false);
  };
  return (
    <Dialog
      label={$t('Neuer Tresor')}
      title={$t('Neuer Cryptomator-Tresor')}
      subtitle={$t('Ein verschlüsselter Ordner, den auch Cryptomator auf anderen Geräten öffnet.')}
      icon={<span className="icon-tile tone-accent"><Lock size={18} /></span>}
      width={520}
      onClose={closeDialog}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!ok} onClick={() => void go()}>{busy ? $t('Wird angelegt …') : $t('Anlegen')}</Button></>}
    >
      <div className="form-stack">
        <TextField label={$t('Name')} value={name} onChange={setName} autoFocus />
        <TextField type="password" label={$t('Passwort')} value={password} onChange={setPassword} placeholder={$t('Passwort (mindestens 8 Zeichen)')} invalid={tooShort} />
        <TextField type="password" label={$t('Passwort wiederholen')} value={repeat} onChange={setRepeat} placeholder={$t('Passwort wiederholen')} invalid={mismatch} onEnter={() => void go()} />
        {mismatch && <span className="small tone-warn">{$t('Die beiden Passwörter sind nicht gleich.')}</span>}
        <div className="notice tone-warn-notice">
          <AlertTriangle size={15} strokeWidth={1.75} className="tone-warn" aria-hidden="true" />
          <span>{$t('Das Passwort lässt sich nicht zurücksetzen. Ohne Passwort sind die Dateien im Tresor verloren.')}</span>
        </div>
      </div>
    </Dialog>
  );
}
