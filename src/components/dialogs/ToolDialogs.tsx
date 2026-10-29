/**
 * Small windows for the functions taken over from WinSCP:
 * "Auswählen nach Muster", the countdown before the action after the queue,
 * and "Arbeitsbereiche".
 */
import { useEffect, useMemo, useState } from 'react';
import type { PaneSide, Protocol } from '../../backend/types';
import { cancelCloudSignIn, CLOUD_NAMES, signInToCloud } from '../../state/cloud';
import { closeDialog, finishCopyOrMove, serverById, useStore, type AfterQueue } from '../../state/store';
import { afterQueueLabel, matchingNames, openWorkspace, removeWorkspace, runAfterQueue, saveWorkspace, selectByMask, setAfterQueue } from '../../state/tools';
import { Button, Checkbox, Segmented, TextField } from '../ui';
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
    <Dialog label={title} title={title} width={500}
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
      footer={<><span className="flex-1" />{error && <Button onClick={() => setRun((n) => n + 1)}>{$t('Noch einmal')}</Button>}<Button onClick={cancelCloudSignIn}>{$t('Abbrechen')}</Button></>}>
      {error
        ? <p className="small tone-danger">{error}</p>
        : <p className="small muted">{$t('Im Browser hat sich die Anmeldeseite von {0} geöffnet. Melde dich dort an und erlaube den Zugriff für Bitcrane. Danach geht es hier von selbst weiter. Bitcrane bekommt dein Passwort nie zu sehen.', name)}</p>}
    </Dialog>
  );
}
