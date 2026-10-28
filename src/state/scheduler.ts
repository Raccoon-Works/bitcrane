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
import { connectServer, isConnected } from './live';
import { notify } from './shell';
import { getState, ruleFor, runSyncBetween, serverById, updateSettings, watchForLocal, type SyncFavorite } from './store';
import { actionsOf, contentDiffers, planLines, sameSizePairs, walkPlace, type Place } from './syncPlan';
import { $t } from '../i18n';

const HOUR_MS = 3600 * 1000;
/** Comparisons running right now (a slow run is not started a second time). */
const running = new Set<string>();

/** Start time of today's run of a daily schedule ("03:00"). */
function todayAt(time: string | undefined, now: Date): number {
  const [h, m] = (time ?? '03:00').split(':').map((x) => Number(x) || 0);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/**
 * True when a comparison should run now. A daily run that was missed (computer
 * off at that time) is made up as soon as Bitcrane runs later that day.
 */
function isDue(f: SyncFavorite, now: number, atStart: boolean): boolean {
  const s = f.schedule;
  if (!s) return false;
  if (s.mode === 'startup') return atStart;
  if (s.mode === 'hourly') return !f.lastRun || now - f.lastRun >= HOUR_MS - 30_000;
  const target = todayAt(s.time, new Date(now));
  return now >= target && (f.lastRun ?? 0) < target;
}

function saveResult(id: string, result: string) {
  const list = getState().settings.syncFavorites;
  updateSettings({ syncFavorites: list.map((x) => (x.id === id ? { ...x, lastRun: Date.now(), lastResult: result } : x)) });
}

/** Runs one saved comparison without the window. */
export async function runScheduled(f: SyncFavorite): Promise<void> {
  if (running.has(f.id)) return;
  running.add(f.id);
  const leftServer = f.leftServerId ?? '';
  const rightServer = f.rightLocal ? '' : f.serverId;
  const here = getState().platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC');
  const left: Place = { serverId: leftServer, dir: f.local, name: leftServer ? serverById(leftServer)?.name ?? '?' : here };
  const right: Place = { serverId: rightServer, dir: f.remote, name: rightServer ? serverById(rightServer)?.name ?? '?' : here };
  try {
    for (const sid of [leftServer, rightServer].filter(Boolean)) {
      if (!serverById(sid)) throw new Error($t('Der Server dieses Abgleichs gibt es nicht mehr.'));
      if (!isConnected(sid) && !(await connectServer(sid))) throw new Error($t('Keine Verbindung zu {0}.', serverById(sid)?.name ?? sid));
    }
    const [local, remote] = await Promise.all([walkPlace(left), walkPlace(right)]);
    // Left out: like in the window (watch or general patterns plus the servers' rules).
    const s = getState().settings;
    const own = (!leftServer ? watchForLocal(f.local)?.excludes : undefined) ?? s.defaultExcludes;
    const excludes = [...new Set([...own, ...[leftServer, rightServer].filter(Boolean).flatMap((sid) => ruleFor(sid)?.excludes ?? [])])];
    const differs = f.byContent ? await contentDiffers(left, right, sameSizePairs(local, remote, excludes)) : null;
    const base = { direction: f.direction, bySize: f.bySize, days: f.days ?? 0, excludes, differs };
    const allowDelete = f.deletes && !!f.schedule?.allowDelete;
    const lines = planLines(local, remote, { ...base, deletes: allowDelete });
    // What a run with deleting would have removed; reported, not done.
    const notDeleted = f.deletes && !allowDelete ? planLines(local, remote, { ...base, deletes: true }).filter((l) => l.action.startsWith('delete')).length : 0;
    const actions = actionsOf(lines);
    const { n, deleteCount } = actions.length ? runSyncBetween(leftServer, f.local, rightServer, f.remote, actions) : { n: 0, deleteCount: 0 };
    const parts = [
      n ? $t('{0} übertragen', n) : '',
      deleteCount ? $t('{0} gelöscht', deleteCount) : '',
      notDeleted ? $t('{0} nicht gelöscht (Löschen ist für geplante Läufe aus)', notDeleted) : '',
    ].filter(Boolean);
    const result = parts.length ? parts.join(', ') : $t('nichts zu tun');
    saveResult(f.id, result);
    addLog(n || deleteCount ? 'ok' : 'info', $t('Geplanter Abgleich „{0}“: {1}', f.name, result), rightServer || leftServer || undefined);
    if (n || deleteCount || notDeleted) void notify($t('Abgleich „{0}“', f.name), result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    saveResult(f.id, $t('Fehler: {0}', msg));
    addLog('error', $t('Geplanter Abgleich „{0}“ fehlgeschlagen: {1}', f.name, msg), rightServer || leftServer || undefined);
    void notify($t('Abgleich „{0}“ fehlgeschlagen', f.name), msg);
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
  return s.mode === 'daily' ? $t('täglich {0}', s.time ?? '03:00') : s.mode === 'hourly' ? $t('stündlich') : $t('beim Start');
}
