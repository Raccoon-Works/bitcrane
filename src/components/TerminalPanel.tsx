/**
 * The built-in SSH terminal (state/terminal.ts): a panel below the two
 * halves, or the whole tab. A bar on top holds the sessions of this tab,
 * "+" for another one, the snippets, search, and the switch between panel
 * and whole tab.
 */
import '@xterm/xterm/css/xterm.css';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowsInSimple, ArrowsOutSimple, BracketsCurly, CaretDown, MagnifyingGlass, Plus, Trash, X } from '@phosphor-icons/react';
import { $t } from '../i18n';
import { openDialog, serverById, updateSettings, useStore } from '../state/store';
import { themeFor, attachTerminal, clearTerminal, closeTerminal, findInTerminal, fitTerminal, newTerminal, sendSnippet, setActiveTerminal, terminalBackToPanel, terminalInOwnTab, toggleTerminal } from '../state/terminal';
import type { Snippet } from '../state/terminal';
import { ResizeHandle } from './ResizeHandle';
import { IconButton } from './ui';

/** Stable empty list: a new [] on every render would redraw the store endlessly. */
const NO_SNIPPETS: Snippet[] = [];

/** Hosts one session's xterm element and keeps it fitted to the area. */
function TerminalView({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) attachTerminal(id, ref.current);
  }, [id]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fitTerminal(id));
    ro.observe(el);
    return () => ro.disconnect();
  }, [id]);
  return <div ref={ref} className="term-view" />;
}

function SnippetMenu({ id, onClose }: { id: string; onClose: () => void }) {
  const snippets = useStore((s) => s.settings.snippets) ?? NO_SNIPPETS;
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.term-snippets')) onClose();
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [onClose]);
  return (
    <div className="term-snippets menu" role="menu">
      {snippets.length === 0 && <span className="small muted term-snippets-empty">{$t('Noch keine Snippets. Gespeicherte Befehle fügst du hier mit einem Klick ein.')}</span>}
      {snippets.map((sn) => (
        <button key={sn.id} type="button" role="menuitem" className="menu-item" title={sn.command} onClick={() => { sendSnippet(id, sn); onClose(); }}>
          <span className="ellipsis">{sn.name || sn.command}</span>
          {sn.run && <span className="menu-key">↵</span>}
        </button>
      ))}
      <div className="menu-sep" />
      <button type="button" role="menuitem" className="menu-item" onClick={() => { onClose(); openDialog({ type: 'settings', tab: 'terminal' }); }}>
        {$t('Snippets verwalten …')}
      </button>
    </div>
  );
}

export function TerminalPanel() {
  const tab = useStore((s) => s.tabs.find((x) => x.id === s.activeTabId));
  const all = useStore((s) => s.terminals);
  const sessions = all.filter((x) => x.tabId === tab?.id);
  const height = useStore((s) => s.settings.terminalHeight ?? 260);
  const [snippets, setSnippets] = useState(false);
  const [find, setFind] = useState<string | null>(null);
  // Re-render when the look changes, so the frame matches the terminal's background.
  useStore((s) => s.settings.terminal);
  useStore((s) => s.theme);
  useStore((s) => s.servers);
  const t = tab?.terminal;
  if (!tab || !t?.open || !sessions.length) return null;
  const active = sessions.find((x) => x.id === t.active) ?? sessions[0];
  const full = !!t.full;
  const label = (n: number, serverId: string) => `${serverId ? serverById(serverId)?.name ?? '' : $t('Lokal')}${n > 1 ? ` ${n}` : ''}`;
  return (
    <section className={`term-panel${full ? ' is-full' : ''}`} style={{ ...(full ? {} : { height }), '--term-bg': themeFor(active.serverId).background } as CSSProperties} aria-label={$t('Terminal')}>
      {!full && (
        <ResizeHandle orientation="horizontal" label={$t('Höhe des Terminals (ziehen, Doppelklick: zurücksetzen)')} value={height} min={120} max={900} step={20}
          toValue={(start, d) => start - d} onChange={(v) => updateSettings({ terminalHeight: Math.round(v) })} onReset={() => updateSettings({ terminalHeight: 260 })} className="term-handle" />
      )}
      <div className="term-bar">
        <div className="term-tabs" role="tablist">
          {sessions.map((x) => (
            <span key={x.id} role="tab" aria-selected={x.id === active.id} className={`term-tab${x.id === active.id ? ' is-active' : ''}${x.alive ? '' : ' is-ended'}`}
              onClick={() => setActiveTerminal(tab.id, x.id)}>
              <span className="ellipsis">{label(x.number, x.serverId)}</span>
              <button type="button" className="term-tab-close" aria-label={$t('Terminal schließen')} onClick={(e) => { e.stopPropagation(); closeTerminal(x.id); }}><X size={11} weight="bold" /></button>
            </span>
          ))}
          <IconButton label={$t('Neues Terminal')} onClick={() => newTerminal(active.serverId ? 'server' : 'local')}><Plus size={15} weight="bold" /></IconButton>
        </div>
        <span className="flex-1" />
        {find !== null && (
          <input className="term-find" autoFocus value={find} placeholder={$t('Im Terminal suchen')} onChange={(e) => { setFind(e.target.value); findInTerminal(active.id, e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') findInTerminal(active.id, find, e.shiftKey); if (e.key === 'Escape') setFind(null); }} />
        )}
        <IconButton label={$t('Suchen')} onClick={() => setFind(find === null ? '' : null)}><MagnifyingGlass size={16} /></IconButton>
        <span className="term-snippets-anchor">
          <IconButton label={$t('Snippets')} onClick={() => setSnippets(!snippets)}><BracketsCurly size={16} /></IconButton>
          {snippets && <SnippetMenu id={active.id} onClose={() => setSnippets(false)} />}
        </span>
        <IconButton label={$t('Leeren')} onClick={() => clearTerminal(active.id)}><Trash size={16} /></IconButton>
        {full
          ? <IconButton label={$t('Zurück unter die Dateien')} onClick={terminalBackToPanel}><ArrowsInSimple size={16} /></IconButton>
          : <IconButton label={$t('In eigenem Tab öffnen')} onClick={() => terminalInOwnTab(active.id)}><ArrowsOutSimple size={16} /></IconButton>}
        {!full && <IconButton label={$t('Terminal ausblenden')} onClick={() => toggleTerminal()}><CaretDown size={16} weight="bold" /></IconButton>}
      </div>
      <TerminalView key={active.id} id={active.id} />
    </section>
  );
}
