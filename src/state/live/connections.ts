/**
 * Connecting to servers: host keys, passwords and passphrases, retries and the
 * bookkeeping of which servers are connected.
 */
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { type Server, isCloudProtocol } from '../../backend/types';
import { type StoredConfig } from './config';
import { type AppState, serverById, getState, showToast, setState, subscribeStore, uid } from '../core';
import { type AuthParams, type ConnectParams, toBackendError, type BackendError } from '../../backend/api';
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

export const connected = new Set<string>();
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
export const connecting = new Map<string, Promise<boolean>>();
/** Servers whose last connection attempt failed; no automatic retry until the user acts. */
export const failed = new Set<string>();

export const isConnected = (serverId: string) => connected.has(serverId);
export const isConnecting = (serverId: string) => connecting.has(serverId);

function passphraseAccount(srv: Server) {
  return `passphrase:${srv.keyPath}`;
}
/** Keychain entry of a cloud service's sign-in (refresh token). */
export function cloudAccount(srv: Pick<Server, 'id'>) {
  return `cloud:${srv.id}`;
}

function passwordAccount(srv: Server) {
  return `password:${srv.user}@${srv.host}:${srv.port}`;
}
export function proxyAccount(p: { user?: string; host: string; port: number }) {
  return `proxy:${p.user ?? ''}@${p.host}:${p.port}`;
}

/** Removes the stored secrets of a deleted server, unless a remaining server uses the same account. */
export async function forgetSecrets(removed: Server, remaining: Server[]) {
  const accounts = (x: Server) => [
    passwordAccount(x),
    passphraseAccount(x),
    ...(x.proxy?.user ? [proxyAccount(x.proxy)] : []),
    ...(isCloudProtocol(x.protocol) ? [cloudAccount(x)] : []),
  ];
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
    if (
      await backend.secretSet(account, value).then(
        () => true,
        () => false,
      )
    )
      n++;
  }
  return n;
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

/** Address of a WebDAV server. */
export function davUrl(srv: Server): string {
  const https = srv.davHttps !== false;
  const port = srv.port && srv.port !== (https ? 443 : 80) ? `:${srv.port}` : '';
  const path = (srv.davPath || '/').startsWith('/') ? srv.davPath || '/' : `/${srv.davPath}`;
  return `${https ? 'https' : 'http'}://${srv.host}${port}${path}`;
}

