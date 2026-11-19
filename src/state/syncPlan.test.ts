import { describe, expect, it } from 'vitest';
import type { WalkItem } from '../backend/api';
import {
  actionsOf,
  alignCase,
  baseKey,
  isExcluded,
  learnBase,
  planLines,
  sameSizePairs,
  sidesOf,
  TOLERANCE_MS,
  type Base,
  type Direction,
  type Side,
} from './syncPlan';

const T = new Date(2026, 5, 15, 12).getTime();

/** One side of a file: "l" files live below ~/site, "r" files below /srv/www. */
const l = (rel: string, size: number, mtime = T): [string, Side] => [
  rel,
  { size, mtime, path: `~/site/${rel}`, localRel: rel },
];
const r = (rel: string, size: number, mtime = T): [string, Side] => [
  rel,
  { size, mtime, path: `/srv/www/${rel}`, localRel: rel },
];

function plan(
  local: Array<[string, Side]>,
  remote: Array<[string, Side]>,
  o: {
    direction?: Direction;
    bySize?: boolean;
    deletes?: boolean;
    days?: number;
    excludes?: string[];
    differs?: Map<string, boolean>;
    base?: Base;
  } = {},
) {
  return planLines(new Map(local), new Map(remote), {
    direction: 'up',
    bySize: false,
    deletes: false,
    days: 0,
    excludes: [],
    ...o,
  }).map((x) => [x.rel, x.action]);
}

describe('isExcluded', () => {
  it('matches any segment by name or extension', () => {
    expect(isExcluded('a/node_modules/b.js', ['node_modules'])).toBe(true);
    expect(isExcluded('src/app.LOG', ['*.log'])).toBe(true);
    expect(isExcluded('.git', ['.git'])).toBe(true);
  });

  it('does not match parts of names', () => {
    expect(isExcluded('src/app.log.txt', ['*.log'])).toBe(false);
    expect(isExcluded('my.git/x', ['.git'])).toBe(false);
    expect(isExcluded('a/b', [])).toBe(false);
  });
});

