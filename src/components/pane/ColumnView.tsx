/**
 * Column view (Finder, ForkLift): the folder above, the folder shown, and what
 * the chosen folder holds (or the chosen file's size and date).
 */
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { CaretRight } from '@phosphor-icons/react';
import type { FileEntry, PaneSide } from '../../backend/types';
import {
  activateEntry,
  activeTab,
  clearPaneSelection,
  folderRows,
  isPackage,
  loadFolder,
  navigate,
  revealSearchResult,
  useStore,
} from '../../state/store';
import { formatDate, formatSize } from '../../util/format';
import * as paths from '../../util/paths';
import { FileGlyph, FolderGlyph } from '../icons';
import { $t } from '../../i18n';

export function ColumnView({
  side,
  path,
  entries,
  selected,
  listRef,
  children,
}: {
  side: PaneSide;
  path: string;
  entries: FileEntry[];
  /** Names selected in the folder shown. */
  selected: string[];
  listRef: RefObject<HTMLDivElement | null>;
  /** The rows of the folder shown. */
  children: ReactNode;
}) {
  const fsRev = useStore((s) => s.fsRev);
  const showHidden = useStore((s) => s.settings.showHidden);
  const sort = useStore((s) => s.settings.sort[side]);
  const serverId = useStore((s) => activeTab(s)?.serverId);
  const leftServerId = useStore((s) => activeTab(s)?.leftServerId);
  const parentDir = path && paths.parent(path) !== path ? paths.parent(path) : null;
  const chosen = selected.length === 1 ? entries.find((e) => e.name === selected[0]) : undefined;
  const childDir = chosen?.kind === 'dir' && !isPackage(side, chosen) ? paths.join(path, chosen.name) : null;
  const parentRows = useMemo(
    () => (parentDir ? folderRows(side, parentDir) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the listing is read from the store; these values say when it changed
    [side, parentDir, fsRev, showHidden, sort, serverId, leftServerId],
  );
  const childRows = useMemo(
    () => (childDir ? folderRows(side, childDir) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the listing is read from the store; these values say when it changed
    [side, childDir, fsRev, showHidden, sort, serverId, leftServerId],
  );
  useEffect(() => {
    if (parentDir) loadFolder(side, parentDir);
  }, [side, parentDir]);
  useEffect(() => {
    if (childDir) loadFolder(side, childDir);
  }, [side, childDir]);
  const parentColRef = useRef<HTMLDivElement>(null);
  // The folder shown stays in view in the column above it.
  useEffect(() => {
    parentColRef.current?.querySelector('.is-here')?.scrollIntoView({ block: 'nearest' });
  }, [parentDir, parentRows]);

  /** A row of the side columns: the folder above or the chosen folder's contents. */
  const sideRow = (e: FileEntry, here: boolean, onPick: () => void, onOpen: () => void) => (
    <div
      key={e.name}
      role="option"
      aria-selected={here}
      className={`row${here ? ' is-sel-inactive is-here' : ''}`}
      onMouseDown={(ev) => {
        if (ev.button === 0) {
          listRef.current?.focus({ preventScroll: true });
          onPick();
        }
      }}
      onDoubleClick={onOpen}
    >
      <span className="row-bar" />
      <span />
      {e.kind === 'dir' ? <FolderGlyph size={18} /> : <FileGlyph size={18} name={e.name} />}
      <span className="row-name">
        <span className="ellipsis">{e.name}</span>
      </span>
      {e.kind === 'dir' ? <CaretRight size={11} weight="bold" className="miller-caret" aria-hidden="true" /> : <span />}
    </div>
  );

  return (
    <div className="miller">
      {parentDir && (
        <div className="miller-col is-parent" ref={parentColRef} aria-label={$t('Übergeordneter Ordner')}>
          {(parentRows ?? []).map((e) =>
            sideRow(
              e,
              e.name === paths.basename(path),
              () => {
                if (e.kind === 'dir' && e.name !== paths.basename(path)) navigate(side, paths.join(parentDir, e.name));
                else if (e.kind === 'file') revealSearchResult(side, paths.join(parentDir, e.name));
              },
              () => activateEntry(side, e.name),
            ),
          )}
        </div>
      )}
      <div
        className="miller-col is-current"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) clearPaneSelection(side);
        }}
      >
        {children}
      </div>
      <div className="miller-col is-child">
        {childDir && childRows && childRows.length === 0 && (
          <div className="miller-empty small muted">{$t('Leer')}</div>
        )}
        {childDir &&
          (childRows ?? []).map((e) =>
            sideRow(
              e,
              false,
              () => revealSearchResult(side, paths.join(childDir, e.name)),
              () => {},
            ),
          )}
        {!childDir && chosen && (
          <div className="miller-empty small muted">
            {chosen.name}
            <span>
              {formatSize(chosen.size)} · {formatDate(chosen.mtime)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
