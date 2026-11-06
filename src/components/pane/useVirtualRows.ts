/**
 * Long lists draw only the rows in view (plus a margin), like the Finder and
 * the Explorer: a folder with 20 000 files scrolls as smoothly as one with 20.
 * Also keeps the keyboard cursor row visible, drawn or not.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useStore } from '../../state/store';

/** Lists longer than this draw only the visible rows; the margin keeps fast scrolling free of gaps. */
const VIRTUAL_MIN = 300;
const VIRTUAL_MARGIN = 20;

export function useVirtualRows(
  listRef: RefObject<HTMLDivElement | null>,
  /** The list view without a search through subfolders: the only view that is drawn in part. */
  plainList: boolean,
  count: number,
  cursor: number,
) {
  const virtual = plainList && count > VIRTUAL_MIN;
  const rowsRef = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(34);
  const density = useStore((st) => st.settings.density);
  const [view, setView] = useState({ top: 0, height: 900 });
  // Stable, so the effects below re-run only when the list changes, not on every render.
  const measureView = useCallback(() => {
    const el = listRef.current;
    const rows = rowsRef.current;
    if (!el) return;
    const top = Math.max(0, el.scrollTop - (rows ? rows.offsetTop : 0));
    setView((v) => (Math.abs(v.top - top) < 2 && v.height === el.clientHeight ? v : { top, height: el.clientHeight }));
  }, [listRef]);
  useLayoutEffect(() => {
    if (!virtual) return;
    const first = rowsRef.current?.querySelector<HTMLElement>('.row');
    if (first && first.offsetHeight) setRowH(first.offsetHeight);
    measureView();
  }, [virtual, count, density, measureView]);
  useEffect(() => {
    const el = listRef.current;
    if (!virtual || !el) return;
    let frame = 0;
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measureView();
        });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [virtual, listRef, measureView]);
  const firstRow = virtual ? Math.max(0, Math.floor(view.top / rowH) - VIRTUAL_MARGIN) : 0;
  const lastRow = virtual ? Math.min(count, Math.ceil((view.top + view.height) / rowH) + VIRTUAL_MARGIN) : count;

  // Keep the keyboard cursor row visible (a row outside the drawn part is scrolled to by its position).
  useEffect(() => {
    if (cursor < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    const el = listRef.current;
    if (virtual && el) {
      const offset = rowsRef.current?.offsetTop ?? 0;
      const y = offset + cursor * rowH;
      if (y < el.scrollTop) el.scrollTop = y;
      else if (y + rowH > el.scrollTop + el.clientHeight) el.scrollTop = y + rowH - el.clientHeight;
      return;
    }
    row?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrolls only when the cursor moves, not on every new listing
  }, [cursor]);

  return { virtual, rowsRef, rowH, firstRow, lastRow };
}
