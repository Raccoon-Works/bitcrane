/**
 * Closes a popup (menu, popover) on a click outside it or on Escape. `inside` names further areas
 * that count as part of it (the button that opened it, a bar it belongs to).
 */
import { useEffect } from 'react';

export function useCloseOnOutside(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void,
  inside?: (target: HTMLElement) => boolean,
) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !inside?.(t)) close();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open, ref, close, inside]);
}
