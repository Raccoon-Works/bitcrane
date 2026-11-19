/**
 * Connecting to servers: host keys, passwords and passphrases, retries and the
 * bookkeeping of which servers are connected.
 */
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { type Server, isCloudProtocol, TLS_CERTIFICATE } from '../../backend/types';
import { type StoredConfig } from './config';
import { serverById, getState, showToast, setState, subscribeStore } from '../core';
import type { AppState } from '../appState';
import { type ConnectRequest, type SecretRef, toBackendError, type BackendError } from '../../backend/api';
import { $t } from '../../i18n';
import { bump, listings } from './listing';
import { openDialog } from '../panels';
import { addLog } from '../log';
import { pump } from './transfers';
import { startAutoForwards, refreshForwards } from '../forward';
import { synced, initialSync } from './watches';
import { showError } from '../errors';
import { updateSettings } from '../settings';
import { offerCloudPlaces } from '../places';
import { saveNow } from './config';

export const connected = new Set<string>();
/** Server clock minus local clock (ms), measured when connecting. */
const clockOffsets = new Map<string, number>();

/** How far the server's clock is ahead of this computer (ms; negative = behind), measured when connecting. */
export function clockOffset(serverId: string): number {
  return clockOffsets.get(serverId) ?? 0;
}

/**
 * Margin for "which copy is newer": SFTP keeps whole seconds, and a server
 * whose clock is off makes its own changes look older or newer by that much.
 */
export function timeTolerance(serverId: string): number {
  return 1000 + Math.abs(clockOffsets.get(serverId) ?? 0);
}
export const connecting = new Map<string, Promise<boolean>>();
/** Servers whose last connection attempt failed; no automatic retry until the user acts. */
export const failed = new Set<string>();

export const isConnected = (serverId: string) => connected.has(serverId);
export const isConnecting = (serverId: string) => connecting.has(serverId);

/** The keychain entry of a server's password (also an S3 secret key and a vault's password). */
function passwordRef(srv: Server): SecretRef {
  return { kind: 'password', user: srv.user, host: srv.host, port: srv.port };
}

/** The keychain entry of a key file's passphrase. */
export function passphraseRef(keyPath: Server['keyPath']): SecretRef {
  return { kind: 'passphrase', keyPath };
}

/** The keychain entry of a proxy password. */
export function proxyRef(p: { user?: string; host: string; port: number }): SecretRef {
  return { kind: 'proxy', user: p.user ?? '', host: p.host, port: p.port };
}

/**
 * Whether a secret is stored. Only the core reads secrets; the interface needs to know whether
 * to ask the user for one.
 */
export function hasSecret(secret: SecretRef): Promise<boolean> {
  return backend.secretExists(secret);
}

/** Removes the stored secrets of a deleted server, unless a remaining server uses the same entry. */
export async function forgetSecrets(removed: Server, remaining: Server[]) {
  await backend.serverForgetSecrets(removed, remaining);
}

/** SFTP (SSH) or one of the other protocols. */
export const isSftp = (srv: Pick<Server, 'protocol'>) => !srv.protocol || srv.protocol === 'sftp';

/**
 * 0.2.44 brought the built-in terminal: a toolbar the user had changed gets
 * its button once (before "Informationen"), so it can be found. Removing it
 * afterwards sticks (settings.toolbarTerminalAdded).
 */
export function withTerminalButton(
  cfg: Partial<StoredConfig> | null | undefined,
  toolbar: AppState['toolbar'],
): AppState['toolbar'] {
  const settings = cfg?.settings as { toolbarTerminalAdded?: boolean } | undefined;
  if (!cfg?.toolbar || settings?.toolbarTerminalAdded || toolbar.includes('terminal')) return toolbar;
  const at = toolbar.indexOf('info');
  return at < 0 ? [...toolbar, 'terminal'] : [...toolbar.slice(0, at), 'terminal', ...toolbar.slice(at)];
}

