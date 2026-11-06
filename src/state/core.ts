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

import { isTauri, type CloudPlace, type Place } from '../backend/api';
import * as fs from '../backend/mockFs';
import * as live from './live';
import type { Conflict, FileEntry, HostKey, PaneSide, Platform, Protocol, Server, Tab, Theme, Transfer, Watch, WatchOptions } from '../backend/types';

import { describeFile } from '../util/format';
import * as paths from '../util/paths';
import { type Sealed } from '../util/crypto';
import { DEMO_PLATFORM, DEMO_THEME } from '../util/demo';
import { $t, LANG, type Lang } from '../i18n';
import { type CompareRef } from './fileOps';
import { updateTab } from './tabs';
import { closePaneServer } from './watches';
import { updateSettings } from './settings';

/** True inside the desktop app: real files and real servers instead of the demo data. */
export const LIVE = isTauri;

/* ------------------------------------------------------------------------ */
/* State shape                                                              */
/* ------------------------------------------------------------------------ */

export type DialogState =
  | { type: 'watchSetup'; editId?: string }
  | { type: 'serverEdit'; serverId?: string; cloud?: Protocol; terminal?: boolean; preset?: Partial<Server> }
  | { type: 'confirm'; title: string; text: string; confirm: string; danger?: boolean; run: () => void; detail?: string }
  | { type: 'checksum'; side: PaneSide; name: string }
  | { type: 'presign'; side: PaneSide; name: string }
  | { type: 'editWith'; side: PaneSide; name: string }
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
  | { type: 'copyTo'; side: PaneSide; names: string[] }
  | { type: 'gitCommit'; root: string }
  | { type: 'tagFiles'; name: string; color: number }
  | { type: 'shortcuts' }
  | { type: 'secret'; serverId: string; kind: 'passphrase' | 'password'; wrong?: boolean }
  | { type: 'diff'; transferId: string }
  | { type: 'compareFiles'; a: CompareRef; b: CompareRef }
  | { type: 'uploadTo'; paths: string[] }
  | { type: 'vaultCreate'; side: PaneSide }
  | { type: 'log' }
  | { type: 'preview'; side: PaneSide }
  | { type: 'batchRename'; side: PaneSide; names: string[] }
  | { type: 'selectMask'; side: PaneSide; mode?: 'add' | 'remove' }
  | { type: 'afterQueue'; action: AfterQueue }
  | { type: 'workspaces' }
  | { type: 'cloudSignIn'; service: Protocol; serverId?: string }
  | { type: 'mergeFolders'; fromDir: string; names: string[]; toDir: string; move: boolean; clashes: string[] }
  | { type: 'compare'; favoriteId?: string }
  | { type: 'import'; firstStart?: boolean }
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
  kind?: 'files' | 'columns' | 'server' | 'paneSource' | 'place' | 'sidebarPlace' | 'sidebarRecent' | 'sidebarSection' | 'crumbs' | 'serverGroup' | 'placesMore' | 'git' | 'tab';
  /** Tab right-clicked in the tab bar ("tab"). */
  tabId?: string;
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
  /** The two halves on top of each other instead of side by side. */
  stackHalves?: boolean;
  /** Only the active half is shown (narrow windows, work on one side); the other stays the target of transfers. */
  singleHalf?: boolean;
  /** Sidebar with favourites, recent folders, devices, shares and tags (on unless switched off). */
  sidebar?: boolean;
  /** Keys: Explorer / Finder style, or the F keys of WinSCP and Total Commander (F5 copy, F6 move …). */
  keyScheme?: 'standard' | 'commander';
  /** Row height of the lists: standard, or compact for small windows. */
  density?: 'standard' | 'compact';
  /** Width of the sidebar in pixels. */
  sidebarWidth?: number;
  /** Folders of this computer opened last (sidebar). */
  recentDirs?: string[];
  /** Built-in editor: font size, line wrapping, tab width (CodeEditor.tsx). */
  editorPrefs?: { fontSize: number; wrap: boolean; tabSize: number };
  /** Files open in the built-in editor, reopened when it is first shown after a start. */
  editorDocs?: Array<{ serverId: string; path: string }>;
  /** "Im Editor öffnen": the built-in editor (standard) or a program of the system. */
  editorMode?: 'builtin' | 'external';
  /** Sidebar sections in the user's order, folded ones, and hidden ones. */
  sidebarOrder?: SidebarSection[];
  sidebarCollapsed?: SidebarSection[];
  sidebarHidden?: SidebarSection[];
  /** Git state in local file lists (on unless switched off). */
  gitStatus?: boolean;
  /** "Kopieren nach …": the folders used last. */
  copyToRecent?: string[];
  /** Interface language. */
  language: Lang;
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
  /** True once Bitcrane offered the servers of other programs (first start without servers). */
  importAsked?: boolean;
  /** Server groups without servers yet (created with "Neue Gruppe"); groups with servers come from the servers. */
  serverGroups: string[];
  /** Share of the left half in the window (0.2 … 0.8), set by dragging the line between the halves. */
  splitRatio: number;
  /** Width of the group column in the server list, in pixels. */
  serverSourcesWidth: number;
  /** Server list: the group column is hidden. */
  serverSourcesHidden?: boolean;
  /** Height of the opened activity area, in pixels. */
  activityHeight: number;
  uploadDirPerms: string;
  /** Upload under a temporary name first and rename when complete. */
  uploadTempName: boolean;
  /** Keep the modification time of transferred files. */
  keepMtime: boolean;
  /** Algorithm last used in "Prüfsumme". */
  checksumAlgo?: 'md5' | 'sha1' | 'sha256' | 'sha512';
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
  /** Speed limit for uploads (and server to server) together in KB/s (0 = unlimited). */
  bandwidthLimit: number;
  /** Speed limit for downloads in KB/s (0 = unlimited); missing = the same as `bandwidthLimit` (before 0.2.84 one limit for both). */
  bandwidthLimitDown?: number;
  /** Open downloaded files with their usual program (manual downloads only). */
  openAfterDownload?: boolean;
  /** "Im System-Terminal öffnen": Mac iterm / ghostty, Windows powershell / cmd; missing = Terminal / Windows Terminal. */
  externalTerminal?: string;
  /** Duration last chosen for an S3 link, in seconds. */
  presignSecs?: number;
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
  /** Preview pictures for images on servers in the icons view (each one is read from the server). */
  remoteThumbs?: boolean;
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
  viewMode: Record<PaneSide, ViewMode>;
}

