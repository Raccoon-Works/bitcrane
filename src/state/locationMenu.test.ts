import { describe, expect, it } from 'vitest';
import type { Server } from '../backend/types';
import { locationMenuGroups, recentServers, type LocationMenuInput, type LocationMenuItem } from './locationMenu';

function server(id: string, lastUsed?: number, extra: Partial<Server> = {}): Server {
  return {
    id,
    name: id,
    mono: id.slice(0, 2).toUpperCase(),
    color: 'gray',
    host: `${id}.example`,
    port: 22,
    user: 'demo',
    auth: 'key',
    keyPath: '',
    group: '',
    localStart: '~',
    remoteStart: '/',
    online: false,
    lastUsed,
    ...extra,
  };
}

const SERVERS = [
  server('alpha', 100),
  server('beta', 600),
  server('gamma', 300),
  server('delta', 500),
  server('epsilon', 200),
  server('zeta', 400),
  server('never'),
  server('quick-closed', 900, { temporary: true }),
  server('quick-open', 50, { temporary: true, online: true }),
];

describe('recentServers', () => {
  it('lists the five used last, newest first', () => {
    expect(recentServers(SERVERS, '').map((x) => x.id)).toEqual(['beta', 'delta', 'zeta', 'gamma', 'epsilon']);
  });

  it('leaves out the server of the other half before counting', () => {
    expect(recentServers(SERVERS, 'beta').map((x) => x.id)).toEqual(['delta', 'zeta', 'gamma', 'epsilon', 'alpha']);
  });

  it('skips servers never used and closed quick connections, keeps open ones', () => {
    const ids = recentServers(SERVERS, '', 20).map((x) => x.id);
    expect(ids).not.toContain('never');
    expect(ids).not.toContain('quick-closed');
    expect(ids).toContain('quick-open');
  });
});

/** The menu as kinds per group, for compact comparisons. */
function kinds(groups: LocationMenuItem[][]): string[][] {
  return groups.map((g) => g.map((it) => it.kind));
}

const FAV = { place: { name: 'Projekte', path: '~/Projekte' }, label: 'Projekte' };
const DRIVES = [
  { name: 'C:', path: 'C:/' },
  { name: 'D:', path: 'D:/', label: 'Daten' },
];

function input(over: Partial<LocationMenuInput> = {}): LocationMenuInput {
  return {
    side: 'local',
    tab: { serverId: 'beta', leftServerId: undefined, rightLocal: false },
    favorites: [FAV],
    drives: DRIVES,
    servers: SERVERS,
    show: { favorites: true, drives: true, servers: true },
    ...over,
  };
}

describe('locationMenuGroups', () => {
  it('builds the left half on this computer in the agreed order', () => {
    const groups = locationMenuGroups(input());
    expect(kinds(groups)).toEqual([
      ['computer'],
      ['favorite'],
      ['drive', 'drive'],
      ['server', 'server', 'server', 'server', 'server'],
      ['otherFolder', 'enterPath'],
      ['serverList'],
    ]);
    expect(groups[0][0]).toEqual({ kind: 'computer', checked: true });
    expect(groups[2][0]).toMatchObject({ kind: 'drive', first: true });
    expect(groups[2][1]).toMatchObject({ kind: 'drive', first: false });
    // The right half's server is not offered on the left.
    expect(groups[3].some((it) => it.kind === 'server' && it.server.id === 'beta')).toBe(false);
  });

  it('marks the server the half shows and offers to disconnect it', () => {
    const groups = locationMenuGroups(input({ tab: { serverId: 'beta', leftServerId: 'delta' } }));
    expect(groups[0][0]).toEqual({ kind: 'computer', checked: false });
    const checked = groups[3].filter((it) => it.kind === 'server' && it.checked);
    expect(checked).toHaveLength(1);
    expect(groups[groups.length - 1].map((it) => it.kind)).toEqual(['serverList', 'disconnect']);
  });

  it('offers other folders on the right half only while it shows this computer', () => {
    const onServer = locationMenuGroups(input({ side: 'remote', tab: { serverId: 'beta', leftServerId: 'delta' } }));
    expect(kinds(onServer).flat()).not.toContain('otherFolder');
    expect(onServer.flat().filter((it) => it.kind === 'server' && it.server.id === 'delta')).toHaveLength(0);
    const local = locationMenuGroups(input({ side: 'remote', tab: { serverId: '', rightLocal: true } }));
    expect(local[0][0]).toEqual({ kind: 'computer', checked: true });
    expect(kinds(local)).toContainEqual(['otherFolder', 'enterPath']);
    expect(kinds(local)[kinds(local).length - 1]).toEqual(['serverList']);
  });

  it('leaves out groups that are switched off or empty, without empty separators', () => {
    const groups = locationMenuGroups(
      input({ favorites: [], drives: DRIVES, show: { favorites: true, drives: false, servers: false } }),
    );
    expect(kinds(groups)).toEqual([['computer'], ['otherFolder', 'enterPath'], ['serverList']]);
  });
});
