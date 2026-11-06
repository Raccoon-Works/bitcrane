/**
 * Selection in the file lists.
 */

import type { PaneSide } from '../backend/types';

import { state, setState, paneEntries } from './core';
import { updateSettings } from './settings';

export function setFocusSide(side: PaneSide) {
  if (state.focusSide !== side) setState({ focusSide: side });
}

/** Makes the other half the active one; with "Nur eine Hälfte" that also shows it. */
export function focusOtherHalf() {
  setFocusSide(state.focusSide === 'local' ? 'remote' : 'local');
}

/** "Nur eine Hälfte": shows only the active half, or both again. */
export function toggleSingleHalf() {
  updateSettings({ singleHalf: !state.settings.singleHalf });
}

/** Mouse click on a row with optional modifier keys. */
export function clickRow(side: PaneSide, index: number, mod: { shift?: boolean; toggle?: boolean }) {
  const entries = paneEntries(side);
  const entry = entries[index];
  if (!entry) return;
  const sel = state.selection[side];
  let names: string[];
  let anchor = sel.anchor;
  if (mod.shift && sel.anchor >= 0) {
    const [a, b] = [Math.min(sel.anchor, index), Math.max(sel.anchor, index)];
    names = entries.slice(a, b + 1).map((e) => e.name);
  } else if (mod.toggle) {
    names = sel.names.includes(entry.name) ? sel.names.filter((n) => n !== entry.name) : [...sel.names, entry.name];
    anchor = index;
  } else {
    names = [entry.name];
    anchor = index;
  }
  setState((s) => ({ focusSide: side, selection: { ...s.selection, [side]: { names, cursor: index, anchor } }, renaming: null }));
}

export function clearPaneSelection(side: PaneSide) {
  setState((s) => ({ focusSide: side, selection: { ...s.selection, [side]: { names: [], cursor: -1, anchor: -1 } } }));
}

/** Arrow-key movement in the focused pane. */
export function moveCursor(side: PaneSide, delta: number, extend: boolean) {
  const entries = paneEntries(side);
  if (!entries.length) return;
  const sel = state.selection[side];
  const cursor = Math.max(0, Math.min(entries.length - 1, (sel.cursor < 0 ? (delta > 0 ? -1 : entries.length) : sel.cursor) + delta));
  if (extend && sel.anchor >= 0) {
    const [a, b] = [Math.min(sel.anchor, cursor), Math.max(sel.anchor, cursor)];
    setState((s) => ({ selection: { ...s.selection, [side]: { names: entries.slice(a, b + 1).map((e) => e.name), cursor, anchor: sel.anchor } } }));
  } else {
    setState((s) => ({ selection: { ...s.selection, [side]: { names: [entries[cursor].name], cursor, anchor: cursor } } }));
  }
}

/** Einfg (Commander keys): selects or deselects the entry under the cursor and moves on to the next. */
export function toggleAtCursor(side: PaneSide = state.focusSide) {
  const entries = paneEntries(side);
  const sel = state.selection[side];
  const entry = entries[sel.cursor];
  if (!entry) return;
  const names = sel.names.includes(entry.name) ? sel.names.filter((n) => n !== entry.name) : [...sel.names, entry.name];
  const cursor = Math.min(entries.length - 1, sel.cursor + 1);
  setState((s) => ({ selection: { ...s.selection, [side]: { names, cursor, anchor: cursor } } }));
}

export function selectAll(side: PaneSide) {
  const entries = paneEntries(side);
  setState((s) => ({ selection: { ...s.selection, [side]: { names: entries.map((e) => e.name), cursor: s.selection[side].cursor, anchor: 0 } } }));
}

/** Type-to-select: jumps to the first entry starting with the typed text. */
export function jumpTo(side: PaneSide, prefix: string) {
  const entries = paneEntries(side);
  const idx = entries.findIndex((e) => e.name.toLowerCase().replace(/^\./, '').startsWith(prefix.toLowerCase()));
  if (idx >= 0) setState((s) => ({ selection: { ...s.selection, [side]: { names: [entries[idx].name], cursor: idx, anchor: idx } } }));
}
