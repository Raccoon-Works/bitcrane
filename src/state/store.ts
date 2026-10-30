/**
 * Application state for the Bitcrane user interface.
 *
 * The store is a small external store (subscribe/getSnapshot) consumed through
 * `useStore`. All user actions are plain functions exported from this module.
 *
 * In the browser prototype every action talks to the mock file systems in
 * `backend/mockFs.ts` and a timer simulates transfer progress, connection
 * drops and folder watch events. In the app (`LIVE`), actions delegate to
 * `live.ts`, which calls the Rust core and receives progress through events.
 */
import type { Snippet, TermSession, TerminalSettings } from './terminal';
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri, type CloudPlace, type ImportedServer, type Place } from '../backend/api';
import * as fs from '../backend/mockFs';
import * as live from './live';
import type {
  Conflict, ConflictChoice, FileEntry, HostKey, PaneSide, Platform, Protocol, Server, Tab, Theme, Transfer, Watch, WatchOptions,
} from '../backend/types';
import { isCloudProtocol } from '../backend/types';
import { describeFile, formatSize, matchesExclude } from '../util/format';
import * as paths from '../util/paths';
import { seal, unseal, type Sealed } from '../util/crypto';
import { $t, LANG, rememberLanguage } from '../i18n';

/** True inside the desktop app: real files and real servers instead of the demo data. */
export const LIVE = isTauri;

/* ------------------------------------------------------------------------ */
/* State shape                                                              */
/* ------------------------------------------------------------------------ */

export type DialogState =
  | { type: 'watchSetup'; editId?: string }
  | { type: 'serverEdit'; serverId?: string; cloud?: Protocol; terminal?: boolean }
  | { type: 'confirm'; title: string; text: string; confirm: string; danger?: boolean; run: () => void; detail?: string }
  | { type: 'checksum'; side: PaneSide; name: string }
  | { type: 'symlink'; target: string }
  | { type: 'palette' }
  | { type: 'edits' }
  | { type: 'exportConfig' }
  | { type: 'importPassword'; sealed: Sealed }
  | { type: 'quickConnect'; terminal?: boolean }
  | { type: 'fingerprint'; mode: 'new' | 'changed'; key: HostKey; serverId: string }
  | { type: 'conflict' }
  | { type: 'perms'; side: PaneSide; path: string }
  | { type: 'settings'; tab: SettingsTab }
  | { type: 'about' }
  | { type: 'licenses' }
  | { type: 'update' }
  | { type: 'toolbar' }
  | { type: 'transfers' }
  | { type: 'confirmDelete'; side: PaneSide; names: string[] }
  | { type: 'shortcuts' }
  | { type: 'secret'; serverId: string; kind: 'passphrase' | 'password'; wrong?: boolean }
  | { type: 'diff'; transferId: string }
  | { type: 'compareFiles'; a: CompareRef; b: CompareRef }
  | { type: 'uploadTo'; paths: string[] }
  | { type: 'vaultCreate'; side: PaneSide }
  | { type: 'log' }
  | { type: 'preview'; side: PaneSide }
  | { type: 'batchRename'; side: PaneSide; names: string[] }
  | { type: 'selectMask'; side: PaneSide }
  | { type: 'afterQueue'; action: AfterQueue }
  | { type: 'workspaces' }
  | { type: 'cloudSignIn'; service: Protocol; serverId?: string }
  | { type: 'mergeFolders'; fromDir: string; names: string[]; toDir: string; move: boolean; clashes: string[] }
  | { type: 'compare'; favoriteId?: string }
  | { type: 'import' }
  | { type: 'cloudPlaces'; found: CloudPlace[] }
  | { type: 'authPrompt'; id: string; serverId: string; host: string; name: string; instructions: string; prompts: Array<{ text: string; echo: boolean }> };

export type SettingsTab = 'general' | 'watch' | 'transfers' | 'rules' | 'connections' | 'appearance' | 'terminal' | 'keys' | 'advanced';

export interface PaneSelection {
  names: string[];
  /** Index of the row with the keyboard cursor. */
  cursor: number;
  /** Index where a shift-selection started. */
  anchor: number;
}

export interface ContextMenuState {
  x: number;
  y: number;
  side: PaneSide;
  /** Empty when the user right-clicked the empty area of a list. */
  names: string[];
  /**
   * "columns": the column header; "server": a server in the server list;
   * "paneSource": the location button of a half; "place": a place in its places bar;
   * "crumbs": the folders above the ones shown in the path bar.
   */
  kind?: 'files' | 'columns' | 'server' | 'paneSource' | 'place' | 'crumbs' | 'serverGroup' | 'placesMore';
  /** Group right-clicked in the server list ("serverGroup"). */
  group?: string;
  serverId?: string;
  /** Folder of the place right-clicked ("place"). */
  place?: string;
}

export interface Settings {
  /** Built-in terminal: look and behaviour (state/terminal.ts). */
  terminal?: Partial<TerminalSettings>;
  /** Saved commands for the terminal. */
  snippets?: Snippet[];
  /** Order of the snippet groups (a group may be empty for a while). */
  snippetGroups?: string[];
  /** Height of the terminal panel in pixels. */
  terminalHeight?: number;
  /** The terminal button was added to a changed toolbar once (0.2.45). */
  toolbarTerminalAdded?: boolean;
  runInBackground: boolean;
  showMenuBarIcon: boolean;
  startAtLogin: boolean;
  defaultDelay: number;
  defaultExcludes: string[];
  defaultMirrorDeletes: boolean;
  notify: 'errors' | 'all' | 'none';
  soundOnError: boolean;
  soundOnDone: boolean;
  dockProgress: boolean;
  themeSetting: 'system' | Theme;
  showHidden: boolean;
  /** Start at login only in the notification area / menu bar, without opening the window. */
  startHidden?: boolean;
  /** Show protected system items (Windows hidden + system); off like in Explorer. */
  showSystem?: boolean;
  confirmDelete: boolean;
  parallel: number;
  /** Interface language. */
  language: 'de' | 'en';
  /**
   * "Beim Start öffnen" (after Transmit): the folder of this computer in the left
   * half, and optionally a server for the right half that connects right away.
   */
  startLocal: string;
  startServer: string;
  /** Double click on a file: open it, open it in the editor, or transfer it to the other half (Transmit). */
  fileDoubleClick: 'open' | 'edit' | 'transfer';
  /** Unix permissions for uploaded files and created folders ('' = leave to the server), e.g. "644" / "755". */
  uploadFilePerms: string;
  /** True once Bitcrane offered the cloud folders it found (first start). */
  cloudAsked: boolean;
  /** Server groups without servers yet (created with "Neue Gruppe"); groups with servers come from the servers. */
  serverGroups: string[];
  /** Share of the left half in the window (0.2 … 0.8), set by dragging the line between the halves. */
  splitRatio: number;
  /** Width of the group column in the server list, in pixels. */
  serverSourcesWidth: number;
  /** Height of the opened activity area, in pixels. */
  activityHeight: number;
  uploadDirPerms: string;
  /** Upload under a temporary name first and rename when complete. */
  uploadTempName: boolean;
  /** Keep the modification time of transferred files. */
  keepMtime: boolean;
  /** What happens when a manually uploaded file already exists on the server. */
  existingFiles: ExistingRule;
  /** The same for downloads (file exists on this computer). */
  existingDownload: ExistingRule;
  /** Skip files whose target has the same size and modification time. */
  skipUnchanged: boolean;
  /** Retry failed transfers automatically (up to three times). */
  autoRetry: boolean;
  /** Look for a new Bitcrane version at start and every few hours. */
  /** Updates (after Transmit): install automatically when quitting, only tell, or never look. */
  updateMode: 'auto' | 'notify' | 'off';
  /** "Mit Bitcrane hochladen" in the Explorer / Finder context menu (missing = on). */
  shellIntegration?: boolean;
  /** Last target of "Mit Bitcrane hochladen": server and folder. */
  uploadToLast?: { serverId: string; dir: string };
  /** Keep the computer from falling asleep while transfers run (missing = on). */
  keepAwake?: boolean;
  /** Client id of the user's own Google app (Google Drive); its secret is in the keychain. */
  googleClientId?: string;
  /** "Zwischen Rechnern abgleichen": folder the user's cloud keeps in step (see sync.ts). */
  syncFolder?: string;
  /** Passwords travel too (encrypted with the sync password from the keychain). */
  syncPasswords?: boolean;
  /** State after the last sync (hashes), last successful sync, file time seen, last error. */
  syncBase?: import('./sync').SyncBase;
  syncAt?: number;
  syncSeen?: number;
  syncError?: string;
  /** Version that ran last time; a different one at start means an update was installed. */
  lastVersion?: string;
  /** Names / patterns never transferred by hand (".DS_Store", "*.tmp"). */
  skipPatterns: string[];
  /** Transfer rules (settings > Regeln). */
  rules?: TransferRule[];
  /** Open the tabs of the last session again when Bitcrane starts. */
  restoreTabs?: boolean;
  /** Own commands for the context menu of server files (WinSCP "Custom commands"). */
  customCommands?: CustomCommand[];
  /** Look of the dark mode: "midnight" (default) or the system's (Explorer/Transmit). 0.2.49 stored "tabby" for midnight. */
  darkPalette?: 'midnight' | 'system' | 'tabby';
  /** Saved sets of tabs (WinSCP "Workspaces"). */
  workspaces?: Workspace[];
  /** Skip files larger than this many MB when transferring by hand (0 = no limit). */
  skipLargerMb: number;
  /** Speed limit for all transfers together in KB/s (0 = unlimited). */
  bandwidthLimit: number;
  /** Reconnect automatically after a dropped connection. */
  autoReconnect: boolean;
  /** Send keepalive messages every 30 seconds. */
  keepAlive: boolean;
  /** Use host aliases from ~/.ssh/config (quick connect, import). */
  readSshConfig: boolean;
  /** Also write the connection log to a file. */
  writeLog: boolean;
  /** Saved watch templates ("Als Vorlage speichern"). */
  watchTemplates: WatchTemplate[];
  /** Show the permissions column in the file lists. */
  showPerms: boolean;
  /** Sort order per side; folders always come first. */
  sort: Record<PaneSide, { key: SortKey; dir: 1 | -1 }>;
  /** Server on the left, this computer on the right. */
  swapSides: boolean;
  /** Program for "Im Editor öffnen" ('' = the system's default program). */
  editorApp: string;
  /** Own editor per file extension (".py" -> program); else `editorApp`. */
  editorByExt: Record<string, string>;
  /** Own keyboard shortcuts: action id -> combination ('' = none). */
  shortcuts: Record<string, string>;
  /** Mac: the hint about "Festplattenvollzugriff" was shown once. */
  diskAccessHinted?: boolean;
  /** Set once the colours given out by the old import were reset (0.2.15). */
  coloursReset?: boolean;
  /** Show a ".." row at the top of a file list to go up (WinSCP, Total Commander); default on Windows. */
  parentRow?: boolean;
  /** What the right half of a new tab shows: the server list or this computer (two local halves). */
  newTabRight?: 'servers' | 'local';
  /** Zoom of the whole window (1 = 100 %), for people who need everything larger. */
  zoom?: number;
  /** Size step of the icons view per half (0 = default … 3 = largest). */
  iconSize?: Partial<Record<PaneSide, number>>;
  /** File symbols of the system (Explorer/Finder) instead of Bitcrane's own. */
  systemIcons?: boolean;
  /** Optional columns of the file lists. */
  columns: { mtime: boolean; size: boolean; kind?: boolean; owner?: boolean };
  /** "detail" also logs every single step (listings, transfers, prompts). */
  logLevel: 'normal' | 'detail';
  /** Addresses typed into "Schnell verbinden", newest first. */
  recentAddresses: string[];
  /** Open sftp:// links (from the browser, a wiki, mails) in Bitcrane. */
  sftpLinks: boolean;
  /** Saved folder comparisons ("Abgleich als Favorit"). */
  syncFavorites: SyncFavorite[];
  /** Starting values for new servers ("Als Vorlage für neue Server"). */
  serverDefaults: Partial<Pick<Server, 'port' | 'user' | 'auth' | 'keyPath' | 'localStart' | 'remoteStart' | 'group' | 'color' | 'jumpServerId' | 'proxy'>>;
  /** Places bar of this computer; missing until the user changes it (then the system places are used). */
  localPlaces?: Place[];
  /** List or icons, per half. */
  viewMode: Record<PaneSide, 'list' | 'icons'>;
}

export type SortKey = 'name' | 'mtime' | 'size' | 'perms' | 'kind' | 'owner';

export interface DeepSearch {
  side: PaneSide;
  base: string;
  query: string;
  loading: boolean;
  error?: string;
  /** Files whose path below `base` matches; `rel` is relative to `base`. */
  results: Array<{ path: string; rel: string; size: number; mtime: number }>;
  /** True when there were more matches than shown. */
  more: boolean;
}

/** A saved "Ordner abgleichen" with its folders and options. */
export interface SyncFavorite {
  id: string;
  name: string;
  serverId: string;
  /** Server to server: the server of the left half. */
  leftServerId?: string;
  /** Two folders of this computer (the right half shows this computer). */
  rightLocal?: boolean;
  /** Only files changed within this many days (0 or missing = all). */
  days?: number;
  /** Runs by itself while Bitcrane is running (also hidden in the notification area). */
  schedule?: SyncSchedule;
  /** Last scheduled run: time and a short result for the server list and the log. */
  lastRun?: number;
  lastResult?: string;
  local: string;
  remote: string;
  direction: 'up' | 'down' | 'both';
  bySize: boolean;
  byContent: boolean;
  deletes: boolean;
}

/** When a saved comparison runs by itself. */
export interface SyncSchedule {
  mode: 'daily' | 'hourly' | 'startup';
  /** "HH:MM" for daily runs. */
  time?: string;
  /** Scheduled runs never delete unless this is switched on explicitly (no one sees the list). */
  allowDelete?: boolean;
}

/** Rule for files that already exist at the target of a manual transfer. */
/** What happens once the transfer queue is empty (WinSCP "Once empty"). */
export type AfterQueue = 'none' | 'disconnect' | 'quit' | 'sleep' | 'shutdown';

/** An own command run on the server for the selected files. Placeholders: {file}, {files}, {name}, {dir}. */
export interface CustomCommand { id: string; name: string; command: string }

/** A tab as saved in a workspace or for the next start. */
export interface SavedTab {
  serverId: string; localPath: string; remotePath: string; leftServerId?: string; rightLocal?: boolean;
  /** Terminals of the tab ('' = this computer), when "Terminals wieder öffnen" is on. */
  terminals?: string[];
  terminalOpen?: boolean;
  /** The terminal filled the tab (SSH-only tabs). */
  terminalFull?: boolean;
}

/** A named set of tabs that can be opened again later. */
export interface Workspace { id: string; name: string; tabs: SavedTab[]; active?: number }

export type ExistingRule = 'ask' | 'overwrite' | 'newer' | 'keepBoth' | 'skip';

/**
 * A transfer rule (settings > Regeln): named settings that a server or a watch
 * uses instead of the general ones, like WinSCP's transfer presets. Empty or
 * missing fields fall back to the general settings.
 */
export interface TransferRule {
  id: string;
  name: string;
  /** Names and patterns that are never transferred (added to the general list and a watch's own). */
  excludes: string[];
  /** Larger files are left out (MB); missing = general setting. */
  skipLargerMb?: number;
  existingUp?: ExistingRule;
  existingDown?: ExistingRule;
  /** Permissions for uploaded files and folders ("644", "755"); empty = server default. */
  filePerms?: string;
  dirPerms?: string;
  /** Keep older versions on the server before replacing a file. */
  keepOldVersion?: boolean;
}

/** Excludes and options of a watch, saved under a name for new watches. */
export interface WatchTemplate {
  name: string;
  excludes: string[];
  options: WatchOptions;
}

export type ToolId =
  | 'nav' | 'newFolder' | 'refresh' | 'info' | 'activity' | 'upload' | 'download' | 'delete' | 'rename'
  | 'perms' | 'hidden' | 'terminal' | 'disconnect' | 'copyPath' | 'editor' | 'sync' | 'syncBrowse' | 'palette' | 'compareDirs' | 'selectMask';

export interface AppState {
  platform: Platform;
  /** Built-in terminal sessions (state/terminal.ts). */
  terminals: TermSession[];
  /** Ids of the SSH tunnels that are running (state/forward.ts). */
  tunnels: string[];
  /** Windows: Explorer folder of each server shown there (mount.ts), by server id. */
  explorerFolders: Record<string, string>;
  theme: Theme;
  /** Dark colour palette (draft): 'auto' = Explorer on Windows, Transmit on the Mac. */
  palette: 'auto' | 'explorer' | 'transmit' | 'midnight' | 'old';
  firstRun: boolean;
  servers: Server[];
  tabs: Tab[];
  activeTabId: string;
  watches: Watch[];
  transfers: Transfer[];
  selection: Record<PaneSide, PaneSelection>;
  focusSide: PaneSide;
  inspectorOpen: boolean;
  /** Set by the user; an error opens the activity automatically. */
  activityOpen: boolean;
  activityFilter: 'all' | 'errors' | 'history' | 'log';
  popoverOpen: boolean;
  menuBarWindowOpen: boolean;
  appMenu: string | null;
  /** Width of the sidebar in pixels; the user can drag its edge. */
  sidebarWidth: number;
  dialog: DialogState | null;
  contextMenu: ContextMenuState | null;
  renaming: { side: PaneSide; name: string } | null;
  /** Server group whose name is being edited in the server list. */
  renamingGroup: string | null;
  /** Side whose path bar is an input field (⌘L). */
  pathEdit: PaneSide | null;
  /** Server files open in the editor (working copies that go up on save). */
  edits: Array<{ localPath: string; serverId: string; remotePath: string; openedAt: number; lastUpload?: number }>;
  /** Calculated folder sizes ("Größe berechnen"), key: side|server|path. */
  folderSizes: Record<string, number>;
  /** Entries copied with ⌘C; ⌘V in the other half transfers them. */
  clipboard: { side: PaneSide; serverId: string; dir: string; names: string[] } | null;
  search: string;
  /** The half the search filters: the focused one when typing started (Transmit searches the active browser). */
  searchSide: PaneSide;
  /** "In Unterordnern suchen" is switched on. */
  deepSearchOn: boolean;
  /** Results of the search in subfolders of the focused side. */
  deepSearch: DeepSearch | null;
  toolbar: ToolId[];
  toolbarLabels: 'icons' | 'iconsText';
  settings: Settings;
  /** Connection drop simulation: server id -> next retry time. */
  offline: Record<string, { attempt: number; nextRetry: number }>;
  conflicts: Conflict[];
  /** Increases whenever any file system changes, so lists re-read. */
  fsRev: number;
  /** Clock used for "vor 12 Sek." texts; updated every second. */
  now: number;
  /** A short message shown at the bottom of the window. */
  toast: { text: string; tone: 'info' | 'ok' | 'error' | 'update' } | null;
  speed: number;
  /** Local places in the sidebar. */
  places: Place[];
  /** Drives and volumes of this computer (desktop app only). */
  drives: Place[];
  /** Name of the home folder, shown as the first breadcrumb. */
  homeName: string;
  /** Bitcrane was started at login and keeps its window hidden (the status icon must then be shown). */
  startedHidden?: boolean;
  /** "Verzeichnisse vergleichen": the halves mark entries that differ from the other half. */
  compareDirs: boolean;
  /** What happens once all transfers are finished; resets to "none" after it ran. */
  afterQueue: AfterQueue;
  /** Rule for transfers by hand in this session: '' = the server's rule, 'none' = no rule, else a rule id. */
  transferRule: string;
  /** Cloud services this build has app keys for (desktop app; the prototype shows all). */
  cloudAvailable: { dropbox: boolean; onedrive: boolean };
  /** Update in progress or waiting (null: none known). */
  update: import('./updates').UpdateState | null;
  /** Where dragged files would land: a side and a folder name ('' = folder shown). */
  /** Drop target while dragging: a folder in a half ('' = the folder shown), a place
      in a places bar (`place` = its path), or the places bar itself (`addPlace`). */
  dropHint: { side: PaneSide; name: string; place?: string; addPlace?: boolean } | null;
  /** Folders opened in place (triangle in the list), as paths relative to the folder shown. */
  expanded: Record<PaneSide, string[]>;
}

