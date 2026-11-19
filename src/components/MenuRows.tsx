/**
 * Entries of a menu in groups between separators: the application menus
 * (AppMenu.tsx) and the right-click menus (ContextMenu.tsx).
 */
import type { ReactNode } from 'react';
import { menuText } from '../i18n';
import { Check } from './glyphs';

export interface MenuRow {
  label: string;
  /** Shortcut shown at the right. */
  key?: string;
  /** Without one the entry is shown disabled. */
  run?: () => void;
  danger?: boolean;
  checked?: boolean;
  /** Colour dot before the label (Finder tags). */
  dot?: string;
  icon?: ReactNode;
}

/** `onChoose` runs before the entry's own action (it closes the menu). */
export function MenuRows({ groups, onChoose }: { groups: MenuRow[][]; onChoose: () => void }) {
  const rows = groups.flat();
  // As in the system menus: once any entry can carry a tick or a symbol, all texts start at the same edge.
  const anyCheck = rows.some((it) => it.checked !== undefined);
  const anyIcon = rows.some((it) => it.icon);
  return (
    <>
      {groups.map((g, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="menu-sep" role="separator" />}
          {/* Position as key: labels repeat (two crumbs "app" in /srv/app/app). */}
          {g.map((it, i) => (
            <button
              key={i}
              type="button"
              role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={it.checked}
              className={`menu-item${it.danger ? ' is-danger' : ''}`}
              disabled={!it.run}
              onClick={() => {
                onChoose();
                it.run?.();
              }}
            >
              {anyCheck && (
                <span className="menu-check" aria-hidden="true">
                  {it.checked ? <Check size={13} strokeWidth={2.2} /> : null}
                </span>
              )}
              {anyIcon && (
                <span className="menu-icon" aria-hidden="true">
                  {it.icon}
                </span>
              )}
              {it.dot && <span className="tag-dot menu-tag-dot" style={{ background: it.dot }} aria-hidden="true" />}
              <span className="flex-1">{menuText(it.label)}</span>
              {it.key && <span className="menu-key">{it.key}</span>}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}
