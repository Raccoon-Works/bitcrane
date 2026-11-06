/**
 * Shape of the application state: the state itself, the settings, the dialog
 * in front, the context menu and the smaller records they hold.
 */
import type { CloudPlace, Place } from '../backend/api';
import type {
  Conflict,
  HostKey,
  PaneSide,
  Platform,
  Protocol,
  Server,
  SettingsTab,
  Tab,
  Theme,
  Transfer,
  Watch,
  WatchOptions,
} from '../backend/types';
import type { Sealed } from '../util/crypto';
import type { Lang } from '../i18n';
import type { CompareRef } from './fileOps';
import type { SyncBase } from './sync';
import type { Snippet, TermSession, TerminalSettings } from './terminal';
import type { UpdateState } from './updates';

export type DialogState =
  | { type: 'watchSetup'; editId?: string }
  | { type: 'serverEdit'; serverId?: string; cloud?: Protocol; terminal?: boolean; preset?: Partial<Server> }
  | {
      type: 'confirm';
      title: string;
      text: string;
      confirm: string;
      danger?: boolean;
      run: () => void;
      detail?: string;
    }
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
  | {
      type: 'authPrompt';
      id: string;
      serverId: string;
      host: string;
      name: string;
      instructions: string;
      prompts: Array<{ text: string; echo: boolean }>;
    };

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
  kind?:
    | 'files'
    | 'columns'
    | 'server'
    | 'paneSource'
    | 'place'
    | 'sidebarPlace'
    | 'sidebarRecent'
    | 'sidebarSection'
    | 'crumbs'
    | 'serverGroup'
    | 'placesMore'
    | 'git'
    | 'tab';
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
  syncBase?: SyncBase;
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
  serverDefaults: Partial<
    Pick<
      Server,
      'port' | 'user' | 'auth' | 'keyPath' | 'localStart' | 'remoteStart' | 'group' | 'color' | 'jumpServerId' | 'proxy'
    >
  >;
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

/** What happens once the transfer queue is empty (WinSCP "Once empty"). */
export type AfterQueue = 'none' | 'disconnect' | 'quit' | 'sleep' | 'shutdown';

/** An own command run on the server for the selected files. Placeholders: {file}, {files}, {name}, {dir}. */
export interface CustomCommand {
  id: string;
  name: string;
  command: string;
}

/** A tab as saved in a workspace or for the next start. */
export interface SavedTab {
  serverId: string;
  localPath: string;
  remotePath: string;
  leftServerId?: string;
  rightLocal?: boolean;
  /** Terminals of the tab ('' = this computer), when "Terminals wieder öffnen" is on. */
  terminals?: string[];
  terminalOpen?: boolean;
  /** The terminal filled the tab (SSH-only tabs). */
  terminalFull?: boolean;
}

/** A named set of tabs that can be opened again later. */
export interface Workspace {
  id: string;
  name: string;
  tabs: SavedTab[];
  active?: number;
}

/** Rule for files that already exist at the target of a manual transfer. */
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
  | 'nav'
  | 'newFolder'
  | 'refresh'
  | 'info'
  | 'activity'
  | 'upload'
  | 'download'
  | 'delete'
  | 'rename'
  | 'perms'
  | 'hidden'
  | 'terminal'
  | 'disconnect'
  | 'copyPath'
  | 'editor'
  | 'codeEditor'
  | 'sync'
  | 'syncBrowse'
  | 'palette'
  | 'compareDirs'
  | 'selectMask';

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
  update: UpdateState | null;
  /** Drop target while dragging: a folder in a half ('' = the folder shown), a place in a places
      bar (`place` = its path), or the places bar or sidebar itself (`addPlace`, `sidebar`). */
  dropHint: { side: PaneSide; name: string; place?: string; addPlace?: boolean; sidebar?: boolean } | null;
  /** Folders opened in place (triangle in the list), as paths relative to the folder shown. */
  expanded: Record<PaneSide, string[]>;
}

/** How a half shows its files. */
export type ViewMode = 'list' | 'icons' | 'columns';

/** Sections of the sidebar. */
export type SidebarSection = 'favorites' | 'recent' | 'devices' | 'shares' | 'tags';