/* ------------------------------------------------------------------------ */
/* Initial data                                                             */
/* ------------------------------------------------------------------------ */

export const defaultWatchOptions: WatchOptions = {
  includeSubfolders: true,
  syncOnStart: true,
  startWithApp: true,
  warnIfServerNewer: true,
  runInBackground: true,
  continueOnError: true,
  onlyExisting: false,
  onlySelectedSubfolders: false,
  setPermissions: false,
  mirrorDeletes: false,
  keepOldVersion: false,
  commandEnabled: false,
  command: '',
  delay: 2,
};

function sampleServers(): Server[] {
  const base = { port: 22, auth: 'key' as const, keyPath: '~/.ssh/id_ed25519', online: false };
  return [
    { ...base, id: 'ob', name: 'Cloud · Bots', mono: 'CB', color: 'gray', ruleId: 'rule-bot', host: 'bots.example', user: 'ubuntu', keyPath: '~/.ssh/cloud_bots_ed25519', group: 'Bots', localStart: '~/Projekte/taskbot/live', remoteStart: '/home/ubuntu/bots/taskbot', online: true, lastUsed: Date.now() - 5 * 60000,
      places: [{ name: 'ubuntu', path: '/home/ubuntu' }, { name: 'taskbot', path: '/home/ubuntu/bots/taskbot' }, { name: 'newsbot', path: '/home/ubuntu/bots/newsbot' }] },
    { ...base, id: 'cw', name: 'Community Web', mono: 'CW', color: 'gray', host: 'web.community.example', user: 'web', group: 'Community', localStart: '~/Projekte/community-web', remoteStart: '/var/www/community', online: true, lastUsed: Date.now() - 26 * 3600000,
      places: [{ name: 'community', path: '/var/www/community' }] },
    { ...base, id: 'ts', name: 'Testserver', mono: 'TS', color: 'green', host: 'test.community.example', user: 'test', group: 'Community', localStart: '~', remoteStart: '/home/test' },
    { ...base, id: 'nas', name: 'Backup NAS', mono: 'NA', color: 'gray', host: 'nas.local', user: 'admin', auth: 'password', group: 'Privat', localStart: '~/Downloads', remoteStart: '/volume1/backups' },
  ];
}

function sampleWatches(): Watch[] {
  return [
    {
      id: 'w1', name: 'taskbot live', localPath: '~/Projekte/taskbot/live', serverId: 'ob', remotePath: '/home/ubuntu/bots/taskbot',
      state: 'active', lastFile: 'welcome.py', lastTime: Date.now() - 12000,
      excludes: ['.git', '__pycache__', '.DS_Store', '*.log', '*.tmp', '.venv'],
      options: { ...defaultWatchOptions, commandEnabled: true, command: 'pm2 restart taskbot' },
    },
    {
      id: 'w2', name: 'newsbot live', localPath: '~/Projekte/newsbot', serverId: 'ob', remotePath: '/home/ubuntu/bots/newsbot',
      state: 'paused', lastFile: '', lastTime: Date.now() - 2 * 3600 * 1000,
      excludes: ['.git', '__pycache__', '.DS_Store'],
      options: { ...defaultWatchOptions, command: 'pm2 restart newsbot' },
    },
  ];
}

function sampleTransfers(): Transfer[] {
  const now = Date.now();
  return [
    { id: 't-welcome', name: 'welcome.py', direction: 'up', serverId: 'ob', folder: 'cogs', source: '~/Projekte/taskbot/live/cogs/welcome.py', target: '/home/ubuntu/bots/taskbot/cogs/welcome.py', size: 8192, done: 8192, state: 'done', watchId: 'w1', finishedAt: now - 12000 },
    { id: 't-cmd0', name: 'pm2 restart taskbot', direction: 'command', serverId: 'ob', folder: '', source: '', target: '', size: 1, done: 1, state: 'done', watchId: 'w1', finishedAt: now - 10000, output: '[PM2] Applying action restartProcessId on app [taskbot]\n[PM2] [taskbot](0) ✓' },
    { id: 't-app', name: 'app.css', direction: 'up', serverId: 'ob', folder: 'dashboard/static', source: '~/Projekte/taskbot/live/dashboard/static/app.css', target: '/home/ubuntu/bots/taskbot/dashboard/static/app.css', size: 48 * 1024, done: 0, state: 'queued', watchId: 'w1' },
  ];
}

export const allTools: Array<{ id: ToolId; label: string }> = [
  { id: 'nav', label: $t('Zurück / Vor') },
  { id: 'newFolder', label: $t('Neuer Ordner') },
  { id: 'refresh', label: $t('Aktualisieren') },
  { id: 'info', label: $t('Informationen') },
  { id: 'activity', label: $t('Aktivität') },
  { id: 'upload', label: $t('Hochladen') },
  { id: 'download', label: $t('Herunterladen') },
  { id: 'delete', label: $t('Löschen') },
  { id: 'rename', label: $t('Umbenennen') },
  { id: 'perms', label: $t('Rechte') },
  { id: 'hidden', label: $t('Versteckte Dateien') },
  { id: 'terminal', label: $t('Terminal (SSH)') },
  { id: 'disconnect', label: $t('Trennen') },
  { id: 'copyPath', label: $t('Pfad kopieren') },
  { id: 'editor', label: $t('Im Editor öffnen') },
  { id: 'sync', label: $t('Ordner abgleichen') },
  { id: 'syncBrowse', label: $t('Synchron blättern') },
  { id: 'compareDirs', label: $t('Verzeichnisse vergleichen') },
  { id: 'selectMask', label: $t('Auswählen nach Muster') },
  { id: 'palette', label: $t('Befehle') },
];

/**
 * Standard toolbar: the everyday actions, grouped (see Toolbar.tsx); everything
 * else is in the menus, the context menu and the command palette, and can be
 * added via "Werkzeugleiste anpassen".
 */
export const defaultToolbar: ToolId[] = ['nav', 'upload', 'download', 'newFolder', 'refresh', 'sync', 'syncBrowse', 'terminal', 'info', 'activity'];
/** Earlier standard toolbars (up to 0.2.38, up to 0.2.43): users who never changed theirs get the new one. */
export const oldDefaultToolbars: ToolId[][] = [['nav', 'newFolder', 'refresh', 'info', 'activity'], ['nav', 'upload', 'download', 'newFolder', 'refresh', 'sync', 'syncBrowse', 'info', 'activity']];

function detectPlatform(): Platform {
  const p = (navigator.platform || '') + ' ' + navigator.userAgent;
  return /Win/i.test(p) ? 'win' : 'mac';
}

function detectTheme(): Theme {
  // A host page (e.g. the artifact viewer) may already fix the theme on the root element.
  const fixed = document.documentElement.dataset.theme;
  if (fixed === 'dark' || fixed === 'light') return fixed;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 360;
export const SIDEBAR_DEFAULT = 224;

/** Reads the remembered sidebar width (browser prototype: localStorage). */
function loadSidebarWidth(): number {
  try {
    const v = Number(window.localStorage.getItem('bitcrane.sidebarWidth'));
    if (v >= SIDEBAR_MIN && v <= SIDEBAR_MAX) return v;
  } catch {
    // Storage can be unavailable (private window, sandbox); fall back to the default.
  }
  return SIDEBAR_DEFAULT;
}

function initialState(): AppState {
  const servers = LIVE ? [] : sampleServers();
  return {
    platform: detectPlatform(),
    terminals: [],
    tunnels: [],
    explorerFolders: {},
    theme: detectTheme(),
    palette: 'auto',
    firstRun: false,
    servers,
    tabs: LIVE ? [] : [
      { id: 'tab1', serverId: 'ob', localPath: servers[0].localStart, remotePath: servers[0].remoteStart, back: [], forward: [] },
      { id: 'tab2', serverId: '', localPath: '~', remotePath: '', back: [], forward: [] },
    ],
    activeTabId: LIVE ? '' : 'tab1',
    watches: LIVE ? [] : sampleWatches(),
    transfers: LIVE ? [] : sampleTransfers(),
    selection: LIVE
      ? { local: { names: [], cursor: -1, anchor: -1 }, remote: { names: [], cursor: -1, anchor: -1 } }
      : { local: { names: ['bot.py'], cursor: 3, anchor: 3 }, remote: { names: [], cursor: -1, anchor: -1 } },
    focusSide: 'local',
    inspectorOpen: false,
    activityOpen: false,
    activityFilter: 'all',
    compareDirs: false,
    afterQueue: 'none',
    transferRule: '',
    cloudAvailable: { dropbox: !LIVE, onedrive: !LIVE },
    popoverOpen: false,
    menuBarWindowOpen: false,
    appMenu: null,
    sidebarWidth: loadSidebarWidth(),
    dialog: null,
    contextMenu: null,
    renaming: null,
    renamingGroup: null,
    pathEdit: null,
    folderSizes: {},
    edits: [],
    clipboard: null,
    search: '',
    searchSide: 'local',
    deepSearchOn: false,
    deepSearch: null,
    toolbar: [...defaultToolbar],
    toolbarLabels: 'icons',
    settings: {
      runInBackground: true, showMenuBarIcon: true, startAtLogin: false, defaultDelay: 2,
      defaultExcludes: ['.git', '__pycache__', '.DS_Store', '*.log', '*.tmp'], defaultMirrorDeletes: false,
      notify: 'errors', soundOnError: true, soundOnDone: false, dockProgress: true, themeSetting: 'system',
      showHidden: true, confirmDelete: true, parallel: 2,
      language: LANG, startLocal: '~', startServer: '', fileDoubleClick: 'open', uploadFilePerms: '', uploadDirPerms: '', cloudAsked: false, serverGroups: [], splitRatio: 0.5, serverSourcesWidth: 200, activityHeight: 240, uploadTempName: true, keepMtime: true, existingFiles: 'ask', existingDownload: 'ask', bandwidthLimit: 0,
      autoRetry: true, updateMode: 'auto', skipUnchanged: true, skipPatterns: ['.DS_Store', 'Thumbs.db', 'desktop.ini'], skipLargerMb: 0,
      // The prototype shows one example rule, used by "Cloud · Bots".
      rules: LIVE ? [] : [{ id: 'rule-bot', name: 'Bot', excludes: ['venv', '__pycache__', '*.log', '.git'], filePerms: '644', dirPerms: '755', existingUp: 'overwrite', keepOldVersion: true }],
      autoReconnect: true, keepAlive: true, readSshConfig: true, writeLog: false, watchTemplates: [],
      showPerms: false, sort: { local: { key: 'name', dir: 1 }, remote: { key: 'name', dir: 1 } }, swapSides: false, editorApp: '', editorByExt: {},
      shortcuts: {}, columns: { mtime: true, size: true }, logLevel: 'normal', recentAddresses: [], serverDefaults: {}, syncFavorites: [], sftpLinks: false,
      viewMode: { local: 'list', remote: 'list' },
    },
    offline: {},
    conflicts: [],
    fsRev: 0,
    now: Date.now(),
    toast: null,
    speed: 0,
    drives: [],
    places: [
      { name: 'Alex', path: '~' },
      { name: 'Projekte', path: '~/Projekte' },
      { name: 'Schreibtisch', path: '~/Schreibtisch' },
      { name: 'Downloads', path: '~/Downloads' },
    ],
    homeName: 'Alex',
    update: null,
    dropHint: null,
    expanded: { local: [], remote: [] },
  };
}

/* ------------------------------------------------------------------------ */
/* Store plumbing                                                           */
/* ------------------------------------------------------------------------ */

let state: AppState = initialState();
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

/** Replaces parts of the state and notifies subscribers. */
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function subscribeStore(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** React hook: selects a slice of the state and re-renders when it changes. */
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribeStore, () => selector(state));
}

let idCounter = 0;
export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

/* ------------------------------------------------------------------------ */
/* Derived helpers                                                          */
/* ------------------------------------------------------------------------ */

export function activeTab(s: AppState = state): Tab | undefined {
  return s.tabs.find((t) => t.id === s.activeTabId);
}

export function serverById(id: string, s: AppState = state): Server | undefined {
  return s.servers.find((x) => x.id === id);
}

/** Path shown by a pane of the active tab. */
export function panePath(side: PaneSide, s: AppState = state): string {
  const t = activeTab(s);
  if (!t) return side === 'local' ? '~' : '/';
  return side === 'local' ? t.localPath : t.remotePath;
}

/**
 * Where a pane's files are, as [side for file operations, server id]. The
 * right half always shows the tab's server. The left half shows this computer,
 * or in server-to-server mode a second server and then behaves like a server pane.
 */
export function paneLoc(side: PaneSide, t: Tab | undefined = activeTab()): [PaneSide, string] {
  if (!t) return [side, ''];
  if (side === 'local' && t.leftServerId) return ['remote', t.leftServerId];
  if (side === 'remote' && t.rightLocal && !t.serverId) return ['local', ''];
  return [side, t.serverId];
}

/**
 * True when a half shows the server list instead of files (Transmit's
 * connection panel): the right half while the tab has no server yet, or
 * either half after the user switched it there.
 */
export function paneShowsServers(side: PaneSide, t: Tab | undefined = activeTab()): boolean {
  if (!t) return side === 'remote';
  if (side === 'remote' && !t.serverId && !t.rightLocal) return true;
  return !!t.serverList?.[side];
}

/** Switches a half between its files and the server list. */
export function setPaneServerList(side: PaneSide, on: boolean) {
  const t = activeTab();
  if (!t) return;
  // Without a server the right half has no files to go back to.
  if (!on && side === 'remote' && !t.serverId && !t.rightLocal) return;
  updateTab({ serverList: { ...t.serverList, [side]: on } });
  setState({ focusSide: side, contextMenu: null });
}

/** Name of a tab: its server, or "Neuer Tab" while none is chosen. */
export function tabTitle(t: Tab, s: AppState = state): string {
  if (t.settings) return $t('Einstellungen');
  const right = t.serverId ? serverById(t.serverId, s)?.name : undefined;
  const left = t.leftServerId ? serverById(t.leftServerId, s)?.name : undefined;
  if (right && left) return `${left} ↔ ${right}`;
  if (!right && !left && t.rightLocal) return s.platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC');
  return right ?? left ?? $t('Neuer Tab');
}

/** A tab without a server: this computer on the left, the server list on the right. */
export function emptyTab(localPath = '~', right: 'servers' | 'local' | undefined = state.settings.newTabRight): Tab {
  // Setting "Neuer Tab rechts": the server list (default) or this computer (two local halves).
  const local = right === 'local';
  return { id: uid('tab'), serverId: '', localPath, remotePath: local ? localPath : '', back: [], forward: [], ...(local ? { rightLocal: true } : {}) };
}

/**
 * Two local halves (Total Commander): the right half shows a folder of this
 * computer instead of a server. A server shown there is closed first.
 */
export function setRightLocal(path?: string) {
  const t = activeTab();
  if (!t) return;
  if (t.serverId) closePaneServer('remote');
  const cur = activeTab() ?? t;
  updateTab({ rightLocal: true, serverId: '', remotePath: path ?? (cur.rightLocal && cur.remotePath ? cur.remotePath : cur.leftServerId ? '~' : cur.localPath), back: [], forward: [], syncBrowse: undefined, serverList: { ...cur.serverList, remote: false } });
  setState((s) => ({ selection: { ...s.selection, remote: { names: [], cursor: -1, anchor: -1 } }, expanded: { ...s.expanded, remote: [] }, focusSide: 'remote', contextMenu: null }));
}

/**
 * Connects a server into a half (from the server list or "Schnell verbinden").
 * The left half then shows that server (server to server), the right half
 * becomes the tab's server.
 */
export function openServerIn(side: PaneSide, serverId: string) {
  const t = activeTab();
  const srv = serverById(serverId);
  if (!t || !srv) return;
  setState((st) => ({ servers: st.servers.map((x) => (x.id === serverId ? { ...x, lastUsed: Date.now() } : x)), firstRun: false }));
  if (side === 'local') {
    updateTab({ serverList: { ...t.serverList, local: false } });
    setLeftServer(serverId);
    return;
  }
  // Without a start folder the server's home folder is used; it is known only once connected
  // (an already open connection, e.g. of a folder watch, does not report it again).
  const start = srv.remoteStart || (LIVE && live.isConnected(serverId) ? live.homeOf(serverId) ?? '' : '');
  updateTab({ serverId, rightLocal: false, remotePath: start, back: [], forward: [], syncBrowse: undefined, serverList: { ...t.serverList, remote: false } });
  setState((s) => ({ selection: { ...s.selection, remote: { names: [], cursor: -1, anchor: -1 } }, expanded: { ...s.expanded, remote: [] }, focusSide: 'remote' }));
  if (LIVE) {
    if (!live.isConnected(serverId)) live.connectNow(serverId);
  } else {
    setState((s) => ({ servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: true } : x)) }));
    showToast($t('Verbunden mit {0}', srv.name), 'ok');
  }
}

