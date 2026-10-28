/**
 * Small windows for the functions taken over from WinSCP:
 * "Auswählen nach Muster", the countdown before the action after the queue,
 * and "Arbeitsbereiche".
 */
import { useEffect, useMemo, useState } from 'react';
import type { PaneSide } from '../../backend/types';
import { closeDialog, serverById, useStore, type AfterQueue } from '../../state/store';
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
