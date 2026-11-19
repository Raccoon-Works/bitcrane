/** Creates a symbolic link in the current server folder. */
import { useState } from 'react';
import { showError } from '../../state/errors';
import { activeTab, closeDialog, createSymlink, panePath } from '../../state/store';
import { basename, parent } from '../../util/paths';
import { Button, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function SymlinkDialog({ target: initial }: { target: string }) {
  const tab = activeTab();
  const dir = panePath('remote');
  const [target, setTarget] = useState(initial);
  const [name, setName] = useState(initial ? $t('{0} Link', basename(initial)) : '');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!tab || !name.trim() || !target.trim()) return;
    setBusy(true);
    try {
      await createSymlink(tab.serverId, dir, name.trim(), target.trim());
    } catch (e) {
      showError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog
      label={$t('Symbolischen Link erstellen')}
      title={$t('Symbolischen Link erstellen')}
      subtitle={$t('Im Ordner {0} auf dem Server. Der Link verweist auf eine andere Datei oder einen Ordner.', dir)}
      width={560}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={closeDialog}>{$t('Abbrechen')}</Button>
          <Button variant="primary" disabled={busy || !name.trim() || !target.trim()} onClick={() => void create()}>
            {$t('Erstellen')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <label htmlFor="ln-name">{$t('Name')}</label>
        <TextField id="ln-name" value={name} onChange={setName} autoFocus mono onEnter={() => void create()} />
        <label htmlFor="ln-target">{$t('Ziel')}</label>
        <TextField
          id="ln-target"
          value={target}
          onChange={setTarget}
          mono
          placeholder={parent(dir)}
          onEnter={() => void create()}
        />
      </div>
    </Dialog>
  );
}
