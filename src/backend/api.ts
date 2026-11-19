/**
 * Backend interface used by the store.
 *
 * `tauriBackend` implements it with the Rust core (real files, real SSH/SFTP).
 * The browser prototype does not use it; there the store works on the
 * in-memory demo file systems in `mockFs.ts`.
 */
import type { CloudPlace, FileEntry, HostKey, Place, PortForward, Server } from './types';
import { $t } from '../i18n';

export interface WalkItem {
  /** Full path (UI form). */
  path: string;
  /**
   * Path relative to the walked item's parent, starting with its own name, with the names a
   * server uses: what an upload creates and what a comparison matches both sides by.
   */
  relative: string;
  /**
   * The same path with the names this computer stores, which is what a download creates. Differs
   * only on Windows, where the core writes names it cannot store as %XX ("a:b" as "a%3Ab").
   */
  localRelative: string;
  size: number;
  mtime: number;
}

export type { CloudPlace, Place } from './types';

/** A file whose content matches "Im Inhalt suchen". */
export interface GrepHit {
  path: string;
  rel: string;
  size: number;
  mtime: number;
  line: string;
  lineNo: number;
}

/** Checksum algorithms offered in "Prüfsumme". */
export type ChecksumAlgo = 'md5' | 'sha1' | 'sha256' | 'sha512';

/**
 * Where a secret is kept in the system keychain (src-tauri/src/secrets.rs). The interface names a
 * secret to store or forget it or to ask whether it is stored; no call reads one back. The core
 * uses stored secrets only for the server they were saved for, and export and sync files carry
 * them encrypted with a password the user types (see secrets.rs for the exact limits).
 */
export type SecretRef =
  | { kind: 'password'; user: string; host: string; port: number }
  | { kind: 'passphrase'; keyPath: string }
  | { kind: 'proxy'; user: string; host: string; port: number }
  | { kind: 'cloud'; serverId: string }
  | { kind: 'googleClient' }
  | { kind: 'syncPassword' };

/**
 * One login (see `ConnectRequest` in src-tauri/src/commands/connect.rs). The core takes the jump
 * server from the saved servers and uses stored secrets only when `server` matches its saved entry.
 */
export interface ConnectRequest {
  server: Server;
  /** Typed into the prompt just now; otherwise the stored one is used. */
  password?: string;
  passphrase?: string;
  /** Typed into the prompt for the jump server's password just now. */
  jumpPassword?: string;
  /** Fingerprint or certificate the user confirmed in the host key dialog. */
  trust?: string;
  /** Send keepalive messages (setting "Verbindung offen halten"). */
  keepalive: boolean;
  /** Google Drive: client id of the user's own app key. */
  googleClientId: string;
}