/** True when the pane shows a server (the right half, or the left one in server-to-server mode). */
export const paneOnServer = (side: PaneSide, t: Tab | undefined = activeTab()) => paneLoc(side, t)[0] === 'remote';

/** Server to server: shows a server in the left half, or this computer again (''). */
export function setLeftServer(serverId: string) {
  const t = activeTab();
  if (!t) return;
  const srv = serverId ? serverById(serverId) : undefined;
  if (serverId && !srv) return;
  if ((t.leftServerId ?? '') === serverId) {
    setState({ contextMenu: null });
    return;
  }
  // An empty path is filled with the server's home folder once connected.
  const localPath = srv ? srv.remoteStart || (LIVE ? (live.isConnected(srv.id) ? live.homeOf(srv.id) ?? '' : '') : '/') : (state.servers.find((x) => x.id === t.serverId)?.localStart || '~');
  setState((s) => ({
    tabs: s.tabs.map((x) => (x.id === t.id ? { ...x, leftServerId: srv?.id, localPath, back: [], forward: [], syncBrowse: undefined } : x)),
    selection: { ...s.selection, local: { names: [], cursor: -1, anchor: -1 } },
    contextMenu: null,
  }));
  if (srv && LIVE && !live.isConnected(srv.id)) live.connectNow(srv.id);
  if (srv && !LIVE) setState((s) => ({ servers: s.servers.map((x) => (x.id === srv.id ? { ...x, online: true } : x)) }));
}

/** Folder listing: mock file system, or the live listing cache (undefined until loaded). */
export function listEntries(side: PaneSide, serverId: string, path: string): FileEntry[] | undefined {
  return LIVE ? live.cachedList(side, serverId, path) : fs.list(side, serverId, path);
}

/** Single entry by path, or undefined when unknown. */
export function statEntry(side: PaneSide, serverId: string, path: string): FileEntry | undefined {
  return LIVE ? live.cachedStat(side, serverId, path) : fs.stat(side, serverId, path);
}

/** True when the path is a folder. */
export function isDirEntry(side: PaneSide, serverId: string, path: string): boolean {
  return LIVE ? live.cachedStat(side, serverId, path)?.kind === 'dir' : fs.isDir(side, serverId, path);
}

/** Loading / error / connection state of a pane (live mode only). */
export function paneStatus(side: PaneSide, s: AppState = state): { loading: boolean; error?: string; notConnected?: boolean; connecting?: boolean } {
  if (!LIVE) return { loading: false };
  const t = activeTab(s);
  if (!t) return { loading: false };
  const [ls, sid] = paneLoc(side, t);
  if (ls === 'remote' && !live.isConnected(sid)) return { loading: false, notConnected: true, connecting: live.isConnecting(sid) };
  return live.listingStatus(ls, sid, panePath(side, s));
}

/** Lists a pane, applying the hidden-file setting and the search filter. */
/**
 * Rows of a pane: the folder's entries, sorted and filtered, and below each
 * opened folder (triangle in the list) its entries indented. Rows of opened
 * folders carry their path relative to the folder shown as `name` (e.g.
 * "cogs/welcome.py") and their nesting level as `depth`.
 */
export function paneEntries(side: PaneSide, s: AppState = state): FileEntry[] {
  const t = activeTab(s);
  if (!t || paneShowsServers(side, t)) return [];
  const loc = paneLoc(side, t);
  const base = panePath(side, s);
  const open = new Set(s.settings.viewMode[side] === 'list' ? s.expanded[side] : []);
  const q = s.searchSide === side ? s.search.trim().toLowerCase() : '';
  const level = (rel: string, depth: number): FileEntry[] => {
    let list = listEntries(...loc, rel ? paths.join(base, rel) : base) ?? [];
    // Protected system items (e.g. Windows' old "Anwendungsdaten" junctions) stay out like in Explorer;
    // dot files and items marked hidden follow "Versteckte Dateien zeigen".
    if (!s.settings.showSystem) list = list.filter((e) => (e.hidden ?? 0) < 2);
    if (!s.settings.showHidden) list = list.filter((e) => !e.name.startsWith('.') && !e.hidden);
    list = sortEntries(list, s.settings.sort[side]);
    const out: FileEntry[] = [];
    for (const e of list) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      const opened = e.kind === 'dir' && open.has(name);
      // The search filter shows matching rows and keeps opened folders with matches inside.
      const inner = opened ? level(name, depth + 1) : [];
      if (!q || e.name.toLowerCase().includes(q) || inner.length) out.push({ ...e, name, depth }, ...inner);
    }
    return out;
  };
  return level('', 0);
}

/** Opens or closes a folder in place (triangle in the list view). */
export function toggleExpand(side: PaneSide, rel: string) {
  const t = activeTab();
  if (!t) return;
  const cur = state.expanded[side];
  const open = cur.includes(rel);
  // Closing a folder also closes the folders inside it.
  const next = open ? cur.filter((x) => x !== rel && !x.startsWith(`${rel}/`)) : [...cur, rel];
  setState((s) => ({ expanded: { ...s.expanded, [side]: next } }));
  if (!open && LIVE) live.requestListing(...paneLoc(side, t), paths.join(panePath(side), rel));
}

/** Switches a half between list and icons. */
export function setViewMode(side: PaneSide, mode: 'list' | 'icons') {
  setState((s) => ({ settings: { ...s.settings, viewMode: { ...s.settings.viewMode, [side]: mode } } }));
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** Kind of an entry for the "Art" column ("Ordner", "PNG-Bild" …). */
export const kindOf = (e: FileEntry) => describeFile(e.name.slice(e.name.lastIndexOf('/') + 1), e.kind);

/** Sorts a listing; folders always come first, names break ties. */
export function sortEntries(list: FileEntry[], order: { key: SortKey; dir: 1 | -1 }): FileEntry[] {
  const byName = (a: FileEntry, b: FileEntry) => collator.compare(a.name.replace(/^\./, ''), b.name.replace(/^\./, ''));
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    let c = 0;
    if (order.key === 'mtime') c = a.mtime - b.mtime;
    else if (order.key === 'size') c = a.size - b.size;
    else if (order.key === 'perms') c = a.perms.localeCompare(b.perms);
    else if (order.key === 'kind') c = collator.compare(kindOf(a), kindOf(b));
    else if (order.key === 'owner') c = collator.compare(a.owner ?? '', b.owner ?? '');
    return (c || byName(a, b)) * order.dir;
  });
}

/** Click on a column header: sort by it, a second click reverses. */
export function setSort(side: PaneSide, key: SortKey) {
  setState((s) => {
    const cur = s.settings.sort[side];
    const next = { key, dir: (cur.key === key ? -cur.dir : key === 'name' ? 1 : -1) as 1 | -1 };
    return { settings: { ...s.settings, sort: { ...s.settings.sort, [side]: next } } };
  });
}

/** Zoom steps of the window, like a browser. */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** Strg + Plus / Minus / 0: one zoom step larger, smaller, or back to 100 %. */
export function stepZoom(dir: 1 | -1 | 0) {
  const cur = state.settings.zoom ?? 1;
  // Nearest step to the current zoom, then one step in the wanted direction.
  const at = ZOOM_STEPS.reduce((best, z, i) => (Math.abs(z - cur) < Math.abs(ZOOM_STEPS[best] - cur) ? i : best), 0);
  const next = dir === 0 ? 1 : ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, at + dir))];
  setState((s) => ({ settings: { ...s.settings, zoom: next } }));
  showToast($t('Zoom: {0} %', Math.round(next * 100)));
}

/** Icons view: one size step larger or smaller (slider, Strg + mouse wheel). */
export function setIconSize(side: PaneSide, step: number) {
  const v = Math.max(0, Math.min(3, Math.round(step)));
  setState((s) => ({ settings: { ...s.settings, iconSize: { ...s.settings.iconSize, [side]: v } } }));
}

export const togglePermsColumn = () => setState((s) => ({ settings: { ...s.settings, showPerms: !s.settings.showPerms } }));
export const toggleSwapSides = () => setState((s) => ({ settings: { ...s.settings, swapSides: !s.settings.swapSides } }));

/** Watch that covers the given local path, if any. */
export function watchForLocal(path: string, s: AppState = state): Watch | undefined {
  return s.watches.find((w) => path === w.localPath || path.startsWith(w.localPath + '/'));
}

export function isOffline(serverId: string, s: AppState = state): boolean {
  return !!s.offline[serverId];
}

/** True when the activity should be expanded: user choice or an open error. */
export function activityExpanded(s: AppState = state): boolean {
  return s.activityOpen || s.transfers.some((t) => t.state === 'error');
}

/* ------------------------------------------------------------------------ */
/* Toast                                                                    */
/* ------------------------------------------------------------------------ */

let toastTimer: number | undefined;
export function showToast(text: string, tone: 'info' | 'ok' | 'error' | 'update' = 'info') {
  setState({ toast: { text, tone } });
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setState({ toast: null }), 2600);
}

/* ------------------------------------------------------------------------ */
/* Look                                                                     */
/* ------------------------------------------------------------------------ */

export function setPlatform(platform: Platform) {
  setState({ platform, appMenu: null, contextMenu: null });
}

export function setTheme(theme: Theme) {
  setState((s) => ({ theme, settings: { ...s.settings, themeSetting: theme } }));
}

export function setThemeSetting(themeSetting: 'system' | Theme) {
  setState((s) => ({ settings: { ...s.settings, themeSetting }, theme: themeSetting === 'system' ? detectTheme() : themeSetting }));
}

/* ------------------------------------------------------------------------ */
/* Tabs and navigation                                                      */
/* ------------------------------------------------------------------------ */

function clearSelection(): Record<PaneSide, PaneSelection> {
  return { local: { names: [], cursor: -1, anchor: -1 }, remote: { names: [], cursor: -1, anchor: -1 } };
}

export function selectTab(id: string) {
  setState({ activeTabId: id, selection: clearSelection(), renaming: null, search: '', popoverOpen: false, expanded: { local: [], remote: [] } });
  const t = state.tabs.find((x) => x.id === id);
  if (LIVE && t) {
    if (t.leftServerId && t.serverId) live.autoConnectPair(t.serverId, t.leftServerId);
    else if (t.leftServerId) live.autoConnect(t.leftServerId);
    else if (t.serverId) live.autoConnect(t.serverId);
  }
}

/** Opens a server in a new tab, or switches to its existing tab. */
/** Opens another tab for a server, even when one is already open. */
export function openServerInNewTab(serverId: string) {
  const srv = serverById(serverId);
  if (!srv) return;
  if (srv.openAs === 'terminal' && (!srv.protocol || srv.protocol === 'sftp')) {
    void import('./terminal').then((m) => m.openServerTerminal(serverId));
    return;
  }
  const tab: Tab = { id: uid('tab'), serverId, localPath: srv.localStart || '~', remotePath: srv.remoteStart, back: [], forward: [] };
  setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, selection: clearSelection(), firstRun: false, contextMenu: null }));
  if (LIVE && !live.isConnected(serverId)) live.connectNow(serverId);
}

/** Asks before removing a saved server; its watches are removed as well. */
export function askRemoveServer(id: string) {
  const srv = serverById(id);
  if (!srv) return;
  const watches = state.watches.filter((w) => w.serverId === id);
  openDialog({
    type: 'confirm', danger: true, confirm: $t('Entfernen'),
    title: $t('„{0}“ entfernen?', srv.name),
    text: watches.length
      ? watches.length === 1
        ? $t('Auch die Überwachung {0} wird entfernt. Dateien auf dem Server und auf diesem Computer bleiben, wie sie sind.', `„${watches[0].name}“`)
        : $t('Auch die {0} Überwachungen {1} werden entfernt. Dateien auf dem Server und auf diesem Computer bleiben, wie sie sind.', watches.length, watches.map((w) => `„${w.name}“`).join(', '))
      : $t('Dateien auf dem Server und auf diesem Computer bleiben, wie sie sind.'),
    run: () => {
      deleteServer(id);
      setState((s) => ({ watches: s.watches.filter((w) => w.serverId !== id) }));
      showToast($t('„{0}“ entfernt.', srv.name));
    },
  });
}

export function openServer(serverId: string, files = false) {
  // Servers set to open as a terminal (SSH only): a terminal tab instead of the files.
  const target = serverById(serverId);
  if (!files && target?.openAs === 'terminal' && (!target.protocol || target.protocol === 'sftp')) {
    void import('./terminal').then((m) => m.openServerTerminal(serverId));
    return;
  }
  setState((st) => ({ servers: st.servers.map((x) => (x.id === serverId ? { ...x, lastUsed: Date.now() } : x)) }));
  const s = state;
  const existing = s.tabs.find((t) => t.serverId === serverId);
  if (existing) {
    selectTab(existing.id);
    if (LIVE) live.connectNow(serverId);
    return;
  }
  // A tab without a server takes it (like choosing it in that tab's server list).
  const cur = activeTab();
  if (cur && !cur.serverId) {
    openServerIn('remote', serverId);
    return;
  }
  const srv = serverById(serverId);
  if (!srv) return;
  const tab: Tab = { id: uid('tab'), serverId, localPath: srv.localStart || '~', remotePath: srv.remoteStart, back: [], forward: [] };
  if (LIVE) {
    setState({ tabs: [...s.tabs, tab], activeTabId: tab.id, selection: clearSelection(), expanded: { local: [], remote: [] }, firstRun: false });
    if (!live.isConnected(serverId)) live.connectNow(serverId);
    return;
  }
  setState({
    tabs: [...s.tabs, tab],
    activeTabId: tab.id,
    selection: clearSelection(),
    servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: true } : x)),
  });
  showToast($t('Verbunden mit {0}', srv.name), 'ok');
}

/** "+": a new tab with this computer on the left and the server list on the right. */
export function newTab() {
  const t = activeTab();
  const tab = emptyTab(t && !t.leftServerId ? t.localPath : '~');
  setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, selection: clearSelection(), expanded: { local: [], remote: [] }, contextMenu: null }));
}

/** Closes a tab; the last one becomes a new, empty tab (like WinSCP). */
export function closeTab(id: string) {
  const s = state;
  const idx = s.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  let tabs = s.tabs.filter((t) => t.id !== id);
  if (!tabs.length) tabs = [emptyTab(s.tabs[idx].leftServerId ? '~' : s.tabs[idx].localPath)];
  const activeTabId = s.activeTabId === id ? tabs[Math.max(0, Math.min(idx - 1, tabs.length - 1))].id : s.activeTabId;
  setState({ tabs, activeTabId, selection: s.activeTabId === id ? clearSelection() : s.selection, expanded: s.activeTabId === id ? { local: [], remote: [] } : s.expanded });
}

function updateTab(patch: Partial<Tab>) {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, ...patch } : t)) }));
}

