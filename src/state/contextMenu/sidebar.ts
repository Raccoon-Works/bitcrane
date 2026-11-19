/**
 * Context menus of the sidebar: its sections, recent folders and favourites.
 */
import {
  localPlaces,
  editLocalPlaces,
  SIDEBAR_SECTIONS,
  toggleSidebarHidden,
  type SidebarSection,
  openPlace,
  removeRecent,
  clearRecent,
  addLocalPlace,
  getState,
  updateSettings,
  setState,
} from '../store';
import { $t } from '../../i18n';
import type { MenuContext, MenuItem } from './types';

export function sidebarSectionMenu(ctx: MenuContext): MenuItem[][] {
  const { platform } = ctx;
  const groups: MenuItem[][] = [];
  // Which sections the sidebar shows (Finder: Settings > Sidebar), and the default order.
  const st = getState().settings;
  const hiddenNow = st.sidebarHidden ?? [];
  const names: Record<SidebarSection, string> = {
    favorites: $t('Favoriten'),
    recent: $t('Zuletzt verwendet'),
    devices: $t('Geräte'),
    shares: $t('Freigaben'),
    tags: $t('Tags'),
  };
  groups.push(
    SIDEBAR_SECTIONS.filter((id) => id !== 'tags' || platform === 'mac').map((id) => ({
      label: names[id],
      checked: !hiddenNow.includes(id),
      run: () => toggleSidebarHidden(id),
    })),
  );
  groups.push([
    { label: $t('Alle Bereiche aufklappen'), run: () => updateSettings({ sidebarCollapsed: [] }) },
    { label: $t('Reihenfolge zurücksetzen'), run: () => updateSettings({ sidebarOrder: [] }) },
  ]);
  return groups;
}

export function sidebarRecentMenu(path: string): MenuItem[][] {
  const groups: MenuItem[][] = [];
  // A recently used folder in the sidebar.
  groups.push([
    { label: $t('Öffnen'), run: () => openPlace(path) },
    { label: $t('Pfad kopieren'), run: () => void navigator.clipboard.writeText(path) },
    {
      label: $t('Zu den Favoriten hinzufügen'),
      run: () => {
        addLocalPlace(path);
        setState({ contextMenu: null });
      },
    },
  ]);
  groups.push([
    { label: $t('Aus „Zuletzt verwendet“ entfernen'), run: () => removeRecent(path) },
    { label: $t('Liste leeren'), run: () => clearRecent() },
  ]);
  return groups;
}

export function sidebarPlaceMenu(path: string): MenuItem[][] {
  const groups: MenuItem[][] = [];
  // A favourite in the sidebar.
  const list = localPlaces();
  const i = list.findIndex((p) => p.path === path);
  groups.push([
    { label: $t('Öffnen'), run: () => openPlace(path) },
    { label: $t('Pfad kopieren'), run: () => void navigator.clipboard.writeText(path) },
  ]);
  groups.push([
    ...(i > 0 ? [{ label: $t('Nach oben'), run: () => editLocalPlaces(path, { before: list[i - 1].path }) }] : []),
    ...(i >= 0 && i < list.length - 1
      ? [{ label: $t('Nach unten'), run: () => editLocalPlaces(path, { before: list[i + 2]?.path ?? null }) }]
      : []),
  ]);
  groups.push([
    { label: $t('Aus den Favoriten entfernen'), danger: true, run: () => editLocalPlaces(path, { remove: true }) },
  ]);
  return groups;
}
