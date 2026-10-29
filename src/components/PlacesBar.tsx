/**
 * Places bar of a half (Transmit 5's "Places"): favourite folders of this
 * computer, or of the server the half shows, as a row of buttons.
 *
 * - Click opens the folder in this half.
 * - Files dragged from the other half onto a place are transferred into it.
 * - A folder dragged from this half onto the free part of the bar becomes a place.
 * - Places can be reordered by dragging; dragging one out of the bar and letting
 *   go removes it (also in the context menu, which is the way on Windows).
 */
import { CaretDoubleRight, Cloud, Desktop, DownloadSimple, DropboxLogo, FileText, FolderSimple, GoogleDriveLogo, House } from '@phosphor-icons/react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { PaneSide, Place } from '../backend/types';
import { activeTab, movePlace, navigate, placesFor, removePlace, setState, useStore } from '../state/store';
import { $t } from '../i18n';

/** Icon of a place, guessed from its folder (home, desktop, downloads, documents). */
function PlaceIcon({ place }: { place: Place }) {
  const last = place.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const props = { size: 17, weight: 'duotone', 'aria-hidden': true } as const;
  if (place.cloud === 'dropbox') return <DropboxLogo {...props} />;
  if (place.cloud === 'gdrive') return <GoogleDriveLogo {...props} />;
  if (place.cloud) return <Cloud {...props} />;
  if (place.path === '~') return <House {...props} />;
  if (last === 'desktop' || last === 'schreibtisch') return <Desktop {...props} />;
  if (last === 'downloads') return <DownloadSimple {...props} />;
  if (last === 'documents' || last === 'dokumente') return <FileText {...props} />;
  return <FolderSimple {...props} />;
}

/**
 * Name shown for a place. Cloud folders found by older versions were named
 * with their account ("Google Drive (name@example.com)"), which filled the bar;
 * the account is shown in the tooltip instead.
 */
export function placeLabel(place: Place): string {
  if (!place.cloud) return place.name;
  return place.name.replace(/\s*\([^)]*@[^)]*\)\s*$/, '');
}

/** Tooltip of a place: the folder, and for cloud folders the account it belongs to. */
function placeTitle(place: Place): string {
  const folder = place.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const account = place.cloud && folder.includes('-') ? folder.slice(folder.indexOf('-') + 1) : '';
  return [placeLabel(place) + (account ? ` – ${account}` : ''), place.path, $t('Klicken zum Öffnen, ziehen zum Verschieben')].join('\n');
}

export function PlacesBar({ side }: { side: PaneSide }) {
  // Re-render when the places, the tab or the folder shown change.
  const places = useStore((s) => placesFor(side, s, activeTab(s)));
  const path = useStore((s) => { const t = activeTab(s); return t ? (side === 'local' ? t.localPath : t.remotePath) : ''; });
  const hint = useStore((s) => (s.dropHint?.side === side && (s.dropHint.place || s.dropHint.addPlace) ? s.dropHint : null));
  const barRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ path: string; before: string | null; out: boolean } | null>(null);
  const moved = useRef(false);
  // Places that do not fit stay out of the bar and are listed behind "»" (like a bookmarks bar),
  // instead of all of them shrinking to unreadable names.
  const [fit, setFit] = useState(places.length);
  const measure = () => {
    const bar = barRef.current;
    // Measured only while all places are laid out (after a change or a resize).
    if (!bar || fit < places.length) return;
    const items = [...bar.querySelectorAll<HTMLElement>('[data-place-path]')];
    const limit = bar.clientWidth - 44; // room for the "»" button
    let n = 0;
    for (const el of items) {
      if (el.offsetLeft + el.offsetWidth > limit && n < items.length) break;
      n++;
    }
    // Everything fits without the button: use the full width.
    const last = items[items.length - 1];
    if (last && last.offsetLeft + last.offsetWidth <= bar.clientWidth - 8) n = items.length;
    setFit((f) => (f === n ? f : n));
  };
  useLayoutEffect(() => { setFit(places.length); }, [places]);
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setFit(places.length));
    ro.observe(bar);
    return () => ro.disconnect();
  }, [places]);

  const begin = (e: React.PointerEvent, p: Place) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    moved.current = false;
    let cur: { path: string; before: string | null; out: boolean } | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved.current && Math.abs(ev.clientX - sx) < 5 && Math.abs(ev.clientY - sy) < 5) return;
      moved.current = true;
      const bar = barRef.current?.getBoundingClientRect();
      // Well outside the bar: letting go removes the place.
      const out = !!bar && (ev.clientY < bar.top - 24 || ev.clientY > bar.bottom + 24);
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-place-path]');
      let before: string | null = null;
      if (el && barRef.current?.contains(el)) {
        const r = el.getBoundingClientRect();
        const target = el.dataset.placePath ?? null;
        if (ev.clientX < r.left + r.width / 2) before = target;
        else {
          const i = places.findIndex((x) => x.path === target);
          before = places[i + 1]?.path ?? null;
        }
      } else before = drag?.before ?? null;
      cur = { path: p.path, before, out };
      setDrag(cur);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-dragging-place');
      const c = cur;
      setDrag(null);
      if (!moved.current || !c) return;
      if (c.out) removePlace(side, c.path);
      else movePlace(side, c.path, c.before);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.classList.add('is-dragging-place');
  };

  return (
    <div ref={barRef} className={`places-bar${hint?.addPlace ? ' is-drop' : ''}`} data-places-bar role="toolbar" aria-label={$t('Orte')}>
      {places.map((p, i) => {
        const on = p.path === path;
        if (i >= fit) return <button key={p.path} type="button" data-place-path={p.path} className="place is-overflow" tabIndex={-1} aria-hidden="true"><PlaceIcon place={p} /><span>{placeLabel(p)}</span></button>;
        const isDrop = hint?.place === p.path;
        const isDragged = drag?.path === p.path;
        return (
          <button
            key={p.path}
            type="button"
            data-place-path={p.path}
            className={`place${on ? ' is-on' : ''}${isDrop ? ' is-drop' : ''}${isDragged ? (drag.out ? ' is-leaving' : ' is-dragged') : ''}${drag && !isDragged && drag.before === p.path ? ' drop-before' : ''}`}
            title={placeTitle(p)}
            aria-current={on ? 'location' : undefined}
            onPointerDown={(e) => begin(e, p)}
            onClick={() => { if (moved.current) { moved.current = false; return; } navigate(side, p.path); }}
            onContextMenu={(e) => { e.preventDefault(); setState({ contextMenu: { x: e.clientX, y: e.clientY, side, names: [], kind: 'place', place: p.path } }); }}
          >
            <PlaceIcon place={p} />
            <span className="ellipsis">{placeLabel(p)}</span>
          </button>
        );
      })}
      {fit < places.length && (
        <button type="button" className="place place-more" title={$t('Weitere Orte')} aria-label={$t('Weitere Orte')} aria-haspopup="menu"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setState({ contextMenu: { x: r.left, y: r.bottom + 4, side, names: [], kind: 'placesMore', place: String(fit) } }); }}>
          <CaretDoubleRight size={15} weight="bold" aria-hidden="true" />
        </button>
      )}
      {drag && drag.before === null && !drag.out && <span className="place-end-mark" aria-hidden="true" />}
      {!places.length && <span className="places-empty">{$t('Ordner hierher ziehen, um sie als Orte zu merken')}</span>}
      {drag?.out && <span className="places-remove-hint" role="status">{$t('Loslassen zum Entfernen')}</span>}
    </div>
  );
}
