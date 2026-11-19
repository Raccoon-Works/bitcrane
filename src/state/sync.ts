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
 * Changes to how a server is reached wait for the user's yes (syncMerge.ts
 * heldForReview, dialog "syncReview"): anyone who can write to the cloud
 * folder could otherwise lead a stored password elsewhere.
 *
 * Passwords travel only when the user sets a sync password (the same on every
 * computer); the core then encrypts them (AES-GCM, see src-tauri/src/secrets.rs),
 * and they never pass through the interface. The sync password itself stays in
 * each computer's keychain.
 */
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { Server } from '../backend/types';
import { $t } from '../i18n';
import { showError } from './errors';
import { addLog } from './log';
import { getState, LIVE, setState, showToast, subscribeStore, type Settings } from './store';
import { toBackendError, type Sealed } from '../backend/api';
import {
  hashServer,
  heldForReview,
  mergeServers,
  pick,
  sharedServer,
  stable,
  type HeldServer,
  type SyncBase,
} from './syncMerge';
import { isServerEntry } from './entries';

export type { SyncBase } from './syncMerge';

/** Settings that are the same on every computer. */
const SHARED_SETTINGS = [
  'serverGroups',
  'rules',
  'customCommands',
  'googleClientId',
  'watchTemplates',
  'defaultExcludes',
  'skipPatterns',
  'existingFiles',
  'existingDownload',
  'uploadTempName',
  'keepMtime',
  'serverDefaults',
] as const;
type SharedKey = (typeof SHARED_SETTINGS)[number];

/** Keychain entry of the sync password on this computer. */
const SYNC_PASSWORD = { kind: 'syncPassword' } as const;
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

/** Whether this computer has a sync password. */
function hasSyncPassword(): Promise<boolean> {
  return LIVE ? backend.secretExists(SYNC_PASSWORD) : Promise.resolve(false);
}

