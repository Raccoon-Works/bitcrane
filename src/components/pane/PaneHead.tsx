/**
 * Path bar of a half: location button, breadcrumbs or the path field, chips
 * for synchronous browsing and Git, the connection state, and the controls
 * for the view (columns, icon size, list/icons/columns), the SSH terminal and
 * disconnecting.
 */
import {
  Columns,
  EjectSimple,
  GitBranch,
  ListBullets,
  Plugs,
  SlidersHorizontal,
  SquaresFour,
  TerminalWindow,
} from '@phosphor-icons/react';
import type { PaneSide, Server, Tab } from '../../backend/types';
import {
  closePaneServer,
  editPath,
  setIconSize,
  setState,
  setViewMode,
  toggleSyncBrowse,
  useStore,
  watchForLocal,
  type ViewMode,
} from '../../state/store';
import type { GitStatus } from '../../backend/api';
import { ChevronDown, Link2 } from '../glyphs';
import { LocalTile, ServerTile } from '../ServerTile';
import { IconButton } from '../ui';
import { $t } from '../../i18n';
import { Crumbs } from './Crumbs';
import { PathInput } from './PathInput';

export function PaneHead({
  side,
  tab,
  path,
  onServer,
  server,
  offline,
  connecting,
  git,
  viewMode,
  colView,
  iconStep,
}: {
  side: PaneSide;
  tab: Tab;
  path: string;
  onServer: boolean;
  server: Server | undefined;
  offline: boolean;
  connecting: boolean;
  git: GitStatus | null;
  viewMode: ViewMode;
  /** The column view is in use (a search through subfolders shows a list instead). */
  colView: boolean;
  iconStep: number;
}) {
  const platform = useStore((s) => s.platform);
  const pathEdit = useStore((s) => s.pathEdit === side);
  const watched = useStore((s) => !onServer && !!watchForLocal(path, s));
  const icons = viewMode === 'icons';
  // SSH servers get a button for the built-in terminal next to "Trennen".
  const sshPane = !server?.protocol || server.protocol === 'sftp';

  const stateLabel = !onServer
    ? watched
      ? { text: $t('überwacht'), tone: 'accent' }
      : null
    : offline
      ? { text: $t('getrennt'), tone: 'warn' }
      : connecting
        ? { text: $t('verbindet'), tone: 'muted' }
        : server?.online
          ? { text: $t('verbunden'), tone: 'ok' }
          : { text: $t('nicht verbunden'), tone: 'muted' };

  return (
    <div className="pane-head">
      {/* Location button: this computer and its drives, or which server the half shows. */}
      <button
        type="button"
        className="pane-source"
        title={onServer ? `${server?.name ?? ''} · ${$t('Ort wechseln')}` : $t('Laufwerke und Server')}
        aria-label={$t('Ort wechseln')}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setState({ contextMenu: { x: r.left, y: r.bottom + 4, side, names: [], kind: 'paneSource' } });
        }}
      >
        {onServer ? <ServerTile server={server} /> : <LocalTile />}
        <ChevronDown size={11} strokeWidth={2} aria-hidden="true" />
      </button>
      {pathEdit ? <PathInput side={side} path={path} onServer={onServer} /> : <Crumbs side={side} path={path} />}
      {/* A click into the free space of the path bar makes it editable (like Explorer). */}
      {!pathEdit ? (
        <span className="flex-1 path-fill" title={$t('Pfad eingeben')} onClick={() => editPath(side)} />
      ) : null}
      {tab.syncBrowse && (
        <button
          type="button"
          className="sync-chip"
          title={$t('Synchron blättern: Ordnerwechsel gilt für beide Seiten. Klicken zum Beenden.')}
          onClick={toggleSyncBrowse}
        >
          <Link2 size={12} strokeWidth={2} aria-hidden="true" />
          {$t('synchron')}
        </button>
      )}
      {git && (
        <button
          type="button"
          className="git-chip"
          title={$t('Git: Zweig {0}. Klicken für Commit, Pull und Push.', git.branch)}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setState({ contextMenu: { x: r.left, y: r.bottom + 4, side, names: [], kind: 'git' } });
          }}
        >
          <GitBranch size={13} aria-hidden="true" />
          {git.branch}
          {git.ahead > 0 && <span> ↑{git.ahead}</span>}
          {git.behind > 0 && <span> ↓{git.behind}</span>}
          {Object.keys(git.files).length > 0 && <span className="git-chip-count">{Object.keys(git.files).length}</span>}
        </button>
      )}
      {stateLabel && (
        <span className={`pane-state tone-${stateLabel.tone}`} title={stateLabel.text}>
          <span className="state-dot" />
          <span className="pane-state-text">{stateLabel.text}</span>
        </span>
      )}
      {/* Icons view: size of the symbols and preview pictures (Windows' sizes, the Finder's slider). */}
      {icons && (
        <input
          type="range"
          className="icon-size"
          min={0}
          max={3}
          step={1}
          value={iconStep}
          aria-label={$t('Symbolgröße')}
          title={`${$t('Symbolgröße')} (${$t('Strg + Mausrad')})`}
          onChange={(e) => setIconSize(side, Number(e.target.value))}
        />
      )}
      {/* More columns: the same menu as a right click on the column header (Explorer), here where it can be found. */}
      {!icons && !colView && (
        <IconButton
          label={$t('Spalten wählen')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setState({ contextMenu: { x: r.left, y: r.bottom + 4, side, names: [], kind: 'columns' } });
          }}
        >
          <SlidersHorizontal size={18} weight="bold" />
        </IconButton>
      )}
      <span className="view-switch" role="group" aria-label={$t('Darstellung')}>
        <IconButton label={$t('Liste')} active={viewMode === 'list'} onClick={() => setViewMode(side, 'list')}>
          <ListBullets size={18} weight="bold" />
        </IconButton>
        <IconButton label={$t('Symbole')} active={icons} onClick={() => setViewMode(side, 'icons')}>
          <SquaresFour size={18} weight="duotone" />
        </IconButton>
        <IconButton label={$t('Spalten')} active={viewMode === 'columns'} onClick={() => setViewMode(side, 'columns')}>
          <Columns size={18} weight="bold" />
        </IconButton>
      </span>
      {onServer && sshPane && (
        <IconButton
          label={$t('SSH-Terminal')}
          active={!!tab.terminal?.open}
          onClick={() => void import('../../state/terminal').then((m) => m.toggleTerminal('server'))}
        >
          <TerminalWindow size={18} weight="bold" />
        </IconButton>
      )}
      {onServer && (
        <IconButton label={$t('Trennen')} onClick={() => closePaneServer(side)}>
          {platform === 'mac' ? <EjectSimple size={18} weight="bold" /> : <Plugs size={18} weight="bold" />}
        </IconButton>
      )}
    </div>
  );
}
