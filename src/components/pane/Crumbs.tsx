/**
 * Breadcrumbs of the path bar: every level while they fit; when space runs out
 * the first ones fold into "…" (Explorer). The folder shown opens a menu of the
 * folders above it (Transmit).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CaretDown, CaretRight } from '@phosphor-icons/react';
import type { PaneSide } from '../../backend/types';
import { navigate, setState, useStore } from '../../state/store';
import { crumbs as crumbsFor } from '../../util/paths';
import { $t } from '../../i18n';

export function Crumbs({ side, path }: { side: PaneSide; path: string }) {
  const homeName = useStore((s) => s.homeName);
  const crumbsRef = useRef<HTMLSpanElement>(null);
  const [crumbsHidden, setCrumbsHidden] = useState(0);
  // Start with every level shown and fold one more into "…" while they overflow.
  useLayoutEffect(() => {
    setCrumbsHidden(0);
  }, [path, homeName]);
  useLayoutEffect(() => {
    const el = crumbsRef.current;
    // Stop when only the current folder is left (plus the "…").
    const visible = el ? el.querySelectorAll('.crumb-wrap').length - (crumbsHidden > 0 ? 1 : 0) : 0;
    if (el && visible > 1 && el.scrollWidth > el.clientWidth + 1) setCrumbsHidden((h) => h + 1);
  }, [crumbsHidden, path, homeName]);
  // A wider or narrower path bar starts the folding again.
  useEffect(() => {
    const el = crumbsRef.current?.parentElement;
    if (!el) return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        setCrumbsHidden(0);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const allCrumbs = path ? crumbsFor(path, homeName) : [];
  const crumbs = allCrumbs.slice(Math.min(crumbsHidden, Math.max(0, allCrumbs.length - 1)));
  return (
    <span className="crumbs" ref={crumbsRef}>
      {allCrumbs.length > crumbs.length && (
        <span className="crumb-wrap">
          <button
            type="button"
            className="crumb"
            title={$t('Übergeordnete Ordner')}
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setState({
                contextMenu: {
                  x: r.left,
                  y: r.bottom + 4,
                  side,
                  names: [],
                  kind: 'crumbs',
                  place: `h:${allCrumbs.length - crumbs.length}`,
                },
              });
            }}
          >
            …
          </button>
          <CaretRight className="crumb-sep" size={11} weight="bold" aria-hidden="true" />
        </span>
      )}
      {crumbs.map((c, i) => (
        <span key={c.path} className="crumb-wrap">
          {i === crumbs.length - 1 ? (
            // The folder shown, in the accent colour with a menu of the folders above it (Transmit).
            <button
              type="button"
              className="crumb is-last"
              title={c.path}
              aria-haspopup="menu"
              disabled={allCrumbs.length < 2}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setState({
                  contextMenu: { x: r.left, y: r.bottom + 4, side, names: [], kind: 'crumbs', place: 'all' },
                });
              }}
            >
              {c.name}
              {allCrumbs.length > 1 && <CaretDown size={11} weight="bold" aria-hidden="true" />}
            </button>
          ) : (
            <button type="button" className="crumb" title={c.path} onClick={() => navigate(side, c.path)}>
              {c.name}
            </button>
          )}
          {i < crumbs.length - 1 && <CaretRight className="crumb-sep" size={11} weight="bold" aria-hidden="true" />}
        </span>
      ))}
    </span>
  );
}
