/**
 * Small file tools: checksum (MD5, SHA-1, SHA-256 or SHA-512, compared with
 * the file of the same name in the other half and with a value pasted by the
 * user, e.g. from the download page) and creating a symbolic link on the server.
 */
import { Check, Copy, Loader2, X } from '../glyphs';
import { useEffect, useState } from 'react';
import { toBackendError, type ChecksumAlgo } from '../../backend/api';
import { tauriBackend as backend } from '../../backend/tauriBackend';
import type { PaneSide } from '../../backend/types';
import { reopenEditing, stopEditing, uploadEditingNow } from '../../state/live';
import { activeTab, closeDialog, getState, invalidateRemote, LIVE, listEntries, panePath, showToast, updateSettings, useStore, paneLoc, serverById, editWith } from '../../state/store';
import { formatAgo } from '../../util/format';
import { basename, join, parent } from '../../util/paths';
import { Button, Checkbox, Segmented, TextField } from '../ui';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialogPicker } from '@tauri-apps/plugin-dialog';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

type Sum = { state: 'busy' } | { state: 'ok'; hex: string } | { state: 'error'; text: string };

const ALGOS: Array<{ value: ChecksumAlgo; label: string }> = [
  { value: 'md5', label: 'MD5' }, { value: 'sha1', label: 'SHA-1' }, { value: 'sha256', label: 'SHA-256' }, { value: 'sha512', label: 'SHA-512' },
];
const HEX_LEN: Record<ChecksumAlgo, number> = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };

