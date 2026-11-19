/**
 * Right-click menus, built as plain data (entries in groups between
 * separators) so they can be tested apart from the drawing (ContextMenu.tsx).
 * Each menu shows only what fits the clicked thing (design rule: no
 * greyed-out items from later stages).
 */
import { columnsMenu, tabMenu } from './window';
import { entriesMenu, folderMenu, gitMenu } from './files';
import { crumbsMenu, paneSourceMenu, placeMenu, placesMoreMenu } from './places';
import { serverGroupMenu, serverMenu } from './servers';
import { sidebarPlaceMenu, sidebarRecentMenu, sidebarSectionMenu } from './sidebar';
import type { MenuContext, MenuItem } from './types';

export type { MenuContext, MenuIcon, MenuItem } from './types';

function groupsFor(ctx: MenuContext): MenuItem[][] {
  const { menu, tab } = ctx;
  switch (menu.kind) {
    case 'server':
      return menu.serverId ? serverMenu(ctx, menu.serverId) : [];
    case 'serverGroup':
      return menu.group ? serverGroupMenu(menu.group) : [];
    case 'git':
      return gitMenu(ctx);
    case 'crumbs':
      return crumbsMenu(ctx);
    case 'placesMore':
      return placesMoreMenu(ctx);
    case 'place':
      return menu.place ? placeMenu(ctx, menu.place) : [];
    case 'paneSource':
      return tab ? paneSourceMenu(ctx, tab) : [];
    case 'sidebarSection':
      return sidebarSectionMenu(ctx);
    case 'sidebarRecent':
      return menu.place ? sidebarRecentMenu(menu.place) : [];
    case 'sidebarPlace':
      return menu.place ? sidebarPlaceMenu(menu.place) : [];
    case 'tab':
      return menu.tabId ? tabMenu(ctx, menu.tabId) : [];
    case 'columns':
      return columnsMenu();
    default:
      return menu.names.length ? entriesMenu(ctx) : folderMenu(ctx);
  }
}

/** The menu's groups; groups left empty by conditions are dropped, so no double separators appear. */
export function contextMenuGroups(ctx: MenuContext): MenuItem[][] {
  return groupsFor(ctx).filter((g) => g.length > 0);
}
