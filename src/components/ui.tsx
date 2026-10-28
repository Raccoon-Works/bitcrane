/**
 * Basic building blocks ("Bausteine") of the Bitcrane UI.
 *
 * Every component here implements the states defined in the design system:
 * normal, hover, pressed (scale 0.97), keyboard focus (focus ring only with
 * :focus-visible) and disabled. Styling lives in app.css.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { STAGE_ID, stagePoint } from './stage';
import { Check, ChevronDown } from './glyphs';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';

export function Button({ variant = 'secondary', small, className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  return (
    <button type="button" className={`btn btn-${variant}${small ? ' btn-small' : ''} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/** Square icon button with an accessible label and an optional tooltip. */
export function IconButton({ label, shortcut, active, className = '', children, tipBelow = true, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; active?: boolean; tipBelow?: boolean }) {
  return (
    <Tooltip text={label} shortcut={shortcut} below={tipBelow}>
      <button type="button" aria-label={label} aria-pressed={active} className={`icon-btn${active ? ' is-on' : ''} ${className}`} {...rest}>
        {children}
      </button>
    </Tooltip>
  );
}

export function Checkbox({ checked, onChange, label, note, disabled, danger }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; note?: ReactNode; disabled?: boolean; danger?: boolean }) {
  return (
    <label className={`checkbox${disabled ? ' is-disabled' : ''}${danger ? ' is-danger' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="checkbox-box" aria-hidden="true">{checked && <Check size={11} strokeWidth={3} />}</span>
      {(label || note) && (
        <span className="checkbox-text">
          {label && <span className="checkbox-label">{label}</span>}
          {note && <span className="checkbox-note">{note}</span>}
        </span>
      )}
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  );
}

export function TextField({ value, onChange, mono, placeholder, id, invalid, autoFocus, prefix, onEnter, className = '', type = 'text', label }: { value: string; onChange: (v: string) => void; mono?: boolean; placeholder?: string; id?: string; invalid?: boolean; autoFocus?: boolean; prefix?: ReactNode; onEnter?: () => void; className?: string; type?: 'text' | 'password'; label?: string }) {
  return (
    <span className={`field${mono ? ' is-mono' : ''}${invalid ? ' is-invalid' : ''} ${className}`}>
      {prefix && <span className="field-prefix">{prefix}</span>}
      <input
        id={id}
        type={type}
        aria-label={label}
        autoComplete={type === 'password' ? 'off' : undefined}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-invalid={invalid}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) onEnter();
        }}
      />
    </span>
  );
}

/** Native select styled like a field; keeps keyboard and screen reader behaviour. */
export function Select<T extends string>({ value, onChange, options, id, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; id?: string; label?: string }) {
  return (
    <span className="select">
      <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="segmented">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Tooltip */

/** Time of the last visible tooltip; a follow-up tooltip opens instantly. */
let lastTipClosed = 0;

/**
 * Tooltip after a short pause; subsequent tooltips open at once
 * (design system, section "Tooltip und Klickfläche").
 */
export function Tooltip({ text, shortcut, children, below = true }: { text: string; shortcut?: string; children: ReactNode; below?: boolean }) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const [pos, setPos] = useState<{ x: number; top: number; bottom: number; w: number; h: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = () => {
    const quick = Date.now() - lastTipClosed < 400;
    setInstant(quick);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // Measured in stage coordinates: the tip is drawn on top of everything,
      // so a pane or dialog edge can no longer cut it off.
      const r = anchor.current?.getBoundingClientRect();
      if (r) {
        const a = stagePoint(r.left + r.width / 2, r.top);
        const b = stagePoint(r.left, r.bottom);
        setPos({ x: a.x, top: a.y, bottom: b.y, w: a.w, h: a.h });
      }
      setOpen(true);
    }, quick ? 0 : 600);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    if (open) lastTipClosed = Date.now();
    setOpen(false);
  };
  // Keep the tip inside the window (horizontally) and flip it when there is no room below.
  useLayoutEffect(() => {
    const el = tip.current;
    if (!open || !pos || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(6, Math.min(pos.w - w - 6, pos.x - w / 2))}px`;
    const roomBelow = pos.bottom + 6 + h < pos.h - 4;
    el.style.top = `${below && roomBelow ? pos.bottom + 6 : pos.top - 6 - h}px`;
  }, [open, pos, below]);
  const host = typeof document !== 'undefined' ? document.getElementById(STAGE_ID) ?? document.body : null;
  return (
    <span ref={anchor} className="tip-anchor" onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
      {children}
      {open && pos && host && createPortal(
        <span ref={tip} role="tooltip" className={`tooltip is-floating${instant ? ' is-instant' : ''}`}>
          {text}
          {shortcut && <span className="tooltip-key">{shortcut}</span>}
        </span>,
        host,
      )}
    </span>
  );
}

/* ----------------------------------------------------------- Disclosure */

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="form-section" aria-label={title}>
      <div className="form-section-head">
        <span className="caption-strong">{title}</span>
        {aside}
      </div>
      {children}
    </section>
  );
}