/** Demo value for the browser prototype (right length for the algorithm). */
async function fakeSum(seed: string, algo: ChecksumAlgo): Promise<string> {
  const data = new TextEncoder().encode(seed);
  const digest = await crypto.subtle.digest('SHA-512', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, HEX_LEN[algo]);
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
  const [algo, setAlgo] = useState<ChecksumAlgo>(() => getState().settings.checksumAlgo ?? 'sha256');
  const [mine, setMine] = useState<Sum>({ state: 'busy' });
  const [theirs, setTheirs] = useState<Sum>({ state: 'busy' });
  const [expected, setExpected] = useState('');

  useEffect(() => {
    if (!tab) return;
    let current = true;
    const run = (s: PaneSide, p: string, set: (v: Sum) => void) => {
      set({ state: 'busy' });
      const [ls, sid] = paneLoc(s, tab);
      const job = LIVE ? (ls === 'local' ? backend.localChecksum(p, algo) : backend.remoteChecksum(sid, p, algo)) : fakeSum(basename(p), algo);
      job.then((hex) => current && set({ state: 'ok', hex }), (e) => current && set({ state: 'error', text: toBackendError(e).message }));
    };
    run(side, path, setMine);
    if (counterpart) run(other, otherPath, setTheirs);
    return () => { current = false; };
    // Computed when the dialog opens and when the algorithm changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [algo]);

  const pickAlgo = (a: ChecksumAlgo) => {
    setAlgo(a);
    updateSettings({ checksumAlgo: a });
  };
  // A pasted value decides the algorithm by its length (32 = MD5, 40 = SHA-1 ...).
  const pasted = expected.trim().toLowerCase().replace(/\s+/g, '');
  const pastedAlgo = (Object.keys(HEX_LEN) as ChecksumAlgo[]).find((a) => HEX_LEN[a] === pasted.length && /^[0-9a-f]+$/.test(pasted));
  useEffect(() => {
    if (pastedAlgo && pastedAlgo !== algo) pickAlgo(pastedAlgo);
    // Only when the pasted value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastedAlgo]);

  const same = mine.state === 'ok' && theirs.state === 'ok' ? mine.hex === theirs.hex : undefined;
  const matchesPasted = pasted && mine.state === 'ok' && pastedAlgo === algo ? mine.hex === pasted : undefined;
  const label = (s: PaneSide) => {
    const [ls, sid] = paneLoc(s, tab);
    return ls === 'local' ? $t('Dieser Computer') : tab?.leftServerId ? serverById(sid)?.name ?? $t('Server') : $t('Server');
  };
  return (
    <Dialog label={$t('Prüfsumme')} title={$t('Prüfsumme von „{0}“', name)} subtitle={$t('Gleiche Prüfsumme heißt gleicher Inhalt.')} width={660}
      footer={<><span className="flex-1" /><Button variant="primary" onClick={closeDialog}>{$t('Fertig')}</Button></>}>
      <div className="form-stack">
        <Segmented<ChecksumAlgo> label={$t('Verfahren')} value={algo} onChange={pickAlgo} options={ALGOS} />
        <SumLine label={label(side)} path={path} sum={mine} />
        {counterpart && <SumLine label={label(other)} path={otherPath} sum={theirs} />}
        {same === true && <p className="row-inline tone-ok"><Check size={15} strokeWidth={2.2} aria-hidden="true" />{$t('Beide Dateien haben denselben Inhalt.')}</p>}
        {same === false && <p className="row-inline tone-warn"><X size={15} strokeWidth={2.2} aria-hidden="true" />{$t('Die Inhalte unterscheiden sich.')}</p>}
        <div className="col-text">
          <TextField label={$t('Erwarteten Wert einfügen')} value={expected} onChange={setExpected} mono placeholder={$t('Erwarteten Wert einfügen, z. B. von der Download-Seite')} />
          {pasted && !pastedAlgo && <span className="small muted">{$t('Das sieht nicht nach einer Prüfsumme aus (MD5: 32, SHA-1: 40, SHA-256: 64, SHA-512: 128 Zeichen).')}</span>}
          {matchesPasted === true && <span className="row-inline small tone-ok"><Check size={14} strokeWidth={2.2} aria-hidden="true" />{$t('Stimmt mit dem eingefügten Wert überein.')}</span>}
          {matchesPasted === false && <span className="row-inline small tone-warn"><X size={14} strokeWidth={2.2} aria-hidden="true" />{$t('Weicht vom eingefügten Wert ab.')}</span>}
        </div>
      </div>
    </Dialog>
  );
}

/** Durations offered for an S3 link (SigV4 allows at most seven days). */
const LINK_TIMES: Array<{ value: string; label: string }> = [
  { value: '3600', label: $t('1 Stunde') }, { value: '86400', label: $t('1 Tag') }, { value: '259200', label: $t('3 Tage') }, { value: '604800', label: $t('7 Tage') },
];

/**
 * "Link mit Ablaufdatum" (Transmit "Copy Signed URL", Cyberduck): an S3 file
 * can be downloaded by anyone with the link until it expires. Nothing is
 * stored on the service; the link is signed here with the access key.
 */
export function PresignDialog({ side, name }: { side: PaneSide; name: string }) {
  const tab = activeTab();
  const path = join(panePath(side), name);
  const [secs, setSecs] = useState(() => String(getState().settings.presignSecs ?? 86400));
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!tab) return;
    let current = true;
    setLink('');
    setError('');
    const [, sid] = paneLoc(side, tab);
    const job = LIVE ? backend.remotePresign(sid, path, Number(secs)) : Promise.resolve(`https://bucket.s3.example.com${path}?X-Amz-Expires=${secs}&X-Amz-Signature=…`);
    job.then((l) => current && setLink(l), (e) => current && setError(toBackendError(e).message));
    return () => { current = false; };
    // Signed again whenever the duration changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secs]);
  const until = new Date(Date.now() + Number(secs) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const copy = () => void navigator.clipboard?.writeText(link).then(() => { showToast($t('Link kopiert.'), 'ok'); closeDialog(); });
  return (
    <Dialog label={$t('Link mit Ablaufdatum')} title={$t('Link für „{0}“', name)} subtitle={$t('Jeder mit diesem Link kann die Datei herunterladen, bis er abläuft. Danach funktioniert er nicht mehr.')} width={620}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!link} onClick={copy}>{$t('Link kopieren')}</Button></>}>
      <div className="form-stack">
        <Segmented label={$t('Gültig für')} value={secs} onChange={(v) => { setSecs(v); updateSettings({ presignSecs: Number(v) }); }} options={LINK_TIMES} />
        <span className="small muted">{$t('Gültig bis {0}', until)}</span>
        {!link && !error && <span className="row-inline muted small"><Loader2 size={13} className="spin" aria-hidden="true" />{$t('Wird erstellt …')}</span>}
        {error && <span className="small tone-danger">{error}</span>}
        {link && <code className="mono break small presign-link">{link}</code>}
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
  const appName = (p: string) => p.split('/').pop()?.replace(/\.(app|exe)$/i, '') ?? p;
  const known = [...new Set([s.editorApp, ...Object.values(s.editorByExt)].filter(Boolean))];
  const choose = (app: string | null) => {
    if (remember && ext) {
      const next = { ...s.editorByExt };
      if (app) next[ext] = app; else delete next[ext];
      updateSettings({ editorByExt: next });
    }
    editWith(side, name, app);
  };
  const other = async () => {
    if (!LIVE) { choose(mac ? '/Applications/Visual Studio Code.app' : 'C:/Program Files/Microsoft VS Code/Code.exe'); return; }
    const picked = await openDialogPicker({
      multiple: false, directory: false, title: $t('Programm wählen'), defaultPath: mac ? '/Applications' : undefined,
      filters: mac ? [{ name: 'Programme', extensions: ['app'] }] : [{ name: 'Programme', extensions: ['exe'] }],
    }).catch(() => null);
    if (typeof picked === 'string') choose(await invoke<string>('path_to_ui', { path: picked }));
  };
  const options: Array<{ key: string; label: string; sub?: string; run: () => void }> = [
    { key: 'builtin', label: $t('Editor von Bitcrane'), run: () => choose(null) },
    ...known.map((p) => ({ key: p, label: appName(p), sub: p, run: () => choose(p) })),
    { key: 'system', label: $t('Standardprogramm des Systems'), run: () => choose('') },
  ];
  return (
    <Dialog label={$t('Bearbeiten mit')} title={$t('„{0}“ bearbeiten mit …', name)} width={460}
      footer={<><Button onClick={() => void other()}>{$t('Anderes Programm …')}</Button><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button></>}>
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
