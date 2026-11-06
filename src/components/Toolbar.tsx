/**
 * Toolbar of the main window: navigation, connection tabs (Mac), the watch
 * button in the middle, the customisable tool group and the search field.
 * On Windows the tabs live in the title bar instead (MainWindow.tsx).
 */
import {
  CaretDoubleRight,
  Check,
  SidebarSimple,
  Broadcast,
  CaretLeft,
  CaretRight,
  MagnifyingGlass,
  TreeStructure,
  TextAa,
} from '@phosphor-icons/react';
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { TermNewMenu } from './TermNewMenu';
import {
  activeTab,
  goBack,
  goForward,
  openDialog,
  setSearch,
  togglePopover,
  useStore,
  type ToolId,
  searchTarget,
  setDeepSearch,
  setSearchContent,
  updateSettings,
} from '../state/store';
import { formatAgo } from '../util/format';
import { useKeyLabel } from '../state/keys';
import { IconButton, Tooltip } from './ui';
import { WatchPopover } from './WatchPopover';
import { WinMoreMenu } from './AppMenu';
import { useCloseOnOutside } from '../util/useCloseOnOutside';
import { $t } from '../i18n';
import { useToolDefs } from './toolDefs';

/**
 * Folder watches as a toolbar symbol with a small lamp (replaces the wide
 * pill): green while watches run, orange while one waits for its server,
 * grey when all are paused. A click opens the overview with all details.
 */