/**
 * The jump server of an SFTP server, if one is set, for the log and the password prompt. The core
 * finds it by the same rule (`Server::jump_id`, src-tauri/src/serverconfig.rs).
 */
function jumpOf(srv: Server): Server | undefined {
  const j = isSftp(srv) && srv.jumpServerId ? serverById(srv.jumpServerId) : undefined;
  return j && j.id !== srv.id ? j : undefined;
}

/** What the user typed into the prompt, as password or passphrase. */
function typedSecret(srv: Server, typed: Pick<ConnectOptions, 'secret' | 'secretKind'>) {
  const kind = typed.secretKind ?? (srv.auth === 'password' ? 'password' : 'passphrase');
  return {
    password: kind === 'password' ? typed.secret : undefined,
    passphrase: kind === 'passphrase' ? typed.secret : undefined,
  };
}

/** A login for the core: the server and what the user typed or confirmed. */
function loginRequest(
  srv: Server,
  typed: Pick<ConnectOptions, 'secret' | 'secretKind' | 'trust' | 'jumpPassword'> = {},
): ConnectRequest {
  return {
    server: srv,
    ...typedSecret(srv, typed),
    jumpPassword: typed.jumpPassword,
    trust: typed.trust,
    keepalive: getState().settings.keepAlive,
    googleClientId: getState().settings.googleClientId ?? '',
  };
}

/** A vault whose files lie on another server needs that server connected first. */
function checkVaultStorage(srv: Server) {
  if (srv.protocol === 'vault' && srv.vaultStorageId && !connected.has(srv.vaultStorageId)) {
    throw {
      kind: 'notConnected',
      message: $t('Erst mit {0} verbinden, dort liegt der Tresor.', serverById(srv.vaultStorageId)?.name ?? '?'),
    };
  }
}

/** Connects with the server's protocol; resolves to the start folder (and SSH clock offset). */
async function openConnection(id: string, srv: Server, request: ConnectRequest) {
  checkVaultStorage(srv);
  // The core uses stored secrets only for a server that matches its saved entry, so a change made
  // just now (saving waits a moment to collect changes) has to be in the file first.
  await saveNow();
  return backend.serverConnect(id, request);
}

/**
 * Whether the login has a password: typed just now, or stored for a method that sends one (the
 * same rule the core follows, `Server::uses_password` in src-tauri/src/serverconfig.rs). Asking
 * before connecting avoids a failed attempt: an SMB or FTP login would otherwise first try without
 * a password and report a wrong one.
 */
async function hasPassword(srv: Server, typed: Pick<ConnectOptions, 'secret' | 'secretKind'> = {}) {
  if (typedSecret(srv, typed).password !== undefined) return true;
  return (srv.auth === 'password' || srv.auth === 'auto') && hasSecret(passwordRef(srv));
}

/** Whether the login has a key passphrase: typed just now, or stored for a method that reads a key (`Server::uses_passphrase`). */
async function hasPassphrase(srv: Server, typed: Pick<ConnectOptions, 'secret' | 'secretKind'> = {}) {
  if (typedSecret(srv, typed).passphrase !== undefined) return true;
  return (srv.auth === 'key' || srv.auth === 'auto') && hasSecret(passphraseRef(srv.keyPath));
}

/** Stores a secret typed into a prompt after the login with it worked. */
function keepSecret(secret: SecretRef, value: string) {
  backend.secretStore(secret, value).catch(() => {
    showToast(
      $t('Konnte das Kennwort nicht im Schlüsselbund sichern.'),
      'error',
      $t('Beim nächsten Verbinden fragt Bitcrane wieder danach.'),
    );
  });
}

/**
 * Opens a second, silent connection to a saved server under its own id (used
 * by the Explorer folder, mount.ts). Only works with stored login data and an
 * already trusted host key; resolves to the start folder.
 */
