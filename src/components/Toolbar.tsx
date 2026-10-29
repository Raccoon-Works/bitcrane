/**
 * Toolbar of the main window: navigation, connection tabs (Mac), the watch
 * button in the middle, the customisable tool group and the search field.
 * On Windows the tabs live in the title bar instead (MainWindow.tsx).
 */
import {
  ArrowClockwise, ArrowsClockwise, Checks, Columns, Broadcast, CaretLeft, CaretRight, Command, Copy, DownloadSimple, EyeSlash, FolderSimplePlus, Info, LinkSimple, LockSimple, MagnifyingGlass, NotePencil, PencilSimple, Plugs, SquareHalfBottom, TerminalWindow, Trash, TreeStructure, UploadSimple,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import {
  activeTab, activityExpanded, askDelete, copyPath, disconnect, download, goBack, goForward, newFolder, openDialog,
  refresh, setSearch, startRename, toggleActivity, toggleHidden, toggleInspector, togglePopover,
  upload, useStore, type ToolId,
  getState, openInEditor, searchTarget, openTerminal, setDeepSearch, toggleSyncBrowse,
} from '../state/store';
import { formatAgo } from '../util/format';
import { useKeyLabel } from '../state/keys';
import { IconButton, Tooltip } from './ui';
import { WatchPopover } from './WatchPopover';
import { WinMoreMenu } from './AppMenu';
import { toggleCompareDirs } from '../state/tools';
import { $t } from '../i18n';

/** Platform-specific shortcut label. */
export function useKey() {
  const platform = useStore((s) => s.platform);
  return (mac: string, win: string) => (platform === 'mac' ? mac : win);
}

/**
 * Folder watches as a toolbar symbol with a small lamp (replaces the wide
 * pill): green while watches run, orange while one waits for its server,
 * grey when all are paused. A click opens the overview with all details.
 */
function WatchButton() {
  const watches = useStore((s) => s.watches);
  const open = useStore((s) => s.popoverOpen);
  const now = useStore((s) => s.now);
  const transfers = useStore((s) => s.transfers);
  const sk = useKeyLabel();
  const waiting = watches.find((w) => w.state === 'waiting');
  const active = watches.filter((w) => w.state === 'active');
  let tone = 'off';
  let text = $t('Keine Überwachung');
  if (waiting) {
    tone = 'warn';
    const n = transfers.filter((t) => t.watchId === waiting.id && (t.state === 'queued' || t.state === 'running')).length;
    text = $t('Wartet auf Verbindung: {0} {1}', n, n === 1 ? $t('Datei') : $t('Dateien'));
  } else if (active.length === 1) {
    tone = 'ok';
    text = `${active[0].name} · ${formatAgo(active[0].lastTime, now)}`;
  } else if (active.length > 1) {
    tone = 'ok';
    text = $t('{0} Überwachungen aktiv', active.length);
  } else if (watches.length) {
    text = watches.length === 1 ? $t('Überwachung pausiert') : $t('Alle pausiert');
  }
  return (
    <div className="pill-anchor watch-anchor">
      <Tooltip text={`${$t('Überwachungen')}: ${text}`} shortcut={sk('watchOverview')}>
        <button type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={`${$t('Überwachungen')}: ${text}`} className={`icon-btn watch-btn${open ? ' is-on' : ''}`} onClick={togglePopover}>
          <Broadcast size={20} weight="duotone" />
          <span className={`watch-lamp tone-${tone}`} aria-hidden="true" />
        </button>
      </Tooltip>
      {open && <WatchPopover />}
    </div>
  );
}

/** Kind of each tool: neighbours of the same kind share one capsule, so the bar reads in groups. */
const TOOL_KIND: Record<ToolId, string> = {
  nav: 'nav', upload: 'transfer', download: 'transfer', newFolder: 'files', refresh: 'files', rename: 'files', delete: 'files', editor: 'files', copyPath: 'files', selectMask: 'files',
  sync: 'compare', syncBrowse: 'compare', compareDirs: 'compare', info: 'view', activity: 'view', hidden: 'view', perms: 'view', terminal: 'more', disconnect: 'more', palette: 'more',
};

/** Splits the tools (in the user's order) into runs of the same kind. */
function toolRuns(tools: ToolId[]): ToolId[][] {
  const runs: ToolId[][] = [];
  for (const t of tools) {
    const last = runs[runs.length - 1];
    if (last && TOOL_KIND[last[0]] === TOOL_KIND[t]) last.push(t);
    else runs.push([t]);
  }
  return runs;
}

/** Icon and action for each customisable tool. */
export function useToolDefs(): Record<ToolId, { label: string; key?: string; icon: ReactNode; run: () => void; active?: boolean; disabled?: boolean }> {
  const sk = useKeyLabel();
  const key = useKey();
  const inspector = useStore((s) => s.inspectorOpen);
  const activity = useStore((s) => activityExpanded(s));
  const focus = useStore((s) => s.focusSide);
  const showHidden = useStore((s) => s.settings.showHidden);
  const tab = useStore((s) => activeTab(s));
  const selLocal = useStore((s) => s.selection.local.names.length);
  const selRemote = useStore((s) => s.selection.remote.names.length);
  const sel = focus === 'local' ? selLocal : selRemote;
  const compareOn = useStore((s) => s.compareDirs);
  const ic = (n: ReactNode) => n;
  return {
    nav: { label: $t('Zurück'), key: sk('back'), icon: ic(<CaretLeft size={19} />), run: goBack, disabled: !tab?.back.length },
    newFolder: { label: $t('Neuer Ordner'), key: sk('newFolder'), icon: ic(<FolderSimplePlus size={19} />), run: () => newFolder() },
    refresh: { label: $t('Aktualisieren'), key: sk('refresh'), icon: ic(<ArrowClockwise size={19} />), run: refresh },
    info: { label: $t('Informationen'), key: sk('inspector'), icon: ic(<Info size={19} />), run: toggleInspector, active: inspector },
    activity: { label: $t('Aktivität'), key: sk('activity'), icon: ic(<SquareHalfBottom size={19} />), run: toggleActivity, active: activity },
    upload: { label: $t('Hochladen'), icon: ic(<UploadSimple size={19} />), run: () => upload(), disabled: !selLocal },
    download: { label: $t('Herunterladen'), key: sk('download'), icon: ic(<DownloadSimple size={19} />), run: () => download(), disabled: !selRemote },
    delete: { label: $t('Löschen'), key: key('⌘⌫', $t('Entf')), icon: ic(<Trash size={19} />), run: () => askDelete(focus), disabled: !sel },
    rename: { label: $t('Umbenennen'), key: key('↩', 'F2'), icon: ic(<PencilSimple size={19} />), run: () => startRename(focus), disabled: !sel },
    perms: { label: $t('Rechte'), icon: ic(<LockSimple size={19} />), run: () => toggleInspector(), disabled: false },
    hidden: { label: showHidden ? $t('Versteckte Dateien ausblenden') : $t('Versteckte Dateien zeigen'), key: sk('hidden'), icon: ic(<EyeSlash size={19} />), run: toggleHidden, active: !showHidden },
    terminal: { label: $t('Terminal (SSH)'), icon: ic(<TerminalWindow size={19} />), run: () => openTerminal('remote') },
    disconnect: { label: $t('Trennen'), icon: ic(<Plugs size={19} />), run: () => disconnect() },
    copyPath: { label: $t('Pfad kopieren'), key: sk('copyPath'), icon: ic(<Copy size={19} />), run: () => copyPath(focus) },
    editor: { label: $t('Im Editor öffnen'), icon: ic(<NotePencil size={19} />), run: () => { const n = getState().selection[focus].names[0]; if (n) openInEditor(focus, n); }, disabled: !sel },
    sync: { label: $t('Ordner abgleichen'), icon: ic(<ArrowsClockwise size={19} />), run: () => openDialog({ type: 'compare' }) },
    syncBrowse: { label: $t('Synchron blättern'), key: sk('syncBrowse'), icon: ic(<LinkSimple size={19} />), run: toggleSyncBrowse, active: !!tab?.syncBrowse },
    palette: { label: $t('Befehle'), key: sk('palette'), icon: ic(<Command size={19} />), run: () => openDialog({ type: 'palette' }) },
    compareDirs: { label: $t('Verzeichnisse vergleichen'), key: sk('compareDirs'), icon: ic(<Columns size={19} />), run: toggleCompareDirs, active: compareOn },
    selectMask: { label: $t('Auswählen nach Muster'), key: sk('selectMask'), icon: ic(<Checks size={19} />), run: () => openDialog({ type: 'selectMask', side: focus }) },
  };
}

export function Toolbar() {
  const platform = useStore((s) => s.platform);
  const toolbar = useStore((s) => s.toolbar);
  const labels = useStore((s) => s.toolbarLabels);
  const search = useStore((s) => s.search);
  const deepOn = useStore((s) => s.deepSearchOn);
  // Like Transmit, the field says what it searches: this computer, a server or the server list.
  // Selected as a string: the store hook needs a stable value.
  const targetKey = useStore((s) => { const x = searchTarget(s); return `${x.kind}\n${x.name}`; });
  const [kind, targetName] = targetKey.split('\n');
  const target = { kind: kind as 'local' | 'server' | 'servers', name: targetName };
  const where = target.kind === 'servers' ? $t('Server suchen')
    : target.kind === 'local' ? (deepOn ? $t('Lokal mit Unterordnern suchen') : $t('Lokal suchen'))
    : deepOn ? $t('„{0}“ mit Unterordnern durchsuchen', target.name) : $t('„{0}“ durchsuchen', target.name);
  const tab = useStore((s) => activeTab(s));
  const defs = useToolDefs();
  const sk = useKeyLabel();
  const groupTools = toolbar.filter((t) => t !== 'nav');

  return (
    <header className="toolbar" data-tauri-drag-region onContextMenu={(e) => { e.preventDefault(); openDialog({ type: 'toolbar' }); }}>
      {toolbar.includes('nav') && (
        <div className="tool-group">
          <IconButton label={$t('Zurück')} shortcut={defs.nav.key} disabled={!tab?.back.length} onClick={goBack}><CaretLeft size={19} /></IconButton>
          <IconButton label={$t('Vor')} shortcut={sk('forward')} disabled={!tab?.forward.length} onClick={goForward}><CaretRight size={19} /></IconButton>
        </div>
      )}
      {/* The tabs live in their own row (Mac, see MainWindow) or in the title bar (Windows). */}
      <span className="flex-1" data-tauri-drag-region />
      <div className="tool-group"><WatchButton /></div>
      {toolRuns(groupTools).map((run) => (
        <div key={run.join()} className={`tool-group${labels === 'iconsText' ? ' with-text' : ''}`}>
          {run.map((id) => {
            const d = defs[id];
            return labels === 'iconsText' ? (
              <Tooltip key={id} text={d.label} shortcut={d.key}>
                <button type="button" className={`icon-btn with-text${d.active ? ' is-on' : ''}`} aria-pressed={d.active} disabled={d.disabled} onClick={d.run} data-tool={id}>
                  {d.icon}<span>{d.label}</span>
                </button>
              </Tooltip>
            ) : (
              <IconButton key={id} label={d.label} shortcut={d.key} active={d.active} disabled={d.disabled} onClick={d.run} data-tool={id}>{d.icon}</IconButton>
            );
          })}
        </div>
      ))}
      {/* Windows: the "…" menu sits with the tools, so the search field ends the bar (Explorer, Transmit). */}
      {platform === 'win' && <WinMoreMenu />}
      <label className="search">
        <MagnifyingGlass size={18} aria-hidden="true" />
        <span className="vh">{where}</span>
        {search && <span className="search-side" aria-hidden="true">{target.kind === 'local' ? $t('Lokal') : target.kind === 'servers' ? $t('Server') : target.name}</span>}
        <input type="search" placeholder={where} title={where} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearch('')} />
        {target.kind !== 'servers' && <Tooltip text={deepOn ? $t('Nur in diesem Ordner suchen') : $t('Auch in Unterordnern suchen')} shortcut={sk('deepSearch')}>
          <button type="button" className={`search-scope${deepOn ? ' is-on' : ''}`} aria-pressed={deepOn} aria-label={$t('In Unterordnern suchen')} onClick={(e) => { e.preventDefault(); setDeepSearch(!deepOn); }}>
            <TreeStructure size={16} />
          </button>
        </Tooltip>}
      </label>
    </header>
  );
}
