/**
 * Column header of the list: one sort button per shown column; a right click
 * opens the menu of the columns (Explorer).
 */
import { CaretDown, CaretUp, CaretUpDown } from '@phosphor-icons/react';
import type { PaneSide } from '../../backend/types';
import { setSort, setState, useStore, type SortKey } from '../../state/store';
import { $t } from '../../i18n';

export function ColumnHeader({ side }: { side: PaneSide }) {
  const columns = useStore((s) => s.settings.columns);
  const showPerms = useStore((s) => s.settings.showPerms);
  const sort = useStore((s) => s.settings.sort[side]);
  return (
    <div
      className="col-head"
      role="row"
      onContextMenu={(e) => {
        e.preventDefault();
        setState({ contextMenu: { x: e.clientX, y: e.clientY, side, names: [], kind: 'columns' } });
      }}
    >
      {(
        [
          ['name', $t('Name'), ''],
          ...(columns.mtime ? [['mtime', $t('Geändert'), '']] : []),
          ...(columns.kind ? [['kind', $t('Art'), '']] : []),
          ...(showPerms ? [['perms', $t('Rechte'), '']] : []),
          ...(columns.owner ? [['owner', $t('Besitzer'), '']] : []),
          ...(columns.size ? [['size', $t('Größe'), 'num']] : []),
        ] as Array<[SortKey, string, string]>
      ).map(([key, label, cls]) => (
        <button
          key={key}
          type="button"
          role="columnheader"
          className={`col-btn ${cls}${sort.key === key ? ' is-sorted' : ''}`}
          aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
          title={$t('Klicken zum Sortieren')}
          onClick={() => setSort(side, key)}
        >
          <span className="ellipsis">{label}</span>
          {/* Every column shows that it can sort: the active one with its direction, the others with a quiet double arrow. */}
          {sort.key === key ? (
            sort.dir === 1 ? (
              <CaretUp size={12} weight="bold" aria-hidden="true" />
            ) : (
              <CaretDown size={12} weight="bold" aria-hidden="true" />
            )
          ) : (
            <CaretUpDown size={12} weight="bold" className="col-sort-hint" aria-hidden="true" />
          )}
        </button>
      ))}
    </div>
  );
}
