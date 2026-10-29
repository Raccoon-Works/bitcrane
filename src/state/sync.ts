/**
 * "Zwischen Rechnern abgleichen" (after Panic Sync in Transmit): servers and
 * shared settings are kept in step between the user's computers through a
 * folder their own cloud already synchronises (Dropbox, OneDrive, iCloud
 * Drive, Google Drive …). Bitcrane runs no server of its own.
 *
 * The folder holds "Bitcrane/bitcrane-sync.json". Each computer merges it
 * with its own data in three ways against the state of the last sync
 * ("base"), so additions, changes and deletions on either side carry over:
 * - changed only here    -> keep ours
 * - changed only there   -> take theirs
 * - changed on both      -> keep ours (and write it back)
 * - deleted on one side  -> deleted, unless the other side changed it since
 *
 * Machine-specific things stay local: folder watches, the local start folder
 * of a server, places of this computer, window sizes, workspaces.
 *
 * Passwords travel only when the user sets a sync password (the same on every
 * computer); they are then encrypted (AES-GCM, see util/crypto.ts). The sync
 * password itself stays in each computer's keychain.
 */
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { Server } from '../backend/types';
import { seal, unseal, type Sealed } from '../util/crypto';
import { $t } from '../i18n';
import { addLog } from './log';
import { getState, LIVE, setState, showToast, subscribeStore, type Settings } from './store';

/** Settings that are the same on every computer. */
const SHARED_SETTINGS = ['serverGroups', 'rules', 'customCommands', 'googleClientId', 'watchTemplates', 'defaultExcludes', 'skipPatterns', 'existingFiles', 'existingDownload', 'uploadTempName', 'keepMtime', 'serverDefaults'] as const;
type SharedKey = (typeof SHARED_SETTINGS)[number];

/** Keychain entry of the sync password on this computer. */
const SYNC_PASSWORD = 'sync-password';
/** How often the shared file is checked for changes from the other computer. */
const POLL_MS = 30_000;

interface SyncData {
  format: 'bitcrane-sync';
  version: 1;
  /** When and from which kind of computer the file was written last. */
  updatedAt: number;
  from: string;
  servers: Server[];
  settings: Partial<Pick<Settings, SharedKey>>;
  /** Keychain entries (account -> secret), encrypted with the sync password. */
  secrets?: Sealed;
}

/** What both sides looked like after the last sync (hashes), see the file comment. */
export interface SyncBase {
  servers: Record<string, string>;
  settings: Record<string, string>;
}

/** JSON with sorted keys, so equal data gives equal text. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The shared part of a server (without local start folder, online state, last use). */
function sharedServer(x: Server): Server {
  const copy: Server = { ...x, online: false, localStart: '' };
  delete copy.lastUsed;
  delete copy.temporary;
  return copy;
}

const hashServer = (x: Server) => stable(sharedServer(x));

/** Three-way merge of one value; returns which side wins. */
function pick(ours: string | undefined, theirs: string | undefined, base: string | undefined): 'ours' | 'theirs' {
  if (ours === theirs) return 'ours';
  if (ours === base) return 'theirs';
  return 'ours';
}

/**
 * Three-way merge of the server lists (see the file comment). `theirs` null:
 * no shared file yet, everything here is kept. Returns the merged list (our
 * order first) and the servers taken over from the other computer.
 */
export function mergeServers(ours: Server[], theirs: Server[] | null, base: Record<string, string>): { merged: Server[]; taken: Server[] } {
  const theirServers = new Map((theirs ?? []).map((x) => [x.id, x]));
  const ourServers = new Map(ours.map((x) => [x.id, x]));
  const merged: Server[] = [];
  const taken: Server[] = [];
  for (const id of new Set([...ourServers.keys(), ...theirServers.keys()])) {
    const o = ourServers.get(id);
    const t = theirServers.get(id);
    const ho = o && hashServer(o);
    const ht = t && hashServer(t);
    const hb = base[id];
    if (o && t) {
      if (pick(ho, ht, hb) === 'theirs') {
        const next = { ...t, online: o.online, lastUsed: o.lastUsed, localStart: o.localStart };
        merged.push(next);
        taken.push(next);
      } else merged.push(o);
    } else if (o) {
      // Only here: new (keep), or deleted there since the last sync (drop, unless changed here meanwhile).
      if (hb === undefined || ho !== hb || !theirs) merged.push(o);
    } else if (t) {
      // Only there: new there (take), or deleted here since the last sync (stay deleted, unless changed there).
      if (hb === undefined || ht !== hb) {
        // A start folder from the other kind of computer (C:\…) does not fit here.
        const next = { ...t, online: false, localStart: t.localStart && !t.localStart.includes('\\') && !/^[A-Za-z]:/.test(t.localStart) ? t.localStart : '~' };
        merged.push(next);
        taken.push(next);
      }
    }
  }
  // Keep the order: ours first, then new ones from the other computer.
  const order = new Map(ours.map((x, i) => [x.id, i]));
  merged.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  return { merged, taken };
}

