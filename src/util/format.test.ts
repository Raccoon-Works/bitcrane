// The test environment reports "en-US" (see vite.config.ts), so these are the English texts.
import { describe, expect, it } from 'vitest';
import {
  describeFile,
  extLabel,
  formatAgo,
  formatDate,
  formatDuration,
  formatSize,
  formatSpeed,
  formatTime,
  matchesExclude,
  permsToText,
} from './format';

const KB = 1024;
const MB = 1024 * KB;

describe('formatSize', () => {
  it('counts bytes below one kilobyte', () => {
    expect(formatSize(0)).toBe('0 bytes');
    expect(formatSize(1023)).toBe('1023 bytes');
  });

  it('shows one decimal only from megabytes below ten', () => {
    expect(formatSize(KB)).toBe('1 KB');
    expect(formatSize(14 * KB)).toBe('14 KB');
    expect(formatSize(Math.round(2.4 * MB))).toBe('2.4 MB');
    expect(formatSize(12 * MB)).toBe('12 MB');
  });

  it('stops at terabytes', () => {
    expect(formatSize(3 * 1024 * 1024 * MB)).toBe('3 TB');
    expect(formatSize(1024 * 1024 * 1024 * MB)).toBe('1,024 TB');
  });
});

describe('formatSpeed', () => {
  it('shows a dash while nothing moves', () => {
    expect(formatSpeed(0)).toBe('–');
    expect(formatSpeed(0.5)).toBe('–');
    expect(formatSpeed(NaN)).toBe('–');
  });

  it('rounds to whole bytes per second', () => {
    expect(formatSpeed(500.4)).toBe('500 bytes/s');
    expect(formatSpeed(1.2 * MB)).toBe('1.2 MB/s');
  });
});

describe('formatDate / formatTime', () => {
  const startToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime();

  it('shows a dash for unknown times', () => {
    expect(formatDate(0)).toBe('–');
    expect(formatDate(NaN)).toBe('–');
    expect(formatDate(Infinity)).toBe('–');
  });

  it('names today and yesterday', () => {
    expect(formatDate(startToday + 5 * 60 * 1000)).toBe('Today, 00:05');
    expect(formatDate(startToday - 60 * 60 * 1000)).toBe('Yesterday, 23:00');
  });

  it('uses ISO dates in English further back', () => {
    expect(formatDate(new Date(2025, 2, 7, 12).getTime())).toBe('2025-03-07');
  });

  it('pads clock times', () => {
    expect(formatTime(new Date(2025, 2, 7, 9, 5).getTime())).toBe('09:05');
  });
});

describe('formatAgo', () => {
  const now = new Date(2026, 5, 15, 12).getTime();

  it('steps from seconds to hours', () => {
    expect(formatAgo(now - 4 * 1000, now)).toBe('just now');
    expect(formatAgo(now + 60 * 1000, now)).toBe('just now');
    expect(formatAgo(now - 30 * 1000, now)).toBe('30 s ago');
    expect(formatAgo(now - 89 * 1000, now)).toBe('1 min ago');
    expect(formatAgo(now - 5 * 60 * 1000, now)).toBe('5 min ago');
    expect(formatAgo(now - 3 * 3600 * 1000, now)).toBe('3 h ago');
  });

  it('falls back to the date after a day', () => {
    const old = new Date(2025, 2, 7, 12).getTime();
    expect(formatAgo(old, now)).toBe('2025-03-07');
  });
});

describe('formatDuration', () => {
  it('shows at least one second', () => {
    expect(formatDuration(0)).toBe('1 s');
    expect(formatDuration(59.4)).toBe('59 s');
  });

  it('rounds to minutes and splits hours', () => {
    expect(formatDuration(90)).toBe('2 min');
    expect(formatDuration(3599)).toBe('1 h 0 min');
    expect(formatDuration(4800)).toBe('1 h 20 min');
  });
});

describe('describeFile / extLabel', () => {
  it('describes by extension, ignoring case', () => {
    expect(describeFile('src', 'dir')).toBe('Folder');
    expect(describeFile('app.py', 'file')).toBe('Python script');
    expect(describeFile('data.JSON', 'file')).toBe('JSON data');
    expect(describeFile('backup.tar.gz', 'file')).toBe('GZ file');
    expect(describeFile('Makefile', 'file')).toBe('file');
  });

  it('treats dot files as hidden, except .env', () => {
    expect(describeFile('.env', 'file')).toBe('Environment variables');
    expect(describeFile('.gitignore', 'file')).toBe('Hidden file');
    expect(describeFile('.env.local', 'file')).toBe('LOCAL file');
  });

  it('labels the extension', () => {
    expect(extLabel('app.py')).toBe('.py');
    expect(extLabel('backup.tar.gz')).toBe('.gz');
    expect(extLabel('.env')).toBe('.env');
    expect(extLabel('Makefile')).toBe('file');
  });
});

describe('permsToText', () => {
  it('converts octal digits', () => {
    expect(permsToText('644')).toBe('rw-r--r--');
    expect(permsToText('755')).toBe('rwxr-xr-x');
    expect(permsToText('9')).toBe('---');
  });
});

describe('matchesExclude', () => {
  it('matches exact names and extensions', () => {
    expect(matchesExclude('debug.LOG', ['*.log'])).toBe(true);
    expect(matchesExclude('.git', ['.git'])).toBe(true);
    expect(matchesExclude('a.git', ['.git'])).toBe(false);
    expect(matchesExclude('x', [])).toBe(false);
  });
});
