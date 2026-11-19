/**
 * When a saved comparison runs on its own (state/scheduler.ts), as pure functions.
 */
import type { SyncFavorite } from './appState';

/** Time of a daily run when none is chosen. */
export const DEFAULT_RUN_TIME = '03:00';
const HOUR_MS = 3600 * 1000;
/** Pause after a failed run before the next try (a server down at night is tried again later). */
export const RETRY_AFTER_MS = 15 * 60 * 1000;

/** Start time of today's run of a daily schedule ("03:00"). */
export function todayAt(time: string | undefined, now: Date): number {
  const [h, m] = (time ?? DEFAULT_RUN_TIME).split(':').map((x) => Number(x) || 0);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/**
 * True when a comparison should run now. A daily run that was missed (computer off at that time)
 * is made up as soon as Bitcrane runs later that day; a failed one is tried again after a pause.
 */
export function isDue(f: SyncFavorite, now: number, atStart: boolean): boolean {
  const s = f.schedule;
  if (!s) return false;
  if (f.failedAt !== undefined && now - f.failedAt < RETRY_AFTER_MS) return false;
  if (s.mode === 'startup') return atStart;
  if (s.mode === 'hourly') return !f.lastRun || now - f.lastRun >= HOUR_MS - 30_000;
  const target = todayAt(s.time, new Date(now));
  return now >= target && (f.lastRun ?? 0) < target;
}
