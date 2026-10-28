/**
 * Live mode: connects the store to the real backend (Rust core via Tauri).
 *
 * The browser prototype keeps using the synchronous mock file systems. In the
 * app, the store delegates to the functions in this module, which
 * - cache directory listings and reload them when a pane shows a new folder,
 * - open SSH sessions (host key check, passphrase and password prompts),
 * - run the transfer queue against the backend with real progress,
 * - start and stop folder watchers and turn their events into uploads,
 * - persist servers, watches and settings in the app's config file.
 */
import { startUpdateChecks } from './updates';
import type { AuthParams, BackendError, ConnectParams, TransferOptions, WalkItem } from '../backend/api';
import { toBackendError } from '../backend/api';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { FileEntry, PaneSide, Server, Tab, Transfer, Watch } from '../backend/types';
import { basename, join, parent } from '../util/paths';
import { addLog } from './log';
import { LANG, rememberLanguage } from '../i18n';
import {
  activeTab, editorFor, emptyTab, getState, offerCloudPlaces, openDialog, paneLoc, ruleFor, serverById, setState, showToast, subscribeStore, uid, watchExcludes, type AppState,
} from './store';
import { $t } from '../i18n';

/* ------------------------------------------------------------------------ */
/* Listing cache                                                            */
/* ------------------------------------------------------------------------ */

interface Listing {
  entries: FileEntry[];
  loading: boolean;
  error?: string;
}

const listings = new Map<string, Listing>();

function key(side: PaneSide, serverId: string, path: string): string {
  return side === 'local' ? `L|${path}` : `R|${serverId}|${path}`;
}

const bump = () => setState((s) => ({ fsRev: s.fsRev + 1 }));

/** Cached listing of a folder, or undefined while it was never loaded. */
export function cachedList(side: PaneSide, serverId: string, path: string): FileEntry[] | undefined {
  return listings.get(key(side, serverId, path))?.entries;
}

/** Loading and error state of a folder listing. */
export function listingStatus(side: PaneSide, serverId: string, path: string): { loading: boolean; error?: string } {
  const l = listings.get(key(side, serverId, path));
  return { loading: !l || l.loading, error: l?.error };
}

/** Entry of a path, looked up in the cached listing of its parent folder. */
export function cachedStat(side: PaneSide, serverId: string, path: string): FileEntry | undefined {
  const list = cachedList(side, serverId, parent(path));
  const name = basename(path);
  return list?.find((e) => e.name === name);
}

/** Reads a folder unless it is cached or being read (folders opened in place, views). */
export function requestListing(side: PaneSide, serverId: string, path: string) {
  if (side === 'remote' && (!serverId || !connected.has(serverId))) return;
  if (!listings.has(key(side, serverId, path))) void load(side, serverId, path);
}

async function load(side: PaneSide, serverId: string, path: string) {
  const k = key(side, serverId, path);
  const prev = listings.get(k);
  listings.set(k, { entries: prev?.entries ?? [], loading: true });
  bump();
  try {
    const t0 = Date.now();
    const entries = side === 'local' ? await backend.localList(path) : await backend.remoteList(serverId, path);
    listings.set(k, { entries, loading: false });
    if (side === 'remote') addLog('debug', $t('Ordner gelesen: {0} ({1} Einträge, {2} ms)', path, entries.length, Date.now() - t0), serverId);
  } catch (e) {
    const err = toBackendError(e);
    listings.set(k, { entries: [], loading: false, error: err.message });
    if (side === 'remote') handleRemoteError(serverId, err);
  }
  bump();
}

/** Forgets a cached folder so it is read again when visible. */
export function invalidate(side: PaneSide, serverId: string, path: string) {
  listings.delete(key(side, serverId, path));
}

/** Re-reads both visible folders of the active tab. */
export function refreshVisible() {
  const t = activeTab();
  if (!t) return;
  invalidate(...paneLoc('local', t), t.localPath);
  invalidate(...paneLoc('remote', t), t.remotePath);
  bump();
}

/** Loads the folders of the active tab when they are not cached yet. */
function ensureVisible(s: AppState) {
  const t = s.tabs.find((x) => x.id === s.activeTabId);
  if (!t) return;
  const [ls, lsid] = paneLoc('local', t);
  if (ls === 'local' ? !listings.has(key(ls, lsid, t.localPath)) : t.localPath && connected.has(lsid) && !listings.has(key(ls, lsid, t.localPath))) void load(ls, lsid, t.localPath);
  if (t.serverId && t.remotePath && connected.has(t.serverId) && !listings.has(key('remote', t.serverId, t.remotePath))) {
    void load('remote', t.serverId, t.remotePath);
  }
  // Two local halves (Total Commander): the right half lists this computer too.
  if (t.rightLocal && !t.serverId && t.remotePath && !listings.has(key('local', '', t.remotePath))) void load('local', '', t.remotePath);
  // Folders opened in place (triangle) are read again after a refresh.
  for (const side of ['local', 'remote'] as PaneSide[]) {
    const [sd, sid] = paneLoc(side, t);
    const base = side === 'local' ? t.localPath : t.remotePath;
    for (const rel of s.expanded[side]) requestListing(sd, sid, join(base, rel));
  }
}

/* ------------------------------------------------------------------------ */
/* Connections                                                              */
/* ------------------------------------------------------------------------ */

const connected = new Set<string>();
/** Server clock minus local clock (ms), measured when connecting. */
const clockOffsets = new Map<string, number>();

/**
 * Margin for "which copy is newer": SFTP keeps whole seconds, and a server
 * whose clock is off makes its own changes look older or newer by that much.
 */
/** How far the server's clock is ahead of this computer (ms; negative = behind), measured when connecting. */
export function clockOffset(serverId: string): number {
  return clockOffsets.get(serverId) ?? 0;
}

export function timeTolerance(serverId: string): number {
  return 1000 + Math.abs(clockOffsets.get(serverId) ?? 0);
}
const connecting = new Map<string, Promise<boolean>>();
/** Servers whose last connection attempt failed; no automatic retry until the user acts. */
const failed = new Set<string>();

export const isConnected = (serverId: string) => connected.has(serverId);
export const isConnecting = (serverId: string) => connecting.has(serverId);

function passphraseAccount(srv: Server) {
  return `passphrase:${srv.keyPath}`;
}
function passwordAccount(srv: Server) {
  return `password:${srv.user}@${srv.host}:${srv.port}`;
}
export function proxyAccount(p: { user?: string; host: string; port: number }) {
  return `proxy:${p.user ?? ''}@${p.host}:${p.port}`;
}

/** Removes the stored secrets of a deleted server, unless a remaining server uses the same account. */
export async function forgetSecrets(removed: Server, remaining: Server[]) {
  const accounts = (x: Server) => [passwordAccount(x), passphraseAccount(x), ...(x.proxy?.user ? [proxyAccount(x.proxy)] : [])];
  const inUse = new Set(remaining.flatMap(accounts));
  for (const a of accounts(removed)) if (!inUse.has(a)) await backend.secretDelete(a).catch(() => undefined);
}

