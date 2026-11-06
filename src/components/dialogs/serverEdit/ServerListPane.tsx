/**
 * Left side of the server editor: the saved servers by group with a search,
 * the entry being created, and the buttons for a new server, group or import.
 */
import { useMemo, useState } from 'react';
import { FolderPlus, Plus, Search } from '../../glyphs';
import type { Server } from '../../../backend/types';
import { openDialog } from '../../../state/store';
import { ServerTile } from '../../ServerTile';
import { Button } from '../../ui';
import { $t } from '../../../i18n';

export function ServerListPane({
  servers,
  currentId,
  draft,
  isNew,
  onPick,
  onNew,
}: {
  servers: Server[];
  currentId: string | undefined;
  draft: Server;
  isNew: boolean;
  onPick: (server: Server) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.toLowerCase();
    const list = servers.filter((x) => !q || x.name.toLowerCase().includes(q) || x.host.toLowerCase().includes(q));
    const map = new Map<string, Server[]>();
    for (const x of list) map.set(x.group || $t('Ohne Gruppe'), [...(map.get(x.group || $t('Ohne Gruppe')) ?? []), x]);
    return [...map.entries()];
  }, [servers, query]);

  return (
    <div className="split-list">
      <label className="search small-search">
        <Search size={13} strokeWidth={1.5} aria-hidden="true" />
        <span className="vh">{$t('Server suchen')}</span>
        <input
          type="search"
          placeholder={$t('Server suchen')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="split-scroll" role="listbox" aria-label={$t('Gespeicherte Server')}>
        {groups.map(([g, list]) => (
          <div key={g} className="split-group">
            <span className="side-title">{g}</span>
            {list.map((x) => (
              <button
                key={x.id}
                type="button"
                role="option"
                aria-selected={x.id === currentId}
                className={`split-item${x.id === currentId ? ' is-sel' : ''}`}
                onClick={() => onPick(x)}
              >
                <ServerTile server={x} size={24} />
                <span className="split-text">
                  <span className="strong-500 ellipsis">{x.name}</span>
                  <span className="small sub ellipsis">
                    {x.user}@{x.host}
                  </span>
                </span>
                {x.online && <span className="dot is-ok" />}
              </button>
            ))}
          </div>
        ))}
        {isNew && (
          <div className="split-group">
            <span className="side-title">{$t('Neu')}</span>
            <div className="split-item is-sel">
              <ServerTile
                mono={draft.mono || '?'}
                color={draft.color}
                image={draft.image}
                protocol={draft.protocol}
                size={24}
              />
              <span className="split-text">
                <span className="strong-500">{draft.name || $t('Neuer Server')}</span>
                <span className="small sub">{draft.host || $t('noch nicht gespeichert')}</span>
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="split-foot">
        <button type="button" className="icon-btn" aria-label={$t('Neuer Server')} onClick={onNew}>
          <Plus size={15} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={$t('Neue Gruppe')}
          title={$t('Gruppe: im Feld „Gruppe“ einen Namen eintragen')}
          onClick={() => document.getElementById('s-group')?.focus()}
        >
          <FolderPlus size={15} strokeWidth={1.75} />
        </button>
        <span className="flex-1" />
        <Button variant="ghost" small onClick={() => openDialog({ type: 'import' })}>
          {$t('Importieren …')}
        </Button>
      </div>
    </div>
  );
}
