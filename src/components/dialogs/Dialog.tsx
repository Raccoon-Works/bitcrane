/**
 * Modal dialog shell used by all dialogs.
 *
 * - Opens centred with a 200 ms fade/scale (design system "motion-dialog").
 * - Escape closes, Tab stays inside the dialog (focus trap).
 * - Footer stays visible; long content scrolls in the middle.
 * - `windowLike` renders a separate window look (Settings, Transfers) with
 *   traffic lights on the Mac and a title bar on Windows.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { closeDialog, useStore } from '../../state/store';
import { TrafficLights } from '../TrafficLights';
import { $t } from '../../i18n';

export function Dialog({
  label, title, subtitle, icon, children, footer, width = 560, onClose = closeDialog, windowLike, windowTitle, className = '', maxHeight,
}: {
  label: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  onClose?: () => void;
  windowLike?: boolean;
  windowTitle?: string;
  className?: string;
  maxHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const platform = useStore((s) => s.platform);
  // Keep the latest close handler without re-running the focus effect.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = el.querySelector<HTMLElement>('[autofocus], input:not([type="checkbox"]), select, textarea, button.btn-primary, button');
    first?.focus({ preventScroll: true });
    // Escape is handled on the window so it also works after focus left the
    // dialog (e.g. a button became disabled). Inner fields that use Escape
    // themselves stop its propagation first.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        const items = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"]')).filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); items[items.length - 1].focus(); }
        else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
      }
    };
    el.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onEscape);
    return () => {
      el.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onEscape);
      previous?.focus?.({ preventScroll: true });
    };
  }, []);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !windowLike) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`dialog${windowLike ? ' is-window' : ''} ${className}`}
        style={{ width, maxHeight }}
      >
        {windowLike && (
          <div className="dialog-titlebar">
            {platform === 'mac' ? (
              <>
                <button type="button" className="tl-button" aria-label={$t('Schließen')} onClick={onClose}><TrafficLights /></button>
                <span className="dialog-window-title">{windowTitle}</span>
                <span className="tl-spacer" />
              </>
            ) : (
              <>
                <span className="dialog-window-title is-left">{windowTitle}</span>
                <button type="button" className="win-close" aria-label={$t('Schließen')} onClick={onClose}>
                  <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1"><path d="m0 0 10 10M10 0 0 10" /></svg>
                </button>
              </>
            )}
          </div>
        )}
        {(title || icon) && (
          <div className="dialog-head">
            {icon && <span className="dialog-icon">{icon}</span>}
            <div className="dialog-head-text">
              {title && <span className="headline">{title}</span>}
              {subtitle && <span className="muted">{subtitle}</span>}
            </div>
          </div>
        )}
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}
