/**
 * Context menus of the places bar, the path bar and the location button of a half.
 */
import { locationMenuGroups } from '../locationMenu';
import { crumbs } from '../../util/paths';
import {
  drivesOf,
  localPlaces,
  openLocalIn,
  placesFor,
  setLeftServer,
  setRightLocal,
  setPaneServerList,
  closePaneServer,
  removePlace,
  navigate,
  pickLocalFolder,
  editPath,
  getState,
  panePath,
} from '../store';
import { $t } from '../../i18n';
import { driveLabel, favoriteLabels, placeLabel } from '../../util/placeLabel';
import { menuKeys, type MenuContext, type MenuItem } from './types';
import type { Tab } from '../../backend/types';

export function crumbsMenu(ctx: MenuContext): MenuItem[][] {
  const { menu } = ctx;
  const groups: MenuItem[][] = [];
  // Parent folders not shown in the path bar, nearest first.
  const all = crumbs(panePath(menu.side), getState().homeName);
  // From the "…" button: the folders not shown; from the folder name: all folders above it.
  const hidden = menu.place?.startsWith('h:') ? Number(menu.place.slice(2)) : all.length - 3;
  groups.push(
    all
      .slice(0, menu.place === 'all' ? -1 : hidden)
      .reverse()
      .map((c) => ({ label: c.name, run: () => navigate(menu.side, c.path) })),
  );
  return groups;
}

export function placesMoreMenu(ctx: MenuContext): MenuItem[][] {
  const { menu } = ctx;
  const groups: MenuItem[][] = [];
  // Places that do not fit into the places bar ("»" at its end); place = number shown.
  const shown = Number(menu.place ?? 0);
  groups.push(
    placesFor(menu.side)
      .slice(shown)
      .map((p) => ({ label: placeLabel(p), run: () => navigate(menu.side, p.path) })),
  );
  return groups;
}

export function placeMenu(ctx: MenuContext, path: string): MenuItem[][] {
  const { menu } = ctx;
  const groups: MenuItem[][] = [];
  groups.push([
    { label: $t('Öffnen'), run: () => navigate(menu.side, path) },
    { label: $t('Pfad kopieren'), run: () => void navigator.clipboard.writeText(path) },
  ]);
  groups.push([{ label: $t('Aus der Ortsleiste entfernen'), danger: true, run: () => removePlace(menu.side, path) }]);
  return groups;
}

export function paneSourceMenu(ctx: MenuContext, tab: Tab): MenuItem[][] {
  const { menu, platform } = ctx;
  const { sk } = menuKeys(platform);
  const groups: MenuItem[][] = [];
  // The location button of a half: this computer, its favourites and drives; servers through the server list.
  const side = menu.side;
  const st = getState();
  const mac = platform === 'mac';
  for (const g of locationMenuGroups({
    side,
    tab,
    favorites: favoriteLabels(localPlaces(st)),
    drives: drivesOf(st),
    show: {
      favorites: st.settings.locationMenuFavorites,
      drives: st.settings.locationMenuDrives,
    },
  }))
    groups.push(
      g.map((it): MenuItem => {
        switch (it.kind) {
          case 'computer':
            return {
              label: mac ? $t('Dieser Mac') : $t('Dieser PC'),
              icon: { kind: 'computer' },
              checked: it.checked,
              run: () => (side === 'local' ? setLeftServer('') : setRightLocal()),
            };
          case 'favorite':
            return {
              label: it.label,
              icon: { kind: 'place', place: it.place },
              run: () => openLocalIn(side, it.place.path),
            };
          case 'drive':
            return {
              label: driveLabel(it.place, mac),
              icon: { kind: 'drive', place: it.place, first: it.first },
              run: () => openLocalIn(side, it.place.path),
            };
          case 'otherFolder':
            return { label: $t('Anderer Ordner …'), run: () => void pickLocalFolder(side) };
          case 'enterPath':
            return { label: $t('Pfad eingeben …'), key: sk('editPath'), run: () => editPath(side) };
          case 'serverList':
            return { label: $t('Serverliste zeigen'), run: () => setPaneServerList(side, true) };
          case 'disconnect':
            return { label: $t('Trennen'), run: () => closePaneServer(side) };
        }
      }),
    );
  return groups;
}