/** One sync run: read, merge, apply, write back. Runs one at a time. */
export function runSync(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = syncOnce()
    .catch((e) => {
      const message = toBackendError(e).message;
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
    if (parsed.format !== 'bitcrane-sync' || !Array.isArray(parsed.servers))
      throw new Error($t('Die Datei im Abgleich-Ordner gehört nicht zu Bitcrane.'));
    const servers = parsed.servers.filter(isServerEntry);
    if (servers.length < parsed.servers.length)
      addLog(
        'warn',
        $t('Abgleich: {0} unvollständige Servereinträge übergangen.', parsed.servers.length - servers.length),
      );
    theirs = { ...parsed, servers, settings: parsed.settings ?? {} };
  }
  const base: SyncBase = st.settings.syncBase ?? { servers: {}, settings: {} };
  const ours = st.servers.filter((x) => !x.temporary);

  // Servers; changes to how a server is reached wait for the user (see the file comment).
  const all = mergeServers(ours, theirs ? theirs.servers : null, base.servers);
  const { merged, taken, held } = heldForReview(ours, all.merged, all.taken);

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
  const withPassword = await hasSyncPassword();
  if (theirs?.secrets && withPassword && st.settings.syncPasswords) {
    // Only missing entries are filled in; a password changed here is not overwritten. Secrets the
    // sync password does not open stop the sync; a keychain that refuses to store is reported, and
    // the rest of the sync still applies.
    const refused = await backend.syncSecretsUnseal(theirs.secrets);
    if (refused) showError(refused);
  }

  // Servers or shared settings changed here while the file and the keychain were read: start over
  // with them, so nothing saved meanwhile is replaced by the older snapshot.
  const now = getState();
  if (now.servers !== st.servers || SHARED_SETTINGS.some((k) => now.settings[k] !== st.settings[k])) {
    again = true;
    return;
  }

  // Apply here.
  const serversChanged =
    stable(merged.map(hashServer)) !== stable(ours.map(hashServer)) || merged.length !== ours.length;
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
        if (n)
          showToast(
            n === 1
              ? $t('Abgleich: 1 Server vom anderen Rechner übernommen.')
              : $t('Abgleich: {0} Server vom anderen Rechner übernommen.', n),
            'ok',
          );
      }
    }
  } finally {
    applying = false;
  }

  // Held servers keep the file's version until the user decides, so the other computer's change is
  // neither applied here nor undone there.
  setState({ syncReview: held });
  const heldIds = new Set(held.map((h) => h.theirs.id));
  const written = [...merged.filter((x) => !heldIds.has(x.id)), ...held.map((h) => h.theirs)];

  // Write back when the file differs from the merged result.
  const data: SyncData = {
    format: 'bitcrane-sync',
    version: 1,
    updatedAt: Date.now(),
    from: getState().platform,
    servers: written.map((x) => ({ ...sharedServer(x), localStart: x.localStart })),
    settings: mergedSettings as SyncData['settings'],
  };
  const sameAsFile =
    theirs &&
    stable(theirs.servers.map(hashServer)) === stable(data.servers.map(hashServer)) &&
    stable(theirs.settings) === stable(data.settings);
  let mtime = file?.mtime ?? 0;
  if (!sameAsFile || (st.settings.syncPasswords && withPassword && !theirs?.secrets)) {
    if (st.settings.syncPasswords && withPassword) data.secrets = (await backend.syncSecretsSeal(merged)) ?? undefined;
    else if (theirs?.secrets && !st.settings.syncPasswords) data.secrets = undefined;
    else if (theirs?.secrets) data.secrets = theirs.secrets;
    mtime = await backend.syncWrite(folder, JSON.stringify(data, null, 2));
  }
  patchSettings({
    syncBase: {
      servers: Object.fromEntries([
        ...merged.filter((x) => !heldIds.has(x.id)).map((x) => [x.id, hashServer(x)]),
        ...held.flatMap((h) => (base.servers[h.theirs.id] ? [[h.theirs.id, base.servers[h.theirs.id]]] : [])),
      ]),
      settings: Object.fromEntries(SHARED_SETTINGS.map((k) => [k, stable(mergedSettings[k])])),
    },
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
    const changed =
      s.servers !== last.servers ||
      SHARED_SETTINGS.some((k) => s.settings[k] !== last.settings[k]) ||
      s.settings.syncFolder !== last.settings.syncFolder;
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
    patchSettings({
      syncFolder: undefined,
      syncBase: undefined,
      syncAt: undefined,
      syncSeen: undefined,
      syncError: undefined,
    });
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
    if (LIVE) await backend.secretStore(SYNC_PASSWORD, password);
    patchSettings({ syncPasswords: true });
  } else {
    if (LIVE) await backend.secretForget(SYNC_PASSWORD).catch((e) => showError(e));
    patchSettings({ syncPasswords: false });
  }
  void runSync();
}

/**
 * Answer to the dialog "syncReview". Taking over replaces our entries with the other computer's;
 * keeping them records the other version as seen, so the next run writes ours back to the file.
 */
export function answerSyncReview(take: boolean) {
  const held: HeldServer[] = getState().syncReview;
  setState({ syncReview: [], dialog: null });
  if (take) {
    setState((s) => {
      const byId = new Map(held.map((h) => [h.theirs.id, h.theirs]));
      const replaced = s.servers.map((x) => {
        const t = byId.get(x.id);
        return t ? { ...t, online: x.online, lastUsed: x.lastUsed, localStart: x.localStart } : x;
      });
      const added = held.filter((h) => !s.servers.some((x) => x.id === h.theirs.id)).map((h) => h.theirs);
      return { servers: [...replaced, ...added] };
    });
    addLog('ok', $t('Abgleich: Änderungen vom anderen Rechner übernommen.'));
  } else {
    const base = getState().settings.syncBase ?? { servers: {}, settings: {} };
    patchSettings({
      syncBase: {
        ...base,
        servers: { ...base.servers, ...Object.fromEntries(held.map((h) => [h.theirs.id, hashServer(h.theirs)])) },
      },
    });
    addLog('info', $t('Abgleich: Änderungen vom anderen Rechner nicht übernommen.'));
  }
  void runSync();
}