/** Navigates one pane to a path and records it for "Zurück". */
export function navigate(side: PaneSide, path: string, record = true) {
  const t = activeTab();
  if (!t) return;
  const [ls, sid] = paneLoc(side, t);
  if (ls === 'remote' && isOffline(sid)) {
    showToast($t('Keine Verbindung zum Server.'), 'error');
    return;
  }
  const current = side === 'local' ? t.localPath : t.remotePath;
  if (current === path) return;
  const patch: Partial<Tab> = side === 'local' ? { localPath: path } : { remotePath: path };
  if (record) {
    patch.back = [...t.back, { side, path: current }];
    patch.forward = [];
  }
  // Synchronized browsing: the other side goes to the matching folder.
  const sb = t.syncBrowse;
  const base = sb ? (side === 'local' ? sb.local : sb.remote) : '';
  let other: PaneSide | null = null;
  if (sb && (path === base || path.startsWith(base === '/' ? '/' : base + '/'))) {
    other = side === 'local' ? 'remote' : 'local';
    const rel = path.slice(base.length).replace(/^\//, '');
    const otherBase = side === 'local' ? sb.remote : sb.local;
    const otherPath = rel ? paths.join(otherBase, rel) : otherBase;
    if (other === 'local') patch.localPath = otherPath; else patch.remotePath = otherPath;
  } else if (sb) {
    // Left the shared folders: synchronized browsing ends.
    patch.syncBrowse = undefined;
    showToast($t('Synchron blättern beendet: der Ordner liegt außerhalb der verbundenen Ordner.'));
  }
  updateTab(patch);
  setState((s) => ({
    selection: { ...s.selection, [side]: { names: [], cursor: 0, anchor: 0 }, ...(other ? { [other]: { names: [], cursor: -1, anchor: -1 } } : {}) },
    expanded: { ...s.expanded, [side]: [], ...(other ? { [other]: [] } : {}) },
    focusSide: side, renaming: null,
  }));
}

/** "Synchron blättern" on or off for the current tab (starts from the folders shown now). */
export function toggleSyncBrowse() {
  const t = activeTab();
  if (!t) return;
  if (t.syncBrowse) {
    updateTab({ syncBrowse: undefined });
    showToast($t('Synchron blättern aus.'));
  } else {
    updateTab({ syncBrowse: { local: t.localPath, remote: t.remotePath } });
    showToast($t('Synchron blättern an: Ordnerwechsel auf einer Seite gilt auch für die andere.'));
  }
}

export function goBack() {
  const t = activeTab();
  if (!t || !t.back.length) return;
  const last = t.back[t.back.length - 1];
  const current = last.side === 'local' ? t.localPath : t.remotePath;
  updateTab({
    back: t.back.slice(0, -1),
    forward: [...t.forward, { side: last.side, path: current }],
    ...(last.side === 'local' ? { localPath: last.path } : { remotePath: last.path }),
  });
  setState((s) => ({ selection: { ...s.selection, [last.side]: { names: [], cursor: 0, anchor: 0 } }, focusSide: last.side }));
}

export function goForward() {
  const t = activeTab();
  if (!t || !t.forward.length) return;
  const next = t.forward[t.forward.length - 1];
  const current = next.side === 'local' ? t.localPath : t.remotePath;
  updateTab({
    forward: t.forward.slice(0, -1),
    back: [...t.back, { side: next.side, path: current }],
    ...(next.side === 'local' ? { localPath: next.path } : { remotePath: next.path }),
  });
}

/** Entries of the folder shown that are hidden by the settings (status line "2 versteckt", like WinSCP). */
export function hiddenCount(side: PaneSide, s: AppState = state): number {
  const t = activeTab(s);
  if (!t || paneShowsServers(side, t)) return 0;
  const list = listEntries(...paneLoc(side, t), panePath(side, s)) ?? [];
  return list.filter((e) => (!s.settings.showSystem && (e.hidden ?? 0) >= 2) || (!s.settings.showHidden && (e.name.startsWith('.') || !!e.hidden))).length;
}

/**
 * Rule in effect for a server, or for a watch (its own choice, else its server's).
 * Undefined = the general settings.
 */
export function ruleFor(serverId: string, watchId?: string, s: AppState = state, useChoice = true): TransferRule | undefined {
  const rules = s.settings.rules ?? [];
  // Transfers by hand follow the rule chosen in the activity area (WinSCP "Transfer settings"), if any.
  if (!watchId && useChoice && s.transferRule) return s.transferRule === 'none' ? undefined : rules.find((r) => r.id === s.transferRule);
  const w = watchId ? s.watches.find((x) => x.id === watchId) : undefined;
  if (w?.ruleId === 'none') return undefined;
  const id = w?.ruleId ?? s.servers.find((x) => x.id === serverId)?.ruleId;
  return id ? rules.find((r) => r.id === id) : undefined;
}

/** Excludes of a watch together with those of its rule. */
export function watchExcludes(w: Watch, s: AppState = state): string[] {
  const r = ruleFor(w.serverId, w.id, s);
  return r?.excludes.length ? [...new Set([...w.excludes, ...r.excludes])] : w.excludes;
}

/** Adds, changes or removes a rule; servers and watches using a removed rule fall back. */
export function saveRule(rule: TransferRule) {
  setState((s) => {
    const list = s.settings.rules ?? [];
    return { settings: { ...s.settings, rules: list.some((r) => r.id === rule.id) ? list.map((r) => (r.id === rule.id ? rule : r)) : [...list, rule] } };
  });
}

export function removeRule(id: string) {
  setState((s) => ({
    settings: { ...s.settings, rules: (s.settings.rules ?? []).filter((r) => r.id !== id) },
    servers: s.servers.map((x) => (x.ruleId === id ? { ...x, ruleId: undefined } : x)),
    watches: s.watches.map((w) => (w.ruleId === id ? { ...w, ruleId: undefined } : w)),
  }));
}

export function newRuleId(): string {
  return uid('rule');
}

/** True when the folder shown has a parent to go up to (for the ".." row). */
export function canGoUp(side: PaneSide): boolean {
  const path = panePath(side);
  return !!path && paths.parent(path) !== path;
}

export function goUp(side: PaneSide) {
  const path = panePath(side);
  const up = paths.parent(path);
  if (up !== path) {
    navigate(side, up);
    // Put the cursor on the folder we came from.
    const entries = paneEntries(side);
    const idx = entries.findIndex((e) => e.name === paths.basename(path));
    if (idx >= 0) setState((s) => ({ selection: { ...s.selection, [side]: { names: [entries[idx].name], cursor: idx, anchor: idx } } }));
  }
}

/** Opens a folder entry; files are opened "im Editor" (simulated). */
export function openEntry(side: PaneSide, name: string) {
  const path = paths.join(panePath(side), name);
  const t = activeTab();
  if (!t) return;
  const [ls] = paneLoc(side, t);
  if (isDirEntry(...paneLoc(side, t), path)) navigate(side, path);
  // zip and tar on this computer open like a folder (ForkLift); "Mit Standardprogramm öffnen" is in the context menu.
  else if (ls === 'local' && LIVE && paths.isArchiveName(name)) navigate(side, path);
  else if (LIVE) {
    // Local files open with their default program; server files in the editor (uploaded on save).
    if (ls === 'local') live.openLocal(path);
    else openInEditor(side, name);
  } else showToast(ls === 'local' ? $t('„{0}“ wird im Standard-Programm geöffnet.', name) : $t('„{0}“ wird geladen und im Editor geöffnet. Änderungen gehen beim Sichern zurück auf den Server.', name));
}

/**
 * Double click, Enter (Windows) or ⌘↓ on a row. Folders open; files do what
 * "Doppelklick auf eine Datei" says (Transmit: open, edit or transfer).
 */
export function activateEntry(side: PaneSide, name: string) {
  const t = activeTab();
  if (!t) return;
  const path = paths.join(panePath(side), name);
  const mode = state.settings.fileDoubleClick;
  if (isDirEntry(...paneLoc(side, t), path) || mode === 'open') {
    openEntry(side, name);
    return;
  }
  if (mode === 'edit') {
    openInEditor(side, name);
    return;
  }
  // Transfer into the folder shown by the other half.
  if (side === 'local') {
    if (!t.serverId) {
      showToast($t('Rechts ist noch kein Server verbunden.'));
      return;
    }
    upload([name]);
  } else download([name]);
}

/** "Im Editor öffnen": local files directly, server files as a working copy that is uploaded on save. */
export function openInEditor(side: PaneSide, name: string) {
  const t = activeTab();
  if (!t) return;
  const path = paths.join(panePath(side), name);
  setState({ contextMenu: null });
  const [ls, sid] = paneLoc(side, t);
  if (!LIVE) {
    showToast(ls === 'local' ? $t('„{0}“ wird im Editor geöffnet.', name) : $t('„{0}“ wird geladen und im Editor geöffnet. Änderungen gehen beim Sichern zurück auf den Server.', name));
    return;
  }
  if (ls === 'local') live.openLocal(path, editorFor(path));
  else void live.editRemote(sid, path);
}

/** "Terminal öffnen": an SSH session in the server folder, or a local terminal in the local folder. */
export function openTerminal(side: PaneSide = state.focusSide) {
  const t = activeTab();
  const [ls, sid] = paneLoc(side, t);
  const onServer = ls === 'remote';
  const srv = onServer ? serverById(sid) : undefined;
  setState({ contextMenu: null });
  if (onServer && srv?.protocol && srv.protocol !== 'sftp') {
    showToast($t('Ein Terminal auf dem Server gibt es nur bei SFTP-Servern (über SSH).'));
    return;
  }
  if (!LIVE) {
    showToast(onServer ? $t('Terminal mit {0} wird geöffnet.', srv?.name ?? $t('dem Server')) : $t('Terminal im lokalen Ordner wird geöffnet.'));
    return;
  }
  const home = t?.leftServerId ? '~' : panePath('local');
  const target = onServer && srv
    ? { host: srv.host, port: srv.port, user: srv.user, keyPath: srv.auth === 'key' ? srv.keyPath : undefined, remotePath: panePath(side), localPath: home }
    : { localPath: home };
  void invoke('open_terminal', { target }).catch((e) => showToast(String((e as { message?: string }).message ?? e), 'error'));
}

/* ------------------------------------------------------------- Places */

/** Places bar of a half: favourite folders of this computer, or of the server it shows. */
export function placesFor(side: PaneSide, s: AppState = state, t: Tab | undefined = activeTab(s)): Place[] {
  const [ls, sid] = paneLoc(side, t);
  if (ls === 'local') return s.settings.localPlaces ?? s.places;
  return serverById(sid, s)?.places ?? NO_PLACES;
}

/** Shared empty list, so store selectors keep a stable value. */
const NO_PLACES: Place[] = [];

function setPlaces(side: PaneSide, list: Place[]) {
  const [ls, sid] = paneLoc(side);
  if (ls === 'local') updateSettings({ localPlaces: list });
  else setState((s) => ({ servers: s.servers.map((x) => (x.id === sid ? { ...x, places: list } : x)) }));
}

/** Adds a folder to a half's places bar (dragged in, or ⌘D for the folder shown). */
export function addPlace(side: PaneSide, path: string) {
  const list = placesFor(side);
  if (list.some((p) => p.path === path)) {
    showToast($t('„{0}“ ist schon in der Ortsleiste.', paths.basename(path) || path));
    return;
  }
  const name = path === '~' ? state.homeName : paths.basename(path) || path;
  setPlaces(side, [...list, { name, path }]);
  showToast($t('„{0}“ zur Ortsleiste hinzugefügt.', name), 'ok');
}

export function removePlace(side: PaneSide, path: string) {
  setPlaces(side, placesFor(side).filter((p) => p.path !== path));
  setState({ contextMenu: null });
}

/** Moves a place before another one (`before` = null: to the end). */
export function movePlace(side: PaneSide, path: string, before: string | null) {
  const list = placesFor(side);
  const item = list.find((p) => p.path === path);
  if (!item || path === before) return;
  const rest = list.filter((p) => p.path !== path);
  const at = before === null ? rest.length : rest.findIndex((p) => p.path === before);
  rest.splice(at < 0 ? rest.length : at, 0, item);
  setPlaces(side, rest);
}

/**
 * Looks for Google Drive, OneDrive, Dropbox, iCloud Drive and Box folders and
 * offers the new ones as places (Transmit asks on its first start). `manual`:
 * from the settings, so "nothing found" is reported too.
 */
export async function offerCloudPlaces(manual: boolean) {
  const found: CloudPlace[] = LIVE
    ? await live.cloudPlaces()
    : [{ name: 'Google Drive', path: '~/Library/CloudStorage/GoogleDrive', service: 'gdrive' }, { name: 'OneDrive', path: '~/Library/CloudStorage/OneDrive-Personal', service: 'onedrive' }, { name: 'iCloud Drive', path: '~/Library/Mobile Documents/com~apple~CloudDocs', service: 'icloud' }];
  if (!manual) updateSettings({ cloudAsked: true });
  const known = new Set(placesForComputer().map((p) => p.path));
  const fresh = found.filter((c) => !known.has(c.path));
  if (!fresh.length) {
    if (manual) showToast(found.length ? $t('Alle gefundenen Cloud-Ordner sind schon in der Ortsleiste.') : $t('Auf diesem Rechner wurden keine Cloud-Ordner gefunden.'));
    return;
  }
  if (!manual && state.dialog) return;
  openDialog({ type: 'cloudPlaces', found: fresh });
}

/** Places of this computer (independent of what the left half shows right now). */
function placesForComputer(): Place[] {
  return state.settings.localPlaces ?? state.places;
}

/** Adds the cloud folders the user ticked to the places of this computer. */
export function addCloudPlaces(list: CloudPlace[]) {
  setState({ dialog: null });
  if (!list.length) return;
  const cur = placesForComputer();
  const add = list.filter((c) => !cur.some((p) => p.path === c.path)).map((c) => ({ name: c.name, path: c.path, cloud: c.service }));
  updateSettings({ localPlaces: [...cur, ...add] });
  showToast(add.length === 1 ? $t('„{0}“ zur Ortsleiste hinzugefügt.', add[0].name) : $t('{0} Cloud-Ordner zur Ortsleiste hinzugefügt.', add.length), 'ok');
}

/** ⌘D: the folder shown in the focused half goes into its places bar. */
export function addBookmark() {
  const side = state.focusSide;
  if (!activeTab() || paneShowsServers(side)) return;
  addPlace(side, panePath(side));
}

/** One line of "Ordner abgleichen" the user ticked; `rel` is relative to the tab's folders. */
export interface SyncAction {
  kind: 'upload' | 'download' | 'deleteRemote' | 'deleteLocal';
  rel: string;
  size: number;
}

/** Carries out the ticked lines of "Ordner abgleichen". */
export function runSync(actions: SyncAction[]) {
  const t = activeTab();
  setState({ dialog: null });
  if (!t || !actions.length) return;
  const { n, deleteCount } = runSyncBetween(placeOf('local', t), t.localPath, placeOf('remote', t), t.remotePath, actions);
  showToast($t('Abgleich gestartet: {0} {1}{2}.', n, n === 1 ? $t('Übertragung') : $t('Übertragungen'), deleteCount ? $t(', {0} zu löschen', deleteCount) : ''));
}

/**
 * Carries out sync actions between two places: this computer ('') or a server id,
 * each with its folder. "upload" goes from the left place to the right one,
 * "download" from right to left; this covers computer ↔ server, server ↔ server
 * and two folders of this computer. Used by the comparison window and by
 * scheduled comparisons. Returns the number of copies and deletes started.
 */
export function runSyncBetween(L: string, leftDir: string, R: string, rightDir: string, actions: SyncAction[]): { n: number; deleteCount: number } {
  const t = { localPath: leftDir, remotePath: rightDir };
  const items: Transfer[] = [];
  const localPairs: Array<[string, string]> = [];
  for (const a of actions) {
    if (a.kind !== 'upload' && a.kind !== 'download') continue;
    const toRight = a.kind === 'upload';
    const [from, to] = toRight ? [L, R] : [R, L];
    const source = paths.join(toRight ? t.localPath : t.remotePath, a.rel);
    const target = paths.join(toRight ? t.remotePath : t.localPath, a.rel);
    const base = { id: uid('t'), name: paths.basename(a.rel), folder: relFolder(toRight ? t.remotePath : t.localPath, target), source, target, size: a.size, done: 0, state: 'queued' as const, decided: true };
    if (!from && !to) localPairs.push([source, target]);
    else if (!from) items.push({ ...base, direction: 'up', serverId: to });
    else if (!to) items.push({ ...base, direction: 'down', serverId: from });
    else items.push({ ...base, direction: 'cross', sourceServerId: from, serverId: to });
  }
  enqueue(items);
  // Deletes per place: files in the trash on this computer, removed on a server.
  const deletes = new Map<string, string[]>();
  for (const a of actions) {
    if (a.kind !== 'deleteRemote' && a.kind !== 'deleteLocal') continue;
    const right = a.kind === 'deleteRemote';
    const place = right ? R : L;
    deletes.set(place, [...(deletes.get(place) ?? []), paths.join(right ? t.remotePath : t.localPath, a.rel)]);
  }
  const deleteCount = [...deletes.values()].reduce((n, l) => n + l.length, 0);
  if (LIVE) {
    void live.copyLocalFiles(localPairs);
    for (const [place, list] of deletes) void live.syncDeletes(place, place ? list : [], place ? [] : list);
  } else {
    for (const [place, list] of deletes) list.forEach((p) => fs.remove(place ? 'remote' : 'local', place, p));
    setState((s) => ({ fsRev: s.fsRev + 1 }));
  }
  return { n: items.length + localPairs.length, deleteCount };
}

/** Renames several entries at once (from the "Mehrere umbenennen" window). */
export function renameMany(side: PaneSide, pairs: Array<[string, string]>) {
  const t = activeTab();
  setState({ dialog: null });
  if (!t || !pairs.length) return;
  // The folder is fixed now; the user may switch tabs while the renames run.
  const dir = panePath(side);
  if (LIVE) {
    void (async () => {
      let ok = 0;
      for (const [from, to] of pairs) if (await live.renameEntry(...paneLoc(side, t), dir, from, to)) ok++;
      showToast(ok === pairs.length ? $t('{0} Objekte umbenannt.', ok) : $t('{0} von {1} umbenannt.', ok, pairs.length), ok === pairs.length ? 'ok' : 'error');
      if (state.activeTabId === t.id && panePath(side) === dir) setState((s) => ({ selection: { ...s.selection, [side]: { names: pairs.map((p) => p[1]), cursor: -1, anchor: -1 } } }));
    })();
    return;
  }
  for (const [from, to] of pairs) fs.rename(...paneLoc(side, t), paths.join(dir, from), to);
  setState((s) => ({ fsRev: s.fsRev + 1, selection: { ...s.selection, [side]: { names: pairs.map((p) => p[1]), cursor: -1, anchor: -1 } } }));
  showToast($t('{0} Objekte umbenannt.', pairs.length), 'ok');
}

/** Contents of an export file ("Einstellungen exportieren"). */
interface ExportFile {
  format: 'bitcrane-export';
  version: 1 | 2;
  servers?: Server[];
  watches?: Watch[];
  settings?: Partial<Settings>;
  /** Version 2, encrypted: the payload above (plus secrets) sealed with a password. */
  encrypted?: Sealed;
  /** Only inside an encrypted file: keychain entries (account -> secret). */
  secrets?: Record<string, string>;
}

/** "Server und Überwachungen exportieren …": asks for the options first. */
export function exportConfig() {
  openDialog({ type: 'exportConfig' });
}

/** Writes the export file; with a password it is encrypted and may carry the stored secrets. */
export async function writeExport(password: string, withSecrets: boolean): Promise<boolean> {
  const servers = state.servers.filter((x) => !x.temporary).map((x) => ({ ...x, online: false }));
  const payload: ExportFile = { format: 'bitcrane-export', version: 1, servers, watches: state.watches, settings: { ...state.settings } };
  if (!LIVE) {
    showToast($t('Export: {0} Server und {1} Überwachungen{2} (im Prototyp nicht gespeichert).', servers.length, state.watches.length, password ? $t(', verschlüsselt') : ''));
    return true;
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({ title: $t('Exportieren'), defaultPath: password ? 'bitcrane-export-verschluesselt.json' : 'bitcrane-export.json', filters: [{ name: 'Bitcrane', extensions: ['json'] }] }).catch(() => null);
  if (!path) return false;
  try {
    let file: ExportFile = payload;
    let secretCount = 0;
    if (password) {
      const secrets = withSecrets ? await live.collectSecrets(servers) : undefined;
      secretCount = secrets ? Object.keys(secrets).length : 0;
      file = { format: 'bitcrane-export', version: 2, encrypted: await seal(JSON.stringify({ ...payload, secrets }), password) };
    }
    await invoke('file_write', { path, text: JSON.stringify(file, null, 2) });
    showToast($t('Exportiert: {0} Server, {1} Überwachungen{2}.', servers.length, state.watches.length, password ? $t(', verschlüsselt{0}', secretCount ? $t(' mit {0} Passwörtern', secretCount) : '') : $t('. Passwörter sind nicht enthalten')), 'ok');
    return true;
  } catch (e) {
    showToast(String((e as { message?: string }).message ?? e), 'error');
    return false;
  }
}

/** "… importieren": adds servers and watches from an export file (same entries are replaced). */
export async function importConfig() {
  if (!LIVE) {
    showToast($t('Import einer Exportdatei geht im echten Programm.'));
    return;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({ title: $t('Importieren'), multiple: false, directory: false, filters: [{ name: 'Bitcrane', extensions: ['json'] }] }).catch(() => null);
  if (typeof path !== 'string') return;
  try {
    const data = JSON.parse(await invoke<string>('file_read', { path })) as ExportFile;
    if (data.format !== 'bitcrane-export') throw new Error($t('Das ist keine Exportdatei von Bitcrane.'));
    if (data.encrypted) openDialog({ type: 'importPassword', sealed: data.encrypted });
    else await applyImport(data);
  } catch (e) {
    showToast((e as Error).message || String(e), 'error');
  }
}

/** Decrypts an encrypted export; false when the password is wrong. */
export async function importSealed(sealed: Sealed, password: string): Promise<boolean> {
  let data: ExportFile;
  try {
    data = JSON.parse(await unseal(sealed, password)) as ExportFile;
  } catch {
    return false;
  }
  closeDialog();
  await applyImport(data);
  return true;
}

/** Same connection = same protocol, user, address and port (used to avoid duplicates on import). */
function connectionKey(x: { host: string; port: number; user: string; protocol?: string }) {
  return `${x.protocol ?? 'sftp'}|${x.user.toLowerCase()}@${x.host.toLowerCase()}:${x.port}`;
}

async function applyImport(data: ExportFile) {
  const merge = <T extends { id: string }>(cur: T[], add: T[]) => [...cur.filter((x) => !add.some((a) => a.id === x.id)), ...add];
  // A server that already exists here under another id (same connection) is not added twice;
  // watches of the imported copy are pointed at the existing server instead.
  const existing = new Map(state.servers.filter((x) => !x.temporary).map((x) => [connectionKey(x), x.id]));
  const remap = new Map<string, string>();
  const servers = (data.servers ?? []).filter((x) => {
    const have = existing.get(connectionKey(x));
    if (have && have !== x.id) { remap.set(x.id, have); return false; }
    return true;
  });
  const watches = (data.watches ?? []).map((w) => (remap.has(w.serverId) ? { ...w, serverId: remap.get(w.serverId)! } : w));
  setState((s) => ({
    servers: merge(s.servers, servers.map((x) => ({ ...x, online: false }))),
    watches: merge(s.watches, watches),
    settings: data.settings ? { ...s.settings, ...data.settings } : s.settings,
    firstRun: false,
  }));
  const restored = data.secrets ? await live.restoreSecrets(data.secrets) : 0;
  showToast($t('Importiert: {0} Server, {1} Überwachungen{2}.', servers.length, data.watches?.length ?? 0, restored ? $t(', {0} Passwörter im {1}', restored, state.platform === 'mac' ? $t('Schlüsselbund') : $t('Anmeldespeicher')) : ''), 'ok');
  if (!state.tabs.length && state.servers[0]) openServer(state.servers[0].id, true);
}

/** Opens a local place from the sidebar ("Projekte", "Downloads"). */
/**
 * "Anderer Ordner …" in the location menu: any folder of this computer, chosen
 * in the system's folder dialog (in the prototype the path field opens instead).
 */
export async function pickLocalFolder(side: PaneSide = 'local') {
  setState({ contextMenu: null });
  if (!LIVE) {
    editPath(side);
    return;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title: $t('Ordner öffnen') }).catch(() => null);
  if (typeof picked !== 'string') return;
  const path = await invoke<string>('path_to_ui', { path: picked });
  if (side === 'local' && activeTab()?.leftServerId) setLeftServer('');
  navigate(side, path);
}

export function openPlace(path: string) {
  // Places are on this computer: leave server-to-server mode first.
  if (activeTab()?.leftServerId) setLeftServer('');
  navigate('local', path);
}

/** Opens a watch's folders in the current tab. */
export function openWatchFolders(watchId: string) {
  const w = state.watches.find((x) => x.id === watchId);
  if (!w) return;
  const t = activeTab();
  if (t && t.serverId !== w.serverId) openServer(w.serverId, true);
  updateTab({ leftServerId: undefined, localPath: w.localPath, remotePath: w.remotePath });
  setState({ selection: clearSelection(), popoverOpen: false });
}

/* ------------------------------------------------------------------------ */
/* Selection                                                                */
/* ------------------------------------------------------------------------ */

export function setFocusSide(side: PaneSide) {
  if (state.focusSide !== side) setState({ focusSide: side });
}

/** Mouse click on a row with optional modifier keys. */
export function clickRow(side: PaneSide, index: number, mod: { shift?: boolean; toggle?: boolean }) {
  const entries = paneEntries(side);
  const entry = entries[index];
  if (!entry) return;
  const sel = state.selection[side];
  let names: string[];
  let anchor = sel.anchor;
  if (mod.shift && sel.anchor >= 0) {
    const [a, b] = [Math.min(sel.anchor, index), Math.max(sel.anchor, index)];
    names = entries.slice(a, b + 1).map((e) => e.name);
  } else if (mod.toggle) {
    names = sel.names.includes(entry.name) ? sel.names.filter((n) => n !== entry.name) : [...sel.names, entry.name];
    anchor = index;
  } else {
    names = [entry.name];
    anchor = index;
  }
  setState((s) => ({ focusSide: side, selection: { ...s.selection, [side]: { names, cursor: index, anchor } }, renaming: null }));
}

export function clearPaneSelection(side: PaneSide) {
  setState((s) => ({ focusSide: side, selection: { ...s.selection, [side]: { names: [], cursor: -1, anchor: -1 } } }));
}

/** Arrow-key movement in the focused pane. */
export function moveCursor(side: PaneSide, delta: number, extend: boolean) {
  const entries = paneEntries(side);
  if (!entries.length) return;
  const sel = state.selection[side];
  const cursor = Math.max(0, Math.min(entries.length - 1, (sel.cursor < 0 ? (delta > 0 ? -1 : entries.length) : sel.cursor) + delta));
  if (extend && sel.anchor >= 0) {
    const [a, b] = [Math.min(sel.anchor, cursor), Math.max(sel.anchor, cursor)];
    setState((s) => ({ selection: { ...s.selection, [side]: { names: entries.slice(a, b + 1).map((e) => e.name), cursor, anchor: sel.anchor } } }));
  } else {
    setState((s) => ({ selection: { ...s.selection, [side]: { names: [entries[cursor].name], cursor, anchor: cursor } } }));
  }
}

export function selectAll(side: PaneSide) {
  const entries = paneEntries(side);
  setState((s) => ({ selection: { ...s.selection, [side]: { names: entries.map((e) => e.name), cursor: s.selection[side].cursor, anchor: 0 } } }));
}

/** Type-to-select: jumps to the first entry starting with the typed text. */
export function jumpTo(side: PaneSide, prefix: string) {
  const entries = paneEntries(side);
  const idx = entries.findIndex((e) => e.name.toLowerCase().replace(/^\./, '').startsWith(prefix.toLowerCase()));
  if (idx >= 0) setState((s) => ({ selection: { ...s.selection, [side]: { names: [entries[idx].name], cursor: idx, anchor: idx } } }));
}

/* ------------------------------------------------------------------------ */
/* Panels                                                                   */
/* ------------------------------------------------------------------------ */

export const toggleInspector = () => setState((s) => ({ inspectorOpen: !s.inspectorOpen }));
export const toggleActivity = () => setState((s) => ({ activityOpen: !activityExpanded(s) }));
export const togglePopover = () => setState((s) => ({ popoverOpen: !s.popoverOpen, appMenu: null }));

/** Sets the sidebar width within its limits and remembers it. */
export function setSidebarWidth(width: number) {
  const w = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
  setState({ sidebarWidth: w });
  try {
    window.localStorage.setItem('bitcrane.sidebarWidth', String(w));
  } catch {
    // Not critical: the width simply is not remembered.
  }
}
export const openDialog = (dialog: DialogState) => {
  // The settings are a tab of their own, not a dialog.
  if (dialog?.type === 'settings') return openSettingsTab(dialog.tab);
  setState({ dialog, popoverOpen: false, contextMenu: null, appMenu: null, menuBarWindowOpen: false });
};

/** Opens the settings tab (or brings it to the front) on the given area. */
export function openSettingsTab(section: SettingsTab = 'general') {
  const s = state;
  const close = { dialog: null, popoverOpen: false, contextMenu: null, appMenu: null, menuBarWindowOpen: false };
  const existing = s.tabs.find((t) => t.settings);
  if (existing) {
    setState({ ...close, activeTabId: existing.id, tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, settings: section } : t)) });
    return;
  }
  const from = activeTab(s);
  const tab: Tab = { ...emptyTab(from && !from.leftServerId ? from.localPath : '~'), settings: section };
  const at = Math.max(0, s.tabs.findIndex((t) => t.id === s.activeTabId)) + 1;
  setState({ ...close, tabs: [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)], activeTabId: tab.id, selection: clearSelection() });
}

