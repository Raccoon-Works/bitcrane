/**
 * Rows of the file list: one file or folder (a row of the list or column
 * view, a tile of the icons view) and the ".." row to the folder above.
 */
import type { CSSProperties, RefObject } from 'react';
import { ArrowElbowLeftUp, CaretRight } from '@phosphor-icons/react';
import type { GitStatus, Tag } from '../../backend/api';
import type { FileEntry, PaneSide } from '../../backend/types';
import {
  activateEntry,
  clearPaneSelection,
  clickRow,
  folderSizeKey,
  goUp,
  isPackage,
  kindOf,
  setState,
  toggleExpand,
  type PaneSelection,
  type Settings,
} from '../../state/store';
import { GIT_LABEL, gitMark } from '../../state/git';
import { tagCss } from '../../state/tags';
import type { CompareMark } from '../../state/tools';
import { beginRowDrag } from '../../util/dragDrop';
import { formatDate, formatSize, permsToText } from '../../util/format';
import * as paths from '../../util/paths';
import { typeIconFor } from '../fileTypes';
import { CornerDownRight } from '../glyphs';
import { FileGlyph, FolderGlyph, PackageGlyph } from '../icons';
import { Thumb } from '../Thumb';
import { $t } from '../../i18n';
import { RenameInput } from './RenameInput';

/** Symbol size of the icons view per size step. */
const ICON_PX = [48, 72, 100, 136];

/** What every row of a half needs to know about the half; built once per render of the pane. */
export interface ItemContext {
  side: PaneSide;
  /** Where the files are, as [side for file operations, server id] (see paneLoc). */
  ls: PaneSide;
  sid: string;
  path: string;
  sel: PaneSelection;
  focused: boolean;
  dropHint: string | null;
  marks: Map<string, CompareMark> | null;
  renaming: { side: PaneSide; name: string } | null;
  /** Names in the paired folder of the other half ("nur Server" tags), when the halves are paired. */
  otherNames: Set<string> | null;
  /** Top-level names being uploaded or downloaded. */
  busy: Set<string>;
  /** Folders opened in place in the list. */
  openSet: Set<string>;
  /** This computer on a Mac: names are shown the Finder's way. */
  macLocal: boolean;
  offline: boolean;
  icons: boolean;
  colView: boolean;
  iconStep: number;
  columns: Settings['columns'];
  showPerms: boolean;
  folderSizes: Record<string, number>;
  tags: Record<string, Tag[]> | null;
  git: GitStatus | null;
  /** Server to server: transfers go between two servers. */
  serverToServer: boolean;
  listRef: RefObject<HTMLDivElement | null>;
}

const markLabel = (): Record<CompareMark, string> => ({
  only: $t('fehlt drüben'),
  newer: $t('neuer'),
  older: $t('älter'),
  size: $t('andere Größe'),
});

function rowClass(ctx: ItemContext, entry: FileEntry, index: number) {
  const { sel, focused, dropHint, marks } = ctx;
  const selected = sel.names.includes(entry.name);
  return [
    'row',
    selected ? (focused ? 'is-sel' : 'is-sel-inactive') : '',
    selected && focused && sel.cursor === index ? 'is-cursor' : '',
    dropHint === entry.name ? 'is-drop' : '',
    marks && (entry.depth ?? 0) === 0 && marks.get(entry.name) ? `cmp-${marks.get(entry.name)}` : '',
  ].join(' ');
}