/** Text encrypted with a password, as export and sync files store it (src-tauri/src/secrets.rs). */
export interface Sealed {
  kdf: string;
  iterations: number;
  salt: string;
  iv: string;
  data: string;
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
  | 'hostKeyUnknown'
  | 'hostKeyChanged'
  | 'authFailed'
  | 'passphraseRequired'
  | 'passwordRequired'
  | 'jumpPasswordRequired'
  | 'unreachable'
  | 'notConnected'
  | 'connectionLost'
  | 'permissionDenied'
  | 'notFound'
  | 'alreadyExists'
  | 'cancelled'
  | 'other';

/** Error shape returned by every backend call. */
export interface BackendError {
  kind: ErrorKind;
  /** In the interface language. */
  message: string;
  detail?: string;
  hostKey?: HostKey;
}

/**
 * A message of the Rust core (see src-tauri/src/error.rs): the German text, which is also the key
 * of the translation, and the values for its `{0}`, `{1}` …. A value is shown as it is (a file
 * name, a host) or is a message of its own.
 */
export interface BackendMessage {
  key: string;
  params?: Array<string | BackendMessage>;
}

/** An error as the Rust core sends it. */
type RustError = BackendMessage & Omit<BackendError, 'message'>;

export interface WatchBatch {
  watchId: string;
  changed: WatchedFile[];
  removed: WatchedFile[];
  /** Renamed or moved inside the watched folder: [from, to]. */
  renamed: Array<[WatchedFile, WatchedFile]>;
  /** The watch cannot go on (folder gone, the system stopped reporting); the lists are empty. */
  error?: unknown;
}

/** A file or folder of a watch batch. */
export interface WatchedFile {
  /** Path on this computer. */
  path: string;
  /** Path below the watched folder with the names a server uses (see `WalkItem.relative`). */
  real: string;
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
  auth: 'key' | 'agent' | 'password' | 'auto';
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

/** A Finder tag (Mac) of a file; `color` is the Finder colour number 0 to 7. */
export interface Tag {
  name: string;
  color: number;
}

/** A file or folder found by its Finder tag. */
export interface TaggedFile {
  path: string;
  size: number;
  mtime: number;
  dir: boolean;
}

/** State of a git working copy (see `git.rs`). */
export interface GitStatus {
  root: string;
  branch: string;
  ahead: number;
  behind: number;
  /** Path relative to root → M, A, D, R, ? or U. */
  files: Record<string, string>;
}

/** A shell of this computer that the local terminal can run. */
export interface LocalShell {
  id: string;
  name: string;
}

/** A computer in the network that announces file shares (Bonjour). */
export interface NetworkHost {
  name: string;
  host: string;
}

/** Line ending of an editor document; "mixed" keeps every "\r" in the text and saves it as edited. */
export type EditorEol = '\n' | '\r\n' | 'mixed';
/** Encoding of an editor document: UTF-8, or Latin-1 for a file that is not valid UTF-8. */
export type EditorEncoding = 'utf8' | 'latin1';

/** A file opened in the built-in editor; `eol`, `bom` and `encoding` are kept when it is saved. */
export interface EditorFile {
  text: string;
  mtime: number;
  eol: EditorEol;
  bom: boolean;
  encoding: EditorEncoding;
}

/** The part of a tunnel the backend needs to run it. */
export type ForwardSpec = Pick<PortForward, 'id' | 'kind' | 'bindHost' | 'bindPort' | 'destHost' | 'destPort'>;

/** A session of the built-in terminal; a local one has an empty `serverId`. */
export interface TermOpenParams {
  id: string;
  serverId: string;
  cols: number;
  rows: number;
  cwd?: string;
  /** Command run after the login (server setting). */
  startup?: string;
  /** Local shell id (see `LocalShell`); only for a local terminal. */
  shell?: string;
}

/** What "Terminal öffnen" connects to: a local folder, or a server with its folder. */
export interface TerminalTarget {
  localPath: string;
  host?: string;
  port?: number;
  user?: string;
  keyPath?: string;
  remotePath?: string;
  /** Terminal program (setting "externalTerminal"); the system's default when missing. */
  app?: string;
}

export interface Backend {
  /** Converts a native path (from a system dialog or a drop) into the interface's form. */
  pathToUi(path: string): Promise<string>;
  /** Real target of each folder (links resolved, interface form), in the same order; unchanged when unresolvable. */
  localRealPaths(paths: string[]): Promise<string[]>;
  /** Free bytes on the volume of a folder; null when unknown. */
  localFreeSpace(path: string): Promise<number | null>;
  /** Finder tags of the entries of a folder, by name. */
  localTags(dir: string): Promise<Record<string, Tag[]>>;
  /** Sets (`on`) or removes a tag on files. */
  localTag(paths: string[], name: string, color: number, on: boolean): Promise<void>;
  localTagFind(name: string): Promise<TaggedFile[]>;
  networkHosts(): Promise<NetworkHost[]>;
  /** Null outside a git working copy or without git. */
  gitStatus(dir: string): Promise<GitStatus | null>;
  /** Runs add, addAll, commit, pull or push; resolves to git's output. */
  gitAction(root: string, what: string, paths: string[], message: string, all: boolean): Promise<string>;
  /** Copies server files into temporary files for dragging them out of the window; returns their native paths. */
  remoteDragPrepare(serverId: string, paths: string[]): Promise<string[]>;
  /** Hands native files to the system's drag and drop. */
  dragOut(paths: string[]): Promise<void>;

