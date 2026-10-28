/**
 * Info column on the right ("Informationen", ⌘I / Strg+I). Closed by default.
 * Shows the selected file with preview tile, details, watch relation and the
 * Unix permissions as a checkbox grid that can be changed directly.
 */
import type { PaneSide } from '../backend/types';
import { activeTab, copyPath, openDialog, openInEditor, panePath, savePerms, statEntry, useStore, watchForLocal, paneLoc } from '../state/store';
import { PreviewView, usePreview } from './preview';
import { join } from '../util/paths';
import { describeFile, extLabel, formatDate, formatSize } from '../util/format';
import { FolderGlyph } from './icons';
import { Button } from './ui';
import { $t } from '../i18n';

const who = [$t('Besitzer'), $t('Gruppe'), $t('Andere')];
const what = [$t('lesen'), $t('schreiben'), $t('ausführen')];

/** Start of the selected file (separate component so the hook runs unconditionally). */
function InspectorPreview({ side, serverId, path }: { side: PaneSide; serverId: string; path: string }) {
  const { preview } = usePreview(side, serverId, path);
  if (!preview || preview.kind === 'binary') return null;
  return <div className="insp-preview-box"><PreviewView preview={preview} maxLines={14} /></div>;
}

export function Inspector() {
  const focus = useStore((s) => s.focusSide);
  const sel = useStore((s) => s.selection[focus]);
  const tab = useStore((s) => activeTab(s));
  const watches = useStore((s) => s.watches);
  useStore((s) => s.fsRev);
  if (!tab) return null;

  const dir = panePath(focus);
  const name = sel.names[0];
  const path = name ? join(dir, name) : dir;
  const [ls, sid] = paneLoc(focus, tab);
  const entry = statEntry(ls, sid, path);
  const multi = sel.names.length > 1;

  if (!entry) {
    return <aside className="inspector" aria-label={$t('Informationen')}><p className="muted small">{$t('Nichts ausgewählt.')}</p></aside>;
  }

  // Watch comparison only between this computer and the tab's server.
  const watch = tab.leftServerId ? undefined : focus === 'local' ? watchForLocal(path) : watches.find((w) => w.serverId === tab.serverId && (path === w.remotePath || path.startsWith(w.remotePath + '/')));
  const other = (() => {
    if (!watch) return null;
    const rel = focus === 'local' ? path.slice(watch.localPath.length) : path.slice(watch.remotePath.length);
    const otherPath = (focus === 'local' ? watch.remotePath : watch.localPath) + rel;
    const o = statEntry(focus === 'local' ? 'remote' : 'local', tab.serverId, otherPath);
    if (!o) return { text: focus === 'local' ? $t('noch nicht auf dem Server') : $t('nur auf dem Server'), tone: 'muted' };
    if (o.kind === 'dir' || (o.size === entry.size && Math.abs(o.mtime - entry.mtime) < 120000)) return { text: focus === 'local' ? $t('gleich wie lokal') : $t('gleich wie auf dem Server'), tone: 'ok' };
    return o.mtime > entry.mtime ? { text: focus === 'local' ? $t('Server-Datei ist neuer') : $t('neuer als lokal'), tone: 'warn' } : { text: focus === 'local' ? $t('lokal neuer, wird hochgeladen') : $t('älter als lokal'), tone: 'accent' };
  })();

  const bits = entry.perms.split('').map((d) => Number(d));
  const toggleBit = (row: number, col: number) => {
    const mask = [4, 2, 1][col];
    const next = bits.map((v, i) => (i === row ? v ^ mask : v)).join('');
    savePerms(focus, path, next, entry.owner, entry.group, false);
  };

  return (
    <aside className="inspector" aria-label={$t('Informationen')}>
      <div className="insp-preview">
        <span className="insp-tile">{entry.kind === 'dir' ? <FolderGlyph size={40} /> : <span className="mono tone-accent">{extLabel(entry.name)}</span>}</span>
        <span className="title-text ellipsis">{multi ? $t('{0} Objekte', sel.names.length) : entry.name}</span>
        <span className="small muted">{multi ? $t('mehrere ausgewählt') : `${describeFile(entry.name, entry.kind)}${entry.kind === 'file' ? ` · ${formatSize(entry.size)}` : ''}`}</span>
      </div>
      <dl className="insp-grid">
        <dt>{$t('Geändert')}</dt><dd>{formatDate(entry.mtime)}</dd>
        <dt>{$t('Ort')}</dt><dd className="ellipsis" title={dir}>{dir}</dd>
        <dt>{$t('Besitzer')}</dt><dd>{entry.owner}:{entry.group}</dd>
        {watch && <><dt>{$t('Überwachung')}</dt><dd className="tone-accent">{watch.name}</dd></>}
        {other && <><dt>{focus === 'local' ? $t('Server') : $t('Lokal')}</dt><dd><span className={`state-dot tone-bg-${other.tone}`} />{other.text}</dd></>}
      </dl>
      {!multi && entry.kind === 'file' && <InspectorPreview side={ls} serverId={sid} path={path} />}
      <div className="insp-sep" />
      <div className="insp-perms">
        <div className="insp-perms-head"><span className="strong">{$t('Rechte')}</span><span className="mono muted">{entry.perms}</span></div>
        <div className="perm-grid" role="group" aria-label={$t('Rechte')}>
          <span /><span className="muted center">L</span><span className="muted center">S</span><span className="muted center">A</span>
          {who.map((w, r) => (
            <span key={w} className="contents">
              <span className="text-2">{w}</span>
              {what.map((x, c) => {
                const on = (bits[r] & [4, 2, 1][c]) !== 0;
                return (
                  <button key={x} type="button" role="checkbox" aria-checked={on} aria-label={`${w} ${x}`} className="perm-hit" disabled={multi} onClick={() => toggleBit(r, c)}>
                    <span className={`checkbox-box${on ? ' is-on' : ''}`}>{on && <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.6"><path d="m3.5 8.5 3 3 6-7" /></svg>}</span>
                  </button>
                );
              })}
            </span>
          ))}
        </div>
        <button type="button" className="link small" onClick={() => openDialog({ type: 'perms', side: focus, path })}>{$t('Besitzer und Unterordner …')}</button>
      </div>
      <span className="flex-1" />
      <div className="insp-actions">
        {entry.kind === 'file' && !multi && <Button onClick={() => openInEditor(focus, name ?? entry.name)}>{$t('Im Editor öffnen')}</Button>}
        <Button onClick={() => copyPath(focus, multi ? undefined : name)}>{$t('Pfad kopieren')}</Button>
      </div>
    </aside>
  );
}
