import { useState } from 'react';
import type { PaneSide } from '../../backend/types';
import { closeDialog, editWith, pickProgram, programName, updateSettings, useStore } from '../../state/store';
import { Button, Checkbox } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

/**
 * "Bearbeiten mit …" (WinSCP "Edit with"): the built-in editor, the programs
 * already chosen in the settings, the system's default program, or another
 * one. The choice can be kept for files of this kind.
 */
export function EditWithDialog({ side, name }: { side: PaneSide; name: string }) {
  const s = useStore((st) => st.settings);
  const mac = useStore((st) => st.platform) === 'mac';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  const [remember, setRemember] = useState(false);
  const known = [...new Set([s.editorApp, ...Object.values(s.editorByExt)].filter(Boolean))];
  const choose = (app: string | null) => {
    if (remember && ext) {
      const next = { ...s.editorByExt };
      if (app) next[ext] = app;
      else delete next[ext];
      updateSettings({ editorByExt: next });
    }
    editWith(side, name, app);
  };
  const other = async () => {
    const picked = await pickProgram($t('Programm wählen'), mac);
    if (picked) choose(picked);
  };
  const options: Array<{ key: string; label: string; sub?: string; run: () => void }> = [
    { key: 'builtin', label: $t('Editor von Bitcrane'), run: () => choose(null) },
    ...known.map((p) => ({ key: p, label: programName(p), sub: p, run: () => choose(p) })),
    { key: 'system', label: $t('Standardprogramm des Systems'), run: () => choose('') },
  ];
  return (
    <Dialog
      label={$t('Bearbeiten mit')}
      title={$t('„{0}“ bearbeiten mit …', name)}
      width={460}
      footer={
        <>
          <Button onClick={() => void other()}>{$t('Anderes Programm …')}</Button>
          <span className="flex-1" />
          <Button onClick={closeDialog}>{$t('Abbrechen')}</Button>
        </>
      }
    >
      <div className="form-stack">
        <div className="recent-list">
          {options.map((o) => (
            <button key={o.key} type="button" className="recent-item" onClick={o.run}>
              <span className="col-text min-w-0 flex-1">
                <span className="ellipsis">{o.label}</span>
                {o.sub && <span className="small muted mono ellipsis">{o.sub}</span>}
              </span>
            </button>
          ))}
        </div>
        {ext && <Checkbox checked={remember} onChange={setRemember} label={$t('Für {0}-Dateien merken', ext)} />}
      </div>
    </Dialog>
  );
}
