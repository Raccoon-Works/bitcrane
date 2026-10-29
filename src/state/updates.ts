/**
 * Automatic updates.
 *
 * Bitcrane asks the public update address (see `plugins.updater` in
 * tauri.conf.json) for the newest version. Every update is signed; the app
 * only installs packages whose signature matches the public key it ships
 * with. In the browser prototype the check is simulated.
 *
 * Three modes (Settings, after Transmit): "auto" downloads a new version in
 * the background and installs it when Bitcrane quits (or right away from the
 * update window), "notify" only shows the update window, "off" never looks.
 */
import { $t } from '../i18n';
import { getState, LIVE, openDialog, setState, showToast } from './store';
import { addLog } from './log';

export interface UpdateState {
  /** "ready": downloaded in the background, installed when Bitcrane quits. */
  status: 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  /** True while a background download runs (no window, no progress shown). */
  background?: boolean;
  version?: string;
  notes?: string;
  /** Bytes downloaded so far and the total (if the server tells). */
  done?: number;
  total?: number;
  error?: string;
}

type PendingUpdate = Awaited<ReturnType<typeof import('@tauri-apps/plugin-updater').check>>;
let pending: PendingUpdate = null;
/** True once the package of `pending` has been downloaded (installable without network). */
let downloaded = false;
let timer: number | undefined;

const SIX_HOURS = 6 * 3600 * 1000;

/** Looks for a newer version. `manual`: the user asked, so "up to date" and errors are shown too. */
export async function checkForUpdates(manual: boolean) {
  const cur = getState().update;
  if (cur?.status === 'ready' && manual) {
    openDialog({ type: 'update' });
    return;
  }
  if (cur && cur.status !== 'error' && cur.status !== 'available') return;
  if (!LIVE) {
    if (manual) showToast($t('Bitcrane ist auf dem neuesten Stand.'), 'ok');
    return;
  }
  setState({ update: { status: 'checking' } });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    pending = await check();
    downloaded = false;
    if (!pending) {
      setState({ update: null });
      if (manual) showToast($t('Bitcrane ist auf dem neuesten Stand.'), 'ok');
      return;
    }
    setState({ update: { status: 'available', version: pending.version, notes: pending.body ?? '' } });
    addLog('info', $t('Neue Version verfügbar: {0}', pending.version));
    if (!manual && getState().settings.updateMode === 'auto') {
      void downloadInBackground();
      return;
    }
    // Automatic checks only open the window when nothing else is open.
    if (manual || !getState().dialog) openDialog({ type: 'update' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setState({ update: null });
    addLog(manual ? 'error' : 'debug', $t('Suche nach Updates fehlgeschlagen.'), undefined, message);
    if (manual) showToast($t('Suche nach Updates fehlgeschlagen. Bitte später noch einmal versuchen.'), 'error');
  }
}

/** "Automatisch installieren": loads the package quietly; it is installed when Bitcrane quits. */
async function downloadInBackground() {
  if (!pending) return;
  const update = pending;
  const version = update.version;
  setState({ update: { status: 'downloading', version, notes: update.body ?? '', background: true } });
  try {
    await update.download();
    if (pending !== update) return;
    downloaded = true;
    setState({ update: { status: 'ready', version, notes: update.body ?? '' } });
    addLog('ok', $t('Update {0} geladen, es wird beim Beenden installiert.', version));
    showToast($t('Bitcrane {0} ist geladen und wird beim Beenden installiert.', version), 'update');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Fall back to asking: the update window offers the normal download (and shows its error).
    setState({ update: { status: 'available', version, notes: update.body ?? '' } });
    addLog('warn', $t('Update konnte nicht im Hintergrund geladen werden.'), undefined, message);
    if (!getState().dialog) openDialog({ type: 'update' });
  }
}

/**
 * Called before Bitcrane quits: installs a package that is already downloaded.
 * Windows does not restart the app afterwards (the user wanted to quit).
 * Returns true when an installation ran.
 */
export async function installOnQuit(): Promise<boolean> {
  if (!pending || !downloaded) return false;
  try {
    addLog('info', $t('Update {0} wird beim Beenden installiert.', pending.version));
    await pending.install({ restartAfterInstall: false });
    return true;
  } catch (e) {
    addLog('error', $t('Update konnte nicht installiert werden.'), undefined, e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Downloads (unless already done) and installs the update, then restarts Bitcrane. */
export async function installUpdate() {
  if (!pending) return;
  const version = pending.version;
  if (downloaded) {
    setState({ update: { status: 'installing', version } });
    try {
      const { saveNow } = await import('./live');
      await saveNow();
      await pending.install();
      addLog('ok', $t('Update auf {0} installiert, Bitcrane startet neu.', version));
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({ update: { status: 'error', version, error: message } });
      addLog('error', $t('Update konnte nicht installiert werden.'), undefined, message);
    }
    return;
  }
  setState({ update: { status: 'downloading', version, done: 0 } });
  try {
    // Unfinished transfers are saved first and continue after the restart.
    const { saveNow } = await import('./live');
    await saveNow();
    let done = 0;
    let total: number | undefined;
    await pending.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? undefined;
      else if (ev.event === 'Progress') done += ev.data.chunkLength;
      else if (ev.event === 'Finished') {
        setState({ update: { status: 'installing', version } });
        return;
      }
      setState({ update: { status: 'downloading', version, done, total } });
    });
    addLog('ok', $t('Update auf {0} installiert, Bitcrane startet neu.', version));
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setState({ update: { status: 'error', version, error: message } });
    addLog('error', $t('Update konnte nicht installiert werden.'), undefined, message);
  }
}

/** Starts the regular background check (shortly after start, then every six hours). */
export function startUpdateChecks() {
  window.clearInterval(timer);
  if (!LIVE || getState().settings.updateMode === 'off') return;
  window.setTimeout(() => void checkForUpdates(false), 15000);
  timer = window.setInterval(() => {
    if (getState().settings.updateMode !== 'off') void checkForUpdates(false);
  }, SIX_HOURS);
}
