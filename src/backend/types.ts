/**
 * Shared domain types for Bitcrane.
 *
 * These types describe the data the user interface works with. In the browser
 * prototype they are filled by the mock backend (`mock.ts`). In the Tauri app
 * the same shapes will be returned by Rust commands, so the UI does not need
 * to change when the real backend is plugged in.
 */

/** Which side of the window a file list belongs to. */
export type PaneSide = 'local' | 'remote';

/** Operating system look the UI renders. */
export type Platform = 'mac' | 'win';

/** Colour scheme. */
export type Theme = 'dark' | 'light';

/** A single entry in a directory listing. */
export interface FileEntry {
  name: string;
  kind: 'dir' | 'file';
  /** Size in bytes; 0 for directories. */
  size: number;
  /** Last modification time (milliseconds since epoch). */
  mtime: number;
  /** Unix permission bits as octal string, e.g. "644". */
  perms: string;
  owner: string;
  group: string;
  /** Target of a symbolic link. */
  link?: string;
  /** Local only: 1 = hidden by the system, 2 = protected system item (Windows hidden + system). */
  hidden?: number;
  /** Interface only: nesting level of a row in an opened folder (0 or missing = top level). */
  depth?: number;
}

/** Authentication method of a saved server. */
/** "auto": agent, then the chosen and the default keys, then the password. */
export type AuthMethod = 'auto' | 'key' | 'agent' | 'password';

/** A saved server connection. */
export interface Server {
  id: string;
  name: string;
  /** Transfer rule used for this server (settings > Regeln); missing = the general settings. */
  ruleId?: string;
  /** Two-letter abbreviation shown in the coloured tile. */
  mono: string;
  /** Tile colour key, see `serverColors` in the UI. */
  color: ServerColor;
  /** Own picture for the server (Transmit): a small PNG as data URL (64 px), shown instead of the globe. */
  image?: string;
  host: string;
  port: number;
  user: string;
  auth: AuthMethod;
  keyPath: string;
  group: string;
  localStart: string;
  remoteStart: string;
  /** Whether a live SSH session to this server exists. */
  online: boolean;
  /** Temporary servers come from "Schnell verbinden" and are not saved. */
  temporary?: boolean;
  /** Saved folder pairs of this server (old "Lesezeichen"; turned into `places` when loaded). */
  bookmarks?: Bookmark[];
  /** Favourite folders of this server, shown in the places bar of its half. */
  places?: Place[];
  /** Reach this server through another saved server ("Sprungserver", ProxyJump). */
  jumpServerId?: string;
  /** Transfer protocol; SFTP when missing. */
  protocol?: Protocol;
  /** FTPS only: implicit TLS (own port, usually 990) instead of explicit TLS. */
  implicitTls?: boolean;
  /** When the server was last opened (for "Zuletzt verwendet"). */
  lastUsed?: number;
  /** Connect through a SOCKS5 or HTTP proxy. */
  proxy?: ServerProxy;
  /** Web address of the site this server hosts, e.g. https://example.com ... */
  webUrl?: string;
  /** ... and the server folder that address points to (e.g. /var/www/html). */
  webRoot?: string;
  /** Free text, e.g. what runs there or whom to ask. */
  note?: string;
  /** FTPS / WebDAV over HTTPS: only TLS 1.3. */
  tls13Only?: boolean;
  /** FTP: encoding of file names (old servers often use Latin-1). */
  ftpEncoding?: 'utf8' | 'latin1';
  /** FTP: server time zone in minutes east of UTC (for LIST times). */
  ftpTimezone?: number;
  /** FTP: binary, text, or text for text files only. */
  ftpMode?: 'binary' | 'ascii' | 'auto';
  /** WebDAV: path of the WebDAV folder, e.g. /remote.php/dav/files/name. */
  davPath?: string;
  /** WebDAV: https (default) or plain http. */
  davHttps?: boolean;
  /** SFTP servers: always use shell commands ("SCP") instead of SFTP. */
  scp?: boolean;
  /** SMB: share to start in (empty: the list of shares). */
  smbShare?: string;
  /** SMB: insist on SMB 3 encryption. */
  smbEncrypt?: boolean;
  /** Cryptomator vault: the server it lies on (none: this computer); `host` is the vault folder. */
  vaultStorageId?: string;
  /** Built-in terminal: colour scheme for this server (e.g. red for production), else the setting. */
  termScheme?: string;
  /** Built-in terminal: command typed in after connecting. */
  termStart?: string;
  /** Windows: show the server as a folder in the Explorer (Cloud Files API, see mount_win.rs). */
  mountExplorer?: boolean;
}

export interface ServerProxy {
  kind: 'socks5' | 'http';
  host: string;
  port: number;
  /** Login at the proxy; the password lives in the keychain. */
  user?: string;
}

export type Protocol = 'sftp' | 'ftp' | 'ftps' | 'webdav' | 'smb' | 'vault' | 'dropbox' | 'gdrive' | 'onedrive';

/** Cloud services that Bitcrane treats like a server (signed in through the browser). */
export const CLOUD_PROTOCOLS: Protocol[] = ['dropbox', 'gdrive', 'onedrive'];
export const isCloudProtocol = (p?: Protocol) => !!p && CLOUD_PROTOCOLS.includes(p);

