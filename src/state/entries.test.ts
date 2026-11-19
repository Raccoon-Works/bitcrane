import { describe, expect, it } from 'vitest';
import { defaultWatchOptions } from './defaults';
import { isServerEntry, watchEntry } from './entries';

const server = {
  id: 'a',
  name: 'Web',
  host: 'web.example',
  port: 22,
  user: 'anna',
  auth: 'password',
  keyPath: '',
};

describe('isServerEntry', () => {
  it('accepts a complete entry and refuses broken ones', () => {
    expect(isServerEntry(server)).toBe(true);
    expect(isServerEntry({ ...server, port: '22' })).toBe(false);
    expect(isServerEntry({ ...server, port: 70000 })).toBe(false);
    expect(isServerEntry({ id: 'a' })).toBe(false);
    expect(isServerEntry(null)).toBe(false);
  });
});

describe('watchEntry', () => {
  const watch = { id: 'w', name: 'Bot', localPath: '~/bot', serverId: 'a', remotePath: '/srv/bot' };

  it('completes a short entry with the default options', () => {
    const w = watchEntry({ ...watch, options: { delay: 5 } });
    expect(w?.options).toEqual({ ...defaultWatchOptions, delay: 5 });
    expect([w?.excludes, w?.lastFile, w?.state]).toEqual([[], '', 'active']);
  });

  it('refuses entries without what identifies them', () => {
    expect(watchEntry({ ...watch, localPath: 3 })).toBeNull();
    expect(watchEntry('Bot')).toBeNull();
  });
});