/** Switches the area shown in the settings tab. */
export function setSettingsSection(section: SettingsTab) {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.settings ? { ...t, settings: section } : t)) }));
}
export const closeDialog = () => setState({ dialog: null });
/** What the search field searches: this computer, a server's files, or the server list. */
export function searchTarget(s: AppState = state): { side: PaneSide; kind: 'local' | 'server' | 'servers'; name: string } {
  const side = s.search.trim() ? s.searchSide : s.focusSide;
  const t = activeTab(s);
  if (paneShowsServers(side, t)) return { side, kind: 'servers', name: '' };
  const [ls, sid] = paneLoc(side, t);
  return ls === 'local' ? { side, kind: 'local', name: '' } : { side, kind: 'server', name: serverById(sid, s)?.name ?? '' };
}

export const setSearch = (search: string) => {
  // A new search starts in the focused half; while text is in the field it stays there.
  setState((s) => ({ search, searchSide: s.search.trim() ? s.searchSide : s.focusSide }));
  pruneSelection();
  if (state.deepSearchOn) scheduleDeepSearch();
};

/** Drops selected names that a filter just hid, so actions never touch files the user cannot see. */
function pruneSelection() {
  const next = { ...state.selection };
  let changed = false;
  for (const side of ['local', 'remote'] as PaneSide[]) {
    const visible = new Set(paneEntries(side).map((e) => e.name));
    const names = next[side].names.filter((n) => visible.has(n));
    if (names.length !== next[side].names.length) {
      next[side] = { ...next[side], names };
      changed = true;
    }
  }
  if (changed) setState({ selection: next });
}

/** Walk results per folder, reused for a minute while typing. */
const walkCache = new Map<string, { at: number; items: Array<{ path: string; relative: string; size: number; mtime: number }> }>();
let deepTimer: number | undefined;
let deepRun = 0;

export function setDeepSearch(on: boolean) {
  setState({ deepSearchOn: on, ...(on ? {} : { deepSearch: null }) });
  if (on) {
    if (!state.search.trim()) showToast($t('Suche in Unterordnern an: einen Namen ins Suchfeld tippen.'));
    scheduleDeepSearch();
  }
}

function scheduleDeepSearch() {
  window.clearTimeout(deepTimer);
  const q = state.search.trim();
  if (!q) { setState({ deepSearch: null }); return; }
  deepTimer = window.setTimeout(() => void runDeepSearch(q), 300);
}

async function runDeepSearch(query: string) {
  const t = activeTab();
  if (!t) return;
  const side = state.searchSide;
  if (paneShowsServers(side, t)) return;
  const base = panePath(side);
  const run = ++deepRun;
  const loc = paneLoc(side, t);
  const key = `${loc[0]}|${loc[0] === 'remote' ? loc[1] : ''}|${base}`;
  setState((s) => ({ deepSearch: { side, base, query, loading: true, results: s.deepSearch?.side === side && s.deepSearch.base === base ? s.deepSearch.results : [], more: false } }));
  try {
    let cached = walkCache.get(key);
    if (!cached || Date.now() - cached.at > 60_000) {
      const items = LIVE
        ? await live.walkFiles(...loc, base)
        : fs.walkFiles(...loc, base).map((f) => ({ path: f.path, relative: paths.basename(base) + f.path.slice(base.length), size: f.entry.size, mtime: f.entry.mtime }));
      cached = { at: Date.now(), items };
      walkCache.set(key, cached);
    }
    if (run !== deepRun) return;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = cached.items
      // Walk results start with the walked folder's own name.
      .map((i) => ({ path: i.path, rel: i.relative.split('/').slice(1).join('/'), size: i.size, mtime: i.mtime }))
      .filter((i) => (state.settings.showHidden || !i.rel.split('/').some((seg) => seg.startsWith('.'))) && words.every((w) => i.rel.toLowerCase().includes(w)))
      // Matches in the file name first, then by path.
      .sort((a, b) => Number(!paths.basename(a.rel).toLowerCase().includes(words[0])) - Number(!paths.basename(b.rel).toLowerCase().includes(words[0])) || a.rel.localeCompare(b.rel, 'de'));
    setState({ deepSearch: { side, base, query, loading: false, results: all.slice(0, 500), more: all.length > 500 } });
  } catch (e) {
    if (run !== deepRun) return;
    setState({ deepSearch: { side, base, query, loading: false, results: [], more: false, error: (e as { message?: string })?.message ?? String(e) } });
  }
}

/** Opens the folder of a search result and selects the file. */
export function revealSearchResult(side: PaneSide, path: string) {
  const dir = paths.parent(path);
  const name = paths.basename(path);
  setState({ search: '', deepSearch: null });
  navigate(side, dir);
  // Select once the listing is there.
  let tries = 0;
  const pick = () => {
    const entries = paneEntries(side);
    const idx = entries.findIndex((e) => e.name === name);
    if (idx >= 0) setState((s) => ({ selection: { ...s.selection, [side]: { names: [name], cursor: idx, anchor: idx } }, focusSide: side }));
    else if (++tries < 20) window.setTimeout(pick, 150);
  };
  pick();
}
export const setActivityFilter = (activityFilter: AppState['activityFilter']) => setState({ activityFilter, activityOpen: true });

export function toggleHidden() {
  setState((s) => ({ settings: { ...s.settings, showHidden: !s.settings.showHidden } }));
  pruneSelection();
  showToast(state.settings.showHidden ? $t('Versteckte Dateien werden gezeigt.') : $t('Versteckte Dateien werden ausgeblendet.'));
}

/**
 * Opens an sftp:// link: a saved server with the same address and user if
 * there is one, otherwise a quick connection. A path that ends in a file
 * opens its folder with the file selected.
 */
export function openSftpLink(url: string) {
  if (!state.settings.sftpLinks) {
    showToast($t('Bitcrane öffnet sftp-Links erst, wenn das in den Einstellungen unter „Erweitert“ eingeschaltet ist.'));
    return;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    showToast($t('Link nicht verstanden: {0}', url), 'error');
    return;
  }
  if (u.protocol !== 'sftp:') return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || 22;
  const user = decodeURIComponent(u.username);
  const path = decodeURIComponent(u.pathname || '');
  const srv = state.servers.find((x) => x.host === host && x.port === port && (!user || x.user === user));
  if (!srv) {
    quickConnect(`${user ? `${user}@` : ''}${host}${port !== 22 ? `:${port}` : ''}${path && path !== '/' ? path : ''}`, false, 'auto');
    return;
  }
  openServerInNewTab(srv.id);
  if (path && path !== '/') {
    const isFile = !path.endsWith('/') && /\.[^/]+$/.test(path);
    if (isFile) revealSearchResult('remote', path.replace(/\/+$/, ''));
    else navigate('remote', path.replace(/\/+$/, '') || '/');
  }
}

/** Opens the folders of a saved comparison and shows the comparison. */
export function openSyncFavorite(id: string) {
  const f = state.settings.syncFavorites.find((x) => x.id === id);
  if (!f || (!f.rightLocal && !serverById(f.serverId)) || (f.leftServerId && !serverById(f.leftServerId))) return;
  const tab: Tab = { id: uid('tab'), serverId: f.rightLocal ? '' : f.serverId, localPath: f.local, remotePath: f.remote, back: [], forward: [], ...(f.leftServerId ? { leftServerId: f.leftServerId } : {}), ...(f.rightLocal ? { rightLocal: true } : {}) };
  setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, selection: clearSelection(), contextMenu: null }));
  for (const sid of [f.rightLocal ? '' : f.serverId, f.leftServerId ?? '']) if (sid && LIVE && !live.isConnected(sid)) live.connectNow(sid);
  openDialog({ type: 'compare', favoriteId: id });
}

/** Reads a server folder again (after a change made outside the usual operations). */
export function invalidateRemote(serverId: string, path: string) {
  if (LIVE) live.invalidate('remote', serverId, path);
  setState((s) => ({ fsRev: s.fsRev + 1 }));
}

export function refresh() {
  if (LIVE) live.refreshVisible();
  setState((s) => ({ fsRev: s.fsRev + 1 }));
  showToast($t('Aktualisiert.'));
}

/* ------------------------------------------------------------------------ */
/* File operations                                                          */
/* ------------------------------------------------------------------------ */

/** Names selected in a pane, or the entry under the cursor. */
export function selectedNames(side: PaneSide): string[] {
  return state.selection[side].names;
}

export function startRename(side: PaneSide, name?: string) {
  const sel = selectedNames(side);
  // Several selected: the window for renaming many at once.
  if (!name && sel.length > 1) {
    openDialog({ type: 'batchRename', side, names: sel });
    return;
  }
  const n = name ?? sel[0];
  if (n) setState({ renaming: { side, name: n }, contextMenu: null });
}