  editorRead(serverId: string | null, path: string): Promise<EditorFile>;
  /** Modification time in ms; `serverId` null for a file of this computer. */
  editorMtime(serverId: string | null, path: string): Promise<number>;
  /** Saves the text with the given line ending; returns the new modification time. */
  editorWrite(
    serverId: string | null,
    path: string,
    text: string,
    eol: EditorEol,
    bom: boolean,
    encoding: EditorEncoding,
  ): Promise<number>;

  termShells(): Promise<LocalShell[]>;
  termOpen(params: TermOpenParams): Promise<void>;
  termWrite(id: string, data: string): Promise<void>;
  termResize(id: string, cols: number, rows: number): Promise<void>;
  termClose(id: string): Promise<void>;
  /** Opens the system's terminal program (outside Bitcrane). */
  openTerminal(target: TerminalTarget): Promise<void>;
  /** Tabby's config.yaml, null when Tabby is not installed. */
  tabbyConfig(): Promise<string | null>;
  /** Ids of the tunnels running now. */
  forwardActive(): Promise<string[]>;
  forwardStart(serverId: string, spec: ForwardSpec): Promise<void>;
  forwardStop(id: string): Promise<void>;
  /** Answers a keyboard-interactive login prompt; null cancels it. */
  authPromptAnswer(id: string, answers: string[] | null): Promise<void>;

  /** Version of the running app. */
  appVersion(): Promise<string>;
  /** Path of the program for `bitcrane …` on the command line. */
  cliPath(): Promise<string>;
  /** True after a start at login (the window may stay hidden). */
  startInfo(): Promise<boolean>;
  /** Tells Rust the interface decided about the window, so it does not show it by itself. */
  startDecided(): Promise<void>;
  /** Tells the next start that it follows an update, so the window opens. */
  markUpdateRestart(): Promise<void>;
  /** Prevents the computer from sleeping while `on`. */
  keepAwake(on: boolean): Promise<void>;
  /** "sleep" or "shutdown". */
  systemPower(action: string): Promise<void>;
  /** Adds or removes the "upload with Bitcrane" entry of the system's context menu. */
  shellIntegrationSet(enable: boolean, label: string): Promise<void>;
  /** Mac: whether Bitcrane has Full Disk Access. */
  macFullDiskAccess(): Promise<boolean>;
  /** Mac: opens a page of the System Settings: "fullDisk", "localNetwork", "notifications" or "loginItems". */
  openMacSettings(page: string): Promise<void>;

  localList(path: string): Promise<FileEntry[]>;
  localStat(path: string): Promise<FileEntry>;
  localMkdir(path: string): Promise<void>;
  localNewFile(path: string): Promise<void>;
  localRename(path: string, newName: string): Promise<void>;
  localTrash(paths: string[]): Promise<void>;
  /** Checksum as hex; `algo` is md5, sha1, sha256 (default) or sha512. */
  localChecksum(path: string, algo?: ChecksumAlgo): Promise<string>;
  remoteChecksum(serverId: string, path: string, algo?: ChecksumAlgo): Promise<string>;
  remoteSymlink(serverId: string, link: string, target: string): Promise<void>;
  /** Opens an http(s) address in the default browser. */
  openUrl(url: string): Promise<void>;
  /**
   * Copies into a folder on this computer; returns the new names ("x Kopie" on a clash). With
   * `merge`, a folder whose name exists in the target is merged into it ("Zusammenführen").
   */
  localCopy(paths: string[], destDir: string, merge?: boolean): Promise<string[]>;
  localMove(paths: string[], destDir: string, merge?: boolean): Promise<string[]>;
  /** Copies files to exact targets, replacing existing ones (comparing two local folders). */
  localCopyFiles(pairs: Array<[string, string]>): Promise<void>;
  /** Packs files and folders into a zip next to them; returns the archive's name. */
  localZip(paths: string[]): Promise<string>;
  /** Paths Bitcrane was started with from the Explorer menu (only once). */
  takePendingUploads(): Promise<string[]>;
  /** The jump list entry (Windows) Bitcrane was started from: an action id of the status menu. */
  takeStartAction(): Promise<string | null>;
  /** The sftp:// link Bitcrane was started with (Windows), once. */
  takeStartLink(): Promise<string | null>;
  /** Bitcrane as the program for sftp:// links on or off (Windows). */
  sftpLinksSet(enable: boolean): Promise<void>;
  /** Extracts entries of archives into a new temporary folder; returns [folder, names]. */
  archiveExtractTemp(paths: string[]): Promise<[string, string[]]>;
  /** Shared settings file in a sync folder (null when there is none yet). */
  syncRead(dir: string): Promise<{ text: string; mtime: number } | null>;
  /** Writes the shared settings file; returns its new modification time. */
  syncWrite(dir: string, text: string): Promise<number>;
  /** Link to share a file or folder (cloud services only). */
  remoteShareLink(serverId: string, path: string): Promise<string>;
  /** Files below a folder whose text contains `query` (see local.rs grep / remote.rs grep). */
  localGrep(path: string, query: string, max?: number): Promise<GrepHit[]>;
  remoteGrep(serverId: string, path: string, query: string, max?: number): Promise<GrepHit[]>;
  /** S3: download link valid for `secs` seconds (at most 7 days). */
  remotePresign(serverId: string, path: string, secs: number): Promise<string>;
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
  /** Windows: shows a server (connected under `connectionId`) as a folder in the Explorer; resolves to the folder. */
  mountStart(connectionId: string, serverId: string, name: string, remoteRoot: string): Promise<string>;
  /** Takes it out again; resolves to the folder when it had to stay (outstanding uploads). */
  mountStop(serverId: string, removeFolder: boolean): Promise<string | null>;
  /** Folder of a server shown in the Explorer right now. */
  mountFolder(serverId: string): Promise<string | null>;

