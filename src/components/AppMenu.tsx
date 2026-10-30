/**
 * Application menus.
 *
 * On the Mac the menus live in the system menu bar at the top of the screen;
 * the prototype draws that bar above the window. On Windows the same menus
 * open from the "…" button at the right of the toolbar (as in Explorer and
 * Edge) and with the Alt key; the icon in the title bar keeps the system menu.
 */
import { checkForUpdates } from '../state/updates';
import { invertSelection, toggleCompareDirs } from '../state/tools';
import { ChevronRight } from './glyphs';
import { GearSix, List } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import {
  activeTab, askDelete, closeTab, copySelection, editPath, getState, pasteClipboard, setDeepSearch, toggleSyncBrowse, selectAll, copyPath, download, goBack, goForward, goUp, newFile, newFolder, undoLast, updateSettings, newTab, openDialog, pauseAllTransfers, pauseAllWatches,
  addBookmark, exportConfig, importConfig, refresh, runWatchCommand, setState, toggleActivity, togglePermsColumn, toggleSwapSides, toggleHidden, toggleInspector, togglePopover, upload, useStore, setViewMode, setPaneServerList,
} from '../state/store';
import { closeWindow, minimizeWindow, quitApp, toggleMaximizeWindow } from '../util/appWindow';
import { formatTime } from '../util/format';
import { keyLabel } from '../state/keys';
import { BMark } from './icons';
import { Tooltip } from './ui';
import { $t, LOCALE, menuText } from '../i18n';

export interface MenuItem { label: string; mac?: string; win?: string; run?: () => void; danger?: boolean; sep?: boolean }
export interface MenuDef { id: string; label: string; items: MenuItem[] }

const sep: MenuItem = { label: '', sep: true };
/** Shortcut labels of an action for both platforms (they follow the user's settings). */
const sc = (id: string) => ({ mac: keyLabel(id, 'mac'), win: keyLabel(id, 'win') });

