/**
 * Context menus of the tab bar and the column header.
 */
import {
  closeTab,
  closeOtherTabs,
  closeTabsRight,
  duplicateTab,
  getState,
  togglePermsColumn,
  updateSettings,
  newTab,
} from '../store';
import { $t } from '../../i18n';
import { menuKeys, type MenuContext, type MenuItem } from './types';

export function tabMenu(ctx: MenuContext, id: string): MenuItem[][] {
  const { platform } = ctx;
  const { sk } = menuKeys(platform);
  const groups: MenuItem[][] = [];
  const all = getState().tabs;
  const idx = all.findIndex((x) => x.id === id);
  groups.push([
    { label: $t('Neuer Tab'), key: sk('newTab'), run: newTab },
    ...(!all[idx]?.settings ? [{ label: $t('Tab duplizieren'), run: () => duplicateTab(id) }] : []),
  ]);
  groups.push([
    { label: $t('Tab schließen'), key: sk('closeTab'), run: () => closeTab(id) },
    ...(all.length > 1 ? [{ label: $t('Andere Tabs schließen'), run: () => closeOtherTabs(id) }] : []),
    ...(idx < all.length - 1 ? [{ label: $t('Tabs rechts davon schließen'), run: () => closeTabsRight(id) }] : []),
  ]);
  return groups;
}

export function columnsMenu(): MenuItem[][] {
  const groups: MenuItem[][] = [];
  const st = getState().settings;
  const col = (c: 'mtime' | 'size' | 'kind' | 'owner') => () =>
    updateSettings({ columns: { ...st.columns, [c]: !st.columns[c] } });
  // Same order as the columns. A creation date is missing on purpose: SFTP and FTP servers do not report one.
  groups.push([
    { label: $t('Geändert'), checked: st.columns.mtime, run: col('mtime') },
    { label: $t('Art'), checked: !!st.columns.kind, run: col('kind') },
    { label: $t('Rechte'), checked: st.showPerms, run: togglePermsColumn },
    { label: $t('Besitzer'), checked: !!st.columns.owner, run: col('owner') },
    { label: $t('Größe'), checked: st.columns.size, run: col('size') },
  ]);
  return groups;
}
