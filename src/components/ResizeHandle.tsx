/**
 * A thin bar that can be dragged to resize the areas next to it: the line
 * between the two halves, the edge of the server list's group column and the
 * top edge of the activity area. A double click restores the default size,
 * the arrow keys move it in small steps (keyboard and screen readers).
 */
import { useRef } from 'react';
import { stagePoint } from './stage';

interface Props {
  /** "vertical": a vertical line moved left/right; "horizontal": moved up/down. */
  orientation: 'vertical' | 'horizontal';
  label: string;
  /** Current value in the unit of the caller (pixels or a ratio). */
  value: number;
  min: number;
  max: number;
  /** Converts a pointer movement in stage pixels into the caller's unit. */
  toValue: (start: number, deltaPx: number) => number;
  onChange: (value: number) => void;
  onReset: () => void;
  /** Step for the arrow keys, in the caller's unit. */
  step: number;
  className?: string;
}

export function ResizeHandle({ orientation, label, value, min, max, toValue, onChange, onReset, step, className = '' }: Props) {
  const drag = useRef<{ start: number; from: number } | null>(null);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const pos = (e: PointerEvent | React.PointerEvent) => {
    const p = stagePoint(e.clientX, e.clientY);
    return orientation === 'vertical' ? p.x : p.y;
  };
  const begin = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { start: value, from: pos(e) };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (d) onChange(clamp(toValue(d.start, pos(ev) - d.from)));
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-resizing', 'is-resizing-v', 'is-resizing-h');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.classList.add('is-resizing', orientation === 'vertical' ? 'is-resizing-v' : 'is-resizing-h');
  };
  const onKey = (e: React.KeyboardEvent) => {
    const back = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === back || e.key === fwd) {
      e.preventDefault();
      onChange(clamp(value + (e.key === fwd ? step : -step)));
    }
    if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); onReset(); }
  };
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 100) / 100}
      tabIndex={0}
      title={label}
      className={`resize-handle is-${orientation} ${className}`}
      onPointerDown={begin}
      onDoubleClick={onReset}
      onKeyDown={onKey}
    />
  );
}
