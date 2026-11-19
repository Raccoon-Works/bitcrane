import { describe, expect, it } from 'vitest';
import type { ContextMenuState } from '../appState';
import { $t } from '../../i18n';
import { getState } from '../store';
import { contextMenuGroups } from '.';

const tab = () => getState().tabs.find((t) => t.id === getState().activeTabId);
const labels = (menu: Partial<ContextMenuState>, platform: 'mac' | 'win' = 'mac') =>
  contextMenuGroups({ menu: { x: 0, y: 0, side: 'local', names: [], ...menu }, tab: tab(), platform }).map((g) =>
    g.map((it) => it.label),
  );

describe('context menus', () => {
  it('offer the editor and the Finder for a file of this computer', () => {
    const all = labels({ names: ['app.py'] }).flat();
    expect(all).toContain($t('Im Editor öffnen'));
    expect(all).toContain($t('Im Finder zeigen'));
    expect(all).toContain($t('Prüfsumme …'));
  });

  it('name the Explorer on Windows', () => {
    expect(labels({ names: ['app.py'] }, 'win').flat()).toContain($t('Im Explorer zeigen'));
  });

  it('do not offer the Finder or tags for a server file', () => {
    const all = labels({ side: 'remote', names: ['app.py'] }).flat();
    expect(all).not.toContain($t('Im Finder zeigen'));
    expect(all).toContain($t('Vom Server löschen …'));
    expect(all).not.toContain('Red');
  });

  it('rename several entries at once', () => {
    expect(labels({ names: ['app.py', 'config.py'] }).flat()).toContain($t('{0} Objekte umbenennen …', 2));
  });

  it('show the folder menu for the empty area', () => {
    const all = labels({ names: [] }).flat();
    expect(all).toContain($t('Neuer Ordner'));
    expect(all).toContain($t('Diesen Ordner überwachen …'));
  });

  it('leave out empty groups', () => {
    for (const menu of [{ names: ['app.py'] }, { names: [] }, { kind: 'columns' as const }])
      for (const g of contextMenuGroups({
        menu: { x: 0, y: 0, side: 'local', names: [], ...menu },
        tab: tab(),
        platform: 'mac',
      }))
        expect(g.length).toBeGreaterThan(0);
  });

  it('offer closing other tabs only when there are some', () => {
    const id = getState().activeTabId;
    const all = labels({ kind: 'tab', tabId: id }).flat();
    expect(all.includes($t('Andere Tabs schließen'))).toBe(getState().tabs.length > 1);
  });

  it('list each crumb, even with repeated names', () => {
    const groups = contextMenuGroups({
      menu: { x: 0, y: 0, side: 'local', names: [], kind: 'crumbs', place: 'all' },
      tab: tab(),
      platform: 'mac',
    });
    expect(groups[0].length).toBeGreaterThan(0);
  });
});
