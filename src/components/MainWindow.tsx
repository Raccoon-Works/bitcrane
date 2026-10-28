/**
 * The Bitcrane main window: toolbar, the two halves, activity and info
 * column. No sidebar: servers are chosen inside a half and favourite folders
 * sit in each half's places bar (Transmit 5). On Windows a title bar with the
 * connection tabs sits on top.
 */
import { useRef, type CSSProperties } from 'react';
import { setState, updateSettings, useStore } from '../state/store';
import { ResizeHandle } from './ResizeHandle';
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '../util/appWindow';
import { Activity } from './Activity';
import { WinSystemMenu } from './AppMenu';
import { Inspector } from './Inspector';
import { Pane } from './Pane';
import { ConnectionTabs } from './Tabs';
import { Toolbar } from './Toolbar';
import { TrafficLights } from './TrafficLights';
import { $t } from '../i18n';
import { CheckCircle, Info, WarningCircle } from '@phosphor-icons/react';

function WinTitleBar() {
  return (
    <div
      className="win-titlebar"
      // Free space in the title bar moves the window; a double click maximizes (handled by Tauri).
      data-tauri-drag-region
      onContextMenu={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); setState({ appMenu: 'system' }); } }}
    >
      <WinSystemMenu />
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
  const panesRef = useRef<HTMLDivElement>(null);

  return (
    <div className="window" role="application" aria-label="Bitcrane">
      {platform === 'win' && <WinTitleBar />}
      {/* Mac: the title bar holds the window buttons and the tabs (Transmit); the toolbar sits below, as on Windows. */}
      {platform === 'mac' && (
        <div className="mac-titlebar" data-tauri-drag-region>
          <TrafficLights />
          <ConnectionTabs variant="mac" />
        </div>
      )}
      <div className="window-body">
          <div className="main-col">
            <Toolbar />
            <div className="content">
              <div className="content-main">
                <div className="panes" ref={panesRef} style={{ '--split': split } as CSSProperties}>
                  {swap ? <Pane side="remote" /> : <Pane side="local" />}
                  {/* The line between the halves: drag to share the width differently (double click: half and half). */}
                  <ResizeHandle orientation="vertical" label={$t('Breite der Hälften (ziehen, Doppelklick: zurücksetzen)')} value={split} min={0.2} max={0.8} step={0.02}
                    toValue={(start, d) => start + d / Math.max(1, panesRef.current?.offsetWidth ?? 1)}
                    onChange={(v) => updateSettings({ splitRatio: v })} onReset={() => updateSettings({ splitRatio: 0.5 })} className="split-handle" />
                  {swap ? <Pane side="local" /> : <Pane side="remote" />}
                </div>
                <Activity />
              </div>
              {inspector && <Inspector />}
            </div>
          </div>
      </div>
      {/* Neutral card; only a small symbol shows the kind of message (no coloured frame). */}
      {toast && (
        <div className={`toast tone-${toast.tone}`} role="status">
          {toast.tone === 'ok' ? <CheckCircle size={18} weight="fill" className="toast-icon" aria-hidden="true" />
            : toast.tone === 'error' ? <WarningCircle size={18} weight="fill" className="toast-icon" aria-hidden="true" />
              : <Info size={18} weight="fill" className="toast-icon" aria-hidden="true" />}
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
}