/** Hash of a server as the sync compares it. */
export function serverHash(x: Server): string {
  return hashServer(x);
}

let applying = false;
let timer: number | undefined;
let poll: number | undefined;
let running: Promise<void> | null = null;
let again = false;

/** Status text for the settings ("Zuletzt abgeglichen …" or the last error). */
export function syncStatus(): string {
  const s = getState().settings;
  if (!s.syncFolder) return '';
  if (s.syncError) return s.syncError;
  return s.syncAt ? $t('Zuletzt abgeglichen: {0}', new Date(s.syncAt).toLocaleString()) : $t('Noch nicht abgeglichen.');
}

function patchSettings(patch: Partial<Settings>) {
  setState((st) => ({ settings: { ...st.settings, ...patch } }));
}

/** The sync password of this computer, if one is set. */
async function syncPassword(): Promise<string | null> {
  return LIVE ? backend.secretGet(SYNC_PASSWORD).catch(() => null) : null;
}

/** Keychain entries of these servers (passwords, passphrases, proxies, cloud sign-ins, Google key). */
async function secretsOf(servers: Server[]): Promise<Record<string, string>> {
  const live = await import('./live');
  const out = await live.collectSecrets(servers);
  for (const x of servers) {
    if (x.protocol === 'dropbox' || x.protocol === 'gdrive' || x.protocol === 'onedrive') {
      const v = await backend.secretGet(live.cloudAccount(x)).catch(() => null);
      if (v) out[live.cloudAccount(x)] = v;
    }
  }
  const google = await backend.secretGet('cloud-client:gdrive').catch(() => null);
  if (google) out['cloud-client:gdrive'] = google;
  return out;
}

/** One sync run: read, merge, apply, write back. Runs one at a time. */
export function runSync(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = syncOnce()
    .catch((e) => {
      const message = (e as { message?: string }).message ?? String(e);
      patchSettings({ syncError: message });
      addLog('warn', $t('Abgleich zwischen Rechnern fehlgeschlagen.'), undefined, message);
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        void runSync();
      }
    });
  return running;
}