/** All application menus with their shortcuts (design system, section 13). */
export function menuDefs(): MenuDef[] {
  // Menus run outside React render, so they read the current state directly.
  const focus = () => getState().focusSide;
  return [
    {
      id: 'app', label: 'Bitcrane', items: [
        { label: $t('Über Bitcrane'), run: () => openDialog({ type: 'about' }) },
        { label: $t('Nach Updates suchen …'), run: () => void checkForUpdates(true) },
        sep,
        { label: $t('Einstellungen …'), ...sc('settings'), run: () => openDialog({ type: 'settings', tab: 'general' }) },
        { label: $t('Werkzeugleiste anpassen …'), run: () => openDialog({ type: 'toolbar' }) },
        sep,
        { label: $t('Bitcrane beenden'), mac: '⌘Q', win: 'Alt+F4', run: quitApp },
      ],
    },
    {
      id: 'file', label: $t('Ablage'), items: [
        { label: $t('Neuer Tab'), ...sc('newTab'), run: newTab },
        { label: $t('Schnell verbinden …'), ...sc('quickConnect'), run: () => openDialog({ type: 'quickConnect' }) },
        { label: $t('Neue SSH-Verbindung …'), run: () => openDialog({ type: 'quickConnect', terminal: true }) },
        sep,
        { label: $t('Neuer Ordner'), ...sc('newFolder'), run: () => newFolder() },
        { label: $t('Neue Datei'), ...sc('newFile'), run: () => newFile() },
        { label: $t('Hochladen'), ...sc('upload'), run: () => upload() },
        { label: $t('Herunterladen'), ...sc('download'), run: () => download() },
        sep,
        { label: $t('Tab schließen'), ...sc('closeTab'), run: () => { const t = activeTab(); if (t) closeTab(t.id); } },
        { label: $t('Arbeitsbereiche …'), ...sc('workspaces'), run: () => openDialog({ type: 'workspaces' }) },
        sep,
        { label: $t('Server und Überwachungen exportieren …'), run: () => void exportConfig() },
        { label: $t('Exportdatei importieren …'), run: () => void importConfig() },
      ],
    },
    {
      id: 'edit', label: $t('Bearbeiten'), items: [
        { label: $t('Widerrufen'), ...sc('undo'), run: undoLast },
        sep,
        { label: $t('Kopieren'), ...sc('copy'), run: () => copySelection(focus()) },
        { label: $t('Einfügen'), ...sc('paste'), run: () => pasteClipboard(focus()) },
        { label: $t('Pfad kopieren'), ...sc('copyPath'), run: () => copyPath(focus()) },
        { label: $t('Alles auswählen'), mac: '⌘A', win: 'Strg+A', run: () => selectAll(focus()) },
        { label: $t('Auswählen nach Muster …'), ...sc('selectMask'), run: () => openDialog({ type: 'selectMask', side: focus() }) },
        { label: $t('Auswahl umkehren'), ...sc('invertSelection'), run: () => invertSelection(focus()) },
        sep,
        { label: $t('Löschen …'), mac: '⌘⌫', win: 'Entf', run: () => askDelete(focus()), danger: true },
      ],
    },
    {
      id: 'view', label: $t('Darstellung'), items: [
        { label: $t('Als Liste'), ...sc('viewList'), run: () => setViewMode(focus(), 'list') },
        { label: $t('Als Symbole'), ...sc('viewIcons'), run: () => setViewMode(focus(), 'icons') },
        { label: $t('Als Spalten'), ...sc('viewColumns'), run: () => setViewMode(focus(), 'columns') },
        { label: $t('Serverliste zeigen'), run: () => setPaneServerList(focus(), true) },
        sep,
        { label: $t('Info-Spalte ein/aus'), ...sc('inspector'), run: toggleInspector },
        { label: $t('Aktivität ein/aus'), ...sc('activity'), run: toggleActivity },
        sep,
        { label: $t('Versteckte Dateien ein/aus'), ...sc('hidden'), run: toggleHidden },
        { label: $t('Spalte „Rechte“ ein/aus'), run: togglePermsColumn },
        { label: $t('Seiten tauschen'), run: toggleSwapSides },
        { label: $t('Seitenleiste ein/aus'), ...sc('sidebar'), run: () => updateSettings({ sidebar: getState().settings.sidebar === false }) },
        { label: $t('Hälften untereinander ein/aus'), run: () => updateSettings({ stackHalves: !getState().settings.stackHalves }) },
        { label: $t('Synchron blättern'), ...sc('syncBrowse'), run: toggleSyncBrowse },
        { label: $t('Verzeichnisse vergleichen'), ...sc('compareDirs'), run: toggleCompareDirs },
        { label: $t('Suche in Unterordnern'), ...sc('deepSearch'), run: () => setDeepSearch(!getState().deepSearchOn) },
        { label: $t('Aktualisieren'), ...sc('refresh'), run: refresh },
      ],
    },
    {
      id: 'go', label: $t('Gehe zu'), items: [
        { label: $t('Zurück'), ...sc('back'), run: goBack },
        { label: $t('Vor'), ...sc('forward'), run: goForward },
        { label: $t('Übergeordneter Ordner'), mac: '⌘↑', win: 'Alt+↑', run: () => goUp(focus()) },
        sep,
        { label: $t('Pfad eingeben …'), ...sc('editPath'), run: () => editPath(focus()) },
        sep,
        { label: $t('Ordner zu den Orten hinzufügen'), ...sc('bookmark'), run: addBookmark },
      ],
    },
    {
      id: 'server', label: $t('Server'), items: [
        { label: $t('Server hinzufügen …'), run: () => openDialog({ type: 'serverEdit' }) },
        { label: $t('Server importieren …'), run: () => openDialog({ type: 'import' }) },
        { label: $t('Diesen Server bearbeiten …'), run: () => openDialog({ type: 'serverEdit', serverId: activeTab()?.serverId }) },
        sep,
        { label: $t('Terminal ein/aus'), ...sc('terminal'), run: () => void import('../state/terminal').then((m) => m.toggleTerminal()) },
        { label: $t('Neues SSH-Terminal'), ...sc('terminalNew'), run: () => void import('../state/terminal').then((m) => m.newTerminal('server')) },
        { label: $t('Neues lokales Terminal'), run: () => void import('../state/terminal').then((m) => m.newTerminal('local')) },
        sep,
        { label: $t('Ordner abgleichen …'), run: () => openDialog({ type: 'compare' }) },
        { label: $t('Bearbeitete Dateien …'), run: () => openDialog({ type: 'edits' }) },
        sep,
        { label: $t('Alle Übertragungen pausieren'), run: pauseAllTransfers },
        { label: $t('Übertragungen …'), ...sc('transfers'), run: () => openDialog({ type: 'transfers' }) },
      ],
    },
    {
      id: 'watch', label: $t('Überwachung'), items: [
        { label: $t('Neue Überwachung …'), ...sc('newWatch'), run: () => openDialog({ type: 'watchSetup' }) },
        { label: $t('Überwachung für diesen Tab starten'), ...sc('watchTab'), run: () => openDialog({ type: 'watchSetup' }) },
        sep,
        { label: $t('Alle pausieren oder fortsetzen'), ...sc('pauseWatches'), run: pauseAllWatches },
        sep,
        { label: $t('Testlauf …'), run: () => openDialog({ type: 'watchSetup' }) },
        { label: $t('Befehl nach dem Hochladen jetzt ausführen'), run: () => runWatchCommand() },
        sep,
        { label: $t('Übersicht der Überwachungen'), ...sc('watchOverview'), run: togglePopover },
      ],
    },
    {
      id: 'help', label: $t('Hilfe'), items: [
        { label: $t('Befehle suchen …'), ...sc('palette'), run: () => openDialog({ type: 'palette' }) },
        { label: $t('Tastenkürzel'), ...sc('shortcuts'), run: () => openDialog({ type: 'shortcuts' }) },
        { label: $t('Protokoll'), run: () => openDialog({ type: 'log' }) },
        { label: $t('Über Bitcrane'), run: () => openDialog({ type: 'about' }) },
      ],
    },
  ];
}

