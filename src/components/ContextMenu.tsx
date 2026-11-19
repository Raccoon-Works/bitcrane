/**
 * Draws the right-click menu built in state/contextMenu at the click, kept
 * inside the window, with arrow-key navigation.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCloseOnOutside } from '../util/useCloseOnOutside';
import { contextMenuGroups, type MenuIcon } from '../state/contextMenu';
import { activeTab, setState, useStore } from '../state/store';
import { $t } from '../i18n';
import { MenuRows } from './MenuRows';
import { DriveIcon, PlaceIcon } from './placeIcons';
import { LocalTile } from './ServerTile';
import { stagePoint } from './stage';

const closeContextMenu = () => setState({ contextMenu: null });

function iconOf(icon: MenuIcon) {
  switch (icon.kind) {
    case 'computer':
      return <LocalTile size={16} />;
    case 'place':
      return <PlaceIcon place={icon.place} />;
    case 'drive':
      return <DriveIcon drive={icon.place} first={icon.first} />;
  }
}

export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const platform = useStore((s) => s.platform);
  const ref = useRef<HTMLDivElement>(null);
  // Final position, from the menu's real size (set right after it is laid out).
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    setPos(null);
    const el = ref.current;
    if (!menu || !el) return;
    const p = stagePoint(menu.x, menu.y);
    setPos({
      left: Math.max(8, Math.min(p.x, p.w - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(p.y, p.h - el.offsetHeight - 8)),
    });
  }, [menu]);

  useCloseOnOutside(!!menu, ref, closeContextMenu);
  // Arrow keys move through the entries; the first one has the focus when the menu opens.
  useEffect(() => {
    if (!menu) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
      const i = items.indexOf(document.activeElement as HTMLElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    };
    document.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    return () => document.removeEventListener('keydown', key);
  }, [menu]);

  if (!menu) return null;
  const groups = contextMenuGroups({ menu, tab: activeTab(), platform }).map((g) =>
    g.map((it) => ({ ...it, icon: it.icon && iconOf(it.icon) })),
  );
  // Convert to stage coordinates and keep the menu inside the window. The first
  // frame places it at the click; the real size (rows are taller on Windows)
  // then moves it up or left as far as needed, and a menu taller than the window
  // scrolls (max-height in app.css), like the system menus.
  const pt = stagePoint(menu.x, menu.y);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={$t('Kontextmenü')}
      className="menu context-menu"
      style={{ left: pos?.left ?? pt.x, top: pos?.top ?? pt.y, visibility: pos ? undefined : 'hidden' }}
    >
      <MenuRows groups={groups} onChoose={closeContextMenu} />
    </div>
  );
}