async function syncOnce() {
  const st = getState();
  const folder = st.settings.syncFolder;
  if (!LIVE || !folder) return;
  const file = await backend.syncRead(folder);
  let theirs: SyncData | null = null;
  if (file) {
    const parsed = JSON.parse(file.text) as SyncData;
    if (parsed.format !== 'bitcrane-sync') throw new Error($t('Die Datei im Abgleich-Ordner gehört nicht zu Bitcrane.'));
    theirs = parsed;
  }
  const base: SyncBase = st.settings.syncBase ?? { servers: {}, settings: {} };
  const ours = st.servers.filter((x) => !x.temporary);

  // Servers.
  const { merged, taken } = mergeServers(ours, theirs ? theirs.servers : null, base.servers);

  // Shared settings.
  const settingsPatch: Partial<Settings> = {};
  const mergedSettings: Record<string, unknown> = {};
  for (const key of SHARED_SETTINGS) {
    const o = st.settings[key];
    const t = theirs?.settings[key];
    const ho = stable(o);
    const ht = theirs && key in theirs.settings ? stable(t) : undefined;
    if (ht !== undefined && pick(ho, ht, base.settings[key]) === 'theirs') {
      (settingsPatch as Record<string, unknown>)[key] = t;
      mergedSettings[key] = t;
    } else mergedSettings[key] = o;
  }

  // Passwords from the other computer (only with the sync password).
  const password = await syncPassword();
  if (theirs?.secrets && password && st.settings.syncPasswords) {
    try {
      const secrets = JSON.parse(await unseal(theirs.secrets, password)) as Record<string, string>;
      // Only missing entries are filled in; a password changed here is not overwritten.
      for (const [account, value] of Object.entries(secrets)) {
        const have = await backend.secretGet(account).catch(() => null);
        if (have === null) await backend.secretSet(account, value).catch(() => undefined);
      }
    } catch {
      throw new Error($t('Die Passwörter im Abgleich lassen sich mit deinem Abgleich-Passwort nicht entschlüsseln. Ist es auf allen Rechnern gleich?'));
    }
  }

  // Apply here.
  const serversChanged = stable(merged.map(hashServer)) !== stable(ours.map(hashServer)) || merged.length !== ours.length;
  applying = true;
  try {
    if (serversChanged || Object.keys(settingsPatch).length) {
      setState((s) => ({
        servers: serversChanged ? [...merged, ...s.servers.filter((x) => x.temporary)] : s.servers,
        settings: { ...s.settings, ...settingsPatch },
      }));
      const n = taken.length;
      if (n || Object.keys(settingsPatch).length) {
        addLog('ok', $t('Abgleich: {0} Server vom anderen Rechner übernommen.', n));
        if (n) showToast(n === 1 ? $t('Abgleich: 1 Server vom anderen Rechner übernommen.') : $t('Abgleich: {0} Server vom anderen Rechner übernommen.', n), 'ok');
      }
    }
  } finally {
    applying = false;
  }

  // Write back when the file differs from the merged result.
  const data: SyncData = {
    format: 'bitcrane-sync',
    version: 1,
    updatedAt: Date.now(),
    from: getState().platform,
    servers: merged.map(sharedServer).map((x, i) => ({ ...x, localStart: merged[i].localStart })),
    settings: mergedSettings as SyncData['settings'],
  };
  const sameAsFile = theirs && stable(theirs.servers.map(hashServer)) === stable(data.servers.map(hashServer)) && stable(theirs.settings) === stable(data.settings);
  let mtime = file?.mtime ?? 0;
  if (!sameAsFile || (st.settings.syncPasswords && password && !theirs?.secrets)) {
    if (st.settings.syncPasswords && password) data.secrets = await seal(JSON.stringify(await secretsOf(merged)), password);
    else if (theirs?.secrets && !st.settings.syncPasswords) data.secrets = undefined;
    else if (theirs?.secrets) data.secrets = theirs.secrets;
    mtime = await backend.syncWrite(folder, JSON.stringify(data, null, 2));
  }
  patchSettings({
    syncBase: { servers: Object.fromEntries(merged.map((x) => [x.id, hashServer(x)])), settings: Object.fromEntries(SHARED_SETTINGS.map((k) => [k, stable(mergedSettings[k])])) },
    syncAt: Date.now(),
    syncSeen: mtime,
    syncError: undefined,
  });
}

/** Starts the sync after loading: once now, then on local changes and when the file changes. */
export function startSync() {
  if (!LIVE) return;
  void runSync();
  let last = getState();
  subscribeStore(() => {
    const s = getState();
    const changed = s.servers !== last.servers || SHARED_SETTINGS.some((k) => s.settings[k] !== last.settings[k]) || s.settings.syncFolder !== last.settings.syncFolder;
    last = s;
    if (!changed || applying || !s.settings.syncFolder) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void runSync(), 3000);
  });
  window.clearInterval(poll);
  poll = window.setInterval(async () => {
    const s = getState().settings;
    if (!s.syncFolder || running) return;
    const f = await backend.syncRead(s.syncFolder).catch(() => null);
    if (f && f.mtime !== s.syncSeen) void runSync();
  }, POLL_MS);
}

/** Settings: choose the folder (null switches the sync off). */
export async function setSyncFolder(folder: string | null) {
  if (!folder) {
    patchSettings({ syncFolder: undefined, syncBase: undefined, syncAt: undefined, syncSeen: undefined, syncError: undefined });
    showToast($t('Abgleich zwischen Rechnern ist aus.'));
    return;
  }
  // A new folder starts without a base: everything on both sides is kept (nothing is deleted).
  patchSettings({ syncFolder: folder, syncBase: undefined, syncError: undefined });
  if (!LIVE) {
    showToast($t('Abgleich geht im echten Programm.'));
    return;
  }
  await runSync();
  const s = getState().settings;
  if (!s.syncError) showToast($t('Abgleich eingerichtet. Wähle auf dem anderen Rechner denselben Ordner.'), 'ok');
}

/** Settings: sync password on (stored in this computer's keychain) or off. */
export async function setSyncPassword(password: string | null) {
  if (password) {
    if (LIVE) await backend.secretSet(SYNC_PASSWORD, password);
    patchSettings({ syncPasswords: true });
  } else {
    if (LIVE) await backend.secretDelete(SYNC_PASSWORD).catch(() => undefined);
    patchSettings({ syncPasswords: false });
  }
  void runSync();
}
