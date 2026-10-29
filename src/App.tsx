/**
 * Root component: page background, scaled stage with the app window,
 * dialogs, global keyboard shortcuts and the prototype control bar.
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import { MacMenuBar } from './components/AppMenu';
import { ContextMenu } from './components/ContextMenu';
import { AuthPrompt, CloudPlacesDialog, ConfirmDialog, ConflictDialog, About, Licenses, UpdateDialog, ConfirmDelete, Fingerprint, PermsDialog, QuickConnect, SecretPrompt, Shortcuts } from './components/dialogs/SmallDialogs';
import { DiffDialog, CompareFilesDialog } from './components/dialogs/DiffDialog';
import { ChecksumDialog, EditsDialog, SymlinkDialog } from './components/dialogs/FileTools';
import { Palette } from './components/dialogs/Palette';
import { ExportDialog, ImportPasswordDialog } from './components/dialogs/ExportDialogs';
import { LogDialog } from './components/dialogs/LogDialog';
import { PreviewDialog } from './components/dialogs/PreviewDialog';
import { BatchRename } from './components/dialogs/BatchRename';
import { AfterQueueDialog, CloudSignInDialog, MergeFoldersDialog, SelectMaskDialog, WorkspacesDialog } from './components/dialogs/ToolDialogs';
import { CompareDialog } from './components/dialogs/CompareDialog';
import { ImportDialog } from './components/dialogs/ImportDialog';
import { ServerEdit } from './components/dialogs/ServerEdit';
import { SettingsDialog } from './components/dialogs/Settings';
import { ToolbarCustomize } from './components/dialogs/ToolbarCustomize';
import { TransfersDialog } from './components/dialogs/Transfers';
import { WatchSetup } from './components/dialogs/WatchSetup';
import { MainWindow } from './components/MainWindow';
import { MenuBarWindow } from './components/MenuBarWindow';
import { PrototypeBar } from './components/PrototypeBar';
import { STAGE_ID } from './components/stage';
import { activeTab, copySelection, getState, LIVE, pasteClipboard, setState, startSimulation, useStore } from './state/store';
import { actionFor } from './state/keys';
import { startAfterQueueWatch } from './state/tools';

/** Smallest size at which the window is laid out; smaller screens scale it down. */
const MIN_W = LIVE ? 960 : 1100;
const MIN_H = LIVE ? 600 : 680;
/** Height of the prototype control bar (not shown in the app). */
const BAR_H = LIVE ? 0 : 44;

function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.type) {
    case 'watchSetup': return <WatchSetup key={dialog.editId ?? 'new'} editId={dialog.editId} />;
    case 'serverEdit': return <ServerEdit key={dialog.serverId ?? 'new'} serverId={dialog.serverId} />;
    case 'quickConnect': return <QuickConnect />;
    case 'fingerprint': return <Fingerprint mode={dialog.mode} keyInfo={dialog.key} serverId={dialog.serverId} />;
    case 'conflict': return <ConflictDialog />;
    case 'perms': return <PermsDialog key={dialog.path} side={dialog.side} path={dialog.path} />;
    case 'settings': return <SettingsDialog tab={dialog.tab} />;
    case 'about': return <About />;
    case 'licenses': return <Licenses />;
    case 'update': return <UpdateDialog />;
    case 'toolbar': return <ToolbarCustomize />;
    case 'transfers': return <TransfersDialog />;
    case 'confirmDelete': return <ConfirmDelete side={dialog.side} names={dialog.names} />;
    case 'shortcuts': return <Shortcuts />;
    case 'checksum': return <ChecksumDialog side={dialog.side} name={dialog.name} />;
    case 'symlink': return <SymlinkDialog target={dialog.target} />;
    case 'palette': return <Palette />;
    case 'edits': return <EditsDialog />;
    case 'exportConfig': return <ExportDialog />;
    case 'importPassword': return <ImportPasswordDialog sealed={dialog.sealed} />;
    case 'compareFiles': return <CompareFilesDialog a={dialog.a} b={dialog.b} />;
    case 'confirm': return <ConfirmDialog title={dialog.title} text={dialog.text} confirm={dialog.confirm} danger={dialog.danger} run={dialog.run} />;
    case 'diff': return <DiffDialog transferId={dialog.transferId} />;
    case 'log': return <LogDialog />;
    case 'preview': return <PreviewDialog side={dialog.side} />;
    case 'batchRename': return <BatchRename side={dialog.side} names={dialog.names} />;
    case 'selectMask': return <SelectMaskDialog side={dialog.side} />;
    case 'afterQueue': return <AfterQueueDialog action={dialog.action} />;
    case 'workspaces': return <WorkspacesDialog />;
    case 'cloudSignIn': return <CloudSignInDialog service={dialog.service} serverId={dialog.serverId} />;
    case 'mergeFolders': return <MergeFoldersDialog fromDir={dialog.fromDir} names={dialog.names} toDir={dialog.toDir} move={dialog.move} clashes={dialog.clashes} />;
    case 'compare': return <CompareDialog key={dialog.favoriteId ?? 'new'} favoriteId={dialog.favoriteId} />;
    case 'import': return <ImportDialog />;
    case 'cloudPlaces': return <CloudPlacesDialog found={dialog.found} />;
    case 'authPrompt': return <AuthPrompt key={dialog.id} id={dialog.id} host={dialog.host} name={dialog.name} instructions={dialog.instructions} prompts={dialog.prompts} />;
    case 'secret': return <SecretPrompt key={dialog.serverId + dialog.kind} serverId={dialog.serverId} kind={dialog.kind} wrong={dialog.wrong} />;
  }
}

