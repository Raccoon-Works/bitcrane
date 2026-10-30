/**
 * "Kopieren nach …" (after ForkLift): copies the chosen entries of a half into
 * a folder of this computer — one of the places, a folder used before, or any
 * folder picked in the system dialog — without opening it in the other half.
 * On this computer the entries can be moved instead.
 */
import { invoke } from '@tauri-apps/api/core';
import { useState } from 'react';
import { $t } from '../../i18n';
import { closeDialog, copyTo, LIVE, paneOnServer, useStore } from '../../state/store';
import { Button, Checkbox } from '../ui';
import { Dialog } from './Dialog';

export function CopyToDialog({ side, names }: { side: 'local' | 'remote'; names: string[] }) {
  const places = useStore((s) => s.places);
  const recent = useStore((s) => s.settings.copyToRecent) ?? [];
  const onServer = paneOnServer(side);
  const [move, setMove] = useState(false);
  const what = names.length === 1 ? `„${names[0]}“` : $t('{0} Objekte', names.length);
  const targets = [
    ...recent.map((path) => ({ name: path.split('/').filter(Boolean).pop() ?? path, path, recent: true })),
    ...places.filter((p) => !recent.includes(p.path)).map((p) => ({ name: p.name, path: p.path, recent: false })),
  ];
  const pick = async () => {
    if (!LIVE) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false, title: $t('Kopieren nach') }).catch(() => null);
    if (typeof picked === 'string') copyTo(side, names, await invoke<string>('path_to_ui', { path: picked }), move);
  };
  return (
    <Dialog
      label={$t('Kopieren nach')}
      title={move ? $t('{0} bewegen nach …', what) : $t('{0} kopieren nach …', what)}
      subtitle={onServer ? $t('Vom Server auf diesen Computer, ohne den Ordner erst zu öffnen.') : $t('In einen Ordner dieses Computers, ohne ihn erst zu öffnen.')}
      width={520}
      footer={<><Button onClick={() => void pick()}>{$t('Anderer Ordner …')}</Button><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button></>}
    >
      <div className="form-stack">
        <div className="recent-list copyto-list">
          {targets.map((t) => (
            <button key={t.path} type="button" className="recent-item" onClick={() => copyTo(side, names, t.path, move)}>
              <span className="col-text min-w-0 flex-1">
                <span className="ellipsis">{t.name}</span>
                <span className="small muted mono ellipsis">{t.path}</span>
              </span>
              {t.recent && <span className="small muted">{$t('zuletzt')}</span>}
            </button>
          ))}
        </div>
        {!onServer && <Checkbox checked={move} onChange={setMove} label={$t('Bewegen statt kopieren')} />}
      </div>
    </Dialog>
  );
}
