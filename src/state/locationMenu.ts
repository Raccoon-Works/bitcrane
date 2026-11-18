/**
 * Contents of the location menu of a half (the symbol at the left of its path
 * bar): this computer, favourites, drives, other folders, and the server
 * list. Servers are chosen through the server list only, which keeps the menu short. Pure, so the menu's structure is tested apart
 * from its texts and actions (ContextMenu.tsx).
 */
import type { PaneSide, Place, Tab } from '../backend/types';

export type LocationMenuItem =
  | { kind: 'computer'; checked: boolean }
  | { kind: 'favorite'; place: Place; label: string }
  | { kind: 'drive'; place: Place; first: boolean }
  | { kind: 'otherFolder' }
  | { kind: 'enterPath' }
  | { kind: 'serverList' }
  | { kind: 'disconnect' };

export interface LocationMenuInput {
  side: PaneSide;
  tab: Pick<Tab, 'serverId' | 'leftServerId' | 'rightLocal'>;
  /** Favourites of this computer with their shown names (see favoriteLabels). */
  favorites: Array<{ place: Place; label: string }>;
  drives: Place[];
  show: { favorites: boolean; drives: boolean };
}

/** The menu as groups between separators; groups without entries are left out. */
export function locationMenuGroups({ side, tab, favorites, drives, show }: LocationMenuInput): LocationMenuItem[][] {
  const left = side === 'local';
  const thisServer = (left ? tab.leftServerId : tab.serverId) ?? '';
  // The right half shows this computer only when switched to it (two local halves).
  const onComputer = left ? !thisServer : !!tab.rightLocal && !thisServer;
  const groups: LocationMenuItem[][] = [
    [{ kind: 'computer', checked: onComputer }],
    show.favorites ? favorites.map((f) => ({ kind: 'favorite' as const, ...f })) : [],
    show.drives ? drives.map((place, i) => ({ kind: 'drive' as const, place, first: i === 0 })) : [],
    // Choosing or typing a folder of this computer: the left half always, the right one while it shows this computer.
    left || onComputer ? [{ kind: 'otherFolder' }, { kind: 'enterPath' }] : [],
    [{ kind: 'serverList' }, ...(thisServer ? [{ kind: 'disconnect' as const }] : [])],
  ];
  return groups.filter((g) => g.length > 0);
}