/** Global shortcuts (see state/keys.ts; the user can change them). */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
      if (s.dialog) return;
      if (e.key === 'Escape') {
        if (s.popoverOpen || s.contextMenu || s.appMenu || s.menuBarWindowOpen) setState({ popoverOpen: false, contextMenu: null, appMenu: null, menuBarWindowOpen: false });
        return;
      }
      if (s.firstRun) return;
      const action = actionFor(e, s.platform, typing);
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        action.run();
        return;
      }
      if (!typing && activeTab() && !document.activeElement?.closest('[role="listbox"]') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        // Arrow keys anywhere in the window move into the focused pane.
        const list = document.querySelector<HTMLElement>(`.pane[data-side="${s.focusSide}"] [role="listbox"]`);
        list?.focus();
      }
    };
    // Windows convention: pressing and releasing Alt alone opens the app menu.
    let altAlone = false;
    const onDownAlt = (e: KeyboardEvent) => { altAlone = e.key === 'Alt'; };
    const onUpAlt = (e: KeyboardEvent) => {
      const s = getState();
      if (e.key === 'Alt' && altAlone && s.platform === 'win' && !s.dialog && !s.firstRun) {
        e.preventDefault();
        setState({ appMenu: s.appMenu === 'win' ? null : 'win' });
      }
      altAlone = false;
    };
    // ⌘C / ⌘V can also arrive as copy and paste events from the system menu.
    const inList = () => !!document.activeElement?.closest('[role="listbox"]');
    const onCopy = (e: ClipboardEvent) => { if (inList() && !getState().dialog) { e.preventDefault(); copySelection(getState().focusSide); } };
    const onPaste = (e: ClipboardEvent) => { if (inList() && !getState().dialog) { e.preventDefault(); pasteClipboard(getState().focusSide); } };
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onDownAlt, true);
    window.addEventListener('keyup', onUpAlt, true);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keydown', onDownAlt, true);
      window.removeEventListener('keyup', onUpAlt, true);
    };
  }, []);
}

/** Fits the stage into the viewport, scaling down below the minimum size. */
function useStageSize(platform: string) {
  const [size, setSize] = useState({ w: 1280, h: 800, scale: 1 });
  useLayoutEffect(() => {
    const update = () => {
      const menu = platform === 'mac' && !LIVE ? 26 : 0;
      const availW = window.innerWidth;
      const availH = window.innerHeight - BAR_H;
      const scale = Math.min(1, availW / MIN_W, availH / (MIN_H + menu));
      setSize({ w: Math.max(MIN_W, availW / scale), h: Math.max(MIN_H + menu, availH / scale), scale });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [platform]);
  return size;
}

export default function App() {
  const platform = useStore((s) => s.platform);
  const theme = useStore((s) => s.theme);
  const palette = useStore((s) => (s.palette === 'auto' ? (s.platform === 'win' ? 'explorer' : 'transmit') : s.palette));
  const { w, h, scale } = useStageSize(platform);
  useShortcuts();
  // "Nach Abschluss": watches the transfer queue for the chosen action.
  useEffect(() => { const off = startAfterQueueWatch(); return () => { off(); }; }, []);
  useEffect(() => {
    startSimulation();
    if (LIVE) {
      void import('./state/shell').then((m) => m.startShell());
      void import('./util/dragDrop').then((m) => m.startNativeDrop());
    }
  }, []);
  // Window zoom (Strg + Plus/Minus, Einstellungen > Darstellung): the app zooms its web view
  // like a browser, so everything grows evenly. The browser prototype only shows the step.
  const zoom = useStore((s) => s.settings.zoom ?? 1);
  useEffect(() => {
    if (LIVE) void import('@tauri-apps/api/webview').then((m) => m.getCurrentWebview().setZoom(zoom)).catch(() => undefined);
  }, [zoom]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.platform = platform;
  }, [theme, platform]);

  return (
    <div className={`page${LIVE ? ' is-app' : ''}`} data-platform={platform} data-theme={theme} data-palette={palette}>
      <div className="stage-wrap" style={{ height: `calc(100vh - ${BAR_H}px)` }}>
        <div id={STAGE_ID} data-scale={scale} className="stage" style={{ width: w, height: h, transform: `scale(${scale})` }}>
          {platform === 'mac' && !LIVE && <MacMenuBar />}
          <div className="window-area">
            <MainWindow />
            <Dialogs />
          </div>
          <ContextMenu />
          <MenuBarWindow />
        </div>
      </div>
      {!LIVE && <PrototypeBar />}
    </div>
  );
}

