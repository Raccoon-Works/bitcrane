/**
 * The sidebar's sections: their order, collapsed and hidden ones (Settings > Darstellung),
 * and what the favourites and shares need from the system.
 */
import type { NetworkHost } from '../backend/api';
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { AppState, SidebarSection } from './appState';
import { getState, LIVE, setState } from './core';
import { DEMO_NETWORK_HOSTS } from './demoData';
import { updateSettings } from './settings';

/** Sections of the sidebar in their default order. */
export const SIDEBAR_SECTIONS: SidebarSection[] = ['favorites', 'recent', 'devices', 'shares', 'tags'];

/** Sidebar sections in the user's order (new sections are added at their default place). */
export function sidebarOrder(
  savedOrder: AppState['settings']['sidebarOrder'] = getState().settings.sidebarOrder,
): SidebarSection[] {
  const saved = (savedOrder ?? []).filter((x) => SIDEBAR_SECTIONS.includes(x));
  const missing = SIDEBAR_SECTIONS.filter((x) => !saved.includes(x));
  return [...saved, ...missing];
}

/** Moves a sidebar section before another one (null: to the end). */
export function moveSidebarSection(id: SidebarSection, before: SidebarSection | null) {
  const rest = sidebarOrder().filter((x) => x !== id);
  const i = before === null ? rest.length : Math.max(0, rest.indexOf(before));
  updateSettings({ sidebarOrder: [...rest.slice(0, i), id, ...rest.slice(i)] });
}

/** Folds or unfolds a sidebar section. */
export function toggleSidebarCollapsed(id: SidebarSection) {
  const cur = getState().settings.sidebarCollapsed ?? [];
  updateSettings({ sidebarCollapsed: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
}

/** Shows or hides a sidebar section. */
export function toggleSidebarHidden(id: SidebarSection) {
  const cur = getState().settings.sidebarHidden ?? [];
  updateSettings({ sidebarHidden: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  setState({ contextMenu: null });
}

/** Real target of each folder (links resolved), in the same order; the prototype has no links. */
export function realPaths(paths: string[]): Promise<string[]> {
  return LIVE ? backend.localRealPaths(paths) : Promise.resolve(paths);
}

/** Computers in the network with file shares (Bonjour). */
export function findNetworkHosts(): Promise<NetworkHost[]> {
  return LIVE ? backend.networkHosts() : Promise.resolve(DEMO_NETWORK_HOSTS);
}
