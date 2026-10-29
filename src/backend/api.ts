/**
 * Backend interface used by the store.
 *
 * `tauriBackend` implements it with the Rust core (real files, real SSH/SFTP).
 * The browser prototype does not use it; there the store works on the
 * in-memory demo file systems in `mockFs.ts`.
 */
import type { CloudPlace, FileEntry, HostKey, Place } from './types';
import { $t, tr } from '../i18n';

export interface WalkItem {
  /** Full path (UI form). */
  path: string;
  /** Path relative to the walked item's parent, starting with its own name. */
  relative: string;
  size: number;
  mtime: number;
}

export type { CloudPlace, Place } from './types';

export type AuthParams =
  | { method: 'key'; path: string; passphrase?: string }
  | { method: 'agent' }
  | { method: 'password'; password: string }
  | { method: 'auto'; keyPath?: string; passphrase?: string; password?: string };

export interface ConnectParams {
  host: string;
  port: number;
  user: string;
  auth: AuthParams;
  /** Fingerprint the user confirmed in the host key dialog. */
  trust?: string;
  /** Send keepalive messages (setting "Verbindung offen halten"). */
  keepalive?: boolean;
  /** Connect through this server first (jump server). */
  jump?: ConnectParams;
  /** SOCKS5 or HTTP proxy for the connection. */
  proxy?: { kind: 'socks5' | 'http'; host: string; port: number; user?: string; password?: string };
}

type ProxyParams = NonNullable<ConnectParams['proxy']>;

/** FTP / FTPS connection (see `ftp.rs`). */
export interface FtpConnectParams {
  host: string;
  port: number;
  user: string;
  password?: string;
  tls: 'none' | 'explicit' | 'implicit';
  tls13Only: boolean;
  encoding: 'utf8' | 'latin1';
  tzOffsetMin: number;
  mode: 'binary' | 'ascii' | 'auto';
  trust?: string;
  proxy?: ProxyParams;
}

/** WebDAV connection (see `dav.rs`). */
export interface DavConnectParams {
  url: string;
  user: string;
  password?: string;
  tls13Only: boolean;
  trust?: string;
  proxy?: ProxyParams;
}

/** Options of one transfer (see `transfer.rs`). */
export interface TransferOptions {
  tempName?: boolean;
  keepMtime?: boolean;
  resume?: boolean;
  filePerms?: number;
  dirPerms?: number;
  keepVersions?: number;
  limitKbps?: number;
}

/** Start of a file for the preview: text, an image (base64) or "binary". */
export interface Preview {
  /** "media": PDF, audio or video; `data` is the address the web view loads. */
  kind: 'text' | 'image' | 'binary' | 'media';
  mime: string;
  data: string;
  truncated: boolean;
}

/** Type and protection of a private key file. */
export interface KeyInfo {
  exists: boolean;
  algorithm: string;
  encrypted: boolean;
  invalid: boolean;
}

/** A stored host key fingerprint ("host:port"). */
export interface KnownHost {
  host: string;
  fingerprint: string;
}

export type ErrorKind =
  | 'hostKeyUnknown' | 'hostKeyChanged' | 'authFailed' | 'passphraseRequired' | 'passwordRequired' | 'unreachable' | 'notConnected'
  | 'connectionLost' | 'permissionDenied' | 'notFound' | 'alreadyExists' | 'cancelled' | 'other';

/** Error shape returned by every backend call. */
export interface BackendError {
  kind: ErrorKind;
  message: string;
  detail?: string;
  hostKey?: HostKey;
}

export interface WatchBatch {
  watchId: string;
  changed: string[];
  removed: string[];
  /** Renamed or moved inside the watched folder: [from, to]. */
  renamed?: Array<[string, string]>;
}

/** A server found in FileZilla, WinSCP or the SSH configuration. */
export interface ImportedServer {
  source: string;
  name: string;
  group: string;
  host: string;
  port: number;
  user: string;
  protocol: 'sftp' | 'ftp' | 'ftps' | 'webdav';
  implicitTls: boolean;
  auth: 'key' | 'agent' | 'password';
  keyPath?: string;
  remoteDir?: string;
  localDir?: string;
  jump?: string;
}

/** A host entry from ~/.ssh/config. */
export interface SshConfigHost {
  alias: string;
  host: string;
  port: number;
  user: string;
  identityFile?: string;
}

