/**
 * Git commit for a working copy on this computer: what changed, a message,
 * and whether every change goes in (git add -A first) or only what was added.
 */
import { useState } from 'react';
import { $t } from '../../i18n';
import { GIT_LABEL, gitFor, gitRun } from '../../state/git';
import { closeDialog, getState } from '../../state/store';
import { Button, Checkbox } from '../ui';
import { Dialog } from './Dialog';

export function GitCommit({ root }: { root: string }) {
  const [message, setMessage] = useState('');
  const [all, setAll] = useState(true);
  const [busy, setBusy] = useState(false);
  // The state is cached per shown folder; any folder of this working copy has it.
  const tab = getState().tabs.find((t) => t.id === getState().activeTabId);
  const st = [tab?.localPath, tab?.remotePath].map((d) => (d ? gitFor(d) : null)).find((s) => s?.root === root) ?? null;
  const files = Object.entries(st?.files ?? {});
  const commit = async () => {
    setBusy(true);
    const ok = await gitRun(root, 'commit', { message, all });
    setBusy(false);
    if (ok) closeDialog();
  };
  return (
    <Dialog
      label={$t('Commit')}
      title={$t('Commit in „{0}“', root.split('/').pop() ?? root)}
      subtitle={st ? $t('Zweig {0}', st.branch) : root}
      width={600}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!message.trim() || busy || !files.length} onClick={() => void commit()}>{$t('Commit')}</Button></>}
    >
      <div className="form-stack">
        <textarea className="field git-message" autoFocus value={message} onChange={(e) => setMessage(e.target.value)} placeholder={$t('Was wurde geändert?')} rows={3}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && message.trim()) void commit(); }} />
        <Checkbox checked={all} onChange={setAll} label={$t('Alle Änderungen aufnehmen')} note={$t('Aus: nur, was vorher mit „Für Commit hinzufügen“ gewählt wurde.')} />
        {files.length ? (
          <div className="recent-list git-files">
            {files.slice(0, 200).map(([path, letter]) => (
              <div key={path} className="recent-item">
                <span className={`git-mark git-${letter === '?' ? 'new' : letter}`} title={GIT_LABEL[letter]}>{letter}</span>
                <span className="mono small ellipsis flex-1">{path}</span>
              </div>
            ))}
            {files.length > 200 && <span className="small muted">{$t('und {0} weitere', files.length - 200)}</span>}
          </div>
        ) : <p className="muted">{$t('Keine Änderungen.')}</p>}
      </div>
    </Dialog>
  );
}