  /**
   * Logs into a server and keeps the connection under `serverId`; resolves to the start folder and
   * a problem that did not stop the login (an error to report).
   */
  serverConnect(
    serverId: string,
    request: ConnectRequest,
  ): Promise<{ home: string; clockOffsetMs?: number | null; warning?: unknown }>;
  /** "Verbindung testen": logs in once and closes again; resolves to the start folder. */
  serverTest(request: ConnectRequest): Promise<string>;
  disconnect(serverId: string): Promise<void>;
  /** Creates an empty Cryptomator vault in the new folder `location`. */
  vaultCreate(location: string, storageId: string | undefined, password: string): Promise<void>;
  /** Which cloud services this build has app keys for. */
  cloudServices(): Promise<{ dropbox: boolean; onedrive: boolean }>;
  /**
   * Sign-in in the browser; the core keeps it in the keychain for the server entry `serverId`.
   * Resolves to the account name. Google Drive needs the user's own app key (client id here,
   * secret in the keychain).
   */
  cloudSignIn(service: string, serverId: string, googleClientId: string): Promise<string>;
  cloudSignInCancel(): Promise<void>;
  remoteList(serverId: string, path: string): Promise<FileEntry[]>;
  remoteStat(serverId: string, path: string): Promise<FileEntry>;
  remoteMkdir(serverId: string, path: string): Promise<void>;
  remoteNewFile(serverId: string, path: string): Promise<void>;
  remoteRename(serverId: string, path: string, newName: string): Promise<void>;
  remoteRemove(serverId: string, paths: string[]): Promise<void>;
  remoteMove(serverId: string, from: string, to: string): Promise<void>;
  /** Copies on the server itself; returns the new names. */
  remoteCopy(serverId: string, paths: string[], destDir: string): Promise<string[]>;
  remoteChmod(serverId: string, path: string, perms: string, recursive: boolean): Promise<void>;
  remoteWalk(serverId: string, path: string): Promise<WalkItem[]>;
  remoteExec(serverId: string, command: string): Promise<{ code: number; output: string }>;

  upload(
    id: string,
    serverId: string,
    localPath: string,
    remotePath: string,
    options: TransferOptions,
    onProgress: (done: number, total: number) => void,
  ): Promise<number>;
  download(
    id: string,
    serverId: string,
    remotePath: string,
    localPath: string,
    options: TransferOptions,
    onProgress: (done: number, total: number) => void,
  ): Promise<number>;
  /** True while the backend holds a working connection to the server. */
  isConnected(serverId: string): Promise<boolean>;
  /** Server to server: streams a file from one connected server to another. */
  cross(
    id: string,
    fromServerId: string,
    fromPath: string,
    serverId: string,
    remotePath: string,
    options: TransferOptions,
    onProgress: (done: number, total: number) => void,
  ): Promise<number>;
  /** Stops a running transfer; `discard` also deletes its partial file. */
  cancel(id: string, discard: boolean): Promise<void>;
  /** Deletes the partial file of a transfer that will not continue. */
  discardPartial(serverId: string, direction: 'up' | 'down', localPath: string, remotePath: string): Promise<void>;