function WatchButton({ mode }: { mode: LabelMode }) {
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
    const n = transfers.filter(
      (t) => t.watchId === waiting.id && (t.state === 'queued' || t.state === 'running'),
    ).length;
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
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${$t('Überwachungen')}: ${text}`}
          className={`icon-btn watch-btn is-${tone}${mode !== 'icons' ? ` tb-${mode}` : ''}${open ? ' is-on' : ''}`}
          onClick={togglePopover}
        >
          {mode !== 'text' && <Broadcast size={20} weight="duotone" />}
          <span className={`watch-lamp tone-${tone}`} aria-hidden="true" />
          {mode !== 'icons' && <span className="tb-name">{$t('Überwachung')}</span>}
        </button>
      </Tooltip>
      {open && <WatchPopover />}
    </div>
  );
}

type LabelMode = 'icons' | 'iconsBelow' | 'iconsText' | 'text';

/**
 * One toolbar button in the chosen look: symbol only (name in the tooltip),
 * symbol with a short name below or beside it, or the name alone.
 */
function ToolButton({
  mode,
  label,
  short,
  shortcut,
  icon,
  active,
  disabled,
  onClick,
  className = '',
  tool,
}: {
  mode: LabelMode;
  label: string;
  short?: string;
  shortcut?: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  tool?: string;
}) {
  if (mode === 'icons')
    return (
      <IconButton
        label={label}
        shortcut={shortcut}
        active={active}
        disabled={disabled}
        onClick={onClick}
        className={className}
        data-tool={tool}
      >
        {icon}
      </IconButton>
    );
  const name = mode === 'iconsText' ? label : (short ?? label);
  return (
    <Tooltip text={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        data-tool={tool}
        className={`icon-btn tb-${mode}${active ? ' is-on' : ''} ${className}`}
      >
        {mode !== 'text' && icon}
        <span className="tb-name">{name}</span>
      </button>
    </Tooltip>
  );
}

/** Kind of each tool: neighbours of the same kind share one capsule, so the bar reads in groups. */
const TOOL_KIND: Record<ToolId, string> = {
  nav: 'nav',
  upload: 'transfer',
  download: 'transfer',
  newFolder: 'files',
  refresh: 'files',
  rename: 'files',
  delete: 'files',
  editor: 'files',
  codeEditor: 'more',
  copyPath: 'files',
  selectMask: 'files',
  sync: 'compare',
  syncBrowse: 'compare',
  compareDirs: 'compare',
  info: 'view',
  activity: 'view',
  hidden: 'view',
  perms: 'view',
  terminal: 'more',
  disconnect: 'more',
  palette: 'more',
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

/** Room the "»" button takes when tools overflow: its width plus the gap before it. */
const OVERFLOW_W = 44;

/**
 * How many tools fit into the toolbar (Finder, Explorer and Office do the
 * same: what does not fit moves behind a "»" button instead of wrapping into
 * a second row, so the window never changes height). The tools are measured
 * once with all of them shown; dropping tools from the end does not move the
 * ones before, so their right edges stay valid while the window is resized.
 */
function useToolFit(
  tools: ToolId[],
  layoutKey: string,
  runsRef: React.RefObject<HTMLDivElement | null>,
  spacerRef: React.RefObject<HTMLSpanElement | null>,
) {
  const [fit, setFit] = useState(tools.length);
  const ends = useRef<{ key: string; list: number[] } | null>(null);
  const recompute = useCallback(() => {
    const runs = runsRef.current;
    const spacer = spacerRef.current;
    if (!runs || !spacer) return;
    if (ends.current?.key !== layoutKey) {
      // Measure only while every tool is rendered; otherwise show all first.
      const buttons = Array.from(runs.querySelectorAll<HTMLElement>('[data-tool]'));
      if (buttons.length < tools.length) {
        setFit(tools.length);
        return;
      }
      const left = runs.getBoundingClientRect().left;
      // Right edge of each tool including its capsule padding (the group's edge for the last one in a group).
      const list = buttons.map((b) => {
        const group = b.closest('.tool-group');
        const last = !!group?.lastElementChild?.contains(b);
        return (last && group ? group.getBoundingClientRect().right : b.getBoundingClientRect().right) - left;
      });
      ends.current = { key: layoutKey, list };
    }
    const list = ends.current.list;
    const room = runs.getBoundingClientRect().width + spacer.getBoundingClientRect().width;
    let n = list.length;
    if (n && list[n - 1] > room + 0.5) {
      n = 0;
      while (n < list.length && list[n] <= room - OVERFLOW_W) n++;
    }
    setFit(n);
  }, [layoutKey, tools.length, runsRef, spacerRef]);

  useLayoutEffect(() => {
    // A changed layout (labels, order, platform) is measured again with all tools shown.
    if (ends.current?.key !== layoutKey) setFit(tools.length);
  }, [layoutKey, tools.length]);
  useLayoutEffect(() => {
    recompute();
  });
  useLayoutEffect(() => {
    // The tools' own box and the free space before them change with the window
    // and with the search field, which widens while it is in use.
    const ro = new ResizeObserver(() => recompute());
    if (runsRef.current) ro.observe(runsRef.current);
    if (spacerRef.current) ro.observe(spacerRef.current);
    return () => ro.disconnect();
  }, [recompute, runsRef, spacerRef]);
  return Math.min(fit, tools.length);
}

/** The "»" button with the tools that did not fit into the toolbar. */
function ToolOverflow({ tools }: { tools: ToolId[] }) {
  const defs = useToolDefs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnOutside(open, ref, close);
  const anyCheck = tools.some((id) => defs[id].active !== undefined);
  return (
    <div className="more-anchor tool-overflow" ref={ref}>
      <span className="tool-group">
        <Tooltip text={$t('Weitere Werkzeuge')}>
          <button
            type="button"
            className={`icon-btn${open ? ' is-on' : ''}`}
            aria-label={$t('Weitere Werkzeuge')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <CaretDoubleRight size={17} />
          </button>
        </Tooltip>
      </span>
      {open && (
        <div role="menu" className="menu more-menu">
          {tools.map((id) => {
            const d = defs[id];
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={d.disabled}
                onClick={() => {
                  close();
                  d.run();
                }}
              >
                {anyCheck && (
                  <span className="menu-check" aria-hidden="true">
                    {d.active ? <Check size={13} weight="bold" /> : null}
                  </span>
                )}
                <span className="menu-icon" aria-hidden="true">
                  {d.icon}
                </span>
                <span className="flex-1">{d.label}</span>
                {d.key && <span className="menu-key">{d.key}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Toolbar() {
  const sidebarOn = useStore((s) => s.settings.sidebar !== false);
  const platform = useStore((s) => s.platform);
  const toolbar = useStore((s) => s.toolbar);
  const labels = useStore((s) => s.toolbarLabels);
  const search = useStore((s) => s.search);
  const deepOn = useStore((s) => s.deepSearchOn);
  const contentOn = useStore((s) => s.searchContent);
  // Like Transmit, the field says what it searches: this computer, a server or the server list.
  // Selected as a string: the store hook needs a stable value.
  const targetKey = useStore((s) => {
    const x = searchTarget(s);
    return `${x.kind}\n${x.name}`;
  });
  const [kind, targetName] = targetKey.split('\n');
  const target = { kind: kind as 'local' | 'server' | 'servers', name: targetName };
  const where =
    target.kind === 'servers'
      ? $t('Server suchen')
      : target.kind === 'local'
        ? deepOn
          ? $t('Lokal mit Unterordnern suchen')
          : $t('Lokal suchen')
        : deepOn
          ? $t('„{0}“ mit Unterordnern durchsuchen', target.name)
          : $t('„{0}“ durchsuchen', target.name);
  const tab = useStore((s) => activeTab(s));
  const defs = useToolDefs();
  const sk = useKeyLabel();
  const groupTools = toolbar.filter((t) => t !== 'nav');
  const spacerRef = useRef<HTMLSpanElement>(null);
  const runsRef = useRef<HTMLDivElement>(null);
  const fit = useToolFit(groupTools, `${labels}|${platform}|${groupTools.join()}`, runsRef, spacerRef);
  const shown = groupTools.slice(0, fit);
  const hidden = groupTools.slice(fit);
  const [termMenu, setTermMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <header
      className={`toolbar labels-${labels}`}
      data-tauri-drag-region
      onContextMenu={(e) => {
        e.preventDefault();
        // Right click on the terminal button: which terminal to open (this computer, an SSH server, a new SSH connection).
        if ((e.target as HTMLElement).closest('[data-tool="terminal"]')) setTermMenu({ x: e.clientX, y: e.clientY });
        else openDialog({ type: 'toolbar' });
      }}
    >
      {termMenu && <TermNewMenu x={termMenu.x} y={termMenu.y} onClose={() => setTermMenu(null)} />}
      {/* Sidebar on or off (Finder: the button left of the back arrow). */}
      <div className="tool-group">
        <ToolButton
          mode={labels}
          label={sidebarOn ? $t('Seitenleiste ausblenden') : $t('Seitenleiste einblenden')}
          short={$t('Seitenleiste')}
          shortcut={sk('sidebar')}
          active={sidebarOn}
          className="sidebar-btn"
          onClick={() => updateSettings({ sidebar: !sidebarOn })}
          icon={<SidebarSimple size={19} />}
        />
      </div>
      {toolbar.includes('nav') && (
        <div className="tool-group">
          <ToolButton
            mode={labels}
            label={$t('Zurück')}
            shortcut={defs.nav.key}
            disabled={!tab?.back.length}
            onClick={goBack}
            icon={<CaretLeft size={19} />}
          />
          <ToolButton
            mode={labels}
            label={$t('Vor')}
            shortcut={sk('forward')}
            disabled={!tab?.forward.length}
            onClick={goForward}
            icon={<CaretRight size={19} />}
          />
        </div>
      )}
      {/* The tabs live in their own row (Mac, see MainWindow) or in the title bar (Windows). */}
      <span className="flex-1" data-tauri-drag-region ref={spacerRef} />
      <div className="tool-group">
        <WatchButton mode={labels} />
      </div>
      <div className="tool-runs" ref={runsRef}>
        {toolRuns(shown).map((run) => (
          <div key={run.join()} className="tool-group">
            {run.map((id) => {
              const d = defs[id];
              return (
                <ToolButton
                  key={id}
                  mode={labels}
                  label={d.label}
                  short={d.short}
                  shortcut={d.key}
                  active={d.active}
                  disabled={d.disabled}
                  onClick={d.run}
                  icon={d.icon}
                  tool={id}
                />
              );
            })}
          </div>
        ))}
      </div>
      {hidden.length > 0 && <ToolOverflow tools={hidden} />}
      {/* Windows: the "…" menu sits with the tools, so the search field ends the bar (Explorer, Transmit). */}
      {platform === 'win' && <WinMoreMenu />}
      <label className="search">
        <MagnifyingGlass size={18} aria-hidden="true" />
        <span className="vh">{where}</span>
        {search && (
          <span className="search-side" aria-hidden="true">
            {target.kind === 'local' ? $t('Lokal') : target.kind === 'servers' ? $t('Server') : target.name}
          </span>
        )}
        <input
          type="search"
          placeholder={where}
          title={where}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
        />
        {target.kind !== 'servers' && (
          <Tooltip
            text={contentOn ? $t('Nach Namen suchen') : $t('Im Inhalt der Dateien suchen')}
            shortcut={sk('contentSearch')}
          >
            <button
              type="button"
              className={`search-scope${contentOn ? ' is-on' : ''}`}
              aria-pressed={contentOn}
              aria-label={$t('Im Inhalt suchen')}
              onClick={(e) => {
                e.preventDefault();
                setSearchContent(!contentOn);
              }}
            >
              <TextAa size={16} />
            </button>
          </Tooltip>
        )}
        {target.kind !== 'servers' && (
          <Tooltip
            text={deepOn ? $t('Nur in diesem Ordner suchen') : $t('Auch in Unterordnern suchen')}
            shortcut={sk('deepSearch')}
          >
            <button
              type="button"
              className={`search-scope${deepOn ? ' is-on' : ''}`}
              aria-pressed={deepOn}
              aria-label={$t('In Unterordnern suchen')}
              onClick={(e) => {
                e.preventDefault();
                setDeepSearch(!deepOn);
              }}
            >
              <TreeStructure size={16} />
            </button>
          </Tooltip>
        )}
      </label>
    </header>
  );
}
