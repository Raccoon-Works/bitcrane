/**
 * Checksum (MD5, SHA-1, SHA-256 or SHA-512) of a file, compared with the file
 * of the same name in the other half and with a value pasted by the user,
 * e.g. from the download page.
 */
import { Check, Copy, Loader2, X } from '../glyphs';
import { useEffect, useState } from 'react';
import { toBackendError, type ChecksumAlgo } from '../../backend/api';
import type { PaneSide } from '../../backend/types';
import {
  activeTab,
  algoOfSum,
  checksum,
  cleanSum,
  closeDialog,
  getState,
  listEntries,
  panePath,
  paneLoc,
  serverById,
  showToast,
  updateSettings,
} from '../../state/store';
import { join } from '../../util/paths';
import { Button, Segmented, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

type Sum = { state: 'busy' } | { state: 'ok'; hex: string } | { state: 'error'; text: string };

const ALGOS: Array<{ value: ChecksumAlgo; label: string }> = [
  { value: 'md5', label: 'MD5' },
  { value: 'sha1', label: 'SHA-1' },
  { value: 'sha256', label: 'SHA-256' },
  { value: 'sha512', label: 'SHA-512' },
];

/** A file whose checksum the dialog shows: where it is and its path. */
interface SumFile {
  loc: [PaneSide, string];
  path: string;
}

function SumLine({ label, path, sum }: { label: string; path: string; sum: Sum }) {
  return (
    <div className="sum-line">
      <span className="caption-strong">{label}</span>
      <span className="small muted mono ellipsis" title={path}>
        {path}
      </span>
      {sum.state === 'busy' && (
        <span className="row-inline muted small">
          <Loader2 size={13} className="spin" aria-hidden="true" />
          {$t('Wird berechnet …')}
        </span>
      )}
      {sum.state === 'error' && <span className="small tone-danger">{sum.text}</span>}
      {sum.state === 'ok' && (
        <span className="row-inline">
          <code className="mono break sum-hex">{sum.hex}</code>
          <button
            type="button"
            className="icon-btn"
            aria-label={$t('Prüfsumme kopieren')}
            onClick={() =>
              void navigator.clipboard.writeText(sum.hex).then(() => showToast($t('Prüfsumme kopiert.'), 'ok'))
            }
          >
            <Copy size={13} strokeWidth={1.75} />
          </button>
        </span>
      )}
    </div>
  );
}

export function ChecksumDialog({ side, name }: { side: PaneSide; name: string }) {
  const tab = activeTab();
  const other: PaneSide = side === 'local' ? 'remote' : 'local';
  // The file chosen when the dialog opened, and the file of the same name in the other half then.
  const [files] = useState(() => {
    if (!tab) return null;
    const mine: SumFile = { loc: paneLoc(side, tab), path: join(panePath(side), name) };
    const counterpart = listEntries(...paneLoc(other, tab), panePath(other))?.find(
      (e) => e.name === name && e.kind === 'file',
    );
    const theirs: SumFile | undefined = counterpart && { loc: paneLoc(other, tab), path: join(panePath(other), name) };
    return { mine, theirs };
  });
  const [algo, setAlgo] = useState<ChecksumAlgo>(() => getState().settings.checksumAlgo ?? 'sha256');
  const [mine, setMine] = useState<Sum>({ state: 'busy' });
  const [theirs, setTheirs] = useState<Sum>({ state: 'busy' });
  const [expected, setExpected] = useState('');

  useEffect(() => {
    if (!files) return;
    let current = true;
    const run = ({ loc, path }: SumFile, set: (v: Sum) => void) => {
      set({ state: 'busy' });
      checksum(loc, path, algo).then(
        (hex) => current && set({ state: 'ok', hex }),
        (e) => current && set({ state: 'error', text: toBackendError(e).message }),
      );
    };
    run(files.mine, setMine);
    if (files.theirs) run(files.theirs, setTheirs);
    return () => {
      current = false;
    };
  }, [files, algo]);

  const pickAlgo = (a: ChecksumAlgo) => {
    setAlgo(a);
    updateSettings({ checksumAlgo: a });
  };
  // A pasted value decides the algorithm, once when it becomes a value of another length.
  const pasteExpected = (value: string) => {
    const before = algoOfSum(expected);
    const after = algoOfSum(value);
    setExpected(value);
    if (after && after !== before && after !== algo) pickAlgo(after);
  };
  const pasted = cleanSum(expected);
  const pastedAlgo = algoOfSum(expected);

  const same = mine.state === 'ok' && theirs.state === 'ok' ? mine.hex === theirs.hex : undefined;
  const matchesPasted = pasted && mine.state === 'ok' && pastedAlgo === algo ? mine.hex === pasted : undefined;
  const label = (s: PaneSide) => {
    const [ls, sid] = paneLoc(s, tab);
    return ls === 'local'
      ? $t('Dieser Computer')
      : tab?.leftServerId
        ? (serverById(sid)?.name ?? $t('Server'))
        : $t('Server');
  };
  return (
    <Dialog
      label={$t('Prüfsumme')}
      title={$t('Prüfsumme von „{0}“', name)}
      subtitle={$t('Gleiche Prüfsumme heißt gleicher Inhalt.')}
      width={660}
      footer={
        <>
          <span className="flex-1" />
          <Button variant="primary" onClick={closeDialog}>
            {$t('Fertig')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <Segmented<ChecksumAlgo> label={$t('Verfahren')} value={algo} onChange={pickAlgo} options={ALGOS} />
        {files && <SumLine label={label(side)} path={files.mine.path} sum={mine} />}
        {files?.theirs && <SumLine label={label(other)} path={files.theirs.path} sum={theirs} />}
        {same === true && (
          <p className="row-inline tone-ok">
            <Check size={15} strokeWidth={2.2} aria-hidden="true" />
            {$t('Beide Dateien haben denselben Inhalt.')}
          </p>
        )}
        {same === false && (
          <p className="row-inline tone-warn">
            <X size={15} strokeWidth={2.2} aria-hidden="true" />
            {$t('Die Inhalte unterscheiden sich.')}
          </p>
        )}
        <div className="col-text">
          <TextField
            label={$t('Erwarteten Wert einfügen')}
            value={expected}
            onChange={pasteExpected}
            mono
            placeholder={$t('Erwarteten Wert einfügen, z. B. von der Download-Seite')}
          />
          {pasted && !pastedAlgo && (
            <span className="small muted">
              {$t('Das sieht nicht nach einer Prüfsumme aus (MD5: 32, SHA-1: 40, SHA-256: 64, SHA-512: 128 Zeichen).')}
            </span>
          )}
          {matchesPasted === true && (
            <span className="row-inline small tone-ok">
              <Check size={14} strokeWidth={2.2} aria-hidden="true" />
              {$t('Stimmt mit dem eingefügten Wert überein.')}
            </span>
          )}
          {matchesPasted === false && (
            <span className="row-inline small tone-warn">
              <X size={14} strokeWidth={2.2} aria-hidden="true" />
              {$t('Weicht vom eingefügten Wert ab.')}
            </span>
          )}
        </div>
      </div>
    </Dialog>
  );
}