/** Stored passwords and passphrases of these servers (for an encrypted export). */
export async function collectSecrets(servers: Server[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const accounts = new Set<string>();
  for (const x of servers) {
    accounts.add(passwordAccount(x));
    if (x.keyPath) accounts.add(passphraseAccount(x));
    if (x.proxy?.user) accounts.add(proxyAccount(x.proxy));
  }
  for (const a of accounts) {
    const v = await keychain(a);
    if (v !== undefined) out[a] = v;
  }
  return out;
}

/** Puts imported secrets into the system keychain. */
export async function restoreSecrets(secrets: Record<string, string>): Promise<number> {
  let n = 0;
  for (const [account, value] of Object.entries(secrets)) {
    if (await backend.secretSet(account, value).then(() => true, () => false)) n++;
  }
  return n;
}

/** SFTP (SSH) or one of the other protocols. */
export const isSftp = (srv: Pick<Server, 'protocol'>) => !srv.protocol || srv.protocol === 'sftp';

/** Address of a WebDAV server. */
export function davUrl(srv: Server): string {
  const https = srv.davHttps !== false;
  const port = srv.port && srv.port !== (https ? 443 : 80) ? `:${srv.port}` : '';
  const path = (srv.davPath || '/').startsWith('/') ? srv.davPath || '/' : `/${srv.davPath}`;
  return `${https ? 'https' : 'http'}://${srv.host}${port}${path}`;
}

/** Connects with the server's protocol; resolves to the start folder (and SSH clock offset). */
async function openConnection(id: string, srv: Server, auth: AuthParams, password: string | undefined, trust: string | undefined, jump: ConnectParams | undefined, proxy: ConnectParams['proxy']) {
  if (srv.protocol === 'ftp' || srv.protocol === 'ftps') {
    return backend.connectFtp(id, {
      host: srv.host, port: srv.port, user: srv.user, password, trust, proxy,
      tls: srv.protocol === 'ftp' ? 'none' : srv.implicitTls ? 'implicit' : 'explicit',
      tls13Only: !!srv.tls13Only, encoding: srv.ftpEncoding ?? 'utf8', tzOffsetMin: srv.ftpTimezone ?? 0, mode: srv.ftpMode ?? 'binary',
    });
  }
  if (srv.protocol === 'webdav') {
    return backend.connectDav(id, { url: davUrl(srv), user: srv.user, password, trust, proxy, tls13Only: !!srv.tls13Only });
  }
  return backend.connect(id, { host: srv.host, port: srv.port, user: srv.user, auth, trust, keepalive: getState().settings.keepAlive, jump, proxy });
}

/** Proxy of a server with the password from the keychain. */
async function proxyParams(srv: Server): Promise<ConnectParams['proxy']> {
  const p = srv.proxy;
  if (!p?.host) return undefined;
  return { kind: p.kind, host: p.host, port: p.port, user: p.user || undefined, password: p.user ? await keychain(proxyAccount(p)) : undefined };
}

interface ConnectOptions {
  /** Fingerprint the user just confirmed. */
  trust?: string;
  /** Passphrase or password typed by the user in the prompt. */
  secret?: string;
  /** What `secret` is (needed for "Automatisch", where both can be asked). */
  secretKind?: 'passphrase' | 'password';
  /** Store the typed secret in the system keychain after a successful login. */
  saveSecret?: boolean;
  /** Background reconnect: no dialogs, no toasts on failure. */
  silent?: boolean;
}

async function keychain(account: string): Promise<string | undefined> {
  try {
    return (await backend.secretGet(account)) ?? undefined;
  } catch {
    return undefined; // No keychain: the user is asked instead.
  }
}

/**
 * Login data of a server. Passphrase and password come from the prompt
 * (`typed`) or from the system keychain.
 */
async function buildAuth(srv: Server, typed?: { secret?: string; kind?: 'passphrase' | 'password' }): Promise<{ auth: AuthParams; passphrase?: string; password?: string }> {
  const kind = typed?.kind ?? (srv.auth === 'password' ? 'password' : 'passphrase');
  const passphrase = typed?.secret !== undefined && kind === 'passphrase' ? typed.secret : srv.auth === 'key' || srv.auth === 'auto' ? await keychain(passphraseAccount(srv)) : undefined;
  const password = typed?.secret !== undefined && kind === 'password' ? typed.secret : srv.auth === 'password' || srv.auth === 'auto' ? await keychain(passwordAccount(srv)) : undefined;
  switch (srv.auth) {
    case 'key': return { auth: { method: 'key', path: srv.keyPath, passphrase }, passphrase };
    case 'agent': return { auth: { method: 'agent' } };
    case 'password': return { auth: { method: 'password', password: password ?? '' }, password };
    default: return { auth: { method: 'auto', keyPath: srv.keyPath || undefined, passphrase, password }, passphrase, password };
  }
}

/** Login data of a jump server, with its secret from the keychain if stored. */
async function jumpParams(srv: Server, trust?: string): Promise<ConnectParams | undefined> {
  const j = srv.jumpServerId ? serverById(srv.jumpServerId) : undefined;
  if (!j || j.id === srv.id) return undefined;
  const { auth } = await buildAuth(j);
  return { host: j.host, port: j.port, user: j.user, auth, trust, keepalive: getState().settings.keepAlive, proxy: await proxyParams(j) };
}

const PROTOCOL_LABEL: Record<string, string> = { ftp: 'FTP', ftps: 'FTPS', webdav: 'WebDAV' };
const authLabel = (srv: Server) => (!isSftp(srv) ? `${PROTOCOL_LABEL[srv.protocol ?? ''] ?? ''}${srv.user ? $t(', Passwort') : $t(', anonym')}` : srv.auth === 'key' ? $t('Schlüssel {0}', srv.keyPath) : srv.auth === 'agent' ? 'SSH-Agent' : srv.auth === 'password' ? $t('Passwort') : $t('automatisch'));

/** Opens an SSH session for a saved server. Resolves to true when connected. */
/** Home folder of each connected server: a half that opens an already connected server starts there. */
const homes = new Map<string, string>();
export const homeOf = (serverId: string) => homes.get(serverId);

/** Password typed into "Schnell verbinden"; used once for the first connection of that server. */
const presetSecrets = new Map<string, { secret: string; save: boolean }>();

export function presetPassword(serverId: string, secret: string, save: boolean) {
  presetSecrets.set(serverId, { secret, save });
}

export function connectServer(serverId: string, opts: ConnectOptions = {}): Promise<boolean> {
  const preset = opts.secret === undefined ? presetSecrets.get(serverId) : undefined;
  if (preset) {
    presetSecrets.delete(serverId);
    opts = { ...opts, secret: preset.secret, secretKind: 'password', saveSecret: preset.save };
  }
  const running = connecting.get(serverId);
  if (running) return running;
  const p = doConnect(serverId, opts).finally(() => {
    connecting.delete(serverId);
    bump();
  });
  connecting.set(serverId, p);
  bump();
  return p;
}

async function doConnect(serverId: string, opts: ConnectOptions): Promise<boolean> {
  const srv = serverById(serverId);
  if (!srv) return false;
  const { auth, passphrase, password } = await buildAuth(srv, { secret: opts.secret, kind: opts.secretKind });
  // FTP without a user name logs in anonymously; everything else needs the password.
  const needsPassword = srv.auth === 'password' && !(srv.protocol === 'ftp' || srv.protocol === 'ftps') ? true : srv.auth === 'password' && !!srv.user;
  if (needsPassword && password === undefined) {
    if (opts.trust) pendingLogin.set(serverId, { trust: opts.trust });
    if (!opts.silent) openDialog({ type: 'secret', serverId, kind: 'password' });
    return false;
  }
  try {
    if (!opts.silent) addLog('info', $t('Verbinde mit {0}@{1}:{2} ({3})', srv.user, srv.host, srv.port, authLabel(srv)), serverId);
    const jump = isSftp(srv) ? await jumpParams(srv, opts.trust) : undefined;
    if (jump && !opts.silent) addLog('info', $t('Über den Sprungserver {0}@{1}:{2}', jump.user, jump.host, jump.port), serverId);
    const proxy = jump ? undefined : await proxyParams(srv);
    if (proxy && !opts.silent) addLog('info', $t('Über {0}-Proxy {1}:{2}', proxy.kind === 'http' ? 'HTTP' : 'SOCKS5', proxy.host, proxy.port), serverId);
    const { home, clockOffsetMs } = await openConnection(serverId, srv, auth, password, opts.trust, jump, proxy);
    connected.add(serverId);
    homes.set(serverId, home);
    pendingLogin.delete(serverId);
    addLog('ok', opts.silent ? $t('Wieder verbunden') : $t('Verbunden, Startordner {0}', home), serverId);
    if (typeof clockOffsetMs === 'number') {
      clockOffsets.set(serverId, Math.abs(clockOffsetMs) <= 1500 ? 0 : clockOffsetMs);
      if (Math.abs(clockOffsetMs) > 60000) {
        const min = Math.round(Math.abs(clockOffsetMs) / 60000);
        const text = $t('Die Uhr von {0} geht {1} {2} {3}. Bitcrane berücksichtigt das beim Vergleich von Änderungszeiten.', srv.name, min, min === 1 ? $t('Minute') : $t('Minuten'), clockOffsetMs > 0 ? $t('vor') : $t('nach'));
        addLog('warn', text, serverId);
        if (!opts.silent) showToast(text);
      } else if (Math.abs(clockOffsetMs) > 1500) {
        addLog('info', $t('Zeitunterschied zum Server: {0} Sekunden', Math.round(clockOffsetMs / 1000)), serverId);
      }
    }
    failed.delete(serverId);
    if (opts.saveSecret && opts.secret !== undefined) {
      const kind = opts.secretKind ?? (srv.auth === 'password' ? 'password' : 'passphrase');
      backend.secretSet(kind === 'passphrase' ? passphraseAccount(srv) : passwordAccount(srv), opts.secret).catch(() => {
        showToast($t('Konnte das Kennwort nicht im Schlüsselbund sichern.'), 'error');
      });
    }
    setState((s) => {
      const offline = { ...s.offline };
      delete offline[serverId];
      return {
        offline,
        servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: true } : x)),
        // Tabs without a remote folder start in the watched counterpart of the
        // local folder, otherwise in the home folder.
        tabs: s.tabs.map((t) => {
          // Server to server: the left half starts in this server's home folder.
          if (t.leftServerId === serverId && (!t.localPath || t.localPath === '~')) t = { ...t, localPath: home };
          if (t.serverId !== serverId || (t.remotePath && t.remotePath !== '~')) return t;
          const w = s.watches.find((x) => x.serverId === serverId && (t.localPath === x.localPath || t.localPath.startsWith(x.localPath + '/')));
          return { ...t, remotePath: w ? w.remotePath + t.localPath.slice(w.localPath.length) : home };
        }),
        watches: s.watches.map((w) => (w.serverId === serverId && w.state === 'waiting' ? { ...w, state: 'active' } : w)),
      };
    });
    if (!opts.silent) showToast($t('Verbunden mit {0}', srv.name), 'ok');
    else showToast($t('Wieder verbunden mit {0}. Wartende Dateien werden hochgeladen.', srv.name), 'ok');
    pump();
    // Start comparison for watches of this server that have not synced yet.
    for (const w of getState().watches) {
      if (w.serverId === serverId && w.state !== 'paused' && w.options.syncOnStart && !synced.has(w.id)) void initialSync(w);
    }
    return true;
  } catch (e) {
    const err = toBackendError(e);
    connected.delete(serverId);
    addLog(opts.silent ? 'warn' : 'error', opts.silent ? $t('Neuer Verbindungsversuch fehlgeschlagen: {0}', err.message) : err.message, serverId, err.detail);
    if (opts.silent) return false;
    failed.add(serverId);
    // Keep what was answered so far for the next question of this login.
    if (opts.secret !== undefined || opts.trust) pendingLogin.set(serverId, { secret: opts.secret, secretKind: opts.secretKind, saveSecret: opts.saveSecret, trust: opts.trust });
    switch (err.kind) {
      case 'hostKeyUnknown':
        if (err.hostKey) openDialog({ type: 'fingerprint', mode: 'new', serverId, key: err.hostKey });
        break;
      case 'hostKeyChanged':
        if (err.hostKey) openDialog({ type: 'fingerprint', mode: 'changed', serverId, key: err.hostKey });
        break;
      case 'passphraseRequired':
        openDialog({ type: 'secret', serverId, kind: 'passphrase', wrong: passphrase !== undefined });
        break;
      case 'passwordRequired':
        openDialog({ type: 'secret', serverId, kind: 'password' });
        break;
      case 'authFailed':
        if (srv.auth === 'password' || (srv.auth === 'auto' && password !== undefined)) openDialog({ type: 'secret', serverId, kind: 'password', wrong: true });
        else showToast(`${err.message}${err.detail ? ' ' + err.detail : ''}`, 'error');
        break;
      case 'cancelled':
        break;
      default:
        showToast(`${srv.name}: ${err.message}`, 'error');
    }
    return false;
  }
}

/** Whether a passphrase / password for this server is stored in the keychain. */
export async function hasStoredSecret(srv: Server): Promise<boolean> {
  if (srv.auth === 'agent') return false;
  return (await keychain(srv.auth === 'password' ? passwordAccount(srv) : passphraseAccount(srv))) !== undefined;
}