function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const platform = useStore((s) => s.platform);
  return (
    <>
      {items.map((it, i) =>
        it.sep ? <div key={`sep${i}`} className="menu-sep" role="separator" /> : (
          <button key={it.label} type="button" role="menuitem" className={`menu-item${it.danger ? ' is-danger' : ''}`} disabled={!it.run} onClick={() => { onClose(); it.run?.(); }}>
            <span className="flex-1">{menuText(it.label)}</span>
            {(platform === 'mac' ? it.mac : it.win) && <span className="menu-key">{platform === 'mac' ? it.mac : it.win}</span>}
          </button>
        ),
      )}
    </>
  );
}

function useCloseOnOutside(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, ref, close]);
}

/** Simulated macOS menu bar above the window. */
export function MacMenuBar() {
  const open = useStore((s) => s.appMenu);
  const now = useStore((s) => s.now);
  const trayOpen = useStore((s) => s.menuBarWindowOpen);
  const running = useStore((s) => s.transfers.some((t) => t.state === 'running'));
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setState({ appMenu: null });
  useCloseOnOutside(!!open, ref, close);
  const defs = menuDefs();
  const d = new Date(now);
  const day = d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  return (
    <div className="mac-menubar" ref={ref} role="menubar" aria-label={$t('Menüleiste')}>
      <span className="apple" aria-hidden="true"></span>
      {defs.map((m) => (
        <div key={m.id} className="menubar-anchor">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === m.id}
            className={`menubar-item${m.id === 'app' ? ' is-app' : ''}${open === m.id ? ' is-open' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); setState({ appMenu: open === m.id ? null : m.id }); }}
            onMouseEnter={() => open && open !== m.id && setState({ appMenu: m.id })}
          >
            {m.label}
          </button>
          {open === m.id && (
            <div role="menu" className="menu menubar-menu">
              <MenuList items={m.items} onClose={close} />
            </div>
          )}
        </div>
      ))}
      <span className="flex-1" />
      <button type="button" className={`menubar-extra${trayOpen ? ' is-open' : ''}`} aria-label={$t('Bitcrane in der Menüleiste')} onClick={() => setState((s) => ({ menuBarWindowOpen: !s.menuBarWindowOpen }))}>
        <BMark variant="mono" size={16} />
        {running && <span className="extra-dot" />}
      </button>
      <span className="menubar-clock">{day}  {formatTime(now)}</span>
    </div>
  );
}

/**
 * Windows: system window menu on the app icon (Microsoft title bar guideline:
 * a click on the icon shows the system menu, a double-click closes the window).
 */
export function WinSystemMenu() {
  const open = useStore((s) => s.appMenu === 'system');
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setState({ appMenu: null });
  useCloseOnOutside(open, ref, close);
  // On top: help and program information (an idea from review: what many programs keep behind
  // their icon); below them the usual window commands of Windows.
  const items: MenuItem[] = [
    { label: $t('Befehle suchen …'), ...sc('palette'), run: () => openDialog({ type: 'palette' }) },
    { label: $t('Tastenkürzel'), ...sc('shortcuts'), run: () => openDialog({ type: 'shortcuts' }) },
    { label: $t('Protokoll'), run: () => openDialog({ type: 'log' }) },
    sep,
    { label: $t('Nach Updates suchen …'), run: () => void checkForUpdates(true) },
    { label: $t('Über Bitcrane'), run: () => openDialog({ type: 'about' }) },
    sep,
    { label: $t('Minimieren'), run: minimizeWindow },
    { label: $t('Maximieren / Wiederherstellen'), run: toggleMaximizeWindow },
    sep,
    { label: $t('Schließen'), win: 'Alt+F4', run: closeWindow },
  ];
  return (
    <div className="win-menu-anchor" ref={ref}>
      <button type="button" className="win-logo-btn" aria-label={$t('Fenstermenü')} aria-haspopup="menu" aria-expanded={open} onClick={() => setState({ appMenu: open ? null : 'system' })} onDoubleClick={closeWindow}>
        <BMark variant="winApp" size={24} />
      </button>
      {open && (
        <div role="menu" className="menu win-system-menu">
          <MenuList items={items} onClose={close} />
        </div>
      )}
    </div>
  );
}

/**
 * Windows: the application menu behind a "More" button at the right end of
 * the toolbar (as in Explorer and Edge). Frequent commands sit on top, the
 * full menus open as submenus. Pressing and releasing Alt opens it as well.
 */
export function WinMoreMenu() {
  const open = useStore((s) => s.appMenu === 'win');
  const [sub, setSub] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => { setSub(null); setState({ appMenu: null }); };
  useCloseOnOutside(open, ref, close);
  const defs = menuDefs();
  const byId = (id: string) => defs.find((m) => m.id === id)!;
  const top: MenuItem[] = [
    { label: $t('Neuer Tab'), win: 'Strg+T', run: newTab },
    { label: $t('Schnell verbinden …'), win: 'Strg+K', run: () => openDialog({ type: 'quickConnect' }) },
    { label: $t('Neue SSH-Verbindung …'), run: () => openDialog({ type: 'quickConnect', terminal: true }) },
    { label: $t('Neue Überwachung …'), win: 'Strg+U', run: () => openDialog({ type: 'watchSetup' }) },
    { label: $t('Übertragungen …'), win: 'Strg+Alt+T', run: () => openDialog({ type: 'transfers' }) },
  ];
  // Help, updates and "Über Bitcrane" moved to the B in the title bar; settings have their own button.
  const subs = ['file', 'edit', 'view', 'go', 'server', 'watch'];
  const bottom: MenuItem[] = [
    { label: $t('Werkzeugleiste anpassen …'), run: () => openDialog({ type: 'toolbar' }) },
  ];
  return (
    <div className="more-anchor" ref={ref}>
      {/* Settings in one click (gear), next to the main menu (three lines), both as tool buttons. */}
      <span className="tool-group more-group">
        <Tooltip text={$t('Einstellungen')} shortcut="Strg+,">
          <button type="button" className="icon-btn" aria-label={$t('Einstellungen')} onClick={() => { close(); openDialog({ type: 'settings', tab: 'general' }); }}>
            <GearSix size={19} />
          </button>
        </Tooltip>
        <Tooltip text={$t('Menü')} shortcut="Alt">
          <button type="button" className={`icon-btn${open ? ' is-on' : ''}`} aria-label={$t('Menü')} aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close() : setState({ appMenu: 'win' }))}>
            <List size={19} />
          </button>
        </Tooltip>
      </span>
      {open && (
        <div role="menu" className="menu more-menu" onMouseLeave={() => setSub(null)}>
          <MenuList items={top} onClose={close} />
          <div className="menu-sep" role="separator" />
          {subs.map((id) => {
            const m = byId(id);
            return (
              <div key={id} className="submenu-anchor" onMouseEnter={() => setSub(id)}>
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={sub === id}
                  className={`menu-item${sub === id ? ' is-hl' : ''}`}
                  onClick={() => setSub(sub === id ? null : id)}
                  onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setSub(id); } }}
                >
                  <span className="flex-1">{m.label}</span>
                  <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
                </button>
                {sub === id && (
                  <div role="menu" className="menu submenu">
                    <MenuList items={m.items} onClose={close} />
                  </div>
                )}
              </div>
            );
          })}
          <div className="menu-sep" role="separator" />
          <MenuList items={bottom} onClose={close} />
        </div>
      )}
    </div>
  );
}