export function commitRename(side: PaneSide, oldName: string, newName: string) {
  const t = activeTab();
  setState({ renaming: null });
  // Rows inside opened folders carry a relative path; the new name is just the last part.
  const cut = oldName.lastIndexOf('/');
  const prefix = cut >= 0 ? oldName.slice(0, cut + 1) : '';
  const base = oldName.slice(cut + 1);
  const name = newName.trim();
  if (!t || !name || name === base) return;
  // Windows forbids more characters in local names than servers do.
  const winLocal = state.platform === 'win' && paneLoc(side, t)[0] === 'local';
  if (name.includes('/') || (winLocal && /[\\:*?"<>|]/.test(name))) {
    showToast($t('Ein Name darf diese Zeichen nicht enthalten: {0}', winLocal ? '/ \\ : * ? " < > |' : '/'), 'error');
    return;
  }
  const dir = prefix ? paths.join(panePath(side), prefix.slice(0, -1)) : panePath(side);
  const selectRenamed = () => setState((s) => ({ selection: { ...s.selection, [side]: { ...s.selection[side], names: [prefix + name] } } }));
  if (LIVE) {
    void live.renameEntry(...paneLoc(side, t), dir, base, name).then((ok) => { if (ok) selectRenamed(); });
    return;
  }
  const ok = fs.rename(...paneLoc(side, t), paths.join(dir, base), name);
  if (!ok) {
    showToast($t('„{0}“ gibt es hier schon.', name), 'error');
    return;
  }
  setState((s) => ({ fsRev: s.fsRev + 1 }));
  selectRenamed();
}

export function newFolder(side: PaneSide = state.focusSide) {
  const t = activeTab();
  if (!t) return;
  const loc = paneLoc(side, t);
  if (loc[0] === 'remote' && isOffline(loc[1])) return;
  const existing = new Set((listEntries(...loc, panePath(side)) ?? []).map((e) => e.name));
  let name = $t('Neuer Ordner');
  let i = 2;
  while (existing.has(name)) name = $t('Neuer Ordner {0}', i++);
  if (LIVE) {
    const dir = panePath(side);
    void live.makeFolder(...loc, dir, name).then((ok) => {
      if (ok && state.activeTabId === t.id && panePath(side) === dir) setState((s) => ({ focusSide: side, selection: { ...s.selection, [side]: { names: [name], cursor: -1, anchor: -1 } }, renaming: { side, name } }));
    });
    setState({ contextMenu: null });
    return;
  }
  fs.makeDir(...loc, paths.join(panePath(side), name));
  setState((s) => ({ fsRev: s.fsRev + 1, focusSide: side, contextMenu: null }));
  const idx = paneEntries(side).findIndex((e) => e.name === name);
  setState((s) => ({ selection: { ...s.selection, [side]: { names: [name], cursor: idx, anchor: idx } }, renaming: { side, name } }));
}

export function askDelete(side: PaneSide, names = selectedNames(side)) {
  if (!names.length) return;
  if (state.settings.confirmDelete || paneOnServer(side)) openDialog({ type: 'confirmDelete', side, names });
  else deleteNames(side, names);
}

export function deleteNames(side: PaneSide, names: string[]) {
  const t = activeTab();
  if (!t) return;
  if (LIVE) {
    setState((s) => ({ dialog: null, selection: { ...s.selection, [side]: { names: [], cursor: -1, anchor: -1 } } }));
    void live.removeEntries(...paneLoc(side, t), panePath(side), names);
    return;
  }
  names.forEach((n) => fs.remove(...paneLoc(side, t), paths.join(panePath(side), n)));
  setState((s) => ({ fsRev: s.fsRev + 1, dialog: null, selection: { ...s.selection, [side]: { names: [], cursor: -1, anchor: -1 } } }));
  showToast(names.length === 1 ? $t('„{0}“ gelöscht.', names[0]) : $t('{0} Objekte gelöscht.', names.length));
}

/** Editor program for a file name ('' = the system's default program). */
export function editorFor(name: string, s: AppState = state): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  return (ext && s.settings.editorByExt[ext]) || s.settings.editorApp;
}

/** Web address of a server file, from the server's "Web-Adresse" setting. */
export function webUrlFor(serverId: string, remotePath: string): string | undefined {
  const srv = serverById(serverId);
  if (!srv?.webUrl) return undefined;
  const root = (srv.webRoot || '/').replace(/\/+$/, '') || '';
  if (root && remotePath !== root && !remotePath.startsWith(root + '/')) return undefined;
  const rest = remotePath.slice(root.length).split('/').map(encodeURIComponent).join('/');
  return srv.webUrl.replace(/\/+$/, '') + (rest.startsWith('/') ? rest : `/${rest}`);
}

export function copyWebUrl(serverId: string, remotePath: string) {
  const url = webUrlFor(serverId, remotePath);
  if (!url) return;
  void navigator.clipboard?.writeText(url).then(() => showToast($t('Kopiert: {0}', url), 'ok'), () => showToast(url));
}

export function openWebUrl(serverId: string, remotePath: string) {
  const url = webUrlFor(serverId, remotePath);
  if (url) openExternal(url);
}

/** Opens a web address in the default browser. */
export function openExternal(url: string) {
  if (LIVE) void live.openUrl(url);
  else window.open(url, '_blank', 'noopener');
}

export const folderSizeKey = (side: PaneSide, serverId: string, path: string) => `${side}|${side === 'local' ? '' : serverId}|${path}`;

/** "Größe berechnen": adds up all files in a folder (with subfolders). */
/** "Link kopieren": sharing link of a file or folder on a cloud service. */
export function copyShareLink(side: PaneSide, name: string) {
  const t = activeTab();
  if (!t) return;
  setState({ contextMenu: null });
  const [, serverId] = paneLoc(side, t);
  if (!LIVE) { void navigator.clipboard?.writeText('https://www.dropbox.com/scl/fi/beispiel'); showToast($t('Link kopiert.'), 'ok'); return; }
  void live.copyShareLink(serverId, paths.join(panePath(side), name));
}

/** Opens a local file with its default program (archives otherwise open like a folder). */
export function openWithDefaultApp(side: PaneSide, name: string) {
  setState({ contextMenu: null });
  if (LIVE) live.openLocal(paths.join(panePath(side), name));
  else showToast($t('„{0}“ wird im Standard-Programm geöffnet.', name));
}

/** "Komprimieren" (this computer only): the chosen entries go into one zip next to them. */
export function compressEntries(side: PaneSide, names: string[]) {
  setState({ contextMenu: null });
  if (!LIVE) { showToast($t('Komprimieren geht im echten Programm.')); return; }
  void live.zipLocal(panePath(side), names);
}

/** "Entpacken" (this computer only): a zip is unpacked into a new folder next to it. */
export function extractArchive(side: PaneSide, name: string) {
  setState({ contextMenu: null });
  if (!LIVE) { showToast($t('Entpacken geht im echten Programm.')); return; }
  void live.unzipLocal(panePath(side), name);
}

/** One file for "Dateien vergleichen": where it is and how it is called in the window. */
export interface CompareRef { side: PaneSide; serverId: string; path: string; label: string }

/** Opens the comparison of two files; each may be on this computer or a server. */
export function compareFiles(a: { side: PaneSide; name: string }, b: { side: PaneSide; name: string }) {
  const t = activeTab();
  if (!t) return;
  const ref = (x: { side: PaneSide; name: string }): CompareRef => {
    const [side, serverId] = paneLoc(x.side, t);
    const where = side === 'local' ? $t('Dieser Computer') : serverById(serverId)?.name ?? '';
    return { side, serverId, path: paths.join(panePath(x.side), x.name), label: `${paths.basename(x.name)} · ${where}` };
  };
  setState({ contextMenu: null });
  openDialog({ type: 'compareFiles', a: ref(a), b: ref(b) });
}

export async function computeFolderSize(side: PaneSide, name: string) {
  const t = activeTab();
  if (!t) return;
  const path = paths.join(panePath(side), name);
  setState({ contextMenu: null });
  showToast($t('Größe von „{0}“ wird berechnet …', name));
  try {
    const loc = paneLoc(side, t);
    const files = LIVE ? await live.walkFiles(...loc, path) : fs.walkFiles(...loc, path).map((f) => ({ size: f.entry.size }));
    const total = files.reduce((a, f) => a + f.size, 0);
    setState((s) => ({ folderSizes: { ...s.folderSizes, [folderSizeKey(...loc, path)]: total } }));
    showToast($t('„{0}“: {1} in {2} {3}.', name, formatSize(total), files.length, files.length === 1 ? $t('Datei') : $t('Dateien')), 'ok');
  } catch (e) {
    showToast($t('Größe nicht berechenbar: {0}', e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)), 'error');
  }
}

/** ⌘L: turns the path above a file list into an input field. */
export function editPath(side: PaneSide) {
  if (!activeTab()) return;
  setState({ pathEdit: side, focusSide: side });
}

/** Navigates to a typed path ("~" stands for the home folder on this computer). */
export function submitPath(side: PaneSide, typed: string) {
  setState({ pathEdit: null });
  let p = typed.trim().replace(/\\/g, '/');
  if (!p) return;
  if (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  // A bare drive ("C:") would mean the current folder on that drive; use its root.
  const onServer = paneOnServer(side);
  if (!onServer && /^[A-Za-z]:$/.test(p)) p += '/';
  if (onServer && !p.startsWith('/')) p = paths.join(panePath(side), p);
  navigate(side, p);
}

/** Where a pane's files are for copying: '' for this computer, otherwise the server id. */
function placeOf(side: PaneSide, t: Tab | undefined = activeTab()): string {
  const [ls, sid] = paneLoc(side, t);
  return ls === 'remote' ? sid : '';
}

/** ⌘C on files: remembers them; ⌘V elsewhere copies or transfers them. */
export function copySelection(side: PaneSide) {
  const t = activeTab();
  const names = selectedNames(side);
  if (!t || !names.length) return;
  const from = placeOf(side, t);
  setState({ clipboard: { side, serverId: from, dir: panePath(side), names } });
  const what = names.length === 1 ? `„${names[0]}“` : $t('{0} Objekte', names.length);
  const other = placeOf(side === 'local' ? 'remote' : 'local', t);
  showToast(!from ? $t('{0} kopiert. In der anderen Hälfte einfügen, um hochzuladen.', what)
    : !other ? $t('{0} kopiert. In der anderen Hälfte einfügen, um herunterzuladen.', what)
      : $t('{0} kopiert. In der anderen Hälfte einfügen, um es dorthin zu übertragen.', what));
}

export function pasteClipboard(side: PaneSide) {
  const c = state.clipboard;
  const t = activeTab();
  if (!c || !t) return;
  const to = placeOf(side, t);
  const toDir = panePath(side);
  if (c.serverId === to) {
    // Same computer or same server: a plain copy there.
    if (!LIVE) {
      showToast($t('In der anderen Hälfte einfügen, um zu übertragen.'));
      return;
    }
    if (to) void live.copyOnServer(to, c.dir, c.names, toDir);
    else void live.copyLocal(c.dir, c.names, toDir);
    return;
  }
  transferNames(c.serverId, c.dir, c.names, to, toDir);
}

export function copyPath(side: PaneSide, name?: string) {
  const p = name ? paths.join(panePath(side), name) : panePath(side);
  navigator.clipboard?.writeText(p).catch(() => undefined);
  setState({ contextMenu: null });
  showToast($t('Pfad kopiert: {0}', p));
}

export function savePerms(side: PaneSide, path: string, perms: string, owner: string, group: string, recursive: boolean) {
  const t = activeTab();
  if (!t) return;
  if (LIVE) {
    setState({ dialog: null });
    const [ls, sid] = paneLoc(side, t);
    if (ls === 'remote') void live.changePerms(sid, path, perms, recursive);
    else showToast($t('Rechte auf diesem Computer ändert Bitcrane nicht. Das geht im Finder bzw. Explorer.'));
    return;
  }
  fs.chmod(...paneLoc(side, t), path, perms, owner, group, recursive);
  setState((s) => ({ fsRev: s.fsRev + 1, dialog: null }));
  showToast($t('Rechte gesetzt: {0}{1}', perms, recursive ? $t(' (mit Unterordnern)') : ''), 'ok');
}

/* ------------------------------------------------------------------------ */
/* Transfers                                                                */
/* ------------------------------------------------------------------------ */

function relFolder(root: string, path: string): string {
  const p = paths.parent(path);
  if (p === root) return paths.basename(root);
  return p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
}

function enqueue(items: Transfer[]) {
  if (!items.length) return;
  setState((s) => ({ transfers: [...s.transfers, ...items] }));
}

/**
 * Copies files or folders from one place to another; a place is this computer
 * ('') or a server id. Computer to server uploads, server to computer
 * downloads, server to server streams through this computer.
 */
function transferNames(from: string, fromDir: string, names: string[], to: string, toDir: string) {
  if (!names.length) return;
  // An opened archive on this computer is read-only.
  if (!to && paths.archiveFolder(toDir)) {
    showToast($t('Archive sind schreibgeschützt. Zum Ändern zuerst entpacken.'), 'error');
    return;
  }
  // Two local halves: a plain copy on this computer (Total Commander).
  if (!from && !to) { copyOrMoveLocal(fromDir, names, toDir, false); return; }
  if (from === to) return;
  // Rows inside opened folders carry a relative path ("cogs/welcome.py"); like in
  // the Finder they land directly in the target folder, grouped by their source folder.
  if (names.some((n) => n.includes('/'))) {
    const groups = new Map<string, string[]>();
    for (const n of names) {
      const dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
      groups.set(dir, [...(groups.get(dir) ?? []), n.slice(n.lastIndexOf('/') + 1)]);
    }
    for (const [dir, list] of groups) transferNames(from, dir ? paths.join(fromDir, dir) : fromDir, list, to, toDir);
    return;
  }
  setState({ contextMenu: null });
  if (LIVE) {
    const offline = [from, to].find((id) => id && !live.isConnected(id));
    if (offline) {
      showToast($t('Keine Verbindung zu {0}.', serverById(offline)?.name ?? $t('dem Server')), 'error');
      if (!live.isConnecting(offline)) live.connectNow(offline);
      return;
    }
    if (!from) void live.uploadNames(to, fromDir, toDir, names);
    else if (!to) void live.downloadNames(from, fromDir, toDir, names);
    else void live.crossNames(from, fromDir, to, toDir, names);
    return;
  }
  const items: Transfer[] = [];
  const direction: Transfer['direction'] = !from ? 'up' : !to ? 'down' : 'cross';
  for (const n of names) {
    const src = paths.join(fromDir, n);
    for (const f of fs.walkFiles(from ? 'remote' : 'local', from || to, src)) {
      const target = paths.join(toDir, f.path.slice(fromDir.length + 1));
      items.push({
        id: uid('t'), name: f.entry.name, direction, serverId: to || from, ...(direction === 'cross' ? { sourceServerId: from } : {}),
        folder: relFolder(toDir, target), source: f.path, target, size: f.entry.size, done: 0, state: 'queued',
      });
    }
  }
  enqueue(items);
  if (items.length > 1) showToast($t('{0} Dateien in der Warteschlange.', items.length));
}

/** Copies or moves between two folders of this computer; names may carry a relative path. */
function copyOrMoveLocal(fromDir: string, names: string[], toDir: string, move: boolean) {
  setState({ contextMenu: null });
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
    groups.set(dir, [...(groups.get(dir) ?? []), n.slice(n.lastIndexOf('/') + 1)]);
  }
  for (const [dir, list] of groups) {
    const src = dir ? paths.join(fromDir, dir) : fromDir;
    if (src === toDir) { showToast($t('Quelle und Ziel sind derselbe Ordner.')); continue; }
    // Folders that already exist in the target: ask "Zusammenführen" or "Beide behalten" (Transmit).
    const target = new Set((listEntries('local', '', toDir) ?? []).filter((e) => e.kind === 'dir').map((e) => e.name));
    const clashes = list.filter((n) => target.has(n) && isDirEntry('local', '', paths.join(src, n)));
    if (clashes.length) {
      openDialog({ type: 'mergeFolders', fromDir: src, names: list, toDir, move, clashes });
      continue;
    }
    if (LIVE) { void (move ? live.moveLocal(src, list, toDir) : live.copyLocal(src, list, toDir)); continue; }
    showToast(move ? $t('{0} Objekte verschoben (simuliert).', list.length) : $t('{0} Objekte kopiert (simuliert).', list.length), 'ok');
  }
}

/** Answer of the "Ordner zusammenführen?" window: copies or moves, merging same-named folders or keeping both. */
export function finishCopyOrMove(fromDir: string, names: string[], toDir: string, move: boolean, merge: boolean) {
  setState({ dialog: null });
  if (LIVE) { void (move ? live.moveLocal(fromDir, names, toDir, merge) : live.copyLocal(fromDir, names, toDir, merge)); return; }
  showToast(merge ? $t('{0} Objekte zusammengeführt (simuliert).', names.length) : move ? $t('{0} Objekte verschoben (simuliert).', names.length) : $t('{0} Objekte kopiert (simuliert).', names.length), 'ok');
}

/** Two local halves: moves the selection of one half into the folder of the other. */
export function moveToOtherHalf(side: PaneSide) {
  const t = activeTab();
  if (!t) return;
  const other: PaneSide = side === 'local' ? 'remote' : 'local';
  if (placeOf(side, t) || placeOf(other, t)) return;
  copyOrMoveLocal(panePath(side), selectedNames(side), panePath(other), true);
}

/** "Hochladen": the selected names of the left half go into the right half. */
export function upload(names = selectedNames('local'), targetDir?: string, sourceDir?: string) {
  const t = activeTab();
  if (!t) return;
  transferNames(placeOf('local', t), sourceDir ?? panePath('local'), names, placeOf('remote', t), targetDir ?? panePath('remote'));
}

/** Files dropped in from the Finder / Explorer (native paths) go to a server folder. */
export function uploadLocalPaths(nativePaths: string[], dir: string, side: PaneSide = 'remote') {
  const t = activeTab();
  const to = placeOf(side, t);
  if (!t || !LIVE || !to) return;
  if (!live.isConnected(to)) {
    showToast($t('Keine Verbindung zum Server.'), 'error');
    return;
  }
  void live.uploadNativePaths(to, nativePaths, dir);
}

/** "Herunterladen": the selected names of the right half go into the left half. */
export function download(names = selectedNames('remote'), targetDir?: string, sourceDir?: string) {
  const t = activeTab();
  if (!t) return;
  transferNames(placeOf('remote', t), sourceDir ?? panePath('remote'), names, placeOf('local', t), targetDir ?? panePath('local'));
}

export function retryTransfer(id: string) {
  const tr = state.transfers.find((x) => x.id === id);
  if (LIVE && tr) live.clearFailed(tr.serverId);
  setState((s) => ({ transfers: s.transfers.map((x) => (x.id === id ? { ...x, state: 'queued', done: 0, error: undefined, errorDetail: undefined, hold: undefined } : x)) }));
}

export function skipTransfer(id: string) {
  setState((s) => ({ transfers: s.transfers.filter((x) => x.id !== id) }));
}

export function cancelTransfer(id: string) {
  setState((s) => ({ transfers: s.transfers.filter((x) => x.id !== id) }));
}