export type SortKey = 'name' | 'mtime' | 'size' | 'perms' | 'kind' | 'owner';

export interface DeepSearch {
  side: PaneSide;
  base: string;
  query: string;
  loading: boolean;
  error?: string;
  /** Files whose path below `base` matches; `rel` is relative to `base`. */
  results: Array<{ path: string; rel: string; size: number; mtime: number; line?: string; lineNo?: number }>;
  /** Searched in the files' content ("Inhalt durchsuchen") instead of their names. */
  content?: boolean;
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
  | 'perms' | 'hidden' | 'terminal' | 'disconnect' | 'copyPath' | 'editor' | 'codeEditor' | 'sync' | 'syncBrowse' | 'palette' | 'compareDirs' | 'selectMask';

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
  clipboard: { side: PaneSide; serverId: string; dir: string; names: string[]; cut?: boolean } | null;
  search: string;
  /** The half the search filters: the focused one when typing started (Transmit searches the active browser). */
  searchSide: PaneSide;
  /** "In Unterordnern suchen" is switched on. */
  deepSearchOn: boolean;
  /** Search also looks inside files (with deepSearchOn): local and SSH servers. */
  searchContent: boolean;
  /** Results of the search in subfolders of the focused side. */
  deepSearch: DeepSearch | null;
  toolbar: ToolId[];
  /** Toolbar look: symbols only, with the name below (Transmit, Finder), with the name beside, or names only. */
  toolbarLabels: 'icons' | 'iconsBelow' | 'iconsText' | 'text';
  settings: Settings;
  /** Connection drop simulation: server id -> next retry time. */
  offline: Record<string, { attempt: number; nextRetry: number }>;
  conflicts: Conflict[];
  /** Increases whenever any file system changes, so lists re-read. */
  fsRev: number;
  /** Clock used for "vor 12 Sek." texts; updated every second. */
  now: number;
  /** A short message shown at the bottom of the window. */
  toast: { text: string; tone: 'info' | 'ok' | 'error' | 'update'; hint?: string } | null;
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
  dropHint: { side: PaneSide; name: string; place?: string; addPlace?: boolean; sidebar?: boolean } | null;
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

export function sampleServers(): Server[] {
  const base = { port: 22, auth: 'key' as const, keyPath: '~/.ssh/id_ed25519', online: false };
  return [
    { ...base, id: 'ob', name: 'Webshop · Live', mono: 'WL', color: 'gray', ruleId: 'rule-app', host: 'shop.example', user: 'deploy', keyPath: '~/.ssh/shop_ed25519', group: 'Webshop', localStart: '~/Projekte/webshop/live', remoteStart: '/home/deploy/apps/webshop', online: true, lastUsed: Date.now() - 5 * 60000,
      places: [{ name: 'deploy', path: '/home/deploy' }, { name: 'webshop', path: '/home/deploy/apps/webshop' }, { name: 'blog', path: '/home/deploy/apps/blog' }] },
    { ...base, id: 'cw', name: 'Portfolio', mono: 'PF', color: 'gray', host: 'portfolio.example', user: 'web', group: 'Websites', localStart: '~/Projekte/portfolio', remoteStart: '/var/www/portfolio', online: true, lastUsed: Date.now() - 26 * 3600000,
      places: [{ name: 'portfolio', path: '/var/www/portfolio' }] },
    { ...base, id: 'ts', name: 'Testserver', mono: 'TS', color: 'green', host: 'test.portfolio.example', user: 'test', group: 'Websites', localStart: '~', remoteStart: '/home/test' },
    { ...base, id: 'nas', name: 'Backup NAS', mono: 'NA', color: 'gray', host: 'nas.local', user: 'admin', auth: 'password', group: 'Privat', localStart: '~/Downloads', remoteStart: '/volume1/backups' },
  ];
}

function sampleWatches(): Watch[] {
  return [
    {
      id: 'w1', name: 'webshop live', localPath: '~/Projekte/webshop/live', serverId: 'ob', remotePath: '/home/deploy/apps/webshop',
      state: 'active', lastFile: 'cart.py', lastTime: Date.now() - 12000,
      excludes: ['.git', '__pycache__', '.DS_Store', '*.log', '*.tmp', '.venv'],
      options: { ...defaultWatchOptions, commandEnabled: true, command: 'pm2 restart webshop' },
    },
    {
      id: 'w2', name: 'blog live', localPath: '~/Projekte/blog', serverId: 'ob', remotePath: '/home/deploy/apps/blog',
      state: 'paused', lastFile: '', lastTime: Date.now() - 2 * 3600 * 1000,
      excludes: ['.git', '__pycache__', '.DS_Store'],
      options: { ...defaultWatchOptions, command: 'pm2 restart blog' },
    },
  ];
}

function sampleTransfers(): Transfer[] {
  const now = Date.now();
  return [
    { id: 't-welcome', name: 'cart.py', direction: 'up', serverId: 'ob', folder: 'routes', source: '~/Projekte/webshop/live/routes/cart.py', target: '/home/deploy/apps/webshop/routes/cart.py', size: 8192, done: 8192, state: 'done', watchId: 'w1', finishedAt: now - 12000 },
    { id: 't-cmd0', name: 'pm2 restart webshop', direction: 'command', serverId: 'ob', folder: '', source: '', target: '', size: 1, done: 1, state: 'done', watchId: 'w1', finishedAt: now - 10000, output: '[PM2] Applying action restartProcessId on app [webshop]\n[PM2] [webshop](0) ✓' },
    { id: 't-app', name: 'app.css', direction: 'up', serverId: 'ob', folder: 'admin/static', source: '~/Projekte/webshop/live/admin/static/app.css', target: '/home/deploy/apps/webshop/admin/static/app.css', size: 48 * 1024, done: 0, state: 'queued', watchId: 'w1' },
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
  { id: 'codeEditor', label: $t('Editor') },
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
  if (DEMO_PLATFORM) return DEMO_PLATFORM;
  const p = (navigator.platform || '') + ' ' + navigator.userAgent;
  return /Win/i.test(p) ? 'win' : 'mac';
}

/**
 * A host page (e.g. the artifact viewer) may fix the theme on the root element.
 * Read once at load: the app itself writes data-theme on the root later, and
 * reading it then would turn "Wie das System" into the last chosen theme.
 */
const HOST_THEME = document.documentElement.dataset.theme;

export function detectTheme(): Theme {
  if (DEMO_THEME) return DEMO_THEME;
  if (HOST_THEME === 'dark' || HOST_THEME === 'light') return HOST_THEME;
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

export function initialState(): AppState {
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
      : { local: { names: ['app.py'], cursor: 3, anchor: 3 }, remote: { names: [], cursor: -1, anchor: -1 } },
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
    searchContent: false,
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
      // The prototype shows one example rule, used by "Webshop · Live".
      rules: LIVE ? [] : [{ id: 'rule-app', name: 'Python-App', excludes: ['venv', '__pycache__', '*.log', '.git'], filePerms: '644', dirPerms: '755', existingUp: 'overwrite', keepOldVersion: true }],
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

export let state: AppState = initialState();
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
  const linked = linkedStart(srv, start);
  updateTab({ serverId, rightLocal: false, remotePath: start, back: [], forward: [], syncBrowse: linked, ...(linked ? { localPath: linked.local } : {}), serverList: { ...t.serverList, remote: false } });
  setState((s) => ({ selection: { ...s.selection, remote: { names: [], cursor: -1, anchor: -1 } }, expanded: { ...s.expanded, remote: [] }, focusSide: 'remote' }));
  if (LIVE) {
    if (!live.isConnected(serverId)) live.connectNow(serverId);
  } else {
    setState((s) => ({ servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: true } : x)) }));
    showToast($t('Verbunden mit {0}', srv.name), 'ok');
  }
}

