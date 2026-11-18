/**
 * Contents of the location menu of a half (the symbol at the left of its path
 * bar): this computer, favourites, drives, the servers used last, other
 * folders, and the server list. Pure, so the menu's structure is tested apart
 * from its texts and actions (ContextMenu.tsx).
 */
import type { PaneSide, Place, Server, Tab } from '../backend/types';

/** How many servers the menu offers; the server list has all of them. */
export const LOCATION_MENU_SERVERS = 5;

export type LocationMenuItem =
  | { kind: 'computer'; checked: boolean }
  | { kind: 'favorite'; place: Place; label: string }
  | { kind: 'drive'; place: Place; first: boolean }
  | { kind: 'server'; server: Server; checked: boolean }
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
  servers: Server[];
  show: { favorites: boolean; drives: boolean; servers: boolean };
}

/**
 * The servers used last, newest first, without `excludeId` (the server of the
 * other half, which cannot show in both). Quick connections count only while
 * they are open, as in the rest of the menu.
 */
export function recentServers(servers: Server[], excludeId: string, count = LOCATION_MENU_SERVERS): Server[] {
  return servers
    .filter((x) => x.lastUsed && (!x.temporary || x.online) && x.id !== excludeId)
    .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
    .slice(0, count);
}

/** The menu as groups between separators; groups without entries are left out. */
export function locationMenuGroups({
  side,
  tab,
  favorites,
  drives,
  servers,
  show,
}: LocationMenuInput): LocationMenuItem[][] {
  const left = side === 'local';
  const thisServer = (left ? tab.leftServerId : tab.serverId) ?? '';
  const otherServer = (left ? tab.serverId : tab.leftServerId) ?? '';
  // The right half shows this computer only when switched to it (two local halves).
  const onComputer = left ? !thisServer : !!tab.rightLocal && !thisServer;
  const groups: LocationMenuItem[][] = [
    [{ kind: 'computer', checked: onComputer }],
    show.favorites ? favorites.map((f) => ({ kind: 'favorite' as const, ...f })) : [],
    show.drives ? drives.map((place, i) => ({ kind: 'drive' as const, place, first: i === 0 })) : [],
    show.servers
      ? recentServers(servers, otherServer).map((server) => ({
          kind: 'server' as const,
          server,
          checked: server.id === thisServer,
        }))
      : [],
    // Choosing or typing a folder of this computer: the left half always, the right one while it shows this computer.
    left || onComputer ? [{ kind: 'otherFolder' }, { kind: 'enterPath' }] : [],
    [{ kind: 'serverList' }, ...(thisServer ? [{ kind: 'disconnect' as const }] : [])],
  ];
  return groups.filter((g) => g.length > 0);
}