/** Adds a public key to ~/.ssh/authorized_keys on a connected server. */
export async function installPublicKey(serverId: string, publicKey: string): Promise<string | null> {
  if (!connected.has(serverId)) return $t('Dafür muss Bitcrane mit diesem Server verbunden sein (z. B. noch mit Passwort oder dem bisherigen Schlüssel).');
  // A public key line never contains single quotes; refuse anything else to keep the command safe.
  if (!/^[A-Za-z0-9@.+/=_ :-]+$/.test(publicKey)) return $t('Der öffentliche Schlüssel enthält unerwartete Zeichen.');
  const cmd = `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF '${publicKey}' ~/.ssh/authorized_keys || printf '%s\n' '${publicKey}' >> ~/.ssh/authorized_keys) && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;
  try {
    const r = await backend.remoteExec(serverId, cmd);
    if (r.code !== 0) return $t('Der Server meldet Code {0}: {1}', r.code, r.output.trim());
    addLog('ok', $t('Öffentlichen Schlüssel in ~/.ssh/authorized_keys eingetragen'), serverId);
    return null;
  } catch (e) {
    return toBackendError(e).message;
  }
}

/** "Verbindung testen" in the server dialog: logs in once and closes again. */
export async function testServer(srv: Server): Promise<{ ok: boolean; text: string }> {
  const { auth, passphrase, password } = await buildAuth(srv);
  if (srv.auth === 'password' && password === undefined) return { ok: true, text: $t('Das Passwort fragt Bitcrane beim Verbinden ab.') };
  try {
    if (!isSftp(srv)) {
      // Other protocols: a short connection with a temporary id.
      const id = `test-${uid('t')}`;
      const { home } = await openConnection(id, srv, auth, password, undefined, undefined, await proxyParams(srv));
      await backend.disconnect(id).catch(() => undefined);
      return { ok: true, text: $t('Erreichbar, Anmeldung erfolgreich (Startordner {0})', home) };
    }
    const jump = await jumpParams(srv);
    const home = await backend.sshTest({ host: srv.host, port: srv.port, user: srv.user, auth, keepalive: false, jump, proxy: jump ? undefined : await proxyParams(srv) });
    return { ok: true, text: home ? $t('Erreichbar, Anmeldung erfolgreich (Startordner {0})', home) : $t('Erreichbar. Den Fingerabdruck bestätigst du beim ersten Verbinden.') };
  } catch (e) {
    const err = toBackendError(e);
    if (err.kind === 'passphraseRequired' && passphrase === undefined) return { ok: true, text: $t('Erreichbar. Die Passphrase des Schlüssels fragt Bitcrane beim Verbinden ab.') };
    if (err.kind === 'passwordRequired') return { ok: true, text: $t('Erreichbar. Das Passwort fragt Bitcrane beim Verbinden ab.') };
    if (err.kind === 'hostKeyUnknown') return { ok: true, text: err.hostKey?.algorithm === 'TLS-Zertifikat' ? $t('Erreichbar. Das Zertifikat bestätigst du beim ersten Verbinden.') : $t('Erreichbar. Den Fingerabdruck bestätigst du beim ersten Verbinden.') };
    return { ok: false, text: err.message + (err.detail && err.kind !== 'unreachable' ? ` (${err.detail})` : '') };
  }
}

/** Closes the SSH session of a server. */
export async function disconnectServer(serverId: string) {
  connected.delete(serverId);
  addLog('info', $t('Getrennt'), serverId);
  failed.add(serverId);
  try {
    await backend.disconnect(serverId);
  } catch {
    // Already closed.
  }
  for (const k of [...listings.keys()]) if (k.startsWith(`R|${serverId}|`)) listings.delete(k);
  setState((s) => ({ servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: false } : x)) }));
  bump();
}

/** Called by user actions ("Verbinden", opening a server) to connect again. */
export function connectNow(serverId: string) {
  failed.delete(serverId);
  void connectServer(serverId);
}

/** Connects when a tab of the server becomes visible, unless the last attempt failed. */
export function autoConnect(serverId: string) {
  if (!connected.has(serverId) && !connecting.has(serverId) && !failed.has(serverId) && !getState().offline[serverId]) void connectServer(serverId);
}

/** Server to server: connects the right server first, then the left one (password prompts one after the other). */
export function autoConnectPair(right: string, left: string) {
  const needsRight = !connected.has(right) && !connecting.has(right) && !failed.has(right) && !getState().offline[right];
  if (needsRight) void connectServer(right).then(() => autoConnect(left));
  else autoConnect(left);
}

/** Lets the queue try a failed server again (after "Wiederholen"). */
export function clearFailed(serverId: string) {
  failed.delete(serverId);
}

/**
 * What the user already answered during one login (typed password, trusted
 * fingerprint), so a second question does not lose the first answer.
 */
const pendingLogin = new Map<string, Pick<ConnectOptions, 'secret' | 'secretKind' | 'saveSecret' | 'trust'>>();

/** Answer from the host key dialog. */
export function trustAndConnect(serverId: string, fingerprint: string) {
  failed.delete(serverId);
  void connectServer(serverId, { ...pendingLogin.get(serverId), trust: fingerprint });
}

/** Answer from the passphrase / password prompt. */
export function submitSecret(serverId: string, secret: string, save: boolean, kind: 'passphrase' | 'password') {
  failed.delete(serverId);
  void connectServer(serverId, { trust: pendingLogin.get(serverId)?.trust, secret, secretKind: kind, saveSecret: save });
}

/** Marks a server as dropped; a timer tries to reconnect in the background. */
function markOffline(serverId: string) {
  if (!connected.has(serverId) && (getState().offline[serverId] || failed.has(serverId))) return;
  connected.delete(serverId);
  addLog('warn', $t('Verbindung unterbrochen'), serverId);
  if (!getState().settings.autoReconnect) {
    // No automatic reconnect: the pane shows "Nicht verbunden" with a button.
    failed.add(serverId);
    showToast($t('Verbindung zu {0} unterbrochen.', serverById(serverId)?.name ?? $t('dem Server')), 'error');
    setState((s) => ({
      servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: false } : x)),
      watches: s.watches.map((w) => (w.serverId === serverId && w.state === 'active' ? { ...w, state: 'waiting' } : w)),
    }));
    return;
  }
  setState((s) => ({
    offline: { ...s.offline, [serverId]: { attempt: 1, nextRetry: Date.now() + 5000 } },
    servers: s.servers.map((x) => (x.id === serverId ? { ...x, online: false } : x)),
    watches: s.watches.map((w) => (w.serverId === serverId && w.state === 'active' ? { ...w, state: 'waiting' } : w)),
  }));
}

function handleRemoteError(serverId: string, err: BackendError) {
  if (err.kind === 'connectionLost' || err.kind === 'notConnected') markOffline(serverId);
}

/** Background reconnect with growing pauses (5 s, 10 s, … up to 60 s). */
async function retryOffline(now: number) {
  const s = getState();
  for (const [id, info] of Object.entries(s.offline)) {
    if (now < info.nextRetry || connecting.has(id)) continue;
    const ok = await connectServer(id, { silent: true });
    if (!ok) {
      setState((st) => (st.offline[id]
        ? { offline: { ...st.offline, [id]: { attempt: info.attempt + 1, nextRetry: Date.now() + Math.min(60, 5 * (info.attempt + 1)) * 1000 } } }
        : {}));
    } else {
      for (const k of [...listings.keys()]) if (k.startsWith(`R|${id}|`)) listings.delete(k);
      bump();
    }
  }
}

/* ------------------------------------------------------------------------ */
/* File operations                                                          */
/* ------------------------------------------------------------------------ */

async function run(side: PaneSide, serverId: string, dir: string, op: () => Promise<unknown>, okText?: string): Promise<boolean> {
  try {
    await op();
    invalidate(side, serverId, dir);
    bump();
    if (okText) showToast(okText, 'ok');
    return true;
  } catch (e) {
    const err = toBackendError(e);
    if (side === 'remote') handleRemoteError(serverId, err);
    showToast(err.message, 'error');
    invalidate(side, serverId, dir);
    bump();
    return false;
  }
}

export function renameEntry(side: PaneSide, serverId: string, dir: string, oldName: string, newName: string) {
  const path = join(dir, oldName);
  return run(side, serverId, dir, () => (side === 'local' ? backend.localRename(path, newName) : backend.remoteRename(serverId, path, newName)));
}

export function makeFolder(side: PaneSide, serverId: string, dir: string, name: string) {
  const path = join(dir, name);
  return run(side, serverId, dir, () => (side === 'local' ? backend.localMkdir(path) : backend.remoteMkdir(serverId, path)));
}

export function removeEntries(side: PaneSide, serverId: string, dir: string, names: string[]) {
  const paths = names.map((n) => join(dir, n));
  const what = names.length === 1 ? `„${names[0]}“` : $t('{0} Objekte', names.length);
  return run(
    side, serverId, dir,
    () => (side === 'local' ? backend.localTrash(paths) : backend.remoteRemove(serverId, paths)),
    side === 'local' ? $t('{0} in den Papierkorb gelegt.', what) : $t('{0} gelöscht.', what),
  );
}

const copiedText = (names: string[]) => (names.length === 1 ? $t('Kopiert als „{0}“.', names[0]) : $t('{0} Objekte kopiert.', names.length));

/** Copies on the server (⌘C, ⌘V in the same half). */
export async function copyOnServer(serverId: string, fromDir: string, names: string[], toDir: string) {
  let made: string[] = [];
  const ok = await run('remote', serverId, toDir, async () => { made = await backend.remoteCopy(serverId, names.map((n) => join(fromDir, n)), toDir); });
  if (ok) showToast(copiedText(made), 'ok');
}

/** Copies on this computer. */
/** Moves files or folders between two folders of this computer (two local halves). */
export async function moveLocal(fromDir: string, names: string[], toDir: string) {
  let made: string[] = [];
  const ok = await run('local', '', toDir, async () => { made = await backend.localMove(names.map((n) => join(fromDir, n)), toDir); });
  invalidate('local', '', fromDir);
  bump();
  if (ok) showToast(made.length === 1 ? $t('„{0}“ verschoben.', made[0]) : $t('{0} Objekte verschoben.', made.length), 'ok');
}

export async function copyLocal(fromDir: string, names: string[], toDir: string) {
  let made: string[] = [];
  const ok = await run('local', '', toDir, async () => { made = await backend.localCopy(names.map((n) => join(fromDir, n)), toDir); });
  if (ok) showToast(copiedText(made), 'ok');
}

export function changePerms(serverId: string, path: string, perms: string, recursive: boolean) {
  return run('remote', serverId, parent(path), () => backend.remoteChmod(serverId, path, perms, recursive), $t('Rechte gesetzt: {0}{1}', perms, recursive ? $t(' (mit Unterordnern)') : ''));
}

/** All files below a folder (for folder sizes and searching). */
export function walkFiles(side: PaneSide, serverId: string, path: string): Promise<WalkItem[]> {
  return side === 'local' ? backend.localWalk(path) : backend.remoteWalk(serverId, path);
}

export function openUrl(url: string) {
  backend.openUrl(url).catch((e) => showToast(toBackendError(e).message, 'error'));
}

export function openLocal(path: string, app?: string) {
  backend.localOpen(path, app).catch((e) => showToast(toBackendError(e).message, 'error'));
}

/* ------------------------------------------------------------------------ */
/* Editing server files                                                     */
/* ------------------------------------------------------------------------ */

interface EditSession {
  serverId: string;
  remotePath: string;
  localPath: string;
  /** Server modification time of the version the editor has. */
  remoteMtime: number;
  /** Ignore file events until then (our own download wrote the file). */
  quietUntil: number;
  /** Saved again while an upload was running: upload once more afterwards. */
  dirty?: boolean;
  watchId: string;
}

/** Mirrors the open working copies into the store ("Bearbeitete Dateien"). */
function publishEdits(patch?: { localPath: string; lastUpload: number }) {
  setState((st) => ({
    edits: [...editSessions.values()].map((e) => {
      const prev = st.edits.find((x) => x.localPath === e.localPath);
      return { localPath: e.localPath, serverId: e.serverId, remotePath: e.remotePath, openedAt: prev?.openedAt ?? Date.now(), lastUpload: patch?.localPath === e.localPath ? patch.lastUpload : prev?.lastUpload };
    }),
  }));
}

/** Stops uploading a working copy when it is saved (the file stays). */
export async function stopEditing(localPath: string) {
  const e = editSessions.get(localPath);
  if (!e) return;
  editSessions.delete(localPath);
  await backend.watchStop(e.watchId).catch(() => undefined);
  publishEdits();
}

/** Opens a working copy in the editor again. */
export function reopenEditing(localPath: string) {
  backend.localOpen(localPath, editorFor(localPath)).catch((e) => showToast(toBackendError(e).message, 'error'));
}

/** Uploads a working copy now, without waiting for the next save. */
export function uploadEditingNow(localPath: string) {
  const e = editSessions.get(localPath);
  if (!e) return;
  e.quietUntil = 0;
  uploadEdited(localPath);
}

/** Open working copies, by local path. */
const editSessions = new Map<string, EditSession>();

/**
 * Downloads a server file into a working folder, opens it in the editor and
 * uploads it again every time it is saved.
 */
export async function editRemote(serverId: string, remotePath: string) {
  try {
    const localPath = await backend.editTempPath(serverId, remotePath);
    const st = await backend.remoteStat(serverId, remotePath);
    const known = editSessions.get(localPath);
    if (known) known.quietUntil = Date.now() + 2000;
    await backend.download(uid('edit'), serverId, remotePath, localPath, { keepMtime: true, resume: false }, () => undefined);
    const watchId = known?.watchId ?? `edit-${uid('w')}`;
    editSessions.set(localPath, { serverId, remotePath, localPath, remoteMtime: st.mtime, quietUntil: Date.now() + 1500, watchId });
    if (!known) {
      // One watcher per working copy; it reports each save of the editor.
      await backend.watchStart(watchId, parent(localPath), false, [], 400, (b) => {
        if (b.changed.includes(localPath)) uploadEdited(localPath);
      });
    }
    publishEdits();
    backend.localOpen(localPath, editorFor(localPath)).catch((e) => showToast(toBackendError(e).message, 'error'));
    addLog('info', $t('Im Editor geöffnet: {0}', remotePath), serverId);
    showToast($t('„{0}“ ist im Editor geöffnet. Beim Sichern lädt Bitcrane die Datei wieder hoch.', basename(remotePath)));
  } catch (e) {
    const err = toBackendError(e);
    handleRemoteError(serverId, err);
    showToast(err.message, 'error');
  }
}

function uploadEdited(localPath: string) {
  const s = editSessions.get(localPath);
  if (!s || Date.now() < s.quietUntil) return;
  const pending = getState().transfers.filter((x) => x.source === localPath && (x.state === 'queued' || x.state === 'running'));
  // A queued upload reads the file when it starts, so it carries this save too.
  if (pending.some((x) => x.state === 'queued')) return;
  if (pending.length) {
    s.dirty = true;
    return;
  }
  backend.localStat(localPath).then((st) => {
    addLog('info', $t('Im Editor gesichert: {0}', s.remotePath), s.serverId);
    enqueue([{
      id: uid('t'), name: basename(s.remotePath), direction: 'up', serverId: s.serverId, folder: relFolder(parent(s.remotePath), s.remotePath),
      source: localPath, target: s.remotePath, size: st.size, done: 0, state: 'queued', editMtime: s.remoteMtime,
    }]);
  }).catch(() => undefined);
}

/** After an edited file went up: remember the new server time for the next save. */
function editUploaded(tr: Transfer) {
  const s = editSessions.get(tr.source);
  if (!s) return;
  publishEdits({ localPath: s.localPath, lastUpload: Date.now() });
  backend.remoteStat(tr.serverId, tr.target).then((st) => { s.remoteMtime = st.mtime; }).catch(() => undefined).finally(() => {
    if (!s.dirty) return;
    s.dirty = false;
    uploadEdited(s.localPath);
  });
}

/* ------------------------------------------------------------------------ */
/* Transfers                                                                */
/* ------------------------------------------------------------------------ */

function relFolder(root: string, path: string): string {
  const p = parent(path);
  if (p === root) return basename(root);
  return p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
}

function isExcluded(relative: string, excludes: string[]): boolean {
  return relative.split('/').some((seg) => excludes.some((p) => (p.startsWith('*.') ? seg.toLowerCase().endsWith(p.slice(1).toLowerCase()) : seg === p)));
}

function enqueue(items: Transfer[]) {
  if (!items.length) return;
  setState((s) => ({ transfers: [...s.transfers, ...items] }));
}

/** Rules "Beim Übertragen auslassen" (names, patterns, size) for transfers by hand. */
/** Left out by the general "auslassen" settings or by the server's transfer rule. */
function skippedByRules(relative: string, size: number, serverId = ''): boolean {
  const { skipPatterns, skipLargerMb } = getState().settings;
  const rule = serverId ? ruleFor(serverId) : undefined;
  const limit = rule?.skipLargerMb ?? skipLargerMb;
  return isExcluded(relative, skipPatterns) || (!!rule && isExcluded(relative, rule.excludes)) || (limit > 0 && size > limit * 1024 * 1024);
}

function reportSkipped(n: number, serverId: string) {
  if (!n) return;
  addLog('info', $t('{0} {1} nach den Regeln zum Auslassen nicht übertragen', n, n === 1 ? $t('Datei') : $t('Dateien')), serverId);
  showToast($t('{0} {1} ausgelassen (Einstellungen › Übertragungen).', n, n === 1 ? $t('Datei wurde') : $t('Dateien wurden')));
}

/** Uploads local files or folders (selected names in `localDir`) to `remoteDir`. */
export async function uploadNames(serverId: string, localDir: string, remoteDir: string, names: string[]) {
  const items: Transfer[] = [];
  let skipped = 0;
  for (const n of names) {
    let walk: WalkItem[];
    try {
      walk = await backend.localWalk(join(localDir, n));
    } catch (e) {
      showToast(toBackendError(e).message, 'error');
      continue;
    }
    for (const f of walk) {
      if (skippedByRules(f.relative, f.size, serverId)) { skipped++; continue; }
      const target = join(remoteDir, f.relative);
      items.push({ id: uid('t'), name: basename(f.path), direction: 'up', serverId, folder: relFolder(remoteDir, target), source: f.path, target, size: f.size, done: 0, state: 'queued', manual: true });
    }
  }
  enqueue(items);
  if (items.length > 1) showToast($t('{0} Dateien in der Warteschlange.', items.length));
  reportSkipped(skipped, serverId);
}

/** Uploads files and folders given as native paths (dropped from the Finder / Explorer). */
export async function uploadNativePaths(serverId: string, nativePaths: string[], remoteDir: string) {
  const byParent = new Map<string, string[]>();
  for (const n of nativePaths) {
    const ui = await invoke<string>('path_to_ui', { path: n });
    const dir = parent(ui);
    byParent.set(dir, [...(byParent.get(dir) ?? []), basename(ui)]);
  }
  for (const [dir, names] of byParent) await uploadNames(serverId, dir, remoteDir, names);
}

/** Downloads remote files or folders (names in `remoteDir`) into `localDir`. */
export async function downloadNames(serverId: string, remoteDir: string, localDir: string, names: string[]) {
  const items: Transfer[] = [];
  let skipped = 0;
  for (const n of names) {
    let walk: WalkItem[];
    try {
      walk = await backend.remoteWalk(serverId, join(remoteDir, n));
    } catch (e) {
      const err = toBackendError(e);
      handleRemoteError(serverId, err);
      showToast(err.message, 'error');
      continue;
    }
    for (const f of walk) {
      if (skippedByRules(f.relative, f.size, serverId)) { skipped++; continue; }
      const target = join(localDir, f.relative);
      items.push({ id: uid('t'), name: basename(f.path), direction: 'down', serverId, folder: relFolder(localDir, target), source: f.path, target, size: f.size, done: 0, state: 'queued', manual: true });
    }
  }
  enqueue(items);
  if (items.length > 1) showToast($t('{0} Dateien in der Warteschlange.', items.length));
  reportSkipped(skipped, serverId);
}

/** Server to server: copies files or folders (names in `fromDir` on one server) into `toDir` on another. */
export async function crossNames(fromServerId: string, fromDir: string, serverId: string, toDir: string, names: string[]) {
  const items: Transfer[] = [];
  let skipped = 0;
  for (const n of names) {
    let walk: WalkItem[];
    try {
      walk = await backend.remoteWalk(fromServerId, join(fromDir, n));
    } catch (e) {
      const err = toBackendError(e);
      handleRemoteError(fromServerId, err);
      showToast(err.message, 'error');
      continue;
    }
    for (const f of walk) {
      if (skippedByRules(f.relative, f.size, serverId)) { skipped++; continue; }
      const target = join(toDir, f.relative);
      items.push({ id: uid('t'), name: basename(f.path), direction: 'cross', sourceServerId: fromServerId, serverId, folder: relFolder(toDir, target), source: f.path, target, size: f.size, done: 0, state: 'queued', manual: true });
    }
  }
  enqueue(items);
  if (items.length > 1) showToast($t('{0} Dateien in der Warteschlange.', items.length));
  reportSkipped(skipped, serverId);
}

/** Transfers currently handled by the backend. */
const active = new Set<string>();
/** Transfers for which a cancel was sent. */
const cancelling = new Set<string>();
/** Transfers that already passed the "server copy is newer" / "exists" check. */
export const forcedLive = new Set<string>();
/** Watches whose post-upload command runs once their batch is done. */
const pendingCommand = new Set<string>();
let bytesThisSecond = 0;
const lastDone = new Map<string, number>();

function patchTransfer(id: string, patch: Partial<Transfer>) {
  setState((s) => ({ transfers: s.transfers.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
}

function removeTransfer(id: string) {
  setState((s) => ({ transfers: s.transfers.filter((x) => x.id !== id) }));
}

/** "644" -> 0o644; empty or invalid -> undefined (leave the permissions to the server). */
function octal(text: string | undefined): number | undefined {
  const t = (text ?? '').trim();
  return /^[0-7]{3,4}$/.test(t) ? parseInt(t, 8) : undefined;
}

/** Options for one transfer from the settings and the transfer's watch. */
function transferOptions(tr: Transfer): TransferOptions {
  const s = getState();
  const w = tr.watchId ? s.watches.find((x) => x.id === tr.watchId) : undefined;
  const share = Math.max(1, s.settings.parallel);
  // The transfer rule of the watch or the server comes first, then the general settings.
  const rule = ruleFor(tr.serverId, tr.watchId, s);
  return {
    tempName: s.settings.uploadTempName,
    keepMtime: s.settings.keepMtime,
    resume: true,
    // "Standard-Rechte" in the settings; a watch with "Rechte setzen" falls back to 644/755.
    filePerms: octal(rule?.filePerms) ?? octal(s.settings.uploadFilePerms) ?? (w?.options.setPermissions ? 0o644 : undefined),
    dirPerms: octal(rule?.dirPerms) ?? octal(s.settings.uploadDirPerms) ?? (w?.options.setPermissions ? 0o755 : undefined),
    keepVersions: rule?.keepOldVersion || w?.options.keepOldVersion ? KEEP_VERSIONS : 0,
    // The overall limit is shared between the parallel transfers.
    limitKbps: s.settings.bandwidthLimit > 0 ? Math.max(1, Math.floor(s.settings.bandwidthLimit / share)) : 0,
  };
}

/** Number of older versions kept per file ("Ältere Version auf dem Server behalten"). */
export const KEEP_VERSIONS = 5;

let pumpScheduled = false;
/** Starts queued transfers and stops ones the user paused or removed. */
export function pump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  queueMicrotask(() => {
    pumpScheduled = false;
    const s = getState();
    for (const id of active) {
      const tr = s.transfers.find((x) => x.id === id);
      if ((!tr || tr.state !== 'running') && !cancelling.has(id)) {
        cancelling.add(id);
        // Removed: throw the partial file away. Paused: keep it to continue later.
        backend.cancel(id, !tr).catch(() => undefined);
      }
    }
    let slots = Math.max(0, s.settings.parallel - active.size);
    for (const tr of s.transfers) {
      if (slots <= 0) break;
      if (tr.state !== 'queued' || s.offline[tr.serverId] || (tr.sourceServerId && s.offline[tr.sourceServerId])) continue;
      // Server to server needs both connections.
      const needed = tr.sourceServerId ? [tr.serverId, tr.sourceServerId] : [tr.serverId];
      const missing = needed.filter((id) => !connected.has(id));
      if (missing.length) {
        for (const id of missing) if (!connecting.has(id) && !failed.has(id)) void connectServer(id);
        continue;
      }
      slots--;
      void start(tr);
    }
  });
}

/** Deletes partial files of transfers the user removed from the list. */
function discardRemoved(prev: Transfer[], next: Transfer[]) {
  const still = new Set(next.map((t) => t.id));
  for (const t of prev) {
    if (still.has(t.id) || active.has(t.id) || t.direction === 'command' || t.state === 'done' || t.state === 'queued') continue;
    if ((t.direction === 'up' || t.direction === 'cross') && !connected.has(t.serverId)) continue;
    // Server to server keeps its partial file on the target server, like an upload.
    if (t.direction === 'cross') backend.discardPartial(t.serverId, 'up', '', t.target).catch(() => undefined);
    else backend.discardPartial(t.serverId, t.direction, t.direction === 'up' ? t.source : t.target, t.direction === 'up' ? t.target : t.source).catch(() => undefined);
  }
}

function verb(tr: Transfer) {
  return tr.direction === 'up' ? $t('Hochgeladen') : tr.direction === 'cross' ? $t('Übertragen') : $t('Heruntergeladen');
}

async function start(tr: Transfer) {
  active.add(tr.id);
  lastDone.set(tr.id, tr.done);
  patchTransfer(tr.id, { state: 'running', error: undefined, errorDetail: undefined, hold: undefined });
  try {
    if (tr.direction === 'command') {
      addLog('info', $t('Befehl: {0}', tr.name), tr.serverId);
      const res = await backend.remoteExec(tr.serverId, tr.name);
      const output = res.output.trim();
      if (res.code === 0) {
        patchTransfer(tr.id, { state: 'done', done: tr.size, finishedAt: Date.now(), output });
        addLog('ok', $t('Befehl fertig: {0}', tr.name), tr.serverId, output || undefined);
      } else {
        patchTransfer(tr.id, { state: 'error', error: $t('Befehl endete mit Code {0}', res.code), errorDetail: output || undefined, output });
        addLog('error', $t('Befehl endete mit Code {0}: {1}', res.code, tr.name), tr.serverId, output || undefined);
      }
      return;
    }
    if (await preflight(tr)) return;
    addLog('debug', `${tr.direction === 'up' ? $t('Lade hoch') : tr.direction === 'cross' ? $t('Übertrage von {0}', serverById(tr.sourceServerId ?? '')?.name ?? '') : $t('Lade herunter')}: ${tr.source} → ${tr.target}`, tr.serverId);
    const onProgress = (done: number) => {
      bytesThisSecond += Math.max(0, done - (lastDone.get(tr.id) ?? 0));
      lastDone.set(tr.id, done);
      const cur = getState().transfers.find((x) => x.id === tr.id);
      if (cur?.state === 'running') patchTransfer(tr.id, { done });
    };
    const opts = transferOptions(tr);
    const size = tr.direction === 'up'
      ? await backend.upload(tr.id, tr.serverId, tr.source, tr.target, opts, onProgress)
      : tr.direction === 'cross'
        ? await backend.cross(tr.id, tr.sourceServerId ?? '', tr.source, tr.serverId, tr.target, opts, onProgress)
        : await backend.download(tr.id, tr.serverId, tr.source, tr.target, opts, onProgress);
    patchTransfer(tr.id, { state: 'done', done: size, size, finishedAt: Date.now() });
    addLog('ok', `${verb(tr)}: ${tr.target}`, tr.serverId);
    if (tr.editMtime !== undefined) editUploaded(tr);
    const side: PaneSide = tr.direction === 'down' ? 'local' : 'remote';
    invalidate(side, tr.serverId, parent(tr.target));
    bump();
  } catch (e) {
    const err = toBackendError(e);
    const cur = getState().transfers.find((x) => x.id === tr.id);
    if (err.kind === 'cancelled') {
      // Paused: the partial file stays and the transfer continues from there.
      addLog('info', cur ? $t('Pausiert: {0}', tr.target) : $t('Abgebrochen: {0}', tr.target), tr.serverId);
    } else if (err.kind === 'connectionLost' || err.kind === 'notConnected') {
      patchTransfer(tr.id, { state: 'queued' });
      addLog('warn', $t('Verbindung unterbrochen bei {0}; wird fortgesetzt.', tr.name), tr.serverId, err.detail);
      if (tr.sourceServerId) {
        // Server to server: find out which of the two connections broke.
        for (const id of [tr.sourceServerId, tr.serverId]) {
          if (!(await backend.isConnected(id).catch(() => false))) markOffline(id);
        }
      } else markOffline(tr.serverId);
    } else if (cur && s0AutoRetry(tr, err)) {
      // Temporary problem: try again in a few seconds (up to three times).
    } else if (cur) {
      const detail = err.kind === 'permissionDenied'
        ? $t('Der Server verweigert das Schreiben in {0} (Permission denied). Prüfe die Ordnerrechte oder den Besitzer auf dem Server.', parent(tr.target))
        : err.detail;
      patchTransfer(tr.id, { state: 'error', error: err.message, errorDetail: detail });
      addLog('error', `${tr.name}: ${err.message}`, tr.serverId, detail);
      stopWatchOnError(tr, err.message);
    }
  } finally {
    active.delete(tr.id);
    cancelling.delete(tr.id);
    lastDone.delete(tr.id);
    afterTransfer(tr);
    pump();
  }
}

/** Errors that will not go away by trying again. */
const PERMANENT: BackendError['kind'][] = ['permissionDenied', 'notFound', 'alreadyExists', 'authFailed'];

/** Schedules an automatic retry; false when it is not worth one (or retries are used up). */
function s0AutoRetry(tr: Transfer, err: BackendError): boolean {
  const s = getState();
  const tries = tr.retries ?? 0;
  if (!s.settings.autoRetry || tries >= 3 || PERMANENT.includes(err.kind) || tr.direction === 'command') return false;
  patchTransfer(tr.id, { state: 'paused', error: $t('Neuer Versuch gleich ({0} von 3)', tries + 1), retries: tries + 1, hold: 'retry' });
  addLog('warn', $t('{0}: {1} – neuer Versuch in 5 Sekunden ({2} von 3)', tr.name, err.message, tries + 1), tr.serverId, err.detail);
  window.setTimeout(() => {
    const cur = getState().transfers.find((x) => x.id === tr.id);
    if (cur?.state === 'paused' && cur.hold === 'retry') patchTransfer(tr.id, { state: 'queued', error: undefined, hold: undefined });
  }, 5000);
  return true;
}

/** "Bei Fehlern weitermachen" switched off: an error pauses the watch. */
function stopWatchOnError(tr: Transfer, message: string) {
  const w = tr.watchId ? getState().watches.find((x) => x.id === tr.watchId) : undefined;
  if (!w || w.options.continueOnError || w.state === 'paused') return;
  setState((s) => ({ watches: s.watches.map((x) => (x.id === w.id ? { ...x, state: 'paused' } : x)) }));
  showToast($t('Überwachung „{0}“ angehalten: {1}, {2}', w.name, tr.name, message), 'error');
  addLog('warn', $t('Überwachung „{0}“ nach einem Fehler angehalten.', w.name), w.serverId);
}

async function statOrNull(side: PaneSide, serverId: string, path: string): Promise<FileEntry | null> {
  try {
    return side === 'local' ? await backend.localStat(path) : await backend.remoteStat(serverId, path);
  } catch {
    return null;
  }
}

/**
 * Checks before writing. Returns true when the transfer must not run now:
 * skipped (rule for existing files, "nur vorhandene"), or waiting for the
 * user in the conflict dialog.
 */
async function preflight(tr: Transfer): Promise<boolean> {
  const s = getState();
  const watch = tr.watchId ? s.watches.find((w) => w.id === tr.watchId) : undefined;
  if (forcedLive.has(tr.id) || tr.decided) return false;
  const targetSide: PaneSide = tr.direction === 'down' ? 'local' : 'remote';
  const sourceSide: PaneSide = tr.direction === 'up' ? 'local' : 'remote';
  // Server to server: the source is on another server than the target.
  const sourceServer = tr.sourceServerId ?? tr.serverId;

  // Saved in the editor: warn if someone changed the server file since it was opened.
  if (tr.editMtime !== undefined) {
    const remote = await statOrNull('remote', tr.serverId, tr.target);
    const local = await statOrNull('local', tr.serverId, tr.source);
    if (remote && local && remote.mtime - tr.editMtime > 1000) {
      askConflict(tr, 'newer', local, remote);
      return true;
    }
    return false;
  }

  if (watch) {
    if (!watch.options.onlyExisting && !watch.options.warnIfServerNewer) return false;
    const remote = await statOrNull('remote', tr.serverId, tr.target);
    if (!remote) {
      if (watch.options.onlyExisting) {
        removeTransfer(tr.id);
        addLog('info', $t('Nicht hochgeladen (nur vorhandene Dateien): {0}', tr.target), tr.serverId);
        return true;
      }
      return false;
    }
    if (!watch.options.warnIfServerNewer) return false;
    const local = await statOrNull('local', tr.serverId, tr.source);
    // SFTP stores whole seconds; allow for that rounding.
    if (!local || remote.mtime - local.mtime <= timeTolerance(tr.serverId)) return false;
    askConflict(tr, 'newer', local, remote, watch.name);
    return true;
  }

  if (!tr.manual) return false;
  const tRule = ruleFor(tr.serverId, undefined, s);
  const rule = tr.direction === 'down' ? tRule?.existingDown ?? s.settings.existingDownload : tRule?.existingUp ?? s.settings.existingFiles;
  if (rule === 'overwrite' && !s.settings.skipUnchanged) return false;
  const target = await statOrNull(targetSide, tr.serverId, tr.target);
  if (!target || target.kind === 'dir') return false;
  const source = await statOrNull(sourceSide, sourceServer, tr.source);
  if (!source) return false;
  const skip = (why: string) => {
    patchTransfer(tr.id, { state: 'done', done: 0, finishedAt: Date.now(), error: why });
    addLog('info', $t('Übersprungen ({0}): {1}', why, tr.target), tr.serverId);
    return true;
  };
  // Same size and modification time: the file is already there.
  if (s.settings.skipUnchanged && source.size === target.size && Math.abs(source.mtime - target.mtime) <= timeTolerance(tr.serverId)) return skip($t('unverändert'));
  if (rule === 'overwrite') return false;
  if (rule === 'skip') return skip($t('gibt es schon'));
  if (rule === 'keepBoth') {
    // Keep the existing file and store this one next to it under a free name.
    const names = new Set((await (targetSide === 'local' ? backend.localList(parent(tr.target)) : backend.remoteList(tr.serverId, parent(tr.target))).catch(() => [])).map((e) => e.name));
    const dot = tr.name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [tr.name.slice(0, dot), tr.name.slice(dot)] : [tr.name, ''];
    let n = 2;
    let free = `${stem} ${n}${ext}`;
    while (names.has(free)) free = `${stem} ${++n}${ext}`;
    patchTransfer(tr.id, { name: free, target: join(parent(tr.target), free), decided: true });
    tr.name = free;
    tr.target = join(parent(tr.target), free);
    addLog('info', $t('Gibt es schon, wird als „{0}“ daneben gespeichert', free), tr.serverId);
    return false;
  }
  if (rule === 'newer') return source.mtime - target.mtime > timeTolerance(tr.serverId) ? false : skip($t('Ziel ist gleich alt oder neuer'));
  const local = tr.direction === 'down' ? target : source;
  const remote = tr.direction === 'down' ? source : target;
  askConflict(tr, remote.mtime - local.mtime > timeTolerance(tr.serverId) && tr.direction !== 'down' ? 'newer' : 'exists', local, remote);
  return true;
}

function askConflict(tr: Transfer, reason: 'newer' | 'exists', local: FileEntry, remote: FileEntry, watchName?: string) {
  const direction: 'up' | 'down' = tr.direction === 'down' ? 'down' : 'up';
  setState((st) => ({
    conflicts: st.conflicts.some((c) => c.transferId === tr.id) ? st.conflicts : [...st.conflicts, {
      transferId: tr.id, name: tr.name, serverId: tr.serverId, direction, reason, cross: tr.direction === 'cross',
      sourceServerId: tr.sourceServerId,
      remoteFolder: parent(tr.direction === 'down' ? tr.source : tr.target),
      localSize: local.size, localTime: local.mtime, remoteSize: remote.size, remoteTime: remote.mtime, watchName, more: 0,
    }].map((c, i, arr) => ({ ...c, more: arr.length - 1 - i })),
    dialog: st.dialog ?? { type: 'conflict' },
    transfers: st.transfers.map((x) => (x.id === tr.id ? { ...x, state: 'paused', error: $t('Wartet auf Entscheidung'), hold: 'conflict' } : x)),
  }));
}

/** Updates the watch status and runs the post-upload command after a batch. */
function afterTransfer(tr: Transfer) {
  if (!tr.watchId) return;
  const s = getState();
  const w = s.watches.find((x) => x.id === tr.watchId);
  if (!w) return;
  const cur = s.transfers.find((x) => x.id === tr.id);
  if (cur?.state === 'done' && tr.direction === 'up' && !cur.error) {
    setState((st) => ({ watches: st.watches.map((x) => (x.id === w.id ? { ...x, lastFile: cur.name, lastTime: cur.finishedAt ?? Date.now() } : x)) }));
  }
  const batch = s.transfers.filter((x) => x.watchId === w.id && x.direction === 'up');
  const busy = batch.some((x) => x.state === 'running' || x.state === 'queued' || x.state === 'paused');
  if (!busy && pendingCommand.has(w.id)) {
    pendingCommand.delete(w.id);
    const hadError = batch.some((x) => x.state === 'error');
    if (w.options.commandEnabled && w.options.command.trim() && !hadError) {
      enqueue([{ id: uid('t'), name: w.options.command.trim(), direction: 'command', serverId: w.serverId, folder: '', source: '', target: '', size: 1, done: 0, state: 'queued', watchId: w.id }]);
    }
  }
}

/** Conflict answer "Server-Version herunterladen": download the server copy instead. */
export function downloadInstead(tr: Transfer) {
  setState((s) => ({
    transfers: s.transfers.map((x) => (x.id === tr.id
      ? { ...x, direction: 'down', source: tr.target, target: tr.source, state: 'queued', done: 0, error: undefined, hold: undefined, decided: true, watchId: undefined }
      : x)),
  }));
  pump();
}

/* ------------------------------------------------------------------------ */
/* Folder watches                                                           */
/* ------------------------------------------------------------------------ */

/** Watchers running in the backend: watch id -> configuration signature. */
const runningWatches = new Map<string, string>();

function signature(w: Watch) {
  return JSON.stringify([w.localPath, w.options.includeSubfolders, watchExcludes(w), w.options.delay]);
}

/** Starts, restarts and stops backend watchers to match the watch list. */
function reconcileWatches(s: AppState) {
  const wanted = new Map(s.watches.filter((w) => w.state !== 'paused').map((w) => [w.id, w] as const));
  for (const [id] of runningWatches) {
    const w = wanted.get(id);
    if (!w || signature(w) !== runningWatches.get(id)) {
      runningWatches.delete(id);
      backend.watchStop(id).catch(() => undefined);
    }
  }
  for (const [id, w] of wanted) {
    if (runningWatches.has(id)) continue;
    runningWatches.set(id, signature(w));
    backend.watchStart(id, w.localPath, w.options.includeSubfolders, watchExcludes(w), Math.max(200, w.options.delay * 1000), onWatchBatch)
      .then(() => {
        if (w.options.syncOnStart) {
          synced.delete(id);
          void initialSync(w);
        }
      })
      .catch((e) => {
        runningWatches.delete(id);
        showToast($t('Überwachung „{0}“: {1}', w.name, toBackendError(e).message), 'error');
        setState((st) => ({ watches: st.watches.map((x) => (x.id === id ? { ...x, state: 'paused' } : x)) }));
      });
  }
}

function watchTransfer(w: Watch, source: string, size: number): Transfer {
  const target = join(w.remotePath, relOf(w, source));
  return { id: uid('t'), name: basename(source), direction: 'up', serverId: w.serverId, folder: relFolder(w.remotePath, target), source, target, size, done: 0, state: 'queued', watchId: w.id };
}

/** True when a path (relative to the watched folder) lies in the selected subfolders. */
function inSelection(w: Watch, rel: string): boolean {
  if (!w.options.onlySelectedSubfolders) return true;
  return (w.subfolders ?? []).some((f) => rel === f || rel.startsWith(f + '/'));
}

/** Path below the watched folder; tolerates a trailing slash in older saved watches. */
function relOf(w: Watch, localPath: string) {
  const base = w.localPath.replace(/\/+$/, '');
  return localPath.startsWith(`${base}/`) ? localPath.slice(base.length + 1) : basename(localPath);
}
const remoteOf = (w: Watch, localPath: string) => join(w.remotePath, relOf(w, localPath));

async function onWatchBatch(b: { watchId: string; changed: string[]; removed: string[]; renamed?: Array<[string, string]> }) {
  const w = getState().watches.find((x) => x.id === b.watchId);
  if (!w || w.state === 'paused') return;
  addLog('debug', $t('Überwachung „{0}“: {1} geändert, {2} gelöscht, {3} umbenannt', w.name, b.changed.length, b.removed.length, b.renamed?.length ?? 0), w.serverId);
  const items: Transfer[] = [];
  const addFile = async (p: string) => {
    if (!inSelection(w, relOf(w, p))) return;
    // Skip files that are already waiting in the queue.
    if (getState().transfers.some((x) => x.source === p && x.state === 'queued')) return;
    try {
      const st = await backend.localStat(p);
      if (st.kind === 'file') items.push(watchTransfer(w, p, st.size));
      else if (st.kind === 'dir') {
        // A whole folder appeared (moved in or renamed): upload its files.
        for (const f of await backend.localWalk(p)) {
          if (!isExcluded(relOf(w, f.path), watchExcludes(w)) && inSelection(w, relOf(w, f.path))) items.push(watchTransfer(w, f.path, f.size));
        }
      }
    } catch {
      // Deleted again before we got to it.
    }
  };
  for (const p of b.changed) await addFile(p);

  // Renamed locally: rename on the server too when deleting is allowed for this
  // watch; otherwise upload under the new name and leave the old name alone.
  for (const [from, to] of b.renamed ?? []) {
    if (w.options.mirrorDeletes && connected.has(w.serverId) && inSelection(w, relOf(w, from))) {
      try {
        await backend.remoteMove(w.serverId, remoteOf(w, from), remoteOf(w, to));
        addLog('ok', $t('Umbenannt: {0} → {1}', remoteOf(w, from), remoteOf(w, to)), w.serverId);
        invalidate('remote', w.serverId, parent(remoteOf(w, from)));
        invalidate('remote', w.serverId, parent(remoteOf(w, to)));
        bump();
        continue;
      } catch (e) {
        // Not on the server (yet) or the new name exists: fall back to uploading.
        addLog('info', $t('Umbenennen auf dem Server nicht möglich, lade neu hoch: {0}', remoteOf(w, to)), w.serverId, toBackendError(e).message);
      }
    }
    await addFile(to);
  }

  if (items.length) {
    addLog('info', items.length === 1 ? $t('Änderung erkannt: {0}', relOf(w, items[0].source)) : $t('{0} Änderungen erkannt', items.length), w.serverId);
    pendingCommand.add(w.id);
    enqueue(items);
  }
  const removed = b.removed.filter((p) => inSelection(w, relOf(w, p)));
  if (w.options.mirrorDeletes && removed.length && connected.has(w.serverId)) {
    const targets = removed.map((p) => remoteOf(w, p));
    backend.remoteRemove(w.serverId, targets)
      .then(() => {
        targets.forEach((t) => {
          invalidate('remote', w.serverId, parent(t));
          addLog('ok', $t('Auf dem Server gelöscht: {0}', t), w.serverId);
        });
        bump();
      })
      .catch((e) => addLog('warn', $t('Löschen auf dem Server fehlgeschlagen'), w.serverId, toBackendError(e).message));
  }
}

/** "Beim Start abgleichen": uploads files that are newer locally or missing on the server. */
async function initialSync(w: Watch, manual = false) {
  if (!connected.has(w.serverId)) {
    // Runs again as soon as the connection is up (see doConnect).
    if (manual) connectNow(w.serverId);
    else autoConnect(w.serverId);
    return;
  }
  if (synced.has(w.id) && !manual) return;
  synced.add(w.id);
  try {
    const [local, remote] = await Promise.all([backend.localWalk(w.localPath), backend.remoteWalk(w.serverId, w.remotePath).catch(() => [] as WalkItem[])]);
    const remoteByRel = new Map(remote.map((r) => [r.path.slice(w.remotePath.length + 1), r] as const));
    const items: Transfer[] = [];
    for (const f of local) {
      const rel = relOf(w, f.path);
      if (isExcluded(rel, watchExcludes(w)) || !inSelection(w, rel)) continue;
      const r = remoteByRel.get(rel);
      if (!r && w.options.onlyExisting) continue;
      if (!r || f.mtime - r.mtime > timeTolerance(w.serverId)) items.push(watchTransfer(w, f.path, f.size));
    }
    if (items.length) {
      pendingCommand.add(w.id);
      enqueue(items);
      showToast(items.length === 1 ? $t('„{0}“: 1 Datei ist neuer als auf dem Server und wird hochgeladen.', w.name) : $t('„{0}“: {1} Dateien sind neuer als auf dem Server und werden hochgeladen.', w.name, items.length));
    } else if (manual) {
      showToast($t('„{0}“ ist auf dem Server aktuell.', w.name), 'ok');
    }
  } catch (e) {
    showToast($t('Abgleich „{0}“: {1}', w.name, toBackendError(e).message), 'error');
  }
}

/** "Abgleichen": runs the start comparison of a watch now. */
export function syncWatch(watchId: string) {
  const w = getState().watches.find((x) => x.id === watchId);
  if (w) void initialSync(w, true);
}

/** Watches whose start comparison already ran in this session. */
const synced = new Set<string>();

/** Runs the post-upload command of a watch right away. */
export function runCommandNow(watchId: string) {
  const w = getState().watches.find((x) => x.id === watchId);
  if (!w?.options.command.trim()) {
    showToast($t('Für diese Überwachung ist kein Befehl eingetragen.'));
    return;
  }
  enqueue([{ id: uid('t'), name: w.options.command.trim(), direction: 'command', serverId: w.serverId, folder: '', source: '', target: '', size: 1, done: 0, state: 'queued', watchId: w.id }]);
}

/** Deletes chosen in "Ordner abgleichen" (server files removed, local ones to the trash). */
/** Comparing two local folders: copies files to their exact targets, replacing older ones. */
export async function copyLocalFiles(pairs: Array<[string, string]>) {
  if (!pairs.length) return;
  try {
    await backend.localCopyFiles(pairs);
    pairs.forEach(([, to]) => { invalidate('local', '', parent(to)); addLog('ok', $t('Beim Abgleich kopiert: {0}', to)); });
    bump();
    showToast(pairs.length === 1 ? $t('1 Datei kopiert.') : $t('{0} Dateien kopiert.', pairs.length), 'ok');
  } catch (e) {
    showToast(toBackendError(e).message, 'error');
  }
}

export async function syncDeletes(serverId: string, remote: string[], local: string[]) {
  try {
    if (remote.length) {
      await backend.remoteRemove(serverId, remote);
      remote.forEach((p) => { invalidate('remote', serverId, parent(p)); addLog('ok', $t('Beim Abgleich gelöscht: {0}', p), serverId); });
    }
    if (local.length) {
      await backend.localTrash(local);
      local.forEach((p) => { invalidate('local', serverId, parent(p)); addLog('ok', $t('Beim Abgleich in den Papierkorb: {0}', p)); });
    }
    bump();
  } catch (e) {
    showToast(toBackendError(e).message, 'error');
  }
}

/** "Jetzt testen" in the watch dialog: runs the command once on the server. */
export async function testCommand(serverId: string, command: string): Promise<{ code: number; output: string } | { error: string }> {
  if (!connected.has(serverId)) {
    const ok = await connectServer(serverId);
    if (!ok) return { error: $t('Keine Verbindung zum Server.') };
  }
  try {
    addLog('info', $t('Befehl testen: {0}', command), serverId);
    const r = await backend.remoteExec(serverId, command);
    addLog(r.code === 0 ? 'ok' : 'error', $t('Test endete mit Code {0}', r.code), serverId, r.output.trim() || undefined);
    return r;
  } catch (e) {
    return { error: toBackendError(e).message };
  }
}

/** "Testlauf": tells the user how many files the watch would cover. */
export async function testRun(localPath: string, excludes: string[]) {
  try {
    const files = (await backend.localWalk(localPath)).filter((f) => !isExcluded(f.path.slice(localPath.length + 1), excludes));
    showToast($t('Testlauf: {0} Dateien würden beobachtet. Es wurde nichts übertragen.', files.length));
  } catch (e) {
    showToast(toBackendError(e).message, 'error');
  }
}

/* ------------------------------------------------------------------------ */
/* Configuration                                                            */
/* ------------------------------------------------------------------------ */

interface StoredConfig {
  version: 1;
  servers: Server[];
  watches: Watch[];
  settings: AppState['settings'];
  toolbar: AppState['toolbar'];
  toolbarLabels: AppState['toolbarLabels'];
  /** Unfinished manual transfers; they continue after a restart. Watches catch up on their own. */
  queue?: Transfer[];
  /** Open tabs of the last session ("Beim Start öffnen: Zuletzt geöffnete Tabs"). */
  tabs?: Array<{ serverId: string; localPath: string; remotePath: string; leftServerId?: string }>;
  activeTab?: number;
}

let loaded = false;

/** The first tab after starting: "Beim Start öffnen" in the settings. */
function startTab(servers: Server[], settings: AppState['settings']): Tab {
  const tab = emptyTab(settings.startLocal?.trim() || '~', settings.newTabRight);
  const srv = settings.startServer ? servers.find((x) => x.id === settings.startServer) : undefined;
  return srv ? { ...tab, serverId: srv.id, remotePath: srv.remoteStart, rightLocal: undefined } : tab;
}

/** True once the saved configuration has been read. */
export const isConfigLoaded = () => loaded;
let saveTimer: number | undefined;
let lastSaved = '';

function snapshot(s: AppState): string {
  const cfg: StoredConfig = {
    version: 1,
    servers: s.servers.filter((x) => !x.temporary).map((x) => ({ ...x, online: false })),
    watches: s.watches.map((w) => ({ ...w, state: w.state === 'paused' ? 'paused' : 'active' })),
    settings: s.settings,
    toolbar: s.toolbar,
    toolbarLabels: s.toolbarLabels,
    tabs: s.tabs.filter((t) => !s.servers.find((x) => x.id === t.serverId)?.temporary)
      .map((t) => {
        // A temporary server on the left is not kept; the left half shows this computer then.
        const left = t.leftServerId && !s.servers.find((x) => x.id === t.leftServerId)?.temporary ? t.leftServerId : undefined;
        return { serverId: t.serverId, localPath: left || !t.leftServerId ? t.localPath : '~', remotePath: t.remotePath, ...(left ? { leftServerId: left } : {}) };
      }),
    activeTab: Math.max(0, s.tabs.findIndex((t) => t.id === s.activeTabId)),
    // Progress is left out, so the file is not rewritten on every progress step.
    queue: s.transfers
      .filter((t) => t.direction !== 'command' && !t.watchId && t.editMtime === undefined && (t.state === 'queued' || t.state === 'running' || t.state === 'paused'))
      .filter((t) => !s.servers.find((x) => x.id === t.serverId)?.temporary)
      .map((t) => ({ ...t, state: t.state === 'paused' && !t.hold ? 'paused' : 'queued', done: 0, error: undefined, errorDetail: undefined, hold: undefined })),
  };
  return JSON.stringify(cfg);
}

function scheduleSave(s: AppState) {
  if (!loaded) return;
  const snap = snapshot(s);
  // Cancel first: a change that was undone again must not be written later.
  window.clearTimeout(saveTimer);
  if (snap === lastSaved) return;
  saveTimer = window.setTimeout(() => {
    lastSaved = snap;
    backend.configSave(JSON.parse(snap)).catch(() => showToast($t('Einstellungen konnten nicht gespeichert werden.'), 'error'));
  }, 400);
}

/** Reads the drives and volumes of this computer for the sidebar. */
async function loadDrives() {
  const drives = await backend.localDrives().catch(() => []);
  const cur = getState().drives;
  if (drives.length !== cur.length || drives.some((d, i) => d.path !== cur[i].path || d.name !== cur[i].name)) setState({ drives });
}

/** Writes pending changes at once (before quitting). */
export async function saveNow() {
  if (!loaded) return;
  window.clearTimeout(saveTimer);
  const snap = snapshot(getState());
  if (snap === lastSaved) return;
  lastSaved = snap;
  await backend.configSave(JSON.parse(snap)).catch(() => undefined);
}

/**
 * Start at login ("--autostart"): with "Beim Start nur im Infobereich" the window stays hidden and
 * only the status icon is there; otherwise it opens now. A normal start already showed it (Rust).
 */
/** Mac: one-time hint about "Festplattenvollzugriff" (Full Disk Access). */
export function showDiskAccessHint() {
  setState((st) => ({ settings: { ...st.settings, diskAccessHinted: true } }));
  openDialog({
    type: 'confirm',
    title: $t('Zugriff auf deine Ordner'),
    text: $t('macOS fragt bei jedem geschützten Ordner (Schreibtisch, Dokumente, Downloads, iCloud, Cloud-Ordner) einzeln, ob Bitcrane ihn lesen darf. Statt vieler einzelner Fragen kannst du Bitcrane einmal den „Festplattenvollzugriff“ geben: Systemeinstellungen › Datenschutz & Sicherheit › Festplattenvollzugriff › Bitcrane einschalten. Das geht auch später unter Einstellungen › Allgemein.'),
    confirm: $t('Systemeinstellungen öffnen'),
    run: () => { void invoke('open_full_disk_access').catch(() => undefined); },
  });
}

async function decideStartWindow() {
  try {
    const atLogin = await invoke<boolean>('start_info');
    if (atLogin && getState().settings.startHidden) setState({ startedHidden: true });
    else if (atLogin) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().show();
    }
    await invoke('start_decided');
  } catch {
    // Rust shows the window by itself after a while.
  }
}

async function loadConfig() {
  let cfg: Partial<StoredConfig> | null = null;
  try {
    cfg = (await backend.configLoad()) as Partial<StoredConfig> | null;
  } catch (e) {
    // The backend kept a copy of the broken file, so starting empty loses nothing.
    const err = toBackendError(e);
    cfg = null;
    window.setTimeout(() => showToast(err.message, 'error'), 500);
    addLog('error', err.message, undefined, err.detail);
  }
  // Old bookmarks (folder pairs) become places of their server.
  // Up to 0.2.14 the import gave every server a colour in turn; nobody chose them. Reset once to "no colour".
  const resetColours = !!cfg && !cfg.settings?.coloursReset;
  const servers = (cfg?.servers ?? []).map((x) => (x.bookmarks?.length && !x.places
    ? { ...x, places: x.bookmarks.map((b) => ({ name: b.name, path: b.remote })), bookmarks: undefined }
    : x)).map((x) => (resetColours ? { ...x, color: 'gray' as const } : x));
  // The language is read before the settings file at start; keep both in step.
  if (cfg?.settings?.language && cfg.settings.language !== LANG) rememberLanguage(cfg.settings.language);
  setState((s) => ({
    servers,
    // Watches run again after a start, unless paused or set not to start with Bitcrane.
    watches: (cfg?.watches ?? []).map((w) => ({ ...w, state: w.state === 'paused' || w.options?.startWithApp === false ? 'paused' : 'active' })),
    // Older versions had a single switch "Automatisch nach Updates suchen".
    settings: { ...s.settings, ...(cfg?.settings ?? {}), ...(cfg?.settings && !cfg.settings.updateMode && (cfg.settings as { autoUpdate?: boolean }).autoUpdate === false ? { updateMode: 'off' as const } : {}), coloursReset: true },
    toolbar: (cfg?.toolbar ?? s.toolbar).filter((x) => (x as string) !== 'sidebar'),
    toolbarLabels: cfg?.toolbarLabels ?? s.toolbarLabels,
    // The server list in the right half greets new users; no separate first-run screen.
    firstRun: false,
    // Unfinished transfers of the last session continue (from their partial files).
    transfers: (cfg?.queue ?? []).filter((t) => servers.some((x) => x.id === t.serverId)).map((t) => ({ ...t, id: uid('t') })),
    // Bitcrane starts locally without a server (like WinSCP's "Neuer Tab"), unless a start server is set.
    tabs: [startTab(servers, { ...s.settings, ...(cfg?.settings ?? {}) })],
  }));
  setState((s) => ({ activeTabId: s.tabs[0]?.id ?? '' }));
  lastSaved = snapshot(getState());
  loaded = true;
  void decideStartWindow();
  // Mac: macOS asks once per protected folder (Schreibtisch, Dokumente, Downloads, iCloud …).
  // Explain once how to allow all of them at once.
  // Real macOS only (the Linux test build shows the Mac look as well).
  if (getState().platform === 'mac' && navigator.userAgent.includes('Macintosh') && !getState().settings.diskAccessHinted) {
    // Waits until no other window (e.g. the cloud folders offer) is open.
    const tryHint = () => (getState().dialog ? window.setTimeout(tryHint, 3000) : showDiskAccessHint());
    window.setTimeout(tryHint, 2500);
  }
  // Saved comparisons with a schedule run by themselves from now on.
  void import('./scheduler').then((m) => m.startScheduler());
  try {
    const [places, home] = await Promise.all([backend.localPlaces(), backend.localStat('~')]);
    setState({ homeName: home.name, ...(places.length ? { places } : {}) });
  } catch {
    // Keep the default places.
  }
  void loadDrives();
  // First start: offer the cloud folders found on this computer as places (Transmit).
  if (!getState().settings.cloudAsked) window.setTimeout(() => void offerCloudPlaces(false), 800);
  // A USB stick or network drive may come and go; look again when the window gets the focus.
  window.addEventListener('focus', () => void loadDrives());
  const activeTabNow = getState().tabs.find((t) => t.id === getState().activeTabId);
  const activeServer = activeTabNow?.serverId;
  // Server to server: the left server connects after the right one, so two password prompts never overlap.
  const leftServer = activeTabNow?.leftServerId;
  if (activeServer) void connectServer(activeServer).then(() => { if (leftServer) autoConnect(leftServer); });
  if (getState().transfers.length) pump();
  addLog('info', $t('Bitcrane gestartet, {0} {1}, {2} Überwachungen', servers.length, servers.length === 1 ? $t('Server') : $t('Server'), getState().watches.length));
}

/** Cloud storage folders of this computer (empty when the lookup fails). */
export async function cloudPlaces() {
  return backend.localCloudPlaces().catch(() => []);
}

/**
 * "Schnell verbinden": parses "user@host:port/path". Host names from
 * ~/.ssh/config (aliases) are resolved when that setting is on.
 */
export async function quickConnect(address: string, save: boolean, auth: 'auto' | 'key' | 'password'): Promise<Server | null> {
  // Optional scheme: sftp:// (default), ftp://, ftps://, ftpes:// (explicit TLS), webdav:// / davs://.
  const scheme = address.trim().match(/^([a-z]+):\/\//i)?.[1]?.toLowerCase() ?? 'sftp';
  const protocol: Server['protocol'] = scheme === 'ftp' ? 'ftp' : scheme === 'ftps' || scheme === 'ftpes' ? 'ftps' : scheme === 'webdav' || scheme === 'davs' || scheme === 'dav' ? 'webdav' : 'sftp';
  const m = address.trim().replace(/^[a-z]+:\/\//i, '').match(/^(?:([^@]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/);
  if (!m) {
    showToast($t('Adresse nicht erkannt. Beispiele: ubuntu@server.example:22, ftp://web@host.example'), 'error');
    return null;
  }
  const [, userPart, hostPart, portPart, path] = m;
  let host = hostPart;
  let user = userPart ?? '';
  const defaultPort = protocol === 'ftp' ? 21 : protocol === 'ftps' ? (scheme === 'ftps' ? 990 : 21) : protocol === 'webdav' ? (scheme === 'dav' ? 80 : 443) : 22;
  let port = portPart ? Number(portPart) : defaultPort;
  let keyPath = '~/.ssh/id_ed25519';
  let method: Server['auth'] = auth === 'password' ? 'password' : auth === 'key' ? 'key' : 'auto';
  if (protocol !== 'sftp') {
    return {
      id: uid('srv'), name: hostPart, mono: hostPart.slice(0, 2).toUpperCase(), color: 'gray', host, port, user, auth: 'password', keyPath,
      group: '', localStart: '~', remoteStart: protocol === 'webdav' ? '' : path || '', online: false, temporary: !save,
      protocol, implicitTls: scheme === 'ftps' || undefined, davPath: protocol === 'webdav' ? path || '/' : undefined, davHttps: protocol === 'webdav' ? scheme !== 'dav' : undefined,
    };
  }
  if (getState().settings.readSshConfig) {
    const alias = (await backend.sshConfigHosts().catch(() => [])).find((h) => h.alias === hostPart);
    if (alias) {
      host = alias.host;
      user = userPart ?? alias.user;
      port = portPart ? port : alias.port;
      if (alias.identityFile) {
        keyPath = alias.identityFile;
        if (auth === 'auto') method = 'key';
      }
    }
  }
  if (!user) {
    showToast($t('Bitte einen Benutzer angeben, zum Beispiel ubuntu@server.example.'), 'error');
    return null;
  }
  return {
    id: uid('srv'), name: hostPart, mono: hostPart.slice(0, 2).toUpperCase(), color: 'gray', host, port, user, auth: method, keyPath,
    group: '', localStart: '~', remoteStart: path || '', online: false, temporary: !save,
  };
}

/* ------------------------------------------------------------------------ */
/* Start                                                                    */
/* ------------------------------------------------------------------------ */

let started = false;
let prev: AppState | null = null;

/** Starts live mode once: loads the config and wires the store to the backend. */
export function startLive() {
  if (started) return;
  started = true;
  // Questions of a server during login (one-time code etc.) open a dialog.
  void listen<{ id: string; serverId: string; host: string; name: string; instructions: string; prompts: Array<{ text: string; echo: boolean }> }>('auth-prompt', (e) => {
    addLog('info', $t('Der Server fragt: {0}', e.payload.prompts.map((p) => p.text.trim()).join(' / ')), e.payload.serverId || undefined);
    openDialog({ type: 'authPrompt', ...e.payload });
  });
  subscribeStore(() => {
    const s = getState();
    if (prev && prev === s) return;
    const p = prev;
    prev = s;
    ensureVisible(s);
    if (p && p.transfers !== s.transfers) discardRemoved(p.transfers, s.transfers);
    if (!p || p.transfers !== s.transfers || p.settings.parallel !== s.settings.parallel) pump();
    if (!p || p.watches !== s.watches) reconcileWatches(s);
    if (!p || p.servers !== s.servers || p.watches !== s.watches || p.settings !== s.settings || p.toolbar !== s.toolbar
      || p.toolbarLabels !== s.toolbarLabels || p.tabs !== s.tabs || p.activeTabId !== s.activeTabId || p.transfers !== s.transfers) scheduleSave(s);
  });
  window.setInterval(() => {
    const now = Date.now();
    setState({ now, speed: bytesThisSecond });
    bytesThisSecond = 0;
    void retryOffline(now);
  }, 1000);
  void loadConfig().then(() => {
    reconcileWatches(getState());
    startUpdateChecks();
  });
}
