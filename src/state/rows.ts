/**
 * Rows of a half: which entries show, in which order (sorting, hidden files, folders opened in
 * place), the view mode and icon size.
 */
import * as live from './live';
import type { FileEntry, PaneSide } from '../backend/types';
import { describeFile } from '../util/format';
import * as paths from '../util/paths';
import type { AppState, SortKey, ViewMode } from './appState';
import { activeTab, getState, LIVE, listEntries, paneLoc, panePath, paneShowsServers, setState } from './core';

/** The settings that decide which entries of a folder are shown, and in which order. */
export interface RowView {
  showHidden: boolean;
  showSystem?: boolean;
  sort: AppState['settings']['sort'][PaneSide];
}

/** The row settings of a half. */
export function rowView(side: PaneSide, s: AppState = getState()): RowView {
  return { showHidden: s.settings.showHidden, showSystem: s.settings.showSystem, sort: s.settings.sort[side] };
}

/**
 * Entries of a folder as a half shows them: protected system items (e.g. Windows' old
 * "Anwendungsdaten" junctions) stay out like in Explorer, dot files and items marked hidden
 * follow "Versteckte Dateien zeigen", then sorted.
 */
function visibleRows(list: FileEntry[], view: RowView): FileEntry[] {
  let rows = list;
  if (!view.showSystem) rows = rows.filter((e) => (e.hidden ?? 0) < 2);
  if (!view.showHidden) rows = rows.filter((e) => !e.name.startsWith('.') && !e.hidden);
  return sortEntries(rows, view.sort);
}

/**
 * Entries of any folder of a half, filtered and sorted like the half itself
 * (column view: the folder above and the folder chosen). Undefined until read.
 */
export function folderRows(
  loc: [PaneSide, string],
  dir: string,
  view: RowView,
  list: typeof listEntries = listEntries,
): FileEntry[] | undefined {
  const entries = list(...loc, dir);
  return entries && visibleRows(entries, view);
}

/** Reads a folder of a half when it is not cached yet (call from effects, not while rendering). */
export function loadFolder(side: PaneSide, dir: string) {
  const t = activeTab();
  if (t && LIVE) live.requestListing(...paneLoc(side, t), dir);
}

/**
 * Rows of a pane: the folder's entries, sorted and filtered (hidden files, the
 * search), and below each opened folder (triangle in the list) its entries
 * indented. Rows of opened folders carry their path relative to the folder
 * shown as `name` (e.g. "routes/cart.py") and their nesting level as `depth`.
 */
export function paneEntries(side: PaneSide, s: AppState = getState()): FileEntry[] {
  const t = activeTab(s);
  if (!t || paneShowsServers(side, t)) return [];
  return paneRows({
    loc: paneLoc(side, t),
    base: panePath(side, s),
    opened: s.settings.viewMode[side] === 'list' ? s.expanded[side] : [],
    search: s.searchSide === side ? s.search : '',
    view: rowView(side, s),
  });
}

/** What decides the rows of a half that shows files, besides the listings. */
export interface PaneRowsInput {
  loc: [PaneSide, string];
  /** The folder shown. */
  base: string;
  /** Folders opened in place (list view), relative to `base`. */
  opened: string[];
  /** The search of this half, as typed. */
  search: string;
  view: RowView;
}

/** The rows of `paneEntries`, from explicit inputs (the half's component subscribes to them). */
export function paneRows(input: PaneRowsInput, list: typeof listEntries = listEntries): FileEntry[] {
  const { loc, base, view } = input;
  const open = new Set(input.opened);
  const q = input.search.trim().toLowerCase();
  const level = (rel: string, depth: number): FileEntry[] => {
    const rows = folderRows(loc, rel ? paths.join(base, rel) : base, view, list) ?? [];
    const out: FileEntry[] = [];
    for (const e of rows) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      const opened = e.kind === 'dir' && open.has(name);
      // The search filter shows matching rows and keeps opened folders with matches inside.
      const inner = opened ? level(name, depth + 1) : [];
      if (!q || e.name.toLowerCase().includes(q) || inner.length) out.push({ ...e, name, depth }, ...inner);
    }
    return out;
  };
  return level('', 0);
}

/** Opens or closes a folder in place (triangle in the list view). */
export function toggleExpand(side: PaneSide, rel: string) {
  const t = activeTab();
  if (!t) return;
  const cur = getState().expanded[side];
  const open = cur.includes(rel);
  // Closing a folder also closes the folders inside it.
  const next = open ? cur.filter((x) => x !== rel && !x.startsWith(`${rel}/`)) : [...cur, rel];
  setState((s) => ({ expanded: { ...s.expanded, [side]: next } }));
  if (!open && LIVE) live.requestListing(...paneLoc(side, t), paths.join(panePath(side), rel));
}

/** Switches a half between list, icons and columns. */
export function setViewMode(side: PaneSide, mode: ViewMode) {
  setState((s) => ({ settings: { ...s.settings, viewMode: { ...s.settings.viewMode, [side]: mode } } }));
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/** Kind of an entry for the "Art" column ("Ordner", "PNG-Bild" …). */
export const kindOf = (e: FileEntry) => describeFile(e.name.slice(e.name.lastIndexOf('/') + 1), e.kind);

/** Sorts a listing; folders always come first, names break ties. */
function sortEntries(list: FileEntry[], order: { key: SortKey; dir: 1 | -1 }): FileEntry[] {
  const byName = (a: FileEntry, b: FileEntry) => collator.compare(a.name.replace(/^\./, ''), b.name.replace(/^\./, ''));
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    let c = 0;
    if (order.key === 'mtime') c = a.mtime - b.mtime;
    else if (order.key === 'size') c = a.size - b.size;
    else if (order.key === 'perms') c = a.perms.localeCompare(b.perms);
    else if (order.key === 'kind') c = collator.compare(kindOf(a), kindOf(b));
    else if (order.key === 'owner') c = collator.compare(a.owner ?? '', b.owner ?? '');
    return (c || byName(a, b)) * order.dir;
  });
}

/** Click on a column header: sort by it, a second click reverses. */
export function setSort(side: PaneSide, key: SortKey) {
  setState((s) => {
    const cur = s.settings.sort[side];
    const next = { key, dir: (cur.key === key ? -cur.dir : key === 'name' ? 1 : -1) as 1 | -1 };
    return { settings: { ...s.settings, sort: { ...s.settings.sort, [side]: next } } };
  });
}

/** Icons view: one size step larger or smaller (slider, Strg + mouse wheel). */
export function setIconSize(side: PaneSide, step: number) {
  const v = Math.max(0, Math.min(3, Math.round(step)));
  setState((s) => ({ settings: { ...s.settings, iconSize: { ...s.settings.iconSize, [side]: v } } }));
}
