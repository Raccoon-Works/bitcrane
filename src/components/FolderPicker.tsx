/**
 * Folder choosers used inside dialogs (they cannot open a second dialog):
 * - `FolderPicker`: browse local or server folders and pick one
 *   ("Durchsuchen …" for the server folder of a watch),
 * - `SubfolderChooser`: tick the subfolders a watch should cover
 *   ("Nur ausgewählte Unterordner").
 */
import { ChevronRight, CornerLeftUp, Loader2 } from './glyphs';
import { useEffect, useState } from 'react';
import * as fs from '../backend/mockFs';
import { tauriBackend as backend } from '../backend/tauriBackend';
import { toBackendError } from '../backend/api';
import type { FileEntry, PaneSide } from '../backend/types';
import { LIVE } from '../state/store';
import { crumbs, join, parent } from '../util/paths';
import { FolderGlyph } from './icons';
import { Button, Checkbox } from './ui';
import { $t } from '../i18n';

async function listFolders(side: PaneSide, serverId: string, path: string): Promise<FileEntry[]> {
  const all = LIVE
    ? side === 'local' ? await backend.localList(path) : await backend.remoteList(serverId, path)
    : fs.list(side, serverId, path);
  return all.filter((e) => e.kind === 'dir');
}

export function FolderPicker({ side, serverId, start, homeName, onPick, onClose }: {
  side: PaneSide;
  serverId: string;
  start: string;
  homeName: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(start || (side === 'local' ? '~' : '/'));
  const [folders, setFolders] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setFolders(null);
    setError('');
    listFolders(side, serverId, path)
      .then((f) => { if (!cancelled) setFolders(f); })
      .catch((e) => { if (!cancelled) { setError(toBackendError(e).message); setFolders([]); } });
    return () => { cancelled = true; };
  }, [side, serverId, path]);

  const up = parent(path);
  return (
    <div className="folder-picker" role="group" aria-label={$t('Ordner wählen')}>
      <div className="folder-picker-head">
        <Button small variant="ghost" onClick={() => setPath(up)} disabled={up === path} aria-label={$t('Übergeordneter Ordner')}><CornerLeftUp size={13} strokeWidth={1.75} /></Button>
        <span className="crumbs small">
          {crumbs(path, homeName).map((c, i, arr) => (
            <span key={c.path} className="crumb-wrap">
              <button type="button" className={`crumb${i === arr.length - 1 ? ' is-last' : ''}`} onClick={() => setPath(c.path)}>{c.name}</button>
              {i < arr.length - 1 && <span className="crumb-sep" aria-hidden="true">/</span>}
            </span>
          ))}
        </span>
      </div>
      <div className="folder-picker-list" role="listbox" aria-label={$t('Ordner')}>
        {folders === null && <span className="row-inline small muted folder-picker-note"><Loader2 size={13} className="spin" aria-hidden="true" />{$t('Wird gelesen …')}</span>}
        {error && <span className="small tone-danger folder-picker-note">{error}</span>}
        {folders && !error && !folders.length && <span className="small muted folder-picker-note">{$t('Keine Unterordner.')}</span>}
        {folders?.map((f) => (
          <button key={f.name} type="button" role="option" aria-selected={false} className="folder-picker-row" onDoubleClick={() => setPath(join(path, f.name))} onClick={() => setPath(join(path, f.name))}>
            <FolderGlyph size={16} /><span className="ellipsis flex-1">{f.name}</span><ChevronRight size={12} strokeWidth={2} className="muted" aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="folder-picker-foot">
        <span className="small muted mono ellipsis flex-1">{path}</span>
        <Button small onClick={onClose}>{$t('Abbrechen')}</Button>
        <Button small variant="primary" onClick={() => onPick(path)}>{$t('Diesen Ordner wählen')}</Button>
      </div>
    </div>
  );
}

/** One level of the subfolder tree, loaded when expanded. */
function SubfolderLevel({ root, rel, selected, onToggle }: { root: string; rel: string; selected: string[]; onToggle: (rel: string) => void }) {
  const [folders, setFolders] = useState<FileEntry[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    listFolders('local', '', rel ? join(root, rel) : root).then(setFolders).catch(() => setFolders([]));
  }, [root, rel]);
  if (folders === null) return <span className="row-inline small muted"><Loader2 size={13} className="spin" aria-hidden="true" />{$t('Wird gelesen …')}</span>;
  if (!folders.length && !rel) return <span className="small muted">{$t('Dieser Ordner hat keine Unterordner.')}</span>;
  return (
    <ul className="subfolder-list">
      {folders.map((f) => {
        const r = rel ? `${rel}/${f.name}` : f.name;
        const covered = selected.some((x) => r.startsWith(x + '/'));
        return (
          <li key={r}>
            <span className="row-inline">
              <button type="button" className="icon-btn-sm" aria-label={open[r] ? $t('Zuklappen') : $t('Aufklappen')} aria-expanded={!!open[r]} onClick={() => setOpen({ ...open, [r]: !open[r] })}>
                <ChevronRight size={12} strokeWidth={2} className={`chev${open[r] ? ' is-open' : ''}`} />
              </button>
              <Checkbox checked={covered || selected.includes(r)} disabled={covered} onChange={() => onToggle(r)} label={f.name} />
            </span>
            {open[r] && <SubfolderLevel root={root} rel={r} selected={selected} onToggle={onToggle} />}
          </li>
        );
      })}
    </ul>
  );
}

export function SubfolderChooser({ root, selected, onChange }: { root: string; selected: string[]; onChange: (v: string[]) => void }) {
  const toggle = (rel: string) => {
    if (selected.includes(rel)) onChange(selected.filter((x) => x !== rel));
    // Selecting a folder replaces selections inside it (they are covered anyway).
    else onChange([...selected.filter((x) => !x.startsWith(rel + '/')), rel]);
  };
  return (
    <div className="subfolder-chooser">
      <SubfolderLevel root={root} rel="" selected={selected} onToggle={toggle} />
      {!selected.length && <span className="small tone-warn">{$t('Noch kein Unterordner gewählt: Die Überwachung lädt dann nichts hoch.')}</span>}
    </div>
  );
}