export function toggleTransferPause(id: string) {
  setState((s) => ({ transfers: s.transfers.map((x) => (x.id === id ? { ...x, hold: undefined, state: x.state === 'paused' ? 'queued' : x.state === 'running' || x.state === 'queued' ? 'paused' : x.state } : x)) }));
}

export function pauseAllTransfers() {
  const anyActive = state.transfers.some((x) => x.state === 'running' || x.state === 'queued');
  setState((s) => ({ transfers: s.transfers.map((x) => (anyActive ? (x.state === 'running' || x.state === 'queued' ? { ...x, state: 'paused', hold: undefined } : x) : x.state === 'paused' ? { ...x, state: 'queued', hold: undefined } : x)) }));
}

export function clearFinished() {
  setState((s) => ({ transfers: s.transfers.filter((x) => x.state !== 'done') }));
}

/** Moves a waiting transfer before another one (drag to reorder). */
export function reorderTransfer(id: string, beforeId: string) {
  setState((s) => {
    const list = [...s.transfers];
    const from = list.findIndex((x) => x.id === id);
    if (from < 0) return {};
    const [item] = list.splice(from, 1);
    const to = list.findIndex((x) => x.id === beforeId);
    list.splice(to < 0 ? list.length : to, 0, item);
    return { transfers: list };
  });
}

/** Fixes the demo permission problem so "Wiederholen" succeeds. */
export function fixDemoPermissions() {
  if (LIVE) return;
  fs.chmod('remote', 'ob', '/home/ubuntu/bots/taskbot/dashboard/static', '775', 'ubuntu', 'ubuntu');
  setState((s) => ({ fsRev: s.fsRev + 1 }));
}

/* ------------------------------------------------------------------------ */
/* Conflicts                                                                */
/* ------------------------------------------------------------------------ */

export function resolveConflict(choice: ConflictChoice, applyToAll: boolean) {
  const queue = applyToAll ? state.conflicts : state.conflicts.slice(0, 1);
  for (const c of queue) {
    const tr = state.transfers.find((x) => x.id === c.transferId);
    if (!tr) continue;
    // "Take the server version" on a download conflict means: download and replace.
    const pick: ConflictChoice = choice === 'download' && c.direction === 'down' ? 'replace' : choice;
    if (pick === 'keepServer') {
      // "Keep what is already at the target": the server file on uploads, the local file on downloads.
      const note = c.direction === 'down' ? $t('Übersprungen, Datei auf diesem Rechner behalten') : $t('Übersprungen, Server-Datei behalten');
      setState((s) => ({ transfers: s.transfers.map((x) => (x.id === tr.id ? { ...x, state: 'done', done: 0, finishedAt: Date.now(), error: note, hold: undefined } : x)) }));
    } else if (pick === 'replace') {
      setState((s) => ({ transfers: s.transfers.map((x) => (x.id === tr.id ? { ...x, state: 'queued', error: undefined, hold: undefined } : x)) }));
      forced.add(tr.id);
      live.forcedLive.add(tr.id);
    } else if (pick === 'keepBoth') {
      const dot = tr.name.lastIndexOf('.');
      const tag = c.direction === 'down' ? $t('Server') : c.cross ? serverById(c.sourceServerId ?? '')?.name ?? $t('Server') : state.platform === 'mac' ? $t('Mac') : 'PC';
      const newName = dot > 0 ? `${tr.name.slice(0, dot)} (${tag})${tr.name.slice(dot)}` : `${tr.name} (${tag})`;
      setState((s) => ({ transfers: s.transfers.map((x) => (x.id === tr.id ? { ...x, state: 'queued', error: undefined, hold: undefined, name: newName, target: paths.join(paths.parent(x.target), newName) } : x)) }));
      forced.add(tr.id);
      live.forcedLive.add(tr.id);
    } else if (LIVE) {
      live.downloadInstead(tr);
    } else {
      const remote = fs.stat('remote', tr.serverId, tr.target);
      fs.writeFile('local', tr.serverId, tr.source, remote?.size ?? tr.size, Date.now());
      setState((s) => ({ fsRev: s.fsRev + 1, transfers: s.transfers.map((x) => (x.id === tr.id ? { ...x, direction: 'down', state: 'done', done: x.size, finishedAt: Date.now() } : x)) }));
    }
  }
  const rest = state.conflicts.slice(queue.length).map((c, i, arr) => ({ ...c, more: arr.length - 1 - i }));
  setState({ conflicts: rest, dialog: rest.length ? { type: 'conflict' } : null });
}

/** Transfers that already passed the conflict check. */
const forced = new Set<string>();

/* ------------------------------------------------------------------------ */
/* Watches                                                                  */
/* ------------------------------------------------------------------------ */

export function toggleWatch(id: string) {
  setState((s) => ({ watches: s.watches.map((w) => (w.id === id ? { ...w, state: w.state === 'paused' ? 'active' : 'paused' } : w)) }));
}

export function pauseAllWatches() {
  const anyActive = state.watches.some((w) => w.state !== 'paused');
  setState((s) => ({ watches: s.watches.map((w) => ({ ...w, state: anyActive ? 'paused' : 'active' })) }));
  showToast(anyActive ? $t('Alle Überwachungen pausiert.') : $t('Alle Überwachungen laufen wieder.'));
}

export function saveWatch(w: Omit<Watch, 'id' | 'state' | 'lastFile' | 'lastTime'> & { id?: string }) {
  if (w.id) {
    setState((s) => ({ watches: s.watches.map((x) => (x.id === w.id ? { ...x, ...w } as Watch : x)), dialog: null }));
    showToast($t('Überwachung „{0}“ gespeichert. Sie läuft ohne Neustart weiter.', w.name), 'ok');
    return;
  }
  const watch: Watch = { ...w, id: uid('w'), state: 'active', lastFile: '', lastTime: Date.now() } as Watch;
  setState((s) => ({ watches: [...s.watches, watch], dialog: null }));
  showToast($t('Überwachung „{0}“ läuft.', watch.name), 'ok');
  // Live mode: the watcher starts through the store subscription and syncs on start itself.
  if (watch.options.syncOnStart && !LIVE) {
    // Initial sync: upload a couple of files that are "newer" locally.
    const files = fs.walkFiles('local', watch.serverId, watch.localPath).filter((f) => !matchesExclude(f.entry.name, watch.excludes)).slice(0, 2);
    enqueueWatchFiles(watch, files.map((f) => f.path));
  }
}

export function deleteWatch(id: string) {
  setState((s) => ({ watches: s.watches.filter((w) => w.id !== id), dialog: null }));
}

/** Simulated test run: tells the user what would be uploaded. */
export function testRunWatch(localPath: string, excludes: string[]) {
  if (LIVE) {
    void live.testRun(localPath, excludes);
    return;
  }
  const files = fs.walkFiles('local', 'ob', localPath).filter((f) => !matchesExclude(f.entry.name, excludes));
  showToast($t('Testlauf: {0} Dateien würden beobachtet, beim Start {1} hochgeladen. Es wurde nichts übertragen.', files.length, Math.min(2, files.length)));
}

function enqueueWatchFiles(w: Watch, files: string[]) {
  const items: Transfer[] = files.map((p) => {
    const rel = p.slice(w.localPath.length + 1);
    const target = paths.join(w.remotePath, rel);
    const st = fs.stat('local', w.serverId, p);
    return { id: uid('t'), name: paths.basename(p), direction: 'up', serverId: w.serverId, folder: relFolder(w.remotePath, target), source: p, target, size: st?.size ?? 1024, done: 0, state: 'queued', watchId: w.id };
  });
  enqueue(items);
  pendingCommand.add(w.id);
}

/** Watches whose post-upload command should run once their batch is done. */
const pendingCommand = new Set<string>();

/**
 * Simulates the user saving a file in a watched folder. Called by the
 * prototype panel and by a slow background timer.
 */
export function simulateLocalChange(watchId?: string) {
  if (LIVE) {
    // In the app this is "Abgleichen": compare the watched folder with the server now.
    const w = watchId ? state.watches.find((x) => x.id === watchId) : watchForLocal(panePath('local')) ?? state.watches.find((x) => x.state !== 'paused');
    if (w) live.syncWatch(w.id);
    else showToast($t('Für diesen Ordner gibt es keine Überwachung.'));
    return;
  }
  const w = state.watches.find((x) => (watchId ? x.id === watchId : x.state !== 'paused'));
  if (!w) {
    showToast($t('Keine aktive Überwachung. Starte zuerst eine.'), 'error');
    return;
  }
  const candidates = fs.walkFiles('local', w.serverId, w.localPath)
    .filter((f) => !matchesExclude(f.entry.name, w.excludes))
    .filter((f) => !f.path.includes('/static/logo.png'));
  if (!candidates.length) return;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  fs.touch('local', w.serverId, pick.path, Math.round((Math.random() - 0.3) * 600));
  setState((s) => ({ fsRev: s.fsRev + 1 }));
  if (w.state === 'paused') {
    showToast($t('„{0}“ geändert. Die Überwachung ist pausiert und lädt nichts hoch.', pick.entry.name));
    return;
  }
  // Debounce: wait the configured delay before uploading.
  window.setTimeout(() => enqueueWatchFiles(w, [pick.path]), w.options.delay * 1000);
}

/** Scenario: the file on the server was changed by someone else. */
export function simulateConflict() {
  const w = state.watches[0];
  if (!w) return;
  const path = paths.join(w.localPath, 'bot.py');
  const target = paths.join(w.remotePath, 'bot.py');
  // The user saved locally a moment ago, someone else changed the server copy afterwards.
  fs.touch('local', w.serverId, path, 120);
  window.setTimeout(() => {
    fs.touch('remote', w.serverId, target, 1024);
    setState((s) => ({ fsRev: s.fsRev + 1 }));
    enqueueWatchFiles(w, [path]);
  }, 300);
  setState((s) => ({ fsRev: s.fsRev + 1 }));
}

/** Scenario: an upload fails because the server folder belongs to root. */
export function simulateError() {
  const w = state.watches[0];
  if (!w) return;
  fs.chmod('remote', w.serverId, paths.join(w.remotePath, 'dashboard/static'), '755', 'root', 'root');
  const path = paths.join(w.localPath, 'dashboard/static/logo.png');
  fs.touch('local', w.serverId, path, 200);
  setState((s) => ({ fsRev: s.fsRev + 1 }));
  enqueueWatchFiles(w, [path]);
}

/** Scenario: the SSH connection of the active tab drops. */
export function simulateDisconnect(serverId = activeTab()?.serverId) {
  if (!serverId) return;
  setState((s) => ({
    offline: { ...s.offline, [serverId]: { attempt: 2, nextRetry: Date.now() + 5000 } },
    watches: s.watches.map((w) => (w.serverId === serverId && w.state === 'active' ? { ...w, state: 'waiting' } : w)),
    servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: false } : x)),
  }));
  const w = state.watches.find((x) => x.serverId === serverId && x.state === 'waiting');
  if (w) {
    // Changes keep being collected while offline.
    const files = fs.walkFiles('local', serverId, w.localPath).filter((f) => !matchesExclude(f.entry.name, w.excludes)).slice(0, 3);
    files.forEach((f) => fs.touch('local', serverId, f.path));
    enqueueWatchFiles(w, files.map((f) => f.path));
  }
}

export function reconnect(serverId = activeTab()?.serverId) {
  if (!serverId) return;
  if (LIVE) {
    live.connectNow(serverId);
    return;
  }
  setState((s) => {
    const offline = { ...s.offline };
    delete offline[serverId];
    return {
      offline,
      watches: s.watches.map((w) => (w.serverId === serverId && w.state === 'waiting' ? { ...w, state: 'active' } : w)),
      servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: true } : x)),
    };
  });
  showToast($t('Wieder verbunden. Wartende Dateien werden hochgeladen.'), 'ok');
}

export function disconnect(serverId = activeTab()?.serverId) {
  if (!serverId) return;
  if (LIVE) void live.disconnectServer(serverId);
  setState((s) => ({ servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: false } : x)) }));
  showToast($t('Verbindung getrennt.'));
}

/**
 * "Trennen" in a half's path bar (Transmit's eject button): the half goes back
 * to the server list (left: to this computer). The connection is closed when
 * no other tab still uses the server.
 */
export function closePaneServer(side: PaneSide) {
  const t = activeTab();
  if (!t) return;
  const [ls, sid] = paneLoc(side, t);
  if (ls !== 'remote' || !sid) return;
  if (side === 'local') setLeftServer('');
  else {
    updateTab({ serverId: '', remotePath: '', back: [], forward: [], syncBrowse: undefined, serverList: { ...t.serverList, remote: true } });
    setState((s) => ({ selection: { ...s.selection, remote: { names: [], cursor: -1, anchor: -1 } }, expanded: { ...s.expanded, remote: [] } }));
  }
  // A running folder watch keeps its connection too.
  const stillUsed = state.tabs.some((x) => x.serverId === sid || x.leftServerId === sid) || state.watches.some((w) => w.serverId === sid && w.state !== 'paused');
  if (!stillUsed) disconnect(sid);
}

/* ------------------------------------------------------------------------ */
/* Servers                                                                  */
/* ------------------------------------------------------------------------ */

export function saveServer(server: Server, connect: boolean) {
  const exists = state.servers.some((x) => x.id === server.id);
  setState((s) => ({
    servers: exists ? s.servers.map((x) => (x.id === server.id ? server : x)) : [...s.servers, server],
    dialog: null,
    firstRun: false,
  }));
  if (connect && LIVE) {
    if (exists) void live.disconnectServer(server.id).then(() => openServer(server.id));
    else openServer(server.id);
  } else if (connect) {
    // Cloud services have no fingerprint to confirm (the prototype connects them at once).
    if (!exists && !isCloudProtocol(server.protocol)) {
      openDialog({ type: 'fingerprint', mode: 'new', serverId: server.id, key: { host: server.host, algorithm: 'ED25519', fingerprint: fakeFingerprint(server.host) } });
    } else openServer(server.id);
  } else showToast($t('„{0}“ gespeichert.', server.name), 'ok');
}

/** Server list drag: puts a server before another one (and into that one's group). */
export function moveServer(id: string, beforeId: string | null, group: string) {
  setState((s) => {
    const moving = s.servers.find((x) => x.id === id);
    if (!moving || id === beforeId) return {};
    const rest = s.servers.filter((x) => x.id !== id);
    const at = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1;
    const moved = { ...moving, group };
    if (at < 0) {
      // Behind the last server of the group (or at the end).
      let last = -1;
      rest.forEach((x, i) => { if (!x.temporary && x.group.trim() === group.trim()) last = i; });
      return { servers: last < 0 ? [...rest, moved] : [...rest.slice(0, last + 1), moved, ...rest.slice(last + 1)] };
    }
    return { servers: [...rest.slice(0, at), moved, ...rest.slice(at)] };
  });
}

/* Server groups (the folder button at the bottom of the server list, after Transmit). */

/** All group names: those of saved servers plus empty ones created by the user. */
export function serverGroupNames(s: AppState = state): string[] {
  const names = new Set([...s.servers.filter((x) => !x.temporary).map((x) => x.group.trim()), ...(s.settings.serverGroups ?? [])]);
  names.delete('');
  return [...names].sort((a, b) => a.localeCompare(b, 'de'));
}

/** "Neue Gruppe": an empty group whose name is edited right away. */
export function addServerGroup() {
  const taken = new Set(serverGroupNames());
  let name = $t('Neue Gruppe');
  for (let i = 2; taken.has(name); i++) name = $t('Neue Gruppe {0}', i);
  updateSettings({ serverGroups: [...(state.settings.serverGroups ?? []), name] });
  setState({ renamingGroup: name, contextMenu: null });
}

/** Renames a group for all its servers; an existing name merges both groups. */
export function renameServerGroup(from: string, to: string) {
  const name = to.trim();
  setState({ renamingGroup: null });
  if (!name || name === from) return;
  setState((s) => ({
    servers: s.servers.map((x) => (x.group.trim() === from ? { ...x, group: name } : x)),
    settings: { ...s.settings, serverGroups: [...new Set((s.settings.serverGroups ?? []).map((g) => (g === from ? name : g)))] },
  }));
}

/** "Gruppe auflösen": the servers stay, just without a group. */
export function removeServerGroup(name: string) {
  setState((s) => ({
    servers: s.servers.map((x) => (x.group.trim() === name ? { ...x, group: '' } : x)),
    settings: { ...s.settings, serverGroups: (s.settings.serverGroups ?? []).filter((g) => g !== name) },
    contextMenu: null,
  }));
}

/** Copy of a server with all settings (not the stored password); opens it for editing. */
export function duplicateServer(id: string) {
  const srv = serverById(id);
  if (!srv) return;
  const copy: Server = { ...srv, id: uid('srv'), name: $t('{0} Kopie', srv.name), online: false, temporary: false, lastUsed: undefined, bookmarks: srv.bookmarks?.map((b) => ({ ...b })) };
  setState((s) => {
    const at = s.servers.findIndex((x) => x.id === id);
    return { servers: [...s.servers.slice(0, at + 1), copy, ...s.servers.slice(at + 1)], contextMenu: null };
  });
  openDialog({ type: 'serverEdit', serverId: copy.id });
}

/** Keeps a quick connection as a saved server. */
export function keepServer(id: string) {
  const srv = serverById(id);
  if (!srv) return;
  setState((s) => ({ servers: s.servers.map((x) => (x.id === id ? { ...x, temporary: false } : x)), contextMenu: null }));
  showToast($t('„{0}“ gespeichert.', srv.name), 'ok');
}

export function deleteServer(id: string) {
  const removed = serverById(id);
  if (LIVE) {
    void live.disconnectServer(id);
    if (removed) void live.forgetSecrets(removed, state.servers.filter((x) => x.id !== id));
  }
  setState((s) => {
    const servers = s.servers.filter((x) => x.id !== id);
    let tabs = s.tabs.filter((t) => t.serverId !== id).map((t) => (t.leftServerId === id ? { ...t, leftServerId: undefined, localPath: '~' } : t));
    // Every tab showed the removed server: open the first remaining one instead.
    if (!tabs.length && servers[0]) tabs = [{ id: uid('tab'), serverId: servers[0].id, localPath: servers[0].localStart || '~', remotePath: servers[0].remoteStart, back: [], forward: [] }];
    return { servers, tabs, activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs[0]?.id ?? '' };
  });
}