export async function connectAs(connectionId: string, srv: Server): Promise<string> {
  if (srv.auth === 'password' && srv.user && !(await hasPassword(srv))) {
    throw {
      kind: 'passwordRequired',
      message: $t('Für {0} ist kein Passwort gespeichert. Einmal normal verbinden und das Passwort sichern.', srv.name),
    };
  }
  const { home } = await openConnection(connectionId, srv, loginRequest(srv));
  return home;
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
  /** Password of the jump server, typed by the user in its prompt. */
  jumpPassword?: string;
  /** Store `jumpPassword` for the jump server after a successful login. */
  saveJumpPassword?: boolean;
  /** Background reconnect: no dialogs, no toasts on failure. */
  silent?: boolean;
}

const PROTOCOL_LABEL: Record<string, string> = {
  ftp: 'FTP',
  ftps: 'FTPS',
  webdav: 'WebDAV',
  smb: 'SMB',
  s3: 'S3',
  vault: 'Cryptomator',
  dropbox: 'Dropbox',
  gdrive: 'Google Drive',
  onedrive: 'OneDrive',
};
const authLabel = (srv: Server) =>
  isCloudProtocol(srv.protocol)
    ? $t('Anmeldung über den Browser')
    : !isSftp(srv)
      ? `${PROTOCOL_LABEL[srv.protocol ?? ''] ?? ''}${srv.user ? $t(', Passwort') : srv.protocol === 'smb' ? $t(', Gast') : $t(', anonym')}`
      : srv.auth === 'key'
        ? $t('Schlüssel {0}', srv.keyPath)
        : srv.auth === 'agent'
          ? 'SSH-Agent'
          : srv.auth === 'password'
            ? $t('Passwort')
            : $t('automatisch');

/** Home folder of each connected server: a half that opens an already connected server starts there. */
const homes = new Map<string, string>();
export const homeOf = (serverId: string) => homes.get(serverId);

/** Password typed into "Schnell verbinden"; used once for the first connection of that server. */
const presetSecrets = new Map<string, { secret: string; save: boolean }>();

export function presetPassword(serverId: string, secret: string, save: boolean) {
  presetSecrets.set(serverId, { secret, save });
}