export interface Backend {

  localList(path: string): Promise<FileEntry[]>;
  localStat(path: string): Promise<FileEntry>;
  localMkdir(path: string): Promise<void>;
  localRename(path: string, newName: string): Promise<void>;
  localTrash(paths: string[]): Promise<void>;
  localChecksum(path: string): Promise<string>;
  remoteChecksum(serverId: string, path: string): Promise<string>;
  remoteSymlink(serverId: string, link: string, target: string): Promise<void>;
  /** Opens an http(s) address in the default browser. */
  openUrl(url: string): Promise<void>;
  /** Copies into a folder on this computer; returns the new names ("x Kopie" on a clash). */
  /** With `merge`, a folder whose name exists in the target is merged into it ("Zusammenführen"). */
  localCopy(paths: string[], destDir: string, merge?: boolean): Promise<string[]>;
  localMove(paths: string[], destDir: string, merge?: boolean): Promise<string[]>;
  /** Copies files to exact targets, replacing existing ones (comparing two local folders). */
  localCopyFiles(pairs: Array<[string, string]>): Promise<void>;
  /** Packs files and folders into a zip next to them; returns the archive's name. */
  localZip(paths: string[]): Promise<string>;
  /** Paths Bitcrane was started with from the Explorer menu (only once). */
  takePendingUploads(): Promise<string[]>;
  /** Extracts entries of archives into a new temporary folder; returns [folder, names]. */
  archiveExtractTemp(paths: string[]): Promise<[string, string[]]>;
  /** Shared settings file in a sync folder (null when there is none yet). */
  syncRead(dir: string): Promise<{ text: string; mtime: number } | null>;
  /** Writes the shared settings file; returns its new modification time. */
  syncWrite(dir: string, text: string): Promise<number>;
  /** Link to share a file or folder (cloud services only). */
  remoteShareLink(serverId: string, path: string): Promise<string>;
  /** Unpacks a zip into a new folder next to it; returns the folder's name. */
  localUnzip(path: string): Promise<string>;
  localWalk(path: string): Promise<WalkItem[]>;
  localPlaces(): Promise<Place[]>;
  /** Drives and volumes (C:, D:, USB sticks, network drives; volumes on the Mac). */
  localDrives(): Promise<Place[]>;
  /** Google Drive, OneDrive, Dropbox, iCloud Drive and Box folders of this computer. */
  localCloudPlaces(): Promise<CloudPlace[]>;
  /** Opens a file with the system's default program or with `app`. */
  localOpen(path: string, app?: string): Promise<void>;
  editTempPath(serverId: string, remotePath: string): Promise<string>;
  localReveal(path: string): Promise<void>;

  connect(serverId: string, params: ConnectParams): Promise<{ home: string; clockOffsetMs?: number | null }>;
  disconnect(serverId: string): Promise<void>;
  connectFtp(serverId: string, params: FtpConnectParams): Promise<{ home: string; clockOffsetMs?: number | null }>;
  connectDav(serverId: string, params: DavConnectParams): Promise<{ home: string; clockOffsetMs?: number | null }>;
  /** Dropbox with the refresh token from the sign-in (kept in the keychain). */
  connectDropbox(serverId: string, params: { refreshToken: string }): Promise<{ home: string; clockOffsetMs?: number | null }>;
  /** Which cloud services this build has app keys for. */
  cloudServices(): Promise<{ dropbox: boolean; onedrive: boolean }>;
  /** Sign-in in the browser; resolves with the refresh token and the account name. */
  /** Google Drive needs the user's own app key (client id and secret). */
  cloudSignIn(service: string, clientId?: string, clientSecret?: string): Promise<{ refreshToken: string; account: string }>;
  /** OneDrive; `refreshToken` in the answer is the renewed sign-in to keep. */
  connectOneDrive(serverId: string, params: { refreshToken: string }): Promise<{ home: string; clockOffsetMs?: number | null; refreshToken?: string }>;
  /** Google Drive with the refresh token and the user's own app key. */
  connectGDrive(serverId: string, params: { refreshToken: string; clientId: string; clientSecret: string }): Promise<{ home: string; clockOffsetMs?: number | null }>;
  cloudSignInCancel(): Promise<void>;
  remoteList(serverId: string, path: string): Promise<FileEntry[]>;
  remoteStat(serverId: string, path: string): Promise<FileEntry>;
  remoteMkdir(serverId: string, path: string): Promise<void>;
  remoteRename(serverId: string, path: string, newName: string): Promise<void>;
  remoteRemove(serverId: string, paths: string[]): Promise<void>;
  remoteMove(serverId: string, from: string, to: string): Promise<void>;
  /** Copies on the server itself; returns the new names. */
  remoteCopy(serverId: string, paths: string[], destDir: string): Promise<string[]>;
  remoteChmod(serverId: string, path: string, perms: string, recursive: boolean): Promise<void>;
  remoteWalk(serverId: string, path: string): Promise<WalkItem[]>;
  remoteExec(serverId: string, command: string): Promise<{ code: number; output: string }>;