/**
 * "Beim Öffnen synchron blättern" (Transmit: folder linking): the server's local and
 * server start folders as the linked pair, when both are set.
 */
export function linkedStart(srv: Server, remoteStart: string): Tab['syncBrowse'] {
  if (!srv.syncBrowseOnOpen || !srv.localStart || !remoteStart) return undefined;
  return { local: srv.localStart, remote: remoteStart };
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
export function paneStatus(side: PaneSide, s: AppState = state): { loading: boolean; error?: string; hint?: string; missing?: boolean; notConnected?: boolean; connecting?: boolean } {
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
 * "routes/cart.py") and their nesting level as `depth`.
 */
export type ViewMode = 'list' | 'icons' | 'columns';

/** Sections of the sidebar. */
export type SidebarSection = 'favorites' | 'recent' | 'devices' | 'shares' | 'tags';
export const SIDEBAR_SECTIONS: SidebarSection[] = ['favorites', 'recent', 'devices', 'shares', 'tags'];

/** Sidebar sections in the user's order (new sections are added at their default place). */
export function sidebarOrder(s: AppState = state): SidebarSection[] {
  const saved = (s.settings.sidebarOrder ?? []).filter((x) => SIDEBAR_SECTIONS.includes(x));
  const missing = SIDEBAR_SECTIONS.filter((x) => !saved.includes(x));
  return [...saved, ...missing];
}

/** Moves a sidebar section before another one (null: to the end). */
export function moveSidebarSection(id: SidebarSection, before: SidebarSection | null) {
  const rest = sidebarOrder().filter((x) => x !== id);
  const i = before === null ? rest.length : Math.max(0, rest.indexOf(before));
  updateSettings({ sidebarOrder: [...rest.slice(0, i), id, ...rest.slice(i)] });
}

/** Folds or unfolds a sidebar section. */
export function toggleSidebarCollapsed(id: SidebarSection) {
  const cur = state.settings.sidebarCollapsed ?? [];
  updateSettings({ sidebarCollapsed: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
}

/** Shows or hides a sidebar section. */
export function toggleSidebarHidden(id: SidebarSection) {
  const cur = state.settings.sidebarHidden ?? [];
  updateSettings({ sidebarHidden: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  setState({ contextMenu: null });
}

/**
 * Entries of any folder of a half, filtered and sorted like the half itself
 * (column view: the folder above and the folder chosen). Undefined until read.
 */
export function folderRows(side: PaneSide, dir: string, s: AppState = state): FileEntry[] | undefined {
  const t = activeTab(s);
  if (!t) return undefined;
  const loc = paneLoc(side, t);
  let list = listEntries(...loc, dir);
  if (!list) return undefined;
  if (!s.settings.showSystem) list = list.filter((e) => (e.hidden ?? 0) < 2);
  if (!s.settings.showHidden) list = list.filter((e) => !e.name.startsWith('.') && !e.hidden);
  return sortEntries(list, s.settings.sort[side]);
}

/** Reads a folder of a half when it is not cached yet (call from effects, not while rendering). */
export function loadFolder(side: PaneSide, dir: string) {
  const t = activeTab();
  if (t && LIVE) live.requestListing(...paneLoc(side, t), dir);
}

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

/** Switches a half between list, icons and columns. */
export function setViewMode(side: PaneSide, mode: ViewMode) {
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
export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2];

/** Standard zoom: Mac programs are more compact than Windows ones, so the Mac starts at 90 %. */
export function defaultZoom(s: AppState = state): number {
  return s.platform === 'mac' ? 0.9 : 1;
}

/** The zoom in use: the user's choice, or the standard of the system. */
export function currentZoom(s: AppState = state): number {
  return s.settings.zoom ?? defaultZoom(s);
}

/** Strg + Plus / Minus / 0: one zoom step larger, smaller, or back to the standard. */
export function stepZoom(dir: 1 | -1 | 0) {
  const cur = currentZoom();
  // Nearest step to the current zoom, then one step in the wanted direction.
  const at = ZOOM_STEPS.reduce((best, z, i) => (Math.abs(z - cur) < Math.abs(ZOOM_STEPS[best] - cur) ? i : best), 0);
  const next = dir === 0 ? defaultZoom() : ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, at + dir))];
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
export function showToast(text: string, tone: 'info' | 'ok' | 'error' | 'update' = 'info', hint?: string, sticky = false) {
  setState({ toast: { text, tone, hint: hint || undefined } });
  window.clearTimeout(toastTimer);
  // Sticky: stays until the next message replaces it (a running operation reports its end).
  if (sticky) return;
  // Errors stay long enough to read both lines (about 15 characters a second, at least 6 s).
  const ms = tone === 'error' ? Math.min(12000, Math.max(6000, (text.length + (hint?.length ?? 0)) * 70)) : 2600;
  toastTimer = window.setTimeout(() => setState({ toast: null }), ms);
}
