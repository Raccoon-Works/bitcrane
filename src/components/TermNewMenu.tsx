/**
 * "New terminal" menu, shown by the "+" of the terminal bar and by a right
 * click on the toolbar's terminal button. It is the console entry point for
 * people who only want SSH: a shell on this computer, any saved SSH server,
 * or a quick SSH connection without saving a server first.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { $t } from '../i18n';
import { openDialog, useStore } from '../state/store';
import { localShells, newTerminal, openServerTerminal, terminalSettings } from '../state/terminal';
import { ServerTile } from './ServerTile';

export function TermNewMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const servers = useStore((s) => s.servers);
  const [shells, setShells] = useState<Array<{ id: string; name: string }>>([]);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => { void localShells().then(setShells); }, []);
  // Keep the menu inside the window (it may open near the right or bottom edge).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y, shells.length, servers.length]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  // Saved SSH servers (SFTP / SSH), plus quick connections that are open right now.
  const ssh = servers.filter((s) => (!s.protocol || s.protocol === 'sftp') && (!s.temporary || s.online));
  const preferred = terminalSettings().localShell || shells[0]?.id || '';
  const run = (f: () => void) => () => { onClose(); f(); };

  // Into the page element (it carries the theme), outside bars whose blur would trap a fixed menu.
  return createPortal(
    <div ref={ref} className="menu term-new-menu" role="menu" style={{ left: pos.left, top: pos.top }}>
      <div className="menu-head">{$t('Auf diesem Computer')}</div>
      {shells.length ? shells.map((sh) => (
        <button key={sh.id} type="button" role="menuitem" className="menu-item" onClick={run(() => newTerminal('local', false, sh.id))}>
          <span className="flex-1 ellipsis">{sh.name}</span>
          {sh.id === preferred && <span className="menu-key">{$t('Standard')}</span>}
        </button>
      )) : (
        <button type="button" role="menuitem" className="menu-item" onClick={run(() => newTerminal('local'))}>
          <span className="flex-1 ellipsis">{$t('Lokales Terminal')}</span>
        </button>
      )}
      <div className="menu-sep" />
      <div className="menu-head">{$t('SSH-Server')}</div>
      {ssh.length === 0 && <span className="small muted term-new-empty">{$t('Noch kein SSH-Server gespeichert.')}</span>}
      <div className="term-new-servers">
        {ssh.map((s) => (
          <button key={s.id} type="button" role="menuitem" className="menu-item term-new-server" onClick={run(() => openServerTerminal(s.id))}>
            <ServerTile server={s} size={16} />
            <span className="flex-1 ellipsis">{s.name}</span>
            <span className="small muted mono ellipsis term-new-host">{s.user ? `${s.user}@` : ''}{s.host}</span>
            {s.online && <span className="term-new-online" aria-label={$t('verbunden')} />}
          </button>
        ))}
      </div>
      <div className="menu-sep" />
      <button type="button" role="menuitem" className="menu-item" onClick={run(() => openDialog({ type: 'quickConnect', terminal: true }))}>
        {$t('Neue SSH-Verbindung …')}
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={run(() => openDialog({ type: 'serverEdit', terminal: true }))}>
        {$t('SSH-Server anlegen …')}
      </button>
    </div>,
    document.querySelector('.page') ?? document.body,
  );
}
