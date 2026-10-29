/**
 * Cloud services as servers (Dropbox, Google Drive, OneDrive).
 *
 * Adding one signs in through the browser (see src-tauri/src/oauth.rs). The
 * sign-in (a refresh token) is kept in the keychain under "cloud:<server id>";
 * the server entry itself holds only the account name. A build without the
 * service's app key shows it as "not set up yet".
 *
 * Google Drive is different: Google only allows free use with each user's own
 * app key (client id and secret from their Google Cloud project, see
 * docs/google-drive.md). The id is kept in the settings, the secret in the keychain.
 */
import type { Protocol, Server } from '../backend/types';
import { tauriBackend as backend } from '../backend/tauriBackend';
import { cloudAccount, disconnectServer } from './live';
import { closeDialog, getState, LIVE, newServerTemplate, openDialog, saveServer, serverById, setState, showToast, updateSettings } from './store';
import { addLog } from './log';
import { $t } from '../i18n';

export const CLOUD_NAMES: Record<string, string> = { dropbox: 'Dropbox', onedrive: 'OneDrive', gdrive: 'Google Drive' };

/** Step-by-step guide for the user's own Google app key. */
export const GDRIVE_GUIDE_URL = 'https://github.com/Raccoon-Works/bitcrane/blob/main/docs/google-drive.md';

const GOOGLE_SECRET = 'cloud-client:gdrive';

/** The user's own Google app key, or null when it is not entered yet. */
export async function googleKey(): Promise<{ clientId: string; clientSecret: string } | null> {
  const clientId = getState().settings.googleClientId?.trim() ?? '';
  if (!clientId || !LIVE) return clientId ? { clientId, clientSecret: '' } : null;
  const clientSecret = (await backend.secretGet(GOOGLE_SECRET).catch(() => null)) ?? '';
  return clientSecret ? { clientId, clientSecret } : null;
}

/** Keeps the Google app key: the id in the settings, the secret in the keychain (only when entered). */
export async function saveGoogleKey(clientId: string, clientSecret: string) {
  updateSettings({ googleClientId: clientId.trim() });
  if (LIVE && clientSecret.trim()) await backend.secretSet(GOOGLE_SECRET, clientSecret.trim());
}

/** Starts adding a service: Google Drive without a key opens the server window to enter it first. */
export async function addCloudService(service: Protocol) {
  if (service === 'gdrive' && LIVE && !(await googleKey())) {
    openDialog({ type: 'serverEdit', cloud: 'gdrive' });
    return;
  }
  if ((service === 'dropbox' || service === 'onedrive') && LIVE && !getState().cloudAvailable[service]) {
    showCloudNotSetUp(service);
    return;
  }
  openDialog({ type: 'cloudSignIn', service });
}

/** Asks the app once which services this build can connect to. */
export async function loadCloudServices() {
  if (!LIVE) return;
  try {
    setState({ cloudAvailable: await backend.cloudServices() });
  } catch {
    // Older backend: no cloud services.
  }
}

/**
 * Signs in to a service in the browser. Without `serverId` a new server entry
 * is created and opened; with it, that entry's sign-in is renewed and it reconnects.
 * Resolves to an error text, or null on success (or cancel).
 */
export async function signInToCloud(service: Protocol, serverId?: string): Promise<string | null> {
  const name = CLOUD_NAMES[service] ?? service;
  if (!LIVE) {
    // Prototype: a simulated account.
    const srv: Server = { ...newServerTemplate(), name, protocol: service, host: `${service}.com`, port: 443, user: 'alex@example.com', auth: 'agent', keyPath: '', remoteStart: '/' };
    saveServer(srv, true);
    return null;
  }
  try {
    let key: { clientId: string; clientSecret: string } | null = null;
    if (service === 'gdrive') {
      key = await googleKey();
      if (!key) return $t('Für Google Drive fehlt dein eigener App-Schlüssel (Client-ID und Client-Schlüssel). Die Anleitung zeigt, wie du ihn bekommst.');
    }
    const { refreshToken, account } = await backend.cloudSignIn(service, key?.clientId, key?.clientSecret);
    const existing = serverId ? serverById(serverId) : undefined;
    const srv: Server = existing
      ? { ...existing, user: account || existing.user }
      : { ...newServerTemplate(), name: getState().servers.some((x) => x.protocol === service) ? `${name} · ${account}` : name, protocol: service, host: service === 'gdrive' ? 'drive.google.com' : service === 'onedrive' ? 'onedrive.live.com' : `${service}.com`, port: 443, user: account, auth: 'agent', keyPath: '', remoteStart: '/', group: '' };
    await backend.secretSet(cloudAccount(srv), refreshToken);
    addLog('ok', $t('Bei {0} angemeldet als {1}', name, account), srv.id);
    closeDialog();
    if (existing) await disconnectServer(existing.id);
    saveServer(srv, true);
    return null;
  } catch (e) {
    const err = e as { kind?: string; message?: string; detail?: string };
    if (err.kind === 'cancelled') return null;
    return `${err.message ?? String(e)}${err.detail ? ` (${err.detail})` : ''}`;
  }
}

export function cancelCloudSignIn() {
  if (LIVE) void backend.cloudSignInCancel().catch(() => undefined);
  closeDialog();
}

export function showCloudNotSetUp(service: Protocol) {
  showToast($t('{0} ist in dieser Version noch nicht eingerichtet. Es kommt mit einem der nächsten Updates.', CLOUD_NAMES[service] ?? service));
}
