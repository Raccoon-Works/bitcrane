import { describe, expect, it } from 'vitest';
import type { SyncFavorite } from './appState';
import { isDue, RETRY_AFTER_MS, todayAt } from './schedule';

const at = (h: number, m = 0) => new Date(2026, 10, 19, h, m).getTime();
const fav = (patch: Partial<SyncFavorite>) => ({ id: 'f', name: 'f', ...patch }) as SyncFavorite;
const daily = { mode: 'daily', time: '03:00' } as SyncFavorite['schedule'];

describe('schedule', () => {
  it('places a daily time on the given day, 03:00 when none is set', () => {
    expect(todayAt('14:30', new Date(at(9)))).toBe(at(14, 30));
    expect(todayAt(undefined, new Date(at(9)))).toBe(at(3));
  });

  it('runs a daily comparison once from its time on, also made up later that day', () => {
    expect(isDue(fav({ schedule: daily }), at(2), false)).toBe(false);
    expect(isDue(fav({ schedule: daily }), at(9), false)).toBe(true);
    expect(isDue(fav({ schedule: daily, lastRun: at(3, 1) }), at(9), false)).toBe(false);
  });

  it('tries a failed run again after the pause, not every minute', () => {
    const failed = fav({ schedule: daily, failedAt: at(3) });
    expect(isDue(failed, at(3) + 60_000, false)).toBe(false);
    expect(isDue(failed, at(3) + RETRY_AFTER_MS, false)).toBe(true);
  });

  it('runs hourly and at start as set', () => {
    const hourly = fav({ schedule: { mode: 'hourly' } as SyncFavorite['schedule'], lastRun: at(8) });
    expect(isDue(hourly, at(8, 30), false)).toBe(false);
    expect(isDue(hourly, at(9), false)).toBe(true);
    const startup = fav({ schedule: { mode: 'startup' } as SyncFavorite['schedule'] });
    expect([isDue(startup, at(9), true), isDue(startup, at(9), false)]).toEqual([true, false]);
  });
});