/** A saved folder pair: server folder and, optionally, the matching local folder. */
export interface Bookmark {
  name: string;
  remote: string;
  local?: string;
}

export type ServerColor = 'blue' | 'purple' | 'green' | 'yellow' | 'orange' | 'red' | 'gray';

/** A favourite folder in a places bar. */
export interface Place {
  name: string;
  path: string;
  /** Cloud storage folder ("gdrive", "onedrive", "dropbox", "icloud", "box", "other"): shown with a cloud. */
  cloud?: string;
}

/** A cloud storage folder found on this computer (first start, like Transmit). */
export interface CloudPlace {
  name: string;
  path: string;
  service: string;
}

/** A browsing tab: one server with a local and a remote location. */
export interface Tab {
  id: string;
  serverId: string;
  localPath: string;
  remotePath: string;
  /** Navigation history per side for the back/forward buttons. */
  back: Array<{ side: PaneSide; path: string }>;
  forward: Array<{ side: PaneSide; path: string }>;
  /** "Synchron blättern": the two folders that belong together; both sides follow each other below them. */
  syncBrowse?: { local: string; remote: string };
  /** Server to server: the left half shows this server instead of this computer. */
  leftServerId?: string;
  /** Halves that currently show the server list instead of files (the right half
      always does while the tab has no server). */
  serverList?: Partial<Record<PaneSide, boolean>>;
  /** Two local halves (Total Commander): the right half shows this computer; `remotePath` is then a local path. */
  rightLocal?: boolean;
  /** Built-in terminal of this tab (state/terminal.ts): panel shown, session in front, filling the tab. */
  terminal?: { open: boolean; active?: string; full?: boolean };
}

/** Options of a folder watch. Mirrors the "Überwachung einrichten" dialog. */
export interface WatchOptions {
  includeSubfolders: boolean;
  syncOnStart: boolean;
  /** Runs again when Bitcrane starts (e.g. at login); off = stays paused until started by hand. Missing = on. */
  startWithApp?: boolean;
  warnIfServerNewer: boolean;
  runInBackground: boolean;
  continueOnError: boolean;
  onlyExisting: boolean;
  onlySelectedSubfolders: boolean;
  setPermissions: boolean;
  mirrorDeletes: boolean;
  keepOldVersion: boolean;
  commandEnabled: boolean;
  command: string;
  /** Debounce delay in seconds before uploading collected changes. */
  delay: number;
}

/** A folder watch that uploads local changes automatically. */
export interface Watch {
  id: string;
  name: string;
  /** Transfer rule of this watch; missing = the server's rule, "none" = no rule. */
  ruleId?: string;
  localPath: string;
  serverId: string;
  remotePath: string;
  state: 'active' | 'paused' | 'waiting';
  /** Human readable description of the last event, e.g. "welcome.py". */
  lastFile: string;
  lastTime: number;
  excludes: string[];
  options: WatchOptions;
  /** Subfolders (relative paths) when only selected subfolders are watched. */
  subfolders?: string[];
}

export type TransferState = 'running' | 'queued' | 'done' | 'error' | 'paused';

/** One file transfer in the activity list. */
export interface Transfer {
  id: string;
  name: string;
  /** 'cross': from one server to another (server to server); `serverId` is the target. */
  direction: 'up' | 'down' | 'command' | 'cross';
  serverId: string;
  /** Server to server: the server the file comes from. */
  sourceServerId?: string;
  /** Folder of the file relative to the transfer root, for display. */
  folder: string;
  /** Full source and target paths. */
  source: string;
  target: string;
  size: number;
  done: number;
  state: TransferState;
  error?: string;
  errorDetail?: string;
  watchId?: string;
  finishedAt?: number;
  /** Output of a post-upload command. */
  output?: string;
  /** Started by the user (not by a watch): the rule for existing files applies. */
  manual?: boolean;
  /** The user already decided what happens if the target exists. */
  decided?: boolean;
  /** Upload of a file edited in an editor: server modification time when it was opened. */
  editMtime?: number;
  /** Automatic retries so far. */
  retries?: number;
  /** Why a paused transfer waits: an automatic retry or a conflict decision (not shown, language-neutral). */
  hold?: 'retry' | 'conflict';
}

/** Answer of the user in the conflict dialog. */
export type ConflictChoice = 'keepServer' | 'replace' | 'keepBoth' | 'download';

/** Pending conflict waiting for a decision. */
export interface Conflict {
  transferId: string;
  /** Upload (target on the server) or download (target on this computer). */
  direction?: 'up' | 'down';
  /** Server to server: both copies are on servers; the one being sent is on this server. */
  cross?: boolean;
  sourceServerId?: string;
  /** The other copy is newer, or it simply exists already. */
  reason?: 'newer' | 'exists';
  name: string;
  serverId: string;
  remoteFolder: string;
  localSize: number;
  localTime: number;
  remoteSize: number;
  remoteTime: number;
  watchName?: string;
  /** How many further conflicts wait behind this one. */
  more: number;
}

/** Host key information shown in the fingerprint dialogs. */
export interface HostKey {
  host: string;
  algorithm: string;
  fingerprint: string;
  previous?: string;
}
