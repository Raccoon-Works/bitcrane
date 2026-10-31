/**
 * The Bitcrane main window: the sidebar over the full height (can be hidden),
 * then the tabs, the toolbar, the two halves, activity and info column.
 */
import { Sidebar } from './Sidebar';
import { useEditor } from '../state/editor';
import { lazy, Suspense, useRef, type CSSProperties } from 'react';

// The code editor (CodeMirror) loads when it is first opened, so starting Bitcrane stays quick.
const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })));
import { setState, updateSettings, useStore } from '../state/store';
import { ResizeHandle } from './ResizeHandle';
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '../util/appWindow';
import { Activity } from './Activity';
import { TerminalPanel } from './TerminalPanel';
import { WinSystemMenu } from './AppMenu';
import { Inspector } from './Inspector';
import { Pane } from './Pane';
import { ConnectionTabs } from './Tabs';
import { Toolbar } from './Toolbar';
import { SettingsPage } from './dialogs/Settings';
import { TrafficLights } from './TrafficLights';
import { $t } from '../i18n';
import { CheckCircle, DownloadSimple, Info, WarningCircle } from '@phosphor-icons/react';

function WinTitleBar({ menu = true }: { menu?: boolean }) {
  return (
    <div
      className="win-titlebar"
      // Free space in the title bar moves the window; a double click maximizes (handled by Tauri).
      data-tauri-drag-region
      onContextMenu={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); setState({ appMenu: 'system' }); } }}
    >
      {menu && <WinSystemMenu />}
      <ConnectionTabs variant="win" />
      <span className="flex-1 drag-area" data-tauri-drag-region />
      <div className="caption-buttons">
        <button type="button" tabIndex={-1} aria-label={$t('Minimieren')} onClick={minimizeWindow}><svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1"><path d="M0 5h10" /></svg></button>
        <button type="button" tabIndex={-1} aria-label={$t('Maximieren')} onClick={toggleMaximizeWindow}><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0.5" y="0.5" width="9" height="9" rx="1.5" /></svg></button>
        <button type="button" tabIndex={-1} aria-label={$t('Schließen')} className="is-close" onClick={closeWindow}><svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1"><path d="m0 0 10 10M10 0 0 10" /></svg></button>
      </div>
    </div>
  );
}

export function MainWindow() {
  const platform = useStore((s) => s.platform);
  const inspector = useStore((s) => s.inspectorOpen);
  const toast = useStore((s) => s.toast);
  const swap = useStore((s) => s.settings.swapSides);
  const split = useStore((s) => s.settings.splitRatio ?? 0.5);
  // "Hälften untereinander" (ForkLift): for narrow windows the halves can stack.
  const stacked = useStore((s) => !!s.settings.stackHalves);
  const sidebar = useStore((s) => s.settings.sidebar !== false);
  const sideWidth = useStore((s) => s.settings.sidebarWidth ?? 200);
  const panesRef = useRef<HTMLDivElement>(null);
  const settingsTab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.settings);
  const showSide = sidebar;
  // The built-in editor takes the place of the two halves while it is shown.
  const editorOpen = useEditor().open;
  const termFull = useStore((s) => !!s.tabs.find((t) => t.id === s.activeTabId)?.terminal?.full && s.terminals.some((x) => x.tabId === s.activeTabId));

  return (
    <div className="window" role="application" aria-label="Bitcrane">
      <div className="window-row">
        {/* Sidebar over the full height (Finder, ForkLift): the window buttons (Mac) or the
            Bitcrane menu (Windows) sit at its top, the tabs and the toolbar start right of it. */}
        {showSide && (
          <>
            <div className="side-col" style={{ width: sideWidth }}>
              <div className="side-top" data-tauri-drag-region>
                {platform === 'mac' ? <TrafficLights /> : <WinSystemMenu />}
              </div>
              <Sidebar />
            </div>
            <ResizeHandle orientation="vertical" label={$t('Breite der Seitenleiste (ziehen, Doppelklick: zurücksetzen)')} value={sideWidth} min={150} max={340} step={10}
              toValue={(start, d) => start + d} onChange={(v) => updateSettings({ sidebarWidth: Math.round(v) })} onReset={() => updateSettings({ sidebarWidth: 200 })} className="side-handle" />
          </>
        )}
        <div className="window-col">
      {platform === 'win' && <WinTitleBar menu={!showSide} />}
      {/* Mac: the title bar holds the window buttons and the tabs (Transmit); the toolbar sits below, as on Windows. */}
      {platform === 'mac' && (
        <div className="mac-titlebar" data-tauri-drag-region>
          {!showSide && <TrafficLights />}
          <ConnectionTabs variant="mac" />
        </div>
      )}
      <div className="window-body">
          {settingsTab ? <SettingsPage section={settingsTab} /> : <div className="main-col">
            <Toolbar />
            <div className="content">
              <div className="content-main">
                {/* A terminal in a tab of its own fills the place of the two halves. */}
                {editorOpen && !termFull && <Suspense fallback={<div className="code-editor" />}><CodeEditor /></Suspense>}
                {!termFull && !editorOpen && <div className={`panes${stacked ? ' is-stacked' : ''}`} ref={panesRef} style={{ '--split': split } as CSSProperties}>
                  {swap ? <Pane side="remote" /> : <Pane side="local" />}
                  {/* The line between the halves: drag to share the width differently (double click: half and half). */}
                  <ResizeHandle orientation={stacked ? 'horizontal' : 'vertical'} label={stacked ? $t('Höhe der Hälften (ziehen, Doppelklick: zurücksetzen)') : $t('Breite der Hälften (ziehen, Doppelklick: zurücksetzen)')} value={split} min={0.2} max={0.8} step={0.02}
                    toValue={(start, d) => start + d / Math.max(1, (stacked ? panesRef.current?.offsetHeight : panesRef.current?.offsetWidth) ?? 1)}
                    onChange={(v) => updateSettings({ splitRatio: v })} onReset={() => updateSettings({ splitRatio: 0.5 })} className="split-handle" />
                  {swap ? <Pane side="local" /> : <Pane side="remote" />}
                </div>}
                <TerminalPanel />
                {!termFull && <Activity />}
              </div>
              {inspector && <Inspector />}
            </div>
          </div>}
      </div>
        </div>
      </div>
      {/* Neutral card in the normal text colour; only the small symbol shows the kind of message. */}
      {toast && (
        <div className={`toast toast-${toast.tone}`} role="status">
          {toast.tone === 'ok' ? <CheckCircle size={18} className="toast-icon" aria-hidden="true" />
            : toast.tone === 'error' ? <WarningCircle size={18} className="toast-icon" aria-hidden="true" />
              : toast.tone === 'update' ? <DownloadSimple size={18} className="toast-icon" aria-hidden="true" />
                : <Info size={18} className="toast-icon" aria-hidden="true" />}
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
}