  watchStart(
    watchId: string,
    localPath: string,
    recursive: boolean,
    excludes: string[],
    delayMs: number,
    onBatch: (b: WatchBatch) => void,
  ): Promise<void>;
  watchStop(watchId: string): Promise<void>;

  configLoad(): Promise<unknown>;
  configSave(value: unknown): Promise<void>;
  secretStore(secret: SecretRef, value: string): Promise<void>;
  secretForget(secret: SecretRef): Promise<void>;
  /** Whether the secret is stored (a keychain that cannot be read counts as not). */
  secretExists(secret: SecretRef): Promise<boolean>;
  /** Removes the secrets of a deleted server that no remaining server shares. */
  serverForgetSecrets(removed: Server, remaining: Server[]): Promise<void>;
  /** Encrypts an export file's payload; `withSecrets` adds the stored secrets of its servers. */
  exportSeal(payload: unknown, password: string, withSecrets: boolean): Promise<{ encrypted: Sealed; secrets: number }>;
  /** Decrypts an export file and stores its secrets; null when the password is wrong. */
  importUnseal(sealed: Sealed, password: string): Promise<{ data: unknown; restored: number } | null>;
  /** The secrets of these servers for the sync file; null without a sync password. */
  syncSecretsSeal(servers: Server[]): Promise<Sealed | null>;
  /**
   * Stores the sync file's secrets that are missing here. Fails when the sync password does not
   * open them; resolves to the keychain's refusal, if any (an error to report).
   */
  syncSecretsUnseal(sealed: Sealed): Promise<unknown>;
  sshConfigHosts(): Promise<SshConfigHost[]>;
  importFind(): Promise<{ servers: ImportedServer[]; sources: string[] }>;
  /** Servers from an exported file (Transmit, FileZilla, WinSCP, Cyberduck). */
  importFile(path: string): Promise<ImportedServer[]>;
  fileWrite(path: string, text: string): Promise<void>;
  fileRead(path: string): Promise<string>;

  localReadText(path: string): Promise<TextContent>;
  remoteReadText(serverId: string, path: string): Promise<TextContent>;
  /** Status icon: shown or not, tooltip, and the whole menu (see src-tauri/src/tray.rs). */
  trayUpdate(
    visible: boolean,
    tooltip: string,
    items: Array<{ id?: string; label?: string; enabled?: boolean; checked?: boolean; items?: unknown[] }>,
  ): Promise<void>;
  appQuit(): Promise<void>;

  localPreview(path: string): Promise<Preview>;
  remotePreview(serverId: string, path: string): Promise<Preview>;
  /** Copies a PDF/audio/video file of a server into a temporary file; returns its path. */
  remoteMedia(serverId: string, path: string): Promise<string>;
  keyInfo(path: string): Promise<KeyInfo>;
  keyGenerate(path: string, comment: string, passphrase?: string): Promise<string>;
  keyPublic(path: string): Promise<string>;
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

/** A message of the Rust core in the interface language; its values are never translated. */
export function messageText(m: BackendMessage): string {
  return $t(m.key, ...(m.params ?? []).map((p) => (typeof p === 'string' ? p : messageText(p))));
}

/**
 * Normalises anything thrown by a backend call into a `BackendError`: an error of the Rust core,
 * one the interface made itself (already in its language), or the text of a Tauri plugin.
 */
export function toBackendError(e: unknown): BackendError {
  if (e && typeof e === 'object' && 'kind' in e) {
    if ('key' in e) {
      const { key, params, ...rest } = e as RustError;
      return { ...rest, message: messageText({ key, params }) };
    }
    if ('message' in e) return e as BackendError;
  }
  if (typeof e === 'string') return { kind: 'other', message: e };
  if (e instanceof Error) return { kind: 'other', message: e.message };
  return { kind: 'other', message: $t('Unerwarteter Fehler.') };
}
