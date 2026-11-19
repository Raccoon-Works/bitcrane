/**
 * Scheduled comparisons (Schritt 2, Teil 4): saved comparisons with a schedule
 * ("täglich um 03:00", "stündlich", "beim Start von Bitcrane") run by themselves
 * while Bitcrane is running, also when it only sits in the notification area.
 *
 * A scheduled run does exactly what the comparison window would propose, but
 * nobody sees the list first. It therefore never deletes, unless "Auch löschen"
 * was switched on for that comparison; files it would have deleted are only
 * reported. Every run is written to the log and announced as a notification.
 */
import { addLog } from './log';
import { notify } from './shell';
import { getState, runSyncBetween, updateSettings, type SyncFavorite } from './store';
import {
  actionsOf,
  baseKey,
  contentDiffers,
  learnBase,
  planLines,
  sameSizePairs,
  compareExcludes,
  comparePlace,
  readPlaces,
} from './syncPlan';
import { $t } from '../i18n';
import { toBackendError } from '../backend/api';
import { DEFAULT_RUN_TIME, isDue } from './schedule';

/** Comparisons running right now (a slow run is not started a second time). */
const running = new Set<string>();

/** Records a run that went through. */
function saveResult(id: string, result: string) {
  const list = getState().settings.syncFavorites;
  updateSettings({
    syncFavorites: list.map((x) =>
      x.id === id ? { ...x, lastRun: Date.now(), lastResult: result, failedAt: undefined } : x,
    ),
  });
}

/** Records a failed run: it stays due (isDue tries again after a pause). */
function saveFailure(id: string, result: string) {
  const list = getState().settings.syncFavorites;
  updateSettings({
    syncFavorites: list.map((x) => (x.id === id ? { ...x, lastResult: result, failedAt: Date.now() } : x)),
  });
}

/** Runs one saved comparison without the window. */
async function runScheduled(f: SyncFavorite): Promise<void> {
  if (running.has(f.id)) return;
  running.add(f.id);
  const leftServer = f.leftServerId ?? '';
  const rightServer = f.rightLocal ? '' : f.serverId;
  const left = comparePlace(leftServer, f.local);
  const right = comparePlace(rightServer, f.remote);
  try {
    const [local, remote] = await readPlaces(left, right);
    // Left out: like in the window, but without the rule chosen in the activity area.
    const excludes = compareExcludes(left, right, false);
    const differs = f.byContent ? await contentDiffers(left, right, sameSizePairs(local, remote, excludes)) : null;
    const agreed = f.direction === 'both' ? learnBase(baseKey(left, right), local, remote) : null;
    const base = { direction: f.direction, bySize: f.bySize, days: f.days ?? 0, excludes, differs, base: agreed };
    const allowDelete = f.deletes && !!f.schedule?.allowDelete;
    const lines = planLines(local, remote, { ...base, deletes: allowDelete });
    // What a run with deleting would have removed; reported, not done.
    const notDeleted =
      f.deletes && !allowDelete
        ? planLines(local, remote, { ...base, deletes: true }).filter((l) => l.action.startsWith('delete')).length
        : 0;
    const actions = actionsOf(lines);
    // Changed on both sides: never decided by a scheduled run, only reported.
    const conflicts = lines.filter((l) => l.action === 'conflict').length;
    const { n, deleteCount } = actions.length
      ? runSyncBetween(leftServer, f.local, rightServer, f.remote, actions)
      : { n: 0, deleteCount: 0 };
    const parts = [
      n ? $t('{0} übertragen', n) : '',
      deleteCount ? $t('{0} gelöscht', deleteCount) : '',
      notDeleted ? $t('{0} nicht gelöscht (Löschen ist für geplante Läufe aus)', notDeleted) : '',
      conflicts ? $t('{0} auf beiden Seiten geändert, bitte im Abgleichfenster entscheiden', conflicts) : '',
    ].filter(Boolean);
    const result = parts.length ? parts.join(', ') : $t('nichts zu tun');
    saveResult(f.id, result);
    addLog(
      n || deleteCount ? 'ok' : 'info',
      $t('Geplanter Abgleich „{0}“: {1}', f.name, result),
      rightServer || leftServer || undefined,
    );
    if (n || deleteCount || notDeleted || conflicts) void notify($t('Abgleich „{0}“', f.name), result);
  } catch (e) {
    const msg = toBackendError(e).message;
    saveFailure(f.id, $t('Fehler: {0}', msg));
    addLog(
      'error',
      $t('Geplanter Abgleich „{0}“ fehlgeschlagen: {1}', f.name, msg),
      rightServer || leftServer || undefined,
    );
    // Said once: the tries after it fail the same way until the cause is gone.
    if (f.failedAt === undefined) void notify($t('Abgleich „{0}“ fehlgeschlagen', f.name), msg);
  } finally {
    running.delete(f.id);
  }
}

function runDue(atStart: boolean) {
  const now = Date.now();
  for (const f of getState().settings.syncFavorites) if (isDue(f, now, atStart)) void runScheduled(f);
}

let started = false;
/** Starts the scheduler once the saved settings are loaded (app only). */
export function startScheduler() {
  if (started) return;
  started = true;
  // A short pause after the start, so connections and watches come up first.
  window.setTimeout(() => runDue(true), 15_000);
  window.setInterval(() => runDue(false), 60_000);
}

/** Short text for a schedule ("täglich 03:00"), for the server list. */
export function scheduleLabel(f: SyncFavorite): string {
  const s = f.schedule;
  if (!s) return '';
  return s.mode === 'daily'
    ? $t('täglich {0}', s.time ?? DEFAULT_RUN_TIME)
    : s.mode === 'hourly'
      ? $t('stündlich')
      : $t('beim Start');
}