/** Connects with the server's protocol; resolves to the start folder (and SSH clock offset). */
async function openConnection(
  id: string,
  srv: Server,
  auth: AuthParams,
  password: string | undefined,
  trust: string | undefined,
  jump: ConnectParams | undefined,
  proxy: ConnectParams['proxy'],
) {
  if (srv.protocol === 'ftp' || srv.protocol === 'ftps') {
    return backend.connectFtp(id, {
      host: srv.host,
      port: srv.port,
      user: srv.user,
      password,
      trust,
      proxy,
      tls: srv.protocol === 'ftp' ? 'none' : srv.implicitTls ? 'implicit' : 'explicit',
      tls13Only: !!srv.tls13Only,
      encoding: srv.ftpEncoding ?? 'utf8',
      tzOffsetMin: srv.ftpTimezone ?? 0,
      mode: srv.ftpMode ?? 'binary',
      timeout: srv.connectTimeout,
    });
  }
  if (srv.protocol === 'webdav') {
    return backend.connectDav(id, {
      url: davUrl(srv),
      user: srv.user,
      password,
      trust,
      proxy,
      tls13Only: !!srv.tls13Only,
      timeout: srv.connectTimeout,
    });
  }
  if (srv.protocol === 's3') {
    const port = srv.port && srv.port !== (srv.s3Http ? 80 : 443) ? `:${srv.port}` : '';
    return backend.connectS3(id, {
      endpoint: `${srv.s3Http ? 'http' : 'https'}://${srv.host}${port}`,
      region: srv.s3Region ?? '',
      bucket: srv.s3Bucket ?? '',
      accessKey: srv.user,
      secret: password,
      pathStyle: !!srv.s3PathStyle,
      tls13Only: !!srv.tls13Only,
      trust,
      proxy,
      timeout: srv.connectTimeout,
    });
  }
  if (srv.protocol === 'vault') {
    // The vault's files lie on another server, which has to be connected first.
    const storage = srv.vaultStorageId ? serverById(srv.vaultStorageId) : undefined;
    if (srv.vaultStorageId && !connected.has(srv.vaultStorageId)) {
      throw {
        kind: 'notConnected',
        message: $t('Erst mit {0} verbinden, dort liegt der Tresor.', storage?.name ?? '?'),
      };
    }
    return backend.vaultOpen(id, srv.host, srv.vaultStorageId, password ?? '');
  }
  if (srv.protocol === 'smb') {
    return backend.connectSmb(id, {
      host: srv.host,
      port: srv.port || 445,
      user: srv.user,
      password,
      share: srv.smbShare ?? '',
      encrypt: !!srv.smbEncrypt,
      timeout: srv.connectTimeout,
    });
  }
  if (srv.protocol === 'dropbox') {
    // The sign-in from the browser, kept in the keychain (see addCloudService).
    const refreshToken = await keychain(cloudAccount(srv));
    if (!refreshToken)
      throw { kind: 'authFailed', message: $t('Für {0} fehlt die Anmeldung. Bitte neu anmelden.', srv.name) };
    return backend.connectDropbox(id, { refreshToken });
  }
  if (srv.protocol === 'onedrive') {
    const refreshToken = await keychain(cloudAccount(srv));
    if (!refreshToken)
      throw { kind: 'authFailed', message: $t('Für {0} fehlt die Anmeldung. Bitte neu anmelden.', srv.name) };
    const r = await backend.connectOneDrive(id, { refreshToken });
    // Microsoft renews the sign-in with each use; keep the newest one.
    if (r.refreshToken && r.refreshToken !== refreshToken)
      void backend.secretSet(cloudAccount(srv), r.refreshToken).catch(() => undefined);
    return r;
  }
  if (srv.protocol === 'gdrive') {
    const refreshToken = await keychain(cloudAccount(srv));
    if (!refreshToken)
      throw { kind: 'authFailed', message: $t('Für {0} fehlt die Anmeldung. Bitte neu anmelden.', srv.name) };
    const key = await (await import('../cloud')).googleKey();
    if (!key)
      throw {
        kind: 'other',
        message: $t(
          'Für Google Drive fehlt dein eigener App-Schlüssel (Client-ID und Client-Schlüssel). Die Anleitung zeigt, wie du ihn bekommst.',
        ),
      };
    return backend.connectGDrive(id, { refreshToken, ...key, pdfExport: srv.gdocExport === 'pdf' });
  }
  return backend.connect(id, {
    host: srv.host,
    port: srv.port,
    user: srv.user,
    auth,
    trust,
    keepalive: getState().settings.keepAlive,
    scp: !!srv.scp,
    jump,
    proxy,
    timeout: srv.connectTimeout,
    forwardAgent: !!srv.forwardAgent,
    sftpCommand: srv.sftpCommand?.trim() || undefined,
  });
}

/**
 * Opens a second, silent connection to a saved server under its own id (used
 * by the Explorer folder, mount.ts). Only works with stored login data and an
 * already trusted host key; resolves to the start folder.
 */
export async function connectAs(connectionId: string, srv: Server): Promise<string> {
  const { auth, password } = await buildAuth(srv);
  if (srv.auth === 'password' && srv.user && password === undefined) {
    throw {
      kind: 'passwordRequired',
      message: $t('Für {0} ist kein Passwort gespeichert. Einmal normal verbinden und das Passwort sichern.', srv.name),
    };
  }
  const jump = isSftp(srv) ? await jumpParams(srv) : undefined;
  const { home } = await openConnection(connectionId, srv, auth, password, undefined, jump, await proxyParams(srv));
  return home;
}

