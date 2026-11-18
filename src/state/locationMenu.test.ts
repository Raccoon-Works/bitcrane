import { describe, expect, it } from 'vitest';
import { locationMenuGroups, type LocationMenuInput, type LocationMenuItem } from './locationMenu';

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
    show: { favorites: true, drives: true },
    ...over,
  };
}

describe('locationMenuGroups', () => {
  it('builds the left half on this computer in the agreed order, without servers', () => {
    const groups = locationMenuGroups(input());
    expect(kinds(groups)).toEqual([
      ['computer'],
      ['favorite'],
      ['drive', 'drive'],
      ['otherFolder', 'enterPath'],
      ['serverList'],
    ]);
    expect(groups[0][0]).toEqual({ kind: 'computer', checked: true });
    expect(groups[2][0]).toMatchObject({ kind: 'drive', first: true });
    expect(groups[2][1]).toMatchObject({ kind: 'drive', first: false });
  });

  it('offers to disconnect the server the half shows', () => {
    const groups = locationMenuGroups(input({ tab: { serverId: 'beta', leftServerId: 'delta' } }));
    expect(groups[0][0]).toEqual({ kind: 'computer', checked: false });
    expect(groups[groups.length - 1].map((it) => it.kind)).toEqual(['serverList', 'disconnect']);
  });

  it('offers other folders on the right half only while it shows this computer', () => {
    const onServer = locationMenuGroups(input({ side: 'remote', tab: { serverId: 'beta', leftServerId: 'delta' } }));
    expect(kinds(onServer).flat()).not.toContain('otherFolder');
    const local = locationMenuGroups(input({ side: 'remote', tab: { serverId: '', rightLocal: true } }));
    expect(local[0][0]).toEqual({ kind: 'computer', checked: true });
    expect(kinds(local)).toContainEqual(['otherFolder', 'enterPath']);
    expect(kinds(local)[kinds(local).length - 1]).toEqual(['serverList']);
  });

  it('leaves out groups that are switched off or empty, without empty separators', () => {
    const groups = locationMenuGroups(
      input({ favorites: [], drives: DRIVES, show: { favorites: true, drives: false } }),
    );
    expect(kinds(groups)).toEqual([['computer'], ['otherFolder', 'enterPath'], ['serverList']]);
  });
});