/** Opens an SSH session for a saved server. Resolves to true when connected. */
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
  // FTP without a user name logs in anonymously, SMB as guest; everything else needs the password.
  const needsPassword =
    srv.auth === 'password' && !(srv.protocol === 'ftp' || srv.protocol === 'ftps' || srv.protocol === 'smb')
      ? true
      : srv.auth === 'password' && !!srv.user;
  if (needsPassword && !(await hasPassword(srv, opts))) {
    if (opts.trust || opts.jumpPassword !== undefined)
      pendingLogin.set(serverId, {
        trust: opts.trust,
        jumpPassword: opts.jumpPassword,
        saveJumpPassword: opts.saveJumpPassword,
      });
    if (!opts.silent) openDialog({ type: 'secret', serverId, kind: 'password' });
    return false;
  }
  try {
    if (!opts.silent)
      addLog('info', $t('Verbinde mit {0}@{1}:{2} ({3})', srv.user, srv.host, srv.port, authLabel(srv)), serverId);
    const request = loginRequest(srv, opts);
    const jump = jumpOf(srv);
    if (jump && !opts.silent)
      addLog('info', $t('Über den Sprungserver {0}@{1}:{2}', jump.user, jump.host, jump.port), serverId);
    // Through a jump server its own proxy is used (see login.rs).
    const proxy = jump ? undefined : srv.proxy?.host ? srv.proxy : undefined;
    if (proxy && !opts.silent)
      addLog(
        'info',
        $t('Über {0}-Proxy {1}:{2}', proxy.kind === 'http' ? 'HTTP' : 'SOCKS5', proxy.host, proxy.port),
        serverId,
      );
    const { home, clockOffsetMs, warning } = await openConnection(serverId, srv, request);
    connected.add(serverId);
    homes.set(serverId, home);
    pendingLogin.delete(serverId);
    addLog('ok', opts.silent ? $t('Wieder verbunden') : $t('Verbunden, Startordner {0}', home), serverId);
    if (typeof clockOffsetMs === 'number') {
      clockOffsets.set(serverId, Math.abs(clockOffsetMs) <= 1500 ? 0 : clockOffsetMs);
      if (Math.abs(clockOffsetMs) > 60000) {
        const min = Math.round(Math.abs(clockOffsetMs) / 60000);
        const text = $t(
          'Die Uhr von {0} geht {1} {2} {3}. Bitcrane berücksichtigt das beim Vergleich von Änderungszeiten.',
          srv.name,
          min,
          min === 1 ? $t('Minute') : $t('Minuten'),
          clockOffsetMs > 0 ? $t('vor') : $t('nach'),
        );
        addLog('warn', text, serverId);
        if (!opts.silent) showToast(text);
      } else if (Math.abs(clockOffsetMs) > 1500) {
        addLog('info', $t('Zeitunterschied zum Server: {0} Sekunden', Math.round(clockOffsetMs / 1000)), serverId);
      }
    }
    failed.delete(serverId);
    if (warning) showError(warning, { prefix: srv.name, serverId });
    if (opts.saveSecret && opts.secret !== undefined) {
      const kind = opts.secretKind ?? (srv.auth === 'password' ? 'password' : 'passphrase');
      keepSecret(kind === 'passphrase' ? passphraseRef(srv.keyPath) : passwordRef(srv), opts.secret);
    }
    if (jump && opts.saveJumpPassword && opts.jumpPassword !== undefined)
      keepSecret(passwordRef(jump), opts.jumpPassword);
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
          const w = s.watches.find(
            (x) =>
              x.serverId === serverId && (t.localPath === x.localPath || t.localPath.startsWith(x.localPath + '/')),
          );
          return { ...t, remotePath: w ? w.remotePath + t.localPath.slice(w.localPath.length) : home };
        }),
        watches: s.watches.map((w) =>
          w.serverId === serverId && w.state === 'waiting' ? { ...w, state: 'active' } : w,
        ),
      };
    });
    if (!opts.silent) showToast($t('Verbunden mit {0}', srv.name), 'ok');
    else showToast($t('Wieder verbunden mit {0}. Wartende Dateien werden hochgeladen.', srv.name), 'ok');
    pump();
    // Tunnels marked "beim Verbinden starten".
    void startAutoForwards(serverId);
    // Start comparison for watches of this server that have not synced yet.
    for (const w of getState().watches) {
      if (w.serverId === serverId && w.state !== 'paused' && w.options.syncOnStart && !synced.has(w.id))
        void initialSync(w);
    }
    return true;
  } catch (e) {
    const err = toBackendError(e);
    connected.delete(serverId);
    addLog(
      opts.silent ? 'warn' : 'error',
      opts.silent ? $t('Neuer Verbindungsversuch fehlgeschlagen: {0}', err.message) : err.message,
      serverId,
      err.detail,
    );
    if (opts.silent) return false;
    failed.add(serverId);
    // Keep what was answered so far for the next question of this login.
    if (opts.secret !== undefined || opts.trust || opts.jumpPassword !== undefined)
      pendingLogin.set(serverId, {
        secret: opts.secret,
        secretKind: opts.secretKind,
        saveSecret: opts.saveSecret,
        trust: opts.trust,
        jumpPassword: opts.jumpPassword,
        saveJumpPassword: opts.saveJumpPassword,
      });
    switch (err.kind) {
      case 'hostKeyUnknown':
        if (err.hostKey) openDialog({ type: 'fingerprint', mode: 'new', serverId, key: err.hostKey });
        break;
      case 'hostKeyChanged':
        if (err.hostKey) openDialog({ type: 'fingerprint', mode: 'changed', serverId, key: err.hostKey });
        break;
      case 'passphraseRequired':
        openDialog({ type: 'secret', serverId, kind: 'passphrase', wrong: await hasPassphrase(srv, opts) });
        break;
      case 'passwordRequired':
        openDialog({ type: 'secret', serverId, kind: 'password' });
        break;
      case 'jumpPasswordRequired':
        // The jump server's own password; shown as wrong when the one typed for it was refused.
        openDialog({ type: 'secret', serverId, kind: 'password', jump: true, wrong: opts.jumpPassword !== undefined });
        break;
      case 'authFailed':
        // A cloud service's sign-in was revoked or is missing: sign in again in the browser.
        if (isCloudProtocol(srv.protocol)) openDialog({ type: 'cloudSignIn', service: srv.protocol!, serverId });
        else if (srv.auth === 'password' || (srv.auth === 'auto' && (await hasPassword(srv, opts))))
          openDialog({ type: 'secret', serverId, kind: 'password', wrong: true });
        else showError(err, { prefix: srv.name, serverId, connecting: true, log: 'done' });
        break;
      case 'cancelled':
        break;
      default:
        showError(err, { prefix: srv.name, serverId, connecting: true, log: 'done' });
    }
    return false;
  }
}

