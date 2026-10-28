/**
 * Small file tools: SHA-256 checksum (compared with the file of the same
 * name in the other half, if there is one) and creating a symbolic link on
 * the server.
 */
import { Check, Copy, Loader2, X } from '../glyphs';
import { useEffect, useState } from 'react';
import { toBackendError } from '../../backend/api';
import { tauriBackend as backend } from '../../backend/tauriBackend';
import type { PaneSide } from '../../backend/types';
import { reopenEditing, stopEditing, uploadEditingNow } from '../../state/live';
import { activeTab, closeDialog, invalidateRemote, LIVE, listEntries, panePath, showToast, useStore, paneLoc, serverById } from '../../state/store';
import { formatAgo } from '../../util/format';
import { basename, join, parent } from '../../util/paths';
import { Button, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

type Sum = { state: 'busy' } | { state: 'ok'; hex: string } | { state: 'error'; text: string };

/** Demo value for the browser prototype. */
async function fakeSum(seed: string): Promise<string> {
  const data = new TextEncoder().encode(seed);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function SumLine({ label, path, sum }: { label: string; path: string; sum: Sum }) {
  return (
    <div className="sum-line">
      <span className="caption-strong">{label}</span>
      <span className="small muted mono ellipsis" title={path}>{path}</span>
      {sum.state === 'busy' && <span className="row-inline muted small"><Loader2 size={13} className="spin" aria-hidden="true" />{$t('Wird berechnet …')}</span>}
      {sum.state === 'error' && <span className="small tone-danger">{sum.text}</span>}
      {sum.state === 'ok' && (
        <span className="row-inline">
          <code className="mono break sum-hex">{sum.hex}</code>
          <button type="button" className="icon-btn" aria-label={$t('Prüfsumme kopieren')} onClick={() => void navigator.clipboard?.writeText(sum.hex).then(() => showToast($t('Prüfsumme kopiert.'), 'ok'))}><Copy size={13} strokeWidth={1.75} /></button>
        </span>
      )}
    </div>
  );
}

export function ChecksumDialog({ side, name }: { side: PaneSide; name: string }) {
  const tab = activeTab();
  const other: PaneSide = side === 'local' ? 'remote' : 'local';
  const path = join(panePath(side), name);
  const otherPath = join(panePath(other), name);
  const counterpart = tab ? listEntries(...paneLoc(other, tab), panePath(other))?.find((e) => e.name === name && e.kind === 'file') : undefined;
  const [mine, setMine] = useState<Sum>({ state: 'busy' });
  const [theirs, setTheirs] = useState<Sum>({ state: 'busy' });

  useEffect(() => {
    if (!tab) return;
    const run = (s: PaneSide, p: string, set: (v: Sum) => void) => {
      const [ls, sid] = paneLoc(s, tab);
      const job = LIVE ? (ls === 'local' ? backend.localChecksum(p) : backend.remoteChecksum(sid, p)) : fakeSum(basename(p));
      job.then((hex) => set({ state: 'ok', hex }), (e) => set({ state: 'error', text: toBackendError(e).message }));
    };
    run(side, path, setMine);
    if (counterpart) run(other, otherPath, setTheirs);
    // Computed once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const same = mine.state === 'ok' && theirs.state === 'ok' ? mine.hex === theirs.hex : undefined;
  const label = (s: PaneSide) => {
    const [ls, sid] = paneLoc(s, tab);
    return ls === 'local' ? $t('Dieser Computer') : tab?.leftServerId ? serverById(sid)?.name ?? $t('Server') : $t('Server');
  };
  return (
    <Dialog label={$t('Prüfsumme')} title={$t('Prüfsumme von „{0}“', name)} subtitle={$t('SHA-256. Gleiche Prüfsumme heißt gleicher Inhalt.')} width={620}
      footer={<><span className="flex-1" /><Button variant="primary" onClick={closeDialog}>{$t('Fertig')}</Button></>}>
      <div className="form-stack">
        <SumLine label={label(side)} path={path} sum={mine} />
        {counterpart && <SumLine label={label(other)} path={otherPath} sum={theirs} />}
        {same === true && <p className="row-inline tone-ok"><Check size={15} strokeWidth={2.2} aria-hidden="true" />{$t('Beide Dateien haben denselben Inhalt.')}</p>}
        {same === false && <p className="row-inline tone-warn"><X size={15} strokeWidth={2.2} aria-hidden="true" />{$t('Die Inhalte unterscheiden sich.')}</p>}
      </div>
    </Dialog>
  );
}

export function SymlinkDialog({ target: initial }: { target: string }) {
  const tab = activeTab();
  const dir = panePath('remote');
  const [target, setTarget] = useState(initial);
  const [name, setName] = useState(initial ? $t('{0} Link', basename(initial)) : '');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!tab || !name.trim() || !target.trim()) return;
    if (!LIVE) { showToast($t('Verknüpfung „{0}“ angelegt (Prototyp).', name), 'ok'); closeDialog(); return; }
    setBusy(true);
    try {
      await backend.remoteSymlink(tab.serverId, join(dir, name.trim()), target.trim());
      invalidateRemote(tab.serverId, dir);
      showToast($t('Verknüpfung „{0}“ zeigt auf {1}.', name.trim(), target.trim()), 'ok');
      closeDialog();
    } catch (e) {
      showToast(toBackendError(e).message, 'error');
      setBusy(false);
    }
  };
  return (
    <Dialog label={$t('Symbolischen Link erstellen')} title={$t('Symbolischen Link erstellen')} subtitle={$t('Im Ordner {0} auf dem Server. Der Link verweist auf eine andere Datei oder einen Ordner.', dir)} width={560}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={busy || !name.trim() || !target.trim()} onClick={() => void create()}>{$t('Erstellen')}</Button></>}>
      <div className="form-grid">
        <label htmlFor="ln-name">{$t('Name')}</label>
        <TextField id="ln-name" value={name} onChange={setName} autoFocus mono onEnter={() => void create()} />
        <label htmlFor="ln-target">{$t('Ziel')}</label>
        <TextField id="ln-target" value={target} onChange={setTarget} mono placeholder={parent(dir)} onEnter={() => void create()} />
      </div>
    </Dialog>
  );
}

/** "Bearbeitete Dateien": server files open in an editor; each save uploads them. */
export function EditsDialog() {
  const edits = useStore((s) => s.edits);
  const servers = useStore((s) => s.servers);
  const now = useStore((s) => s.now);
  return (
    <Dialog label={$t('Bearbeitete Dateien')} title={$t('Bearbeitete Dateien')} subtitle={$t('Server-Dateien, die im Editor offen sind. Jedes Sichern lädt sie wieder hoch, bis du das Bearbeiten beendest.')} width={720} maxHeight={600}
      footer={<><span className="flex-1" /><Button variant="primary" onClick={closeDialog}>{$t('Fertig')}</Button></>}>
      {!edits.length && <p className="muted">{$t('Gerade ist keine Server-Datei im Editor offen. Mit „Im Editor öffnen“ auf einer Server-Datei beginnt es.')}</p>}
      {edits.length > 0 && (
        <div className="edit-list">
          {edits.map((e) => (
            <div key={e.localPath} className="edit-row">
              <span className="col-text flex-1 min-w-0">
                <span className="strong-500 ellipsis">{basename(e.remotePath)}</span>
                <span className="small muted mono ellipsis" title={e.remotePath}>{servers.find((x) => x.id === e.serverId)?.name ?? '?'} · {e.remotePath}</span>
                <span className="small muted">{e.lastUpload ? $t('zuletzt hochgeladen {0}', formatAgo(e.lastUpload, now)) : $t('seit dem Öffnen nicht gesichert')}</span>
              </span>
              <Button small onClick={() => reopenEditing(e.localPath)}>{$t('Im Editor zeigen')}</Button>
              <Button small onClick={() => uploadEditingNow(e.localPath)}>{$t('Jetzt hochladen')}</Button>
              <Button small variant="ghost" onClick={() => void stopEditing(e.localPath)}>{$t('Beenden')}</Button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