/** One file or folder: a row of the list, or a tile of the icons view. */
export function FileItem({ ctx, entry, index }: { ctx: ItemContext; entry: FileEntry; index: number }) {
  const { side, ls, sid, path, sel, marks, renaming, otherNames, busy, openSet, macLocal, offline, icons, colView } =
    ctx;
  const { iconStep, columns, showPerms, folderSizes, tags, git, listRef } = ctx;
  const isRenaming = renaming?.side === side && renaming.name === entry.name;
  const depth = entry.depth ?? 0;
  const onlyHere = depth === 0 && side === 'remote' && otherNames && !otherNames.has(entry.name);
  const isBusy = depth === 0 && busy.has(entry.name);
  const label = entry.name.slice(entry.name.lastIndexOf('/') + 1);
  const isOpen = openSet.has(entry.name);
  // Packages (apps, libraries) look and open like files, as in the Finder.
  const pkg = entry.kind === 'dir' && isPackage(side, entry);
  const dirLike = entry.kind === 'dir' && !pkg;
  // The Finder hides ".app" of programs and ".localized" of system folders; so does Bitcrane (display only).
  const shown = macLocal
    ? pkg
      ? label.replace(/\.app$/i, '')
      : entry.kind === 'dir'
        ? label.replace(/\.localized$/i, '')
        : label
    : label;
  const props = {
    role: 'option',
    'aria-selected': sel.names.includes(entry.name),
    'data-index': index,
    'data-dir': dirLike,
    'data-name': entry.name,
    title: icons ? label : undefined,
    onPointerDown: (e: React.PointerEvent) => {
      if (isRenaming || offline || e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
      if ((e.target as HTMLElement).closest('.disclosure')) return;
      beginRowDrag(e, side, sel.names.includes(entry.name) ? sel.names : [entry.name]);
    },
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.disclosure')) return;
      listRef.current?.focus({ preventScroll: true });
      clickRow(side, index, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey });
    },
    onDoubleClick: (e: React.MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.disclosure')) activateEntry(side, entry.name);
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      listRef.current?.focus({ preventScroll: true });
      const names = sel.names.includes(entry.name) ? sel.names : [entry.name];
      if (!sel.names.includes(entry.name)) clickRow(side, index, {});
      setState({ contextMenu: { x: e.clientX, y: e.clientY, side, names } });
    },
  } as const;
  const nameEl = isRenaming ? (
    <RenameInput side={side} name={entry.name} />
  ) : (
    <span className={icons ? 'tile-name' : 'ellipsis'} title={shown !== label ? label : undefined}>
      {shown}
    </span>
  );
  const link = entry.link !== undefined && !isRenaming && (
    <span
      className="link-mark"
      title={$t('Verknüpfung auf {0}', entry.link || $t('ein Ziel, das es nicht mehr gibt'))}
      aria-label={$t('Verknüpfung')}
    >
      <CornerDownRight size={11} strokeWidth={2} />
    </span>
  );
  const busyTag = isBusy && (
    <span className="tag tag-accent">
      {ctx.serverToServer ? $t('wird übertragen') : side === 'local' ? $t('lädt hoch') : $t('lädt herunter')}
    </span>
  );
  if (icons) {
    const ext =
      entry.kind === 'file' && !typeIconFor(label) && label.includes('.')
        ? label
            .slice(label.lastIndexOf('.') + 1)
            .slice(0, 4)
            .toUpperCase()
        : '';
    return (
      <div {...props} className={rowClass(ctx, entry, index).replace('row', 'tile')}>
        <span className="tile-icon">
          {dirLike ? (
            <FolderGlyph size={ICON_PX[iconStep]} />
          ) : entry.kind === 'dir' ? (
            <PackageGlyph size={ICON_PX[iconStep]} path={paths.join(path, entry.name)} name={label} />
          ) : (
            <Thumb
              side={ls}
              serverId={sid}
              path={paths.join(path, entry.name)}
              name={label}
              bytes={entry.size}
              mtime={entry.mtime}
              size={ICON_PX[iconStep]}
            />
          )}
          {ext && (
            <span className="tile-ext" aria-hidden="true">
              {ext}
            </span>
          )}
          {link}
        </span>
        {nameEl}
        {busyTag}
      </div>
    );
  }
  const mark = marks && depth === 0 ? marks.get(entry.name) : undefined;
  const gitState = gitMark(git, path, entry.name, entry.kind === 'dir');
  const folderSize =
    entry.kind === 'dir' ? folderSizes[folderSizeKey(ls, sid, `${path === '/' ? '' : path}/${entry.name}`)] : undefined;
  return (
    <div {...props} className={rowClass(ctx, entry, index)} style={{ '--depth': depth } as CSSProperties}>
      <span className="row-bar" />
      {dirLike && !colView ? (
        <button
          type="button"
          tabIndex={-1}
          className={`disclosure${isOpen ? ' is-open' : ''}`}
          aria-label={isOpen ? $t('„{0}“ zuklappen', label) : $t('„{0}“ aufklappen', label)}
          aria-expanded={isOpen}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpand(side, entry.name);
          }}
        >
          <CaretRight size={13} weight="bold" aria-hidden="true" />
        </button>
      ) : (
        <span />
      )}
      {dirLike ? (
        <FolderGlyph size={20} />
      ) : entry.kind === 'dir' ? (
        <PackageGlyph size={20} path={paths.join(path, entry.name)} name={label} />
      ) : (
        <FileGlyph size={20} name={label} />
      )}
      <span className="row-name">
        {nameEl}
        {link}
        {busyTag}
        {onlyHere && !marks && <span className="tag">{$t('nur Server')}</span>}
        {tags?.[entry.name] && (
          <span className="tag-dots" title={tags[entry.name].map((t) => t.name).join(', ')}>
            {tags[entry.name].map((t) => (
              <span key={t.name} className="tag-dot" style={{ background: tagCss(t.color) }} />
            ))}
          </span>
        )}
        {gitState ? (
          <span
            className={`git-mark git-${gitState === '?' ? 'new' : gitState === '•' ? 'dir' : gitState}`}
            title={`Git: ${GIT_LABEL[gitState] ?? gitState}`}
          >
            {gitState === '•' ? '' : gitState}
          </span>
        ) : null}
        {mark && <span className={`tag cmp-tag is-${mark}`}>{markLabel()[mark]}</span>}
      </span>
      {colView &&
        (dirLike ? <CaretRight size={11} weight="bold" className="miller-caret" aria-hidden="true" /> : <span />)}
      {!colView && columns.mtime && <span className="row-sub nowrap">{formatDate(entry.mtime)}</span>}
      {!colView && columns.kind && <span className="row-sub ellipsis">{kindOf(entry)}</span>}
      {!colView && showPerms && (
        <span className="row-sub mono perms-cell">{entry.perms ? permsToText(entry.perms) : ''}</span>
      )}
      {!colView && columns.owner && <span className="row-sub ellipsis">{entry.owner || '–'}</span>}
      {!colView && columns.size && (
        <span className="row-sub num">
          {entry.kind === 'dir' ? (folderSize !== undefined ? formatSize(folderSize) : '–') : formatSize(entry.size)}
        </span>
      )}
    </div>
  );
}

/** ".." to the folder above (WinSCP, Total Commander). */
export function ParentRow({ side, listRef }: { side: PaneSide; listRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div
      role="option"
      aria-selected={false}
      className="row parent-row"
      title={$t('Übergeordneter Ordner (Doppelklick)')}
      onMouseDown={(e) => {
        if (e.button === 0) {
          listRef.current?.focus({ preventScroll: true });
          clearPaneSelection(side);
        }
      }}
      onDoubleClick={() => goUp(side)}
    >
      <span className="row-bar" />
      <span />
      <span className="parent-glyph">
        <ArrowElbowLeftUp size={16} weight="bold" aria-hidden="true" />
      </span>
      <span className="row-name">
        <span className="ellipsis">..</span>
      </span>
    </div>
  );
}