export function newServerTemplate(): Server {
  const d = state.settings.serverDefaults;
  return {
    id: uid('srv'), name: '', mono: '', color: 'gray', host: '', port: 22, user: '', auth: 'auto', keyPath: '~/.ssh/id_ed25519', group: '', localStart: '~', remoteStart: '', online: false,
    ...d, proxy: d.proxy ? { ...d.proxy } : undefined,
  };
}

/** Builds a deterministic, realistic-looking SHA256 host key fingerprint. */
export function fakeFingerprint(host: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let h = 2166136261;
  let out = '';
  for (let i = 0; i < 43; i++) {
    h ^= host.charCodeAt(i % Math.max(1, host.length)) + i * 31;
    h = Math.imul(h, 16777619) >>> 0;
    out += chars[h % 64];
  }
  return 'SHA256:' + out;
}

/** "sftp://user@host:port" from the quick-connect field. */
/**
 * "Schnell verbinden". A password typed into the form is used for this connection;
 * it is kept in the system keychain only when the server is saved ("Zu Servern hinzufügen").
 */
/**
 * Accepts what people type in a terminal as well: "ssh user@host",
 * "ssh -p 2222 user@host" and ssh:// become the usual user@host:port.
 */
export function normalizeSshAddress(address: string): string {
  let a = address.trim().replace(/^ssh:\/\//i, '');
  const cmd = a.match(/^ssh\s+(.*)$/i);
  if (!cmd) return a;
  let port = '';
  const words: string[] = [];
  const parts = cmd[1].trim().split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '-p' && parts[i + 1]) port = parts[++i];
    else if (/^-p\d+$/.test(parts[i])) port = parts[i].slice(2);
    else if (parts[i] === '-l' && parts[i + 1]) words.unshift(`${parts[++i]}@`);
    // Options with a value (key file, jump host, -o …): skipped together with it.
    else if (/^-[bcDEeFIiJLlmOoQRSWw]$/.test(parts[i])) i++;
    else if (!parts[i].startsWith('-')) words.push(parts[i]);
  }
  a = words.join('');
  return port && !/:\d+(\/|$)/.test(a) ? `${a}:${port}` : a;
}

export function quickConnect(address: string, save: boolean, auth: 'auto' | 'key' | 'password' = 'auto', side?: PaneSide, password?: string, openAs?: 'terminal') {
  address = normalizeSshAddress(address);
  const typed = address.trim().replace(/^sftp:\/\//, '');
  if (typed) setState((s) => ({ settings: { ...s.settings, recentAddresses: [typed, ...s.settings.recentAddresses.filter((a) => a !== typed)].slice(0, 8) } }));
  if (LIVE) {
    void live.quickConnect(address, save, password ? 'password' : auth).then((server) => {
      if (!server) return;
      if (openAs && (!server.protocol || server.protocol === 'sftp')) server = { ...server, openAs };
      setState((s) => ({ servers: [...s.servers, server], dialog: null }));
      if (password) live.presetPassword(server.id, password, save);
      // From the "Schnell verbinden" tab of a half: connect right there.
      if (side && !server.openAs) openServerIn(side, server.id);
      else openServer(server.id);
    });
    return;
  }
  const m = address.trim().replace(/^sftp:\/\//, '').match(/^(?:([^@]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/);
  if (!m) {
    showToast($t('Adresse nicht erkannt. Beispiel: ubuntu@server.example:22'), 'error');
    return;
  }
  const [, user = 'ubuntu', host, port = '22', path] = m;
  const server: Server = {
    ...newServerTemplate(),
    name: host, mono: host.slice(0, 2).toUpperCase(), host, user, port: Number(port), color: 'gray',
    remoteStart: path || (LIVE ? '' : `/home/${user}`), temporary: !save, auth: auth === 'auto' ? 'agent' : auth,
    ...(openAs ? { openAs } : {}),
  };
  setState((s) => ({ servers: [...s.servers, server] }));
  if (side === 'local') {
    openServerIn('local', server.id);
    return;
  }
  openDialog({ type: 'fingerprint', mode: 'new', serverId: server.id, key: { host, algorithm: 'ED25519', fingerprint: fakeFingerprint(host) } });
}

/** Passphrase or password typed by the user in the login prompt. */
export function submitSecret(serverId: string, secret: string, save: boolean, kind: 'passphrase' | 'password') {
  setState({ dialog: null });
  live.submitSecret(serverId, secret, save, kind);
}

/** "Befehl nach dem Hochladen jetzt ausführen" for the watch of the current folder. */
export function runWatchCommand() {
  const w = watchForLocal(panePath('local')) ?? state.watches[0];
  if (!w) {
    showToast($t('Für diesen Ordner gibt es keine Überwachung.'));
    return;
  }
  if (LIVE) live.runCommandNow(w.id);
  else simulateLocalChange(w.id);
}

export function trustHostKey(serverId: string) {
  const d = state.dialog;
  setState({ dialog: null });
  if (LIVE) {
    if (d?.type === 'fingerprint') live.trustAndConnect(serverId, d.key.fingerprint);
    return;
  }
  openServer(serverId);
}

export function rejectHostKey(serverId: string) {
  const temp = serverById(serverId)?.temporary;
  setState((s) => ({ dialog: null, servers: s.servers.filter((x) => !(x.id === serverId && x.temporary)) }));
  if (temp) {
    // Close the tab the temporary server was opened in.
    setState((s) => {
      const tabs = s.tabs.filter((t) => t.serverId !== serverId);
      return { tabs, activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs[0]?.id ?? '' };
    });
  }
  showToast($t('Nicht verbunden.'));
}

/** Scenario: the server's host key changed since the last connection. */
export function simulateChangedHostKey() {
  const srv = serverById(activeTab()?.serverId ?? 'ob');
  if (!srv) return;
  openDialog({ type: 'fingerprint', mode: 'changed', serverId: srv.id, key: { host: srv.host, algorithm: 'ED25519', fingerprint: fakeFingerprint(srv.host + 'neu'), previous: fakeFingerprint(srv.host) } });
}

/* ------------------------------------------------------------------------ */
/* Settings and toolbar                                                     */
/* ------------------------------------------------------------------------ */

export function updateSettings(patch: Partial<Settings>) {
  if (patch.language && patch.language !== state.settings.language) {
    rememberLanguage(patch.language);
    if (!LIVE) {
      // The prototype simply reloads in the new language.
      window.setTimeout(() => window.location.reload(), 50);
    } else {
      showToast($t('Die Sprache wechselt beim nächsten Start von Bitcrane.'));
    }
  }
  setState((s) => ({ settings: { ...s.settings, ...patch } }));
}

export function setToolbar(toolbar: ToolId[]) {
  setState({ toolbar });
}

/* ------------------------------------------------------------------------ */
/* Prototype scenarios                                                      */
/* ------------------------------------------------------------------------ */

/** Shows the first-start screen as if no server was saved yet. */
export function showFirstRun() {
  fs.resetAll();
  const tab = emptyTab('~');
  setState({ ...initialState(), platform: state.platform, theme: state.theme, servers: [], tabs: [tab], watches: [], transfers: [], activeTabId: tab.id });
  // As on a real first start: offer the cloud folders (simulated here).
  window.setTimeout(() => void offerCloudPlaces(false), 400);
  setState((s) => ({ settings: { ...s.settings, syncFavorites: [], recentAddresses: [] } }));
}

/** Restores the sample data. */
export function resetPrototype() {
  fs.resetAll();
  forced.clear();
  pendingCommand.clear();
  setState({ ...initialState(), platform: state.platform, theme: state.theme });
  showToast($t('Beispieldaten wiederhergestellt.'));
}

/** Two letters for the server tile: initials of two words, else the first two letters. */
export function monoFor(name: string): string {
  const words = name.replace(/[^A-Za-z0-9ÄÖÜäöüß ]/g, ' ').split(/\s+/).filter(Boolean);
  const m = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? name).slice(0, 2);
  return (m || 'SV').toUpperCase();
}

/** Adds servers found in other programs (from the import window). */
export function importServers(list: ImportedServer[]) {
  // No colour (it is optional, see ServerTile); servers already there, or twice in the list, are skipped.
  // Same server = same protocol, user, host, port and key file (two entries with different keys are kept).
  const keyOf = (x: { host: string; port: number; user: string; protocol?: string; keyPath?: string; auth?: string }) =>
    `${x.protocol ?? 'sftp'}|${x.user.toLowerCase()}@${x.host.toLowerCase()}:${x.port}|${x.auth === 'key' ? (x.keyPath ?? '') : ''}`;
  const seen = new Set(state.servers.filter((x) => !x.temporary).map(keyOf));
  list = list.filter((s) => { const k = keyOf(s); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!list.length) { setState({ dialog: null }); showToast($t('Diese Server sind schon vorhanden.')); return; }
  const created: Server[] = list.map((s) => ({
    id: uid('srv'), name: s.name, mono: monoFor(s.name),
    color: 'gray', host: s.host, port: s.port, user: s.user,
    auth: s.protocol === 'sftp' ? s.auth : 'password', keyPath: s.keyPath ?? '~/.ssh/id_ed25519', group: s.group,
    localStart: s.localDir ?? '~', remoteStart: s.remoteDir ?? '', online: false,
    protocol: s.protocol, implicitTls: s.implicitTls || undefined,
  }));
  // ProxyJump names refer to other entries of the SSH configuration.
  const all = [...state.servers, ...created];
  list.forEach((s, i) => {
    if (!s.jump) return;
    const j = all.find((x) => x.name === s.jump || x.host === s.jump);
    if (j && j.id !== created[i].id) created[i].jumpServerId = j.id;
  });
  setState((st) => ({ servers: [...st.servers, ...created], dialog: null, firstRun: false }));
  showToast(created.length === 1 ? $t('„{0}“ übernommen.', created[0].name) : $t('{0} Server übernommen.', created.length), 'ok');
  const t = activeTab();
  if ((!t || !t.serverId) && created[0]) openServerIn('remote', created[0].id);
}

/** Adds the SSH-config servers on the welcome screen. */
export function importSshConfig() {
  if (LIVE) {
    openDialog({ type: 'import' });
    return;
  }
  const servers = sampleServers().slice(0, 3).map((x) => ({ ...x, online: false }));
  setState({ servers, firstRun: false });
  showToast($t('3 Server aus der SSH-Konfiguration übernommen.'), 'ok');
}

/* ------------------------------------------------------------------------ */
/* Simulation loop                                                          */
/* ------------------------------------------------------------------------ */

const TICK = 100;
let lastAuto = Date.now();

/** Returns an error text when the demo server refuses writing to a path. */
function writeError(tr: Transfer): { error: string; detail: string } | null {
  if (tr.direction !== 'up') return null;
  const dirPath = paths.parent(tr.target);
  const d = fs.stat('remote', tr.serverId, dirPath);
  if (d && d.owner === 'root' && !d.perms.endsWith('7')) {
    return {
      error: $t('Keine Schreibrechte'),
      detail: $t('Der Server verweigert das Schreiben in {0} (Permission denied). Prüfe die Ordnerrechte oder den Besitzer auf dem Server.', dirPath),
    };
  }
  return null;
}

function tick() {
  const s = state;
  const now = Date.now();
  let changed = false;
  let fsChanged = false;
  let transfers = s.transfers;
  let watches = s.watches;
  let conflicts = s.conflicts;
  let dialog = s.dialog;
  let speed = 0;

  // Retry countdown for dropped connections (the user can also click "Jetzt verbinden").
  let offline = s.offline;
  for (const [id, info] of Object.entries(s.offline)) {
    if (now >= info.nextRetry) {
      offline = { ...offline, [id]: { attempt: Math.min(10, info.attempt + 1), nextRetry: now + 5000 } };
      changed = true;
    }
  }

  const running = transfers.filter((x) => x.state === 'running').length;
  let slots = Math.max(0, s.settings.parallel - running);

  transfers = transfers.map((tr) => {
    if (tr.state === 'queued' && slots > 0 && !offline[tr.serverId]) {
      // Conflict check before writing a watched file.
      const watch = tr.watchId ? watches.find((w) => w.id === tr.watchId) : undefined;
      if (tr.direction === 'up' && watch?.options.warnIfServerNewer && !forced.has(tr.id)) {
        const remote = fs.stat('remote', tr.serverId, tr.target);
        const local = fs.stat('local', tr.serverId, tr.source);
        if (remote && local && remote.mtime > local.mtime && !conflicts.some((c) => c.transferId === tr.id)) {
          conflicts = [...conflicts, {
            transferId: tr.id, name: tr.name, serverId: tr.serverId, remoteFolder: paths.parent(tr.target),
            localSize: local.size, localTime: local.mtime, remoteSize: remote.size, remoteTime: remote.mtime, watchName: watch.name, more: 0,
          }];
          dialog = dialog ?? { type: 'conflict' };
          changed = true;
          return { ...tr, state: 'paused' as const, error: $t('Wartet auf Entscheidung'), hold: 'conflict' as const };
        }
      }
      slots--;
      changed = true;
      return { ...tr, state: 'running' as const };
    }
    if (tr.state === 'running') {
      changed = true;
      if (offline[tr.serverId] || (tr.sourceServerId && offline[tr.sourceServerId])) return { ...tr, state: 'queued' as const, done: 0 };
      if (tr.direction === 'command') {
        const done = tr.done + TICK;
        if (done >= 1500) {
          return { ...tr, done: tr.size, state: 'done' as const, finishedAt: now, output: $t('[PM2] Applying action restartProcessId on app [{0}]\n[PM2] [{1}](0) ✓', tr.name.split(' ').pop(), tr.name.split(' ').pop()) };
        }
        return { ...tr, done };
      }
      const err = writeError(tr);
      if (err) {
        // The server refuses the write shortly after the transfer started.
        if (tr.done > 0) return { ...tr, state: 'error' as const, error: err.error, errorDetail: err.detail };
        return { ...tr, done: Math.round(tr.size * 0.2) };
      }
      // Simulated throughput: roughly 1.2 MB/s, small files finish quickly.
      const rate = 1.2 * 1024 * 1024 * (0.8 + Math.random() * 0.4);
      const step = Math.max(2048, (rate * TICK) / 1000);
      speed += rate;
      const done = Math.min(tr.size, tr.done + step);
      if (done >= tr.size) {
        const targetSide = tr.direction === 'down' ? 'local' : 'remote';
        fs.writeFile(targetSide, tr.serverId, tr.target, tr.size);
        fsChanged = true;
        return { ...tr, done, state: 'done' as const, finishedAt: now };
      }
      return { ...tr, done };
    }
    return tr;
  });

  // Update watch "last upload" info and run post-upload commands once a batch is done.
  for (const w of watches) {
    const batch = transfers.filter((x) => x.watchId === w.id && x.direction === 'up');
    const busy = batch.some((x) => x.state === 'running' || x.state === 'queued' || x.state === 'paused');
    const lastDone = batch.filter((x) => x.state === 'done' && x.finishedAt).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
    if (lastDone && lastDone.finishedAt! > w.lastTime) {
      watches = watches.map((x) => (x.id === w.id ? { ...x, lastFile: lastDone.name, lastTime: lastDone.finishedAt! } : x));
      changed = true;
    }
    if (!busy && pendingCommand.has(w.id)) {
      pendingCommand.delete(w.id);
      const hadError = batch.some((x) => x.state === 'error');
      if (w.options.commandEnabled && w.options.command && !hadError) {
        transfers = [...transfers, { id: uid('t'), name: w.options.command, direction: 'command', serverId: w.serverId, folder: '', source: '', target: '', size: 1, done: 0, state: 'running', watchId: w.id }];
        changed = true;
      }
    }
  }

  // A gentle background event every 40 seconds keeps the active watch alive.
  if (now - lastAuto > 40000) {
    lastAuto = now;
    const active = watches.find((w) => w.state === 'active');
    if (active && !s.dialog) window.setTimeout(() => simulateLocalChange(active.id), 0);
  }

  // Keep the visible history short.
  const doneList = transfers.filter((x) => x.state === 'done');
  if (doneList.length > 40) {
    const drop = new Set(doneList.slice(0, doneList.length - 40).map((x) => x.id));
    transfers = transfers.filter((x) => !drop.has(x.id));
  }

  const nowSec = Math.floor(now / 1000) !== Math.floor(s.now / 1000);
  if (changed || fsChanged || nowSec) {
    setState({
      transfers, watches, conflicts, dialog, offline, speed,
      fsRev: fsChanged ? s.fsRev + 1 : s.fsRev,
      now: nowSec ? now : s.now,
    });
  }
}

let started = false;
/** Starts the simulation timer once. */
/** Prototype: a believable connection log, and one line per finished transfer. */
function simulateLog(addLog: typeof import('./log').addLog) {
  addLog('info', $t('Bitcrane gestartet, {0} {1}, {2} Überwachungen', state.servers.length, $t('Server'), state.watches.length));
  addLog('info', $t('Verbinde mit {0}@{1}:{2} ({3})', 'ubuntu', 'bots.example', 22, $t('SSH-Schlüssel')), 'ob');
  addLog('ok', $t('Verbunden, Startordner {0}', '/home/ubuntu'), 'ob');
  addLog('info', $t('Überwachung „{0}“ gestartet', 'taskbot live'), 'ob');
  const seen = new Map<string, string>();
  subscribeStore(() => {
    for (const t of state.transfers) {
      const before = seen.get(t.id);
      if (before === t.state) continue;
      seen.set(t.id, t.state);
      if (before === undefined && t.state === 'done') continue;
      const what = t.direction === 'command' ? t.name : `${t.direction === 'up' ? '↑' : t.direction === 'down' ? '↓' : '↔'} ${t.target || t.name}`;
      if (t.state === 'running') addLog('info', t.direction === 'command' ? $t('Befehl: {0}', t.name) : $t('Übertrage {0}', what), t.serverId);
      if (t.state === 'done') addLog('ok', t.direction === 'command' ? $t('Befehl fertig: {0}', t.name) : $t('Fertig: {0} ({1})', what, formatSize(t.size)), t.serverId);
      if (t.state === 'error') addLog('error', `${t.name}: ${t.error ?? $t('Fehler')}`, t.serverId);
    }
  });
}

export function startSimulation() {
  if (started) return;
  started = true;
  if (LIVE) live.startLive();
  else {
    window.setInterval(tick, TICK);
    void import('./log').then((m) => simulateLog(m.addLog));
  }
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (state.settings.themeSetting === 'system') setState({ theme: detectTheme() });
  });
}