  upload(id: string, serverId: string, localPath: string, remotePath: string, options: TransferOptions, onProgress: (done: number, total: number) => void): Promise<number>;
  download(id: string, serverId: string, remotePath: string, localPath: string, options: TransferOptions, onProgress: (done: number, total: number) => void): Promise<number>;
  /** True while the backend holds a working connection to the server. */
  isConnected(serverId: string): Promise<boolean>;
  /** Server to server: streams a file from one connected server to another. */
  cross(id: string, fromServerId: string, fromPath: string, serverId: string, remotePath: string, options: TransferOptions, onProgress: (done: number, total: number) => void): Promise<number>;
  /** Stops a running transfer; `discard` also deletes its partial file. */
  cancel(id: string, discard: boolean): Promise<void>;
  /** Deletes the partial file of a transfer that will not continue. */
  discardPartial(serverId: string, direction: 'up' | 'down', localPath: string, remotePath: string): Promise<void>;

  watchStart(watchId: string, localPath: string, recursive: boolean, excludes: string[], delayMs: number, onBatch: (b: WatchBatch) => void): Promise<void>;
  watchStop(watchId: string): Promise<void>;

  configLoad(): Promise<unknown>;
  configSave(value: unknown): Promise<void>;
  secretGet(account: string): Promise<string | null>;
  secretSet(account: string, value: string): Promise<void>;
  secretDelete(account: string): Promise<void>;
  sshConfigHosts(): Promise<SshConfigHost[]>;
  importFind(): Promise<{ servers: ImportedServer[]; sources: string[] }>;
  fileWrite(path: string, text: string): Promise<void>;
  fileRead(path: string): Promise<string>;

  localReadText(path: string): Promise<TextContent>;
  remoteReadText(serverId: string, path: string): Promise<TextContent>;
  /** Status icon: shown or not, tooltip, and the whole menu (see src-tauri/src/tray.rs). */
  trayUpdate(visible: boolean, tooltip: string, items: Array<{ id?: string; label?: string; enabled?: boolean; checked?: boolean; items?: unknown[] }>): Promise<void>;
  appQuit(): Promise<void>;

  localPreview(path: string): Promise<Preview>;
  remotePreview(serverId: string, path: string): Promise<Preview>;
  /** Copies a PDF/audio/video file of a server into a temporary file; returns its path. */
  remoteMedia(serverId: string, path: string): Promise<string>;
  keyInfo(path: string): Promise<KeyInfo>;
  keyGenerate(path: string, comment: string, passphrase?: string): Promise<string>;
  keyPublic(path: string): Promise<string>;
  sshTest(params: ConnectParams): Promise<string>;
  knownHostsList(): Promise<KnownHost[]>;
  knownHostsRemove(host: string): Promise<void>;
  logWrite(lines: string[]): Promise<void>;
  logPath(): Promise<string>;
}

/** Text of a file for the difference view; `truncated` when it was cut off. */
export interface TextContent {
  text: string;
  truncated: boolean;
}

/** Normalises anything thrown by a backend call into a `BackendError`. */
export function toBackendError(e: unknown): BackendError {
  // Messages from the Rust side are German; tr() gives the English version if needed.
  if (e && typeof e === 'object' && 'kind' in e && 'message' in e) return { ...(e as BackendError), message: tr((e as BackendError).message) };
  if (typeof e === 'string') return { kind: 'other', message: tr(e) };
  if (e instanceof Error) return { kind: 'other', message: e.message };
  return { kind: 'other', message: $t('Unerwarteter Fehler.') };
}

/** True when running inside the Tauri app (not in a plain browser). */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
