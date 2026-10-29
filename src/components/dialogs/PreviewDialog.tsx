/**
 * Preview window (space bar on a file, like Quick Look): shows the selected
 * file; arrow keys move to the next or previous file, space or Escape close.
 */
import { Loader2 } from '../glyphs';
import { useEffect } from 'react';
import type { PaneSide } from '../../backend/types';
import { activeTab, closeDialog, moveCursor, paneEntries, panePath, useStore, paneLoc } from '../../state/store';
import { formatDate, formatSize } from '../../util/format';
import { join } from '../../util/paths';
import { PreviewView, usePreview } from '../preview';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function PreviewDialog({ side }: { side: PaneSide }) {
  const sel = useStore((s) => s.selection[side]);
  useStore((s) => s.fsRev);
  const tab = activeTab();
  const entries = paneEntries(side);
  const entry = entries[sel.cursor] ?? entries.find((e) => e.name === sel.names[0]);
  const path = entry && entry.kind === 'file' ? join(panePath(side), entry.name) : null;
  const { preview, error } = usePreview(...paneLoc(side, tab), path, true);

  useEffect(() => {
    // The space press that opened the preview is still on its way; ignore it.
    const openedAt = performance.now();
    const onKey = (e: KeyboardEvent) => {
      if (e.timeStamp <= openedAt) return;
      if (e.key === ' ') { e.preventDefault(); closeDialog(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveCursor(side, e.key === 'ArrowDown' ? 1 : -1, false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [side]);

  return (
    <Dialog label={$t('Vorschau')} title={entry?.name ?? $t('Vorschau')} subtitle={entry ? `${formatSize(entry.size)} · ${formatDate(entry.mtime)}` : undefined} width={860} maxHeight={720} className="preview-dialog">
      <div className="preview-body">
        {!path && <p className="muted">{entry?.kind === 'dir' ? $t('Ordner haben keine Vorschau.') : $t('Keine Datei ausgewählt.')}</p>}
        {path && !preview && !error && <span className="row-inline muted"><Loader2 size={14} className="spin" aria-hidden="true" />{$t('Wird geladen …')}</span>}
        {error && <p className="tone-danger">{error}</p>}
        {preview && <PreviewView preview={preview} />}
      </div>
    </Dialog>
  );
}