/**
 * First start without servers: when WinSCP, FileZilla, Cyberduck, PuTTY or the
 * SSH configuration hold saved servers, Bitcrane offers to take them over once
 * (like Transmit and ForkLift on their first start). Afterwards, or right away
 * when there is nothing to import, the cloud folders are offered as places.
 */
export async function firstStartOffers() {
  const s = getState();
  if (!s.settings.importAsked && !s.servers.some((x) => !x.temporary)) {
    updateSettings({ importAsked: true });
    const found = await backend.importFind();
    if (found?.servers.length && !getState().dialog && !getState().servers.some((x) => !x.temporary)) {
      openDialog({ type: 'import', firstStart: true });
      // The cloud folders wait until this dialog is closed.
      await new Promise<void>((done) => {
        const stop = subscribeStore(() => {
          if (getState().dialog?.type !== 'import') {
            stop();
            done();
          }
        });
      });
    }
  }
  if (!getState().settings.cloudAsked) await offerCloudPlaces(false);
}

/** Adds a public key to ~/.ssh/authorized_keys on a connected server. */
export async function installPublicKey(serverId: string, publicKey: string): Promise<string | null> {
  if (!connected.has(serverId))
    return $t(
      'Dafür muss Bitcrane mit diesem Server verbunden sein (z. B. noch mit Passwort oder dem bisherigen Schlüssel).',
    );
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
  if (srv.auth === 'password' && !(await hasPassword(srv)))
    return { ok: true, text: $t('Das Passwort fragt Bitcrane beim Verbinden ab.') };
  try {
    checkVaultStorage(srv);
    const home = await backend.serverTest(loginRequest(srv));
    return { ok: true, text: $t('Erreichbar, Anmeldung erfolgreich (Startordner {0})', home) };
  } catch (e) {
    const err = toBackendError(e);
    if (err.kind === 'passphraseRequired' && !(await hasPassphrase(srv)))
      return { ok: true, text: $t('Erreichbar. Die Passphrase des Schlüssels fragt Bitcrane beim Verbinden ab.') };
    if (err.kind === 'passwordRequired')
      return { ok: true, text: $t('Erreichbar. Das Passwort fragt Bitcrane beim Verbinden ab.') };
    if (err.kind === 'jumpPasswordRequired')
      return {
        ok: true,
        text: $t('Das Passwort des Sprungservers {0} fragt Bitcrane beim Verbinden ab.', jumpOf(srv)?.name ?? '?'),
      };
    if (err.kind === 'hostKeyUnknown')
      return {
        ok: true,
        text:
          err.hostKey?.algorithm === TLS_CERTIFICATE
            ? $t('Erreichbar. Das Zertifikat bestätigst du beim ersten Verbinden.')
            : $t('Erreichbar. Den Fingerabdruck bestätigst du beim ersten Verbinden.'),
      };
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
  void refreshForwards();
  bump();
}

/** Called by user actions ("Verbinden", opening a server) to connect again. */
export function connectNow(serverId: string) {
  failed.delete(serverId);
  void connectServer(serverId);
}

/** Connects when a tab of the server becomes visible, unless the last attempt failed. */
export function autoConnect(serverId: string) {
  if (!connected.has(serverId) && !connecting.has(serverId) && !failed.has(serverId) && !getState().offline[serverId])
    void connectServer(serverId);
}

/** Server to server: connects the right server first, then the left one (password prompts one after the other). */
export function autoConnectPair(right: string, left: string) {
  const needsRight =
    !connected.has(right) && !connecting.has(right) && !failed.has(right) && !getState().offline[right];
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
const pendingLogin = new Map<
  string,
  Pick<ConnectOptions, 'secret' | 'secretKind' | 'saveSecret' | 'trust' | 'jumpPassword' | 'saveJumpPassword'>
>();

/** Answer from the host key dialog. */
export function trustAndConnect(serverId: string, fingerprint: string) {
  failed.delete(serverId);
  void connectServer(serverId, { ...pendingLogin.get(serverId), trust: fingerprint });
}

/**
 * Answer from the passphrase / password prompt. `jump`: it was the jump server's password; what
 * was answered for the server itself so far is kept.
 */
export function submitSecret(
  serverId: string,
  secret: string,
  save: boolean,
  kind: 'passphrase' | 'password',
  jump = false,
) {
  failed.delete(serverId);
  const pending = pendingLogin.get(serverId);
  void connectServer(
    serverId,
    jump
      ? { ...pending, jumpPassword: secret, saveJumpPassword: save }
      : {
          trust: pending?.trust,
          jumpPassword: pending?.jumpPassword,
          saveJumpPassword: pending?.saveJumpPassword,
          secret,
          secretKind: kind,
          saveSecret: save,
        },
  );
}

/** Marks a server as dropped; a timer tries to reconnect in the background. */
export function markOffline(serverId: string) {
  if (!connected.has(serverId) && (getState().offline[serverId] || failed.has(serverId))) return;
  connected.delete(serverId);
  addLog('warn', $t('Verbindung unterbrochen'), serverId);
  if (!getState().settings.autoReconnect) {
    // No automatic reconnect: the pane shows "Nicht verbunden" with a button.
    failed.add(serverId);
    showToast(
      $t('Verbindung zu {0} unterbrochen.', serverById(serverId)?.name ?? $t('dem Server')),
      'error',
      $t('Bitcrane verbindet sich neu, sobald der Server wieder erreichbar ist.'),
    );
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

export function handleRemoteError(serverId: string, err: BackendError) {
  if (err.kind === 'connectionLost' || err.kind === 'notConnected') markOffline(serverId);
}

let retrying = false;

/**
 * Background reconnect with growing pauses (5 s, 10 s, … up to 60 s). Runs once at a time (it is
 * called every second), and checks each server again right before connecting: an earlier server
 * may have taken long, and connecting a server that is back would cut its running transfers.
 */
export async function retryOffline(now: number) {
  if (retrying) return;
  retrying = true;
  try {
    for (const id of Object.keys(getState().offline)) await retryOne(id, now);
  } finally {
    retrying = false;
  }
}

async function retryOne(id: string, now: number) {
  const info = getState().offline[id];
  if (!info || now < info.nextRetry || connecting.has(id) || connected.has(id)) return;
  if (await connectServer(id, { silent: true })) {
    for (const k of [...listings.keys()]) if (k.startsWith(`R|${id}|`)) listings.delete(k);
    bump();
    return;
  }
  setState((st) =>
    st.offline[id]
      ? {
          offline: {
            ...st.offline,
            [id]: { attempt: info.attempt + 1, nextRetry: Date.now() + Math.min(60, 5 * (info.attempt + 1)) * 1000 },
          },
        }
      : {},
  );
}
