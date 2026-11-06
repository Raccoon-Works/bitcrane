/**
 * Results of a search through subfolders or file contents: a heading with the
 * count, then one row per file with its folder (and the matching line).
 */
import type { RefObject } from 'react';
import type { PaneSide } from '../../backend/types';
import { revealSearchResult, useStore, type DeepSearch } from '../../state/store';
import { formatDate, formatSize } from '../../util/format';
import { Loader2 } from '../glyphs';
import { FileGlyph } from '../icons';
import { $t } from '../../i18n';

export function DeepResults({
  side,
  deep,
  listRef,
}: {
  side: PaneSide;
  deep: DeepSearch;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const columns = useStore((s) => s.settings.columns);
  const showPerms = useStore((s) => s.settings.showPerms);
  return (
    <>
      <div className="deep-head" role="presentation">
        {deep.loading ? (
          <>
            <Loader2 size={13} className="spin" aria-hidden="true" />
            {deep.content ? $t('Suche im Inhalt der Dateien in') : $t('Suche in Unterordnern von')} {deep.base} …
          </>
        ) : deep.error ? (
          <span className="tone-danger">{deep.error}</span>
        ) : deep.content ? (
          <>
            {deep.results.length
              ? $t('{0}{1} Dateien enthalten „{2}“', deep.results.length, deep.more ? '+' : '', deep.query)
              : $t('Keine Datei in {0} enthält „{1}“.', deep.base, deep.query)}
          </>
        ) : (
          <>
            {deep.results.length
              ? $t('{0}{1} {2} in Unterordnern', deep.results.length, deep.more ? '+' : '', $t('Treffer'))
              : $t('Nichts gefunden für „{0}“ in {1} und Unterordnern.', deep.query, deep.base)}
          </>
        )}
      </div>
      {deep.results.map((r) => (
        <div
          key={r.path}
          role="option"
          aria-selected={false}
          className="row"
          title={r.path}
          onDoubleClick={() => revealSearchResult(side, r.path)}
          onMouseDown={(e) => {
            if (e.button === 0) listRef.current?.focus({ preventScroll: true });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') revealSearchResult(side, r.path);
          }}
          tabIndex={-1}
        >
          <span className="row-bar" />
          <span />
          <FileGlyph size={20} name={r.rel} />
          <span className="row-name">
            <span className="ellipsis">{r.rel.split('/').pop()}</span>
            {r.line !== undefined ? (
              <span className="result-path result-line ellipsis" title={r.line}>
                {r.rel.includes('/') ? `${r.rel.split('/').slice(0, -1).join('/')} · ` : ''}
                {$t('Zeile {0}', r.lineNo ?? 0)}: {r.line}
              </span>
            ) : (
              r.rel.includes('/') && (
                <span className="result-path ellipsis">{r.rel.split('/').slice(0, -1).join('/')}</span>
              )
            )}
          </span>
          {columns.mtime && <span className="row-sub nowrap">{r.mtime ? formatDate(r.mtime) : ''}</span>}
          {columns.kind && <span className="row-sub" />}
          {showPerms && <span className="row-sub" />}
          {columns.owner && <span className="row-sub" />}
          {columns.size && <span className="row-sub num">{r.size || !deep.content ? formatSize(r.size) : ''}</span>}
        </div>
      ))}
    </>
  );
}