/** Proxy of a server with the password from the keychain. */
async function proxyParams(srv: Server): Promise<ConnectParams['proxy']> {
  const p = srv.proxy;
  if (!p?.host) return undefined;
  return {
    kind: p.kind,
    host: p.host,
    port: p.port,
    user: p.user || undefined,
    password: p.user ? await keychain(proxyAccount(p)) : undefined,
  };
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
async function buildAuth(
  srv: Server,
  typed?: { secret?: string; kind?: 'passphrase' | 'password' },
): Promise<{ auth: AuthParams; passphrase?: string; password?: string }> {
  const kind = typed?.kind ?? (srv.auth === 'password' ? 'password' : 'passphrase');
  const passphrase =
    typed?.secret !== undefined && kind === 'passphrase'
      ? typed.secret
      : srv.auth === 'key' || srv.auth === 'auto'
        ? await keychain(passphraseAccount(srv))
        : undefined;
  const password =
    typed?.secret !== undefined && kind === 'password'
      ? typed.secret
      : srv.auth === 'password' || srv.auth === 'auto'
        ? await keychain(passwordAccount(srv))
        : undefined;
  switch (srv.auth) {
    case 'key':
      return { auth: { method: 'key', path: srv.keyPath, passphrase }, passphrase };
    case 'agent':
      return { auth: { method: 'agent' } };
    case 'password':
      return { auth: { method: 'password', password: password ?? '' }, password };
    default:
      return {
        auth: { method: 'auto', keyPath: srv.keyPath || undefined, passphrase, password },
        passphrase,
        password,
      };
  }
}

/** Login data of a jump server, with its secret from the keychain if stored. */
async function jumpParams(srv: Server, trust?: string): Promise<ConnectParams | undefined> {
  const j = srv.jumpServerId ? serverById(srv.jumpServerId) : undefined;
  if (!j || j.id === srv.id) return undefined;
  const { auth } = await buildAuth(j);
  return {
    host: j.host,
    port: j.port,
    user: j.user,
    auth,
    trust,
    keepalive: getState().settings.keepAlive,
    proxy: await proxyParams(j),
  };
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
  // FTP without a user name logs in anonymously, SMB as guest; everything else needs the password.
  const needsPassword =
    srv.auth === 'password' && !(srv.protocol === 'ftp' || srv.protocol === 'ftps' || srv.protocol === 'smb')
      ? true
      : srv.auth === 'password' && !!srv.user;
  if (needsPassword && password === undefined) {
    if (opts.trust) pendingLogin.set(serverId, { trust: opts.trust });
    if (!opts.silent) openDialog({ type: 'secret', serverId, kind: 'password' });
    return false;
  }
  try {
    if (!opts.silent)
      addLog('info', $t('Verbinde mit {0}@{1}:{2} ({3})', srv.user, srv.host, srv.port, authLabel(srv)), serverId);
    const jump = isSftp(srv) ? await jumpParams(srv, opts.trust) : undefined;
    if (jump && !opts.silent)
      addLog('info', $t('Über den Sprungserver {0}@{1}:{2}', jump.user, jump.host, jump.port), serverId);
    const proxy = jump ? undefined : await proxyParams(srv);
    if (proxy && !opts.silent)
      addLog(
        'info',
        $t('Über {0}-Proxy {1}:{2}', proxy.kind === 'http' ? 'HTTP' : 'SOCKS5', proxy.host, proxy.port),
        serverId,
      );
    const { home, clockOffsetMs } = await openConnection(serverId, srv, auth, password, opts.trust, jump, proxy);
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
    if (opts.saveSecret && opts.secret !== undefined) {
      const kind = opts.secretKind ?? (srv.auth === 'password' ? 'password' : 'passphrase');
      backend
        .secretSet(kind === 'passphrase' ? passphraseAccount(srv) : passwordAccount(srv), opts.secret)
        .catch(() => {
          showToast(
            $t('Konnte das Kennwort nicht im Schlüsselbund sichern.'),
            'error',
            $t('Beim nächsten Verbinden fragt Bitcrane wieder danach.'),
          );
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
    if (opts.secret !== undefined || opts.trust)
      pendingLogin.set(serverId, {
        secret: opts.secret,
        secretKind: opts.secretKind,
        saveSecret: opts.saveSecret,
        trust: opts.trust,
      });
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
        // A cloud service's sign-in was revoked or is missing: sign in again in the browser.
        if (isCloudProtocol(srv.protocol)) openDialog({ type: 'cloudSignIn', service: srv.protocol!, serverId });
        else if (srv.auth === 'password' || (srv.auth === 'auto' && password !== undefined))
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
    const found = await backend.importFind().catch(() => null);
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

/** Whether a passphrase / password for this server is stored in the keychain. */
export async function hasStoredSecret(srv: Server): Promise<boolean> {
  if (srv.auth === 'agent') return false;
  return (await keychain(srv.auth === 'password' ? passwordAccount(srv) : passphraseAccount(srv))) !== undefined;
}

/** Adds a public key to ~/.ssh/authorized_keys on a connected server. */
export async function installPublicKey(serverId: string, publicKey: string): Promise<string | null> {
  if (!connected.has(serverId))
    return $t(
      'Dafür muss Bitcrane mit diesem Server verbunden sein (z. B. noch mit Passwort oder dem bisherigen Schlüssel).',
    );
  // A public key line never contains single quotes; refuse anything else to keep the command safe.
  if (!/^[A-Za-z0-9@.+/=_ :-]+$/.test(publicKey)) return $t('Der öffentliche Schlüssel enthält unerwartete Zeichen.');
  const cmd = `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF '${publicKey}' ~/.ssh/authorized_keys || printf '%s
' '${publicKey}' >> ~/.ssh/authorized_keys) && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`;
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
  if (srv.auth === 'password' && password === undefined)
    return { ok: true, text: $t('Das Passwort fragt Bitcrane beim Verbinden ab.') };
  try {
    if (!isSftp(srv)) {
      // Other protocols: a short connection with a temporary id.
      const id = `test-${uid('t')}`;
      const { home } = await openConnection(id, srv, auth, password, undefined, undefined, await proxyParams(srv));
      await backend.disconnect(id).catch(() => undefined);
      return { ok: true, text: $t('Erreichbar, Anmeldung erfolgreich (Startordner {0})', home) };
    }
    const jump = await jumpParams(srv);
    const home = await backend.sshTest({
      host: srv.host,
      port: srv.port,
      user: srv.user,
      auth,
      keepalive: false,
      scp: !!srv.scp,
      jump,
      proxy: jump ? undefined : await proxyParams(srv),
    });
    return {
      ok: true,
      text: home
        ? $t('Erreichbar, Anmeldung erfolgreich (Startordner {0})', home)
        : $t('Erreichbar. Den Fingerabdruck bestätigst du beim ersten Verbinden.'),
    };
  } catch (e) {
    const err = toBackendError(e);
    if (err.kind === 'passphraseRequired' && passphrase === undefined)
      return { ok: true, text: $t('Erreichbar. Die Passphrase des Schlüssels fragt Bitcrane beim Verbinden ab.') };
    if (err.kind === 'passwordRequired')
      return { ok: true, text: $t('Erreichbar. Das Passwort fragt Bitcrane beim Verbinden ab.') };
    if (err.kind === 'hostKeyUnknown')
      return {
        ok: true,
        text:
          err.hostKey?.algorithm === 'TLS-Zertifikat'
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
const pendingLogin = new Map<string, Pick<ConnectOptions, 'secret' | 'secretKind' | 'saveSecret' | 'trust'>>();

/** Answer from the host key dialog. */
export function trustAndConnect(serverId: string, fingerprint: string) {
  failed.delete(serverId);
  void connectServer(serverId, { ...pendingLogin.get(serverId), trust: fingerprint });
}

/** Answer from the passphrase / password prompt. */
export function submitSecret(serverId: string, secret: string, save: boolean, kind: 'passphrase' | 'password') {
  failed.delete(serverId);
  void connectServer(serverId, {
    trust: pendingLogin.get(serverId)?.trust,
    secret,
    secretKind: kind,
    saveSecret: save,
  });
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

/** Background reconnect with growing pauses (5 s, 10 s, … up to 60 s). */
export async function retryOffline(now: number) {
  const s = getState();
  for (const [id, info] of Object.entries(s.offline)) {
    if (now < info.nextRetry || connecting.has(id)) continue;
    const ok = await connectServer(id, { silent: true });
    if (!ok) {
      setState((st) =>
        st.offline[id]
          ? {
              offline: {
                ...st.offline,
                [id]: {
                  attempt: info.attempt + 1,
                  nextRetry: Date.now() + Math.min(60, 5 * (info.attempt + 1)) * 1000,
                },
              },
            }
          : {},
      );
    } else {
      for (const k of [...listings.keys()]) if (k.startsWith(`R|${id}|`)) listings.delete(k);
      bump();
    }
  }
}