describe('planLines', () => {
  it('treats times within the tolerance as equal', () => {
    expect(plan([l('a', 10, T)], [r('a', 10, T + TOLERANCE_MS)])).toEqual([['a', 'none']]);
    expect(plan([l('a', 10, T + TOLERANCE_MS + 1)], [r('a', 10, T)])).toEqual([['a', 'upload']]);
  });

  it('copies only towards the chosen direction', () => {
    const local = [l('a', 10, T + 5000)];
    const remote = [r('a', 10, T)];
    expect(plan(local, remote, { direction: 'up' })).toEqual([['a', 'upload']]);
    expect(plan(local, remote, { direction: 'down' })).toEqual([['a', 'none']]);
    expect(plan(local, remote, { direction: 'both' })).toEqual([['a', 'upload']]);
  });

  it('copies a file that differs only in size in the chosen direction', () => {
    expect(plan([l('a', 10)], [r('a', 11)], { direction: 'down' })).toEqual([['a', 'download']]);
    expect(plan([l('a', 10)], [r('a', 11)], { direction: 'both' })).toEqual([['a', 'conflict']]);
  });

  it('handles files on one side only', () => {
    expect(plan([l('a', 1)], [], { direction: 'up' })).toEqual([['a', 'upload']]);
    expect(plan([l('a', 1)], [], { direction: 'down' })).toEqual([['a', 'none']]);
    expect(plan([l('a', 1)], [], { direction: 'down', deletes: true })).toEqual([['a', 'deleteLocal']]);
    expect(plan([], [r('a', 1)], { direction: 'up' })).toEqual([['a', 'none']]);
    expect(plan([], [r('a', 1)], { direction: 'up', deletes: true })).toEqual([['a', 'deleteRemote']]);
    expect(plan([], [r('a', 1)], { direction: 'down' })).toEqual([['a', 'download']]);
    expect(plan([], [r('a', 1)], { direction: 'both' })).toEqual([['a', 'download']]);
  });

  it('compares only sizes when asked to', () => {
    expect(plan([l('a', 10, T)], [r('a', 10, T + 60000)], { bySize: true })).toEqual([['a', 'none']]);
    expect(plan([l('a', 10, T)], [r('a', 11, T + 60000)], { bySize: true })).toEqual([['a', 'upload']]);
  });

  it('uses checksum results for files of equal size', () => {
    const differs = new Map([
      ['same', false],
      ['changed', true],
    ]);
    const local = [l('same', 10, T), l('changed', 10, T)];
    const remote = [r('same', 10, T + 60000), r('changed', 10, T)];
    expect(plan(local, remote, { differs })).toEqual([
      ['changed', 'upload'],
      ['same', 'none'],
    ]);
  });

  it('skips excluded paths and files older than the chosen days', () => {
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const local = [l('new.txt', 1, now), l('old.txt', 1, now - 10 * day), l('debug.log', 1, now)];
    expect(plan(local, [], { days: 7, excludes: ['*.log'] })).toEqual([['new.txt', 'upload']]);
  });

  it('sorts lines by path', () => {
    expect(plan([l('b', 1), l('a/z', 1), l('a', 1)], []).map(([rel]) => rel)).toEqual(['a', 'a/z', 'b']);
  });

  describe('both directions with a base', () => {
    const base: Base = new Map([
      ['a', [10, T]],
      ['gone', [5, T]],
    ]);

    it('lets the side that changed win', () => {
      expect(plan([l('a', 12, T + 60000)], [r('a', 10, T)], { direction: 'both', base })).toEqual([['a', 'upload']]);
      // The changed side wins even when the other copy has the newer time.
      expect(plan([l('a', 10, T)], [r('a', 12, T - 60000)], { direction: 'both', base })).toEqual([['a', 'download']]);
      expect(plan([l('a', 11, T)], [r('a', 12, T)], { direction: 'both', base })).toEqual([['a', 'conflict']]);
    });

    it('recognises a file deleted on one side', () => {
      expect(plan([l('gone', 5, T)], [], { direction: 'both', base, deletes: true })).toEqual([
        ['gone', 'deleteLocal'],
      ]);
      expect(plan([], [r('gone', 5, T)], { direction: 'both', base, deletes: true })).toEqual([
        ['gone', 'deleteRemote'],
      ]);
      // Changed on the side that still has it: copied back instead of deleted.
      expect(plan([l('gone', 6, T)], [], { direction: 'both', base, deletes: true })).toEqual([['gone', 'upload']]);
    });

    it('ignores the base for one-way comparisons', () => {
      expect(plan([l('gone', 5, T)], [], { direction: 'up', base, deletes: true })).toEqual([['gone', 'upload']]);
    });

    it('copies a file deleted on one side back when deleting is off', () => {
      expect(plan([l('gone', 5, T)], [], { direction: 'both', base })).toEqual([['gone', 'upload']]);
      expect(plan([], [r('gone', 5, T)], { direction: 'both', base })).toEqual([['gone', 'download']]);
    });

    it('takes the newer copy without a base, and leaves equal times to the user', () => {
      expect(plan([l('new', 1, T + 60000)], [r('new', 2, T)], { direction: 'both' })).toEqual([['new', 'upload']]);
      expect(plan([l('new', 1, T)], [r('new', 2, T)], { direction: 'both' })).toEqual([['new', 'conflict']]);
    });
  });
});

describe('actionsOf', () => {
  it('turns lines into actions from the right source to the right target', () => {
    const lines = planLines(new Map([l('up', 3, T + 60000), l('both', 7)]), new Map([r('down', 4), r('both', 8)]), {
      direction: 'both',
      bySize: false,
      deletes: false,
      days: 0,
      excludes: [],
    });
    expect(actionsOf(lines)).toEqual([
      { kind: 'download', rel: 'down', localRel: 'down', size: 4, from: '/srv/www/down', to: undefined },
      { kind: 'upload', rel: 'up', localRel: 'up', size: 3, from: '~/site/up', to: undefined },
    ]);
  });

  it('keeps both paths for files on both sides', () => {
    const lines = planLines(new Map([l('a', 3, T + 60000)]), new Map([r('a', 2)]), {
      direction: 'up',
      bySize: false,
      deletes: false,
      days: 0,
      excludes: [],
    });
    expect(actionsOf(lines)).toEqual([
      { kind: 'upload', rel: 'a', localRel: 'a', size: 3, from: '~/site/a', to: '/srv/www/a' },
    ]);
  });

  it('gives a new file on this computer the name the core made storable', () => {
    // On Windows the core walks "logs/12:00.log" on a server with the local form "logs/12%3A00.log".
    const server: [string, Side] = [
      'logs/12:00.log',
      { size: 4, mtime: T, path: '/srv/www/logs/12:00.log', localRel: 'logs/12%3A00.log' },
    ];
    const lines = planLines(new Map(), new Map([server]), {
      direction: 'down',
      bySize: false,
      deletes: false,
      days: 0,
      excludes: [],
    });
    expect(actionsOf(lines)).toEqual([
      {
        kind: 'download',
        rel: 'logs/12:00.log',
        localRel: 'logs/12%3A00.log',
        size: 4,
        from: '/srv/www/logs/12:00.log',
        to: undefined,
      },
    ]);
  });
});

