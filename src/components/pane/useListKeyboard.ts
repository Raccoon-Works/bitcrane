/**
 * Keyboard of the file list: arrows (by row, by tile, into and out of
 * folders), opening, going up, rename, delete, select all, preview and
 * type-to-select.
 */
import { useRef, type KeyboardEvent, type RefObject } from 'react';
import type { FileEntry, PaneSide, Platform } from '../../backend/types';
import {
  activateEntry,
  askDelete,
  clearPaneSelection,
  clickRow,
  goUp,
  isPackage,
  jumpTo,
  moveCursor,
  navigate,
  openDialog,
  selectAll,
  startRename,
  toggleExpand,
  toggleInspector,
  type PaneSelection,
} from '../../state/store';
import * as paths from '../../util/paths';

const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey;

export function useListKeyboard({
  side,
  listRef,
  entries,
  sel,
  renaming,
  icons,
  colView,
  openSet,
  path,
  platform,
}: {
  side: PaneSide;
  listRef: RefObject<HTMLDivElement | null>;
  entries: FileEntry[];
  sel: PaneSelection;
  /** A rename is in progress; its field handles the keys. */
  renaming: boolean;
  icons: boolean;
  colView: boolean;
  openSet: Set<string>;
  path: string;
  platform: Platform;
}) {
  const typeBuffer = useRef({ text: '', at: 0 });
  // Icons view: arrow keys move by row and column.
  const gridCols = () => {
    const el = listRef.current?.querySelector<HTMLElement>('.icon-grid');
    return el ? Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').length) : 1;
  };

  return (e: KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    const cur = entries[sel.cursor];
    if (e.key === 'ArrowDown' && !isMod(e) && !e.altKey) {
      e.preventDefault();
      moveCursor(side, icons ? gridCols() : 1, e.shiftKey);
      return;
    }
    if (e.key === 'ArrowUp' && !isMod(e) && !e.altKey) {
      e.preventDefault();
      moveCursor(side, icons ? -gridCols() : -1, e.shiftKey);
      return;
    }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !isMod(e) && !e.altKey) {
      e.preventDefault();
      const right = e.key === 'ArrowRight';
      if (icons) {
        moveCursor(side, right ? 1 : -1, e.shiftKey);
        return;
      }
      if (colView) {
        // Columns: ← goes to the folder above, → into the chosen folder (Finder).
        if (!right) goUp(side);
        else if (cur?.kind === 'dir' && !isPackage(side, cur)) {
          navigate(side, paths.join(path, cur.name));
          clickRow(side, 0, {});
        }
        return;
      }
      if (!cur) return;
      // List: → opens a folder in place, ← closes it or jumps to the folder around it (Finder).
      if (right && cur.kind === 'dir' && !isPackage(side, cur) && !openSet.has(cur.name)) toggleExpand(side, cur.name);
      else if (!right && cur.kind === 'dir' && openSet.has(cur.name)) toggleExpand(side, cur.name);
      else if (!right && cur.name.includes('/')) {
        const parentIndex = entries.findIndex((x) => x.name === cur.name.slice(0, cur.name.lastIndexOf('/')));
        if (parentIndex >= 0) clickRow(side, parentIndex, {});
      }
      return;
    }
    if ((e.key === 'ArrowUp' && (isMod(e) || e.altKey)) || (e.key === 'Backspace' && platform === 'win')) {
      e.preventDefault();
      goUp(side);
      return;
    }
    if (e.key === 'ArrowDown' && isMod(e) && !e.altKey) {
      e.preventDefault();
      if (cur) activateEntry(side, cur.name);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!cur) return;
      // Mac: Enter renames (Finder). Windows: Enter opens (Explorer).
      if (platform === 'mac') startRename(side, sel.names.length > 1 ? undefined : cur.name);
      else activateEntry(side, cur.name);
      return;
    }
    if (e.key === 'F2') {
      e.preventDefault();
      if (sel.names.length > 1) startRename(side);
      else if (cur) startRename(side, cur.name);
      return;
    }
    if ((e.key === 'Backspace' && isMod(e)) || e.key === 'Delete') {
      e.preventDefault();
      askDelete(side);
      return;
    }
    if (e.key.toLowerCase() === 'a' && isMod(e)) {
      e.preventDefault();
      selectAll(side);
      return;
    }
    // Space: preview of a file (like Quick Look); on a folder it shows the info column.
    if (e.key === ' ') {
      e.preventDefault();
      if (cur?.kind === 'file') openDialog({ type: 'preview', side });
      else toggleInspector();
      return;
    }
    if (e.key === 'Escape') {
      clearPaneSelection(side);
      return;
    }
    if (e.key.length === 1 && !isMod(e) && !e.altKey && /\S/.test(e.key)) {
      const nowMs = Date.now();
      const buf = nowMs - typeBuffer.current.at < 800 ? typeBuffer.current.text + e.key : e.key;
      typeBuffer.current = { text: buf, at: nowMs };
      jumpTo(side, buf);
    }
  };
}
