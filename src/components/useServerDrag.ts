/**
 * Reordering servers in the list by dragging.
 */
import { useRef, useState } from 'react';
import { getState, moveServer } from '../state/store';

/**
 * Reordering servers by dragging. Dropping on the upper half of a server puts
 * the dragged one before it, on the lower half after it; it joins that group.
 */
export function useServerDrag() {
  const [drag, setDrag] = useState<{ id: string; target: string | null; after: boolean; group: string } | null>(null);
  const moved = useRef(false);
  const begin = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const startY = e.clientY;
    moved.current = false;
    let current: { target: string | null; after: boolean; group: string } | null = null;
    const move = (ev: PointerEvent) => {
      if (!moved.current && Math.abs(ev.clientY - startY) < 5) return;
      moved.current = true;
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>(
        '[data-server-id], [data-server-group]',
      );
      if (!el) {
        current = null;
        setDrag({ id, target: null, after: false, group: '\u0000' });
        return;
      }
      if (el.dataset.serverId) {
        const r = el.getBoundingClientRect();
        current = {
          target: el.dataset.serverId,
          after: ev.clientY > r.top + r.height / 2,
          group: el.dataset.group ?? '',
        };
      } else current = { target: null, after: true, group: el.dataset.serverGroup ?? '' };
      setDrag({ id, ...current });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-dragging-server');
      const c = current;
      if (moved.current && c) {
        const servers = getState().servers.filter(
          (x) => !x.temporary && x.group.trim() === c.group.trim() && x.id !== id,
        );
        let before: string | null = c.target;
        if (c.target && c.after) {
          const i = servers.findIndex((x) => x.id === c.target);
          before = servers[i + 1]?.id ?? null;
        }
        moveServer(id, before, c.group);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.classList.add('is-dragging-server');
  };
  /** True right after a drag, so the click that ends it does not select. */
  const wasDrag = () => {
    const m = moved.current;
    moved.current = false;
    return m;
  };
  return { drag, begin, wasDrag };
}
