/**
 * Files with a Finder tag (Mac), found through Spotlight like a click on a tag
 * in the Finder's sidebar. A double click (or Enter) shows the file in the
 * active half of this computer.
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { $t } from '../../i18n';
import { closeDialog, getState, LIVE, revealSearchResult } from '../../state/store';
import { tagCss } from '../../state/tags';
import { formatDate, formatSize } from '../../util/format';
import { FileGlyph, FolderGlyph } from '../icons';
import { Button } from '../ui';
import { Dialog } from './Dialog';

interface Tagged { path: string; size: number; mtime: number; dir: boolean }

export function TagFiles({ name, color }: { name: string; color: number }) {
  const [items, setItems] = useState<Tagged[] | null>(LIVE ? null : []);
  useEffect(() => {
    if (!LIVE) return;
    let live = true;
    void invoke<Tagged[]>('local_tag_find', { name }).then((r) => { if (live) setItems(r); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [name]);
  const reveal = (path: string) => {
    closeDialog();
    // Files of this computer open in a half that shows this computer.
    const t = getState().tabs.find((x) => x.id === getState().activeTabId);
    const side = getState().focusSide === 'remote' && t?.rightLocal && !t.serverId ? 'remote' : 'local';
    revealSearchResult(side, path);
  };
  return (
    <Dialog
      label={$t('Tag')}
      title={<span className="row-inline"><span className="tag-dot side-tag" style={{ background: tagCss(color) }} />{name}</span>}
      subtitle={items ? $t('{0} Objekte mit diesem Tag', items.length) : $t('Wird gesucht …')}
      width={620}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Schließen')}</Button></>}
    >
      {items && items.length === 0 && <p className="muted">{LIVE ? $t('Keine Dateien mit diesem Tag gefunden.') : $t('Die Suche nach Tags geht im echten Programm.')}</p>}
      {items && items.length > 0 && (
        <div className="recent-list tag-files">
          {items.map((it) => {
            const base = it.path.split('/').pop() ?? it.path;
            return (
              <button key={it.path} type="button" className="recent-item tag-file" onDoubleClick={() => reveal(it.path)} onKeyDown={(e) => { if (e.key === 'Enter') reveal(it.path); }} title={it.path}>
                {it.dir ? <FolderGlyph size={18} /> : <FileGlyph size={18} name={base} />}
                <span className="tag-file-name"><span className="ellipsis">{base}</span><span className="small muted ellipsis">{it.path.slice(0, -base.length - 1)}</span></span>
                <span className="small muted nowrap">{it.dir ? '' : formatSize(it.size)}</span>
                <span className="small muted nowrap">{formatDate(it.mtime)}</span>
              </button>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