describe('sameSizePairs', () => {
  it('pairs files of equal size that are not excluded', () => {
    const pairs = sameSizePairs(
      new Map([l('a', 1), l('b', 2), l('c.log', 3), l('only-left', 4)]),
      new Map([r('a', 1), r('b', 9), r('c.log', 3)]),
      ['*.log'],
    );
    expect(pairs.map((p) => p.rel)).toEqual(['a']);
  });
});

describe('learnBase', () => {
  it('records files seen equal and forgets files gone from both sides', () => {
    const key = baseKey(
      { serverId: '', dir: '~/site', name: 'site' },
      { serverId: 'srv-1', dir: '/srv/www', name: 'www' },
    );
    expect(key).toBe('bitcrane.syncBase.|~/site||srv-1|/srv/www');

    const first = learnBase(key, new Map([l('a', 10), l('b', 1)]), new Map([r('a', 10, T + 1000), r('b', 2)]));
    expect(first).toEqual(new Map());

    const second = learnBase(key, new Map(), new Map());
    expect(second).toEqual(new Map([['a', [10, T]]]));

    expect(learnBase(key, new Map(), new Map())).toEqual(new Map());
  });
});

describe('alignCase', () => {
  it('pairs names that differ only in case, under the name the right side has', () => {
    const left = alignCase(new Map([l('Docs/Readme.md', 3)]), new Map([r('docs/README.md', 4)]));
    expect([...left.keys()]).toEqual(['docs/README.md']);
    expect(left.get('docs/README.md')?.path).toBe('~/site/Docs/Readme.md');
  });

  it('prefers the exact name and leaves other files alone', () => {
    const right = new Map([r('a.txt', 1), r('A.txt', 2)]);
    expect([...alignCase(new Map([l('A.txt', 1), l('b.txt', 1)]), right).keys()]).toEqual(['A.txt', 'b.txt']);
  });

  it('keeps a downloaded case twin from being deleted again', () => {
    const local = new Map([l('Readme.md', 3, T)]);
    const remote = new Map([r('README.md', 3, T + 60000)]);
    const lines = planLines(alignCase(local, remote), remote, {
      direction: 'down',
      bySize: false,
      deletes: true,
      days: 0,
      excludes: [],
    });
    expect(lines.map((x) => [x.rel, x.action])).toEqual([['README.md', 'download']]);
    expect(actionsOf(lines)[0]).toMatchObject({ from: '/srv/www/README.md', to: '~/site/Readme.md' });
  });
});

describe('sidesOf', () => {
  const item = (relative: string, mtime = T): WalkItem => ({
    path: `/srv/www/${relative}`,
    relative: `www/${relative}`,
    localRelative: `www/${relative}`,
    size: 1,
    mtime,
  });

  it('keys files below the walked folder and drops the folder itself', () => {
    expect([...sidesOf([item(''), item('a/b.txt')], 0).keys()]).toEqual(['a/b.txt']);
  });

  it('keys composed and decomposed umlauts alike', () => {
    const decomposed = 'u\u0308ber.txt';
    expect([...sidesOf([item(decomposed)], 0).keys()]).toEqual(['\u00fcber.txt']);
    expect(sidesOf([item(decomposed)], 0).get('\u00fcber.txt')?.path).toBe(`/srv/www/${decomposed}`);
  });

  it('moves server times by the clock offset', () => {
    expect(sidesOf([item('a', T + 5000)], 5000).get('a')?.mtime).toBe(T);
  });
});
