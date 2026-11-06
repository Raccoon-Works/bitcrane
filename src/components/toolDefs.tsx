/**
 * The customisable tools of the toolbar: symbol, name, shortcut and action of
 * each (the toolbar and its customise dialog share them).
 */
import { $t } from '../i18n';
import { toggleCompareDirs } from '../state/tools';
import { useKeyLabel } from '../state/keys';
import {
  activeTab,
  activityExpanded,
  askDelete,
  copyPath,
  disconnect,
  download,
  goBack,
  newFolder,
  openDialog,
  refresh,
  startRename,
  toggleActivity,
  toggleHidden,
  toggleInspector,
  upload,
  useStore,
  type ToolId,
  getState,
  openInEditor,
  toggleSyncBrowse,
} from '../state/store';
import { toggleEditor, useEditor } from '../state/editor';
import { type ReactNode } from 'react';
import {
  ArrowClockwise,
  ArrowsClockwise,
  Code,
  Checks,
  Columns,
  CaretLeft,
  Command,
  Copy,
  DownloadSimple,
  EyeSlash,
  FolderSimplePlus,
  Info,
  LinkSimple,
  LockSimple,
  NotePencil,
  PencilSimple,
  Plugs,
  SquareHalfBottom,
  TerminalWindow,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { toggleTerminal } from '../state/terminal';

/** Platform-specific shortcut label. */
export function useKey() {
  const platform = useStore((s) => s.platform);
  return (mac: string, win: string) => (platform === 'mac' ? mac : win);
}

/** Icon and action for each customisable tool. */
export function useToolDefs(): Record<
  ToolId,
  {
    label: string;
    short?: string;
    key?: string;
    icon: ReactNode;
    run: () => void;
    active?: boolean;
    disabled?: boolean;
  }
> {
  const sk = useKeyLabel();
  const key = useKey();
  const inspector = useStore((s) => s.inspectorOpen);
  const terminalOpen = useStore((s) => !!s.tabs.find((t) => t.id === s.activeTabId)?.terminal?.open);
  const activity = useStore((s) => activityExpanded(s));
  const focus = useStore((s) => s.focusSide);
  const showHidden = useStore((s) => s.settings.showHidden);
  const tab = useStore((s) => activeTab(s));
  const selLocal = useStore((s) => s.selection.local.names.length);
  const selRemote = useStore((s) => s.selection.remote.names.length);
  const sel = focus === 'local' ? selLocal : selRemote;
  const compareOn = useStore((s) => s.compareDirs);
  const editorOpen = useEditor().open;
  return {
    nav: {
      label: $t('Zurück'),
      key: sk('back'),
      icon: <CaretLeft size={19} />,
      run: goBack,
      disabled: !tab?.back.length,
    },
    newFolder: {
      label: $t('Neuer Ordner'),
      key: sk('newFolder'),
      icon: <FolderSimplePlus size={19} />,
      run: () => newFolder(),
    },
    refresh: { label: $t('Aktualisieren'), key: sk('refresh'), icon: <ArrowClockwise size={19} />, run: refresh },
    info: {
      label: $t('Informationen'),
      short: $t('Info'),
      key: sk('inspector'),
      icon: <Info size={19} />,
      run: toggleInspector,
      active: inspector,
    },
    activity: {
      label: $t('Aktivität'),
      key: sk('activity'),
      icon: <SquareHalfBottom size={19} />,
      run: toggleActivity,
      active: activity,
    },
    upload: { label: $t('Hochladen'), icon: <UploadSimple size={19} />, run: () => upload(), disabled: !selLocal },
    download: {
      label: $t('Herunterladen'),
      key: sk('download'),
      icon: <DownloadSimple size={19} />,
      run: () => download(),
      disabled: !selRemote,
    },
    delete: {
      label: $t('Löschen'),
      key: key('⌘⌫', $t('Entf')),
      icon: <Trash size={19} />,
      run: () => askDelete(focus),
      disabled: !sel,
    },
    rename: {
      label: $t('Umbenennen'),
      key: key('↩', 'F2'),
      icon: <PencilSimple size={19} />,
      run: () => startRename(focus),
      disabled: !sel,
    },
    perms: { label: $t('Rechte'), icon: <LockSimple size={19} />, run: () => toggleInspector(), disabled: false },
    hidden: {
      label: showHidden ? $t('Versteckte Dateien ausblenden') : $t('Versteckte Dateien zeigen'),
      short: $t('Versteckte'),
      key: sk('hidden'),
      icon: <EyeSlash size={19} />,
      run: toggleHidden,
      active: !showHidden,
    },
    terminal: {
      label: $t('Terminal'),
      key: sk('terminal'),
      icon: <TerminalWindow size={19} />,
      run: () => toggleTerminal(),
      active: terminalOpen,
    },
    disconnect: { label: $t('Trennen'), icon: <Plugs size={19} />, run: () => disconnect() },
    copyPath: {
      label: $t('Pfad kopieren'),
      short: $t('Pfad'),
      key: sk('copyPath'),
      icon: <Copy size={19} />,
      run: () => copyPath(focus),
    },
    editor: {
      label: $t('Im Editor öffnen'),
      short: $t('Bearbeiten'),
      icon: <NotePencil size={19} />,
      run: () => {
        const n = getState().selection[focus].names[0];
        if (n) openInEditor(focus, n);
      },
      disabled: !sel,
    },
    codeEditor: {
      label: $t('Editor'),
      key: sk('codeEditor'),
      icon: <Code size={19} />,
      run: toggleEditor,
      active: editorOpen,
    },
    sync: {
      label: $t('Ordner abgleichen'),
      short: $t('Abgleichen'),
      icon: <ArrowsClockwise size={19} />,
      run: () => openDialog({ type: 'compare' }),
    },
    syncBrowse: {
      label: $t('Synchron blättern'),
      short: $t('Synchron'),
      key: sk('syncBrowse'),
      icon: <LinkSimple size={19} />,
      run: toggleSyncBrowse,
      active: !!tab?.syncBrowse,
    },
    palette: {
      label: $t('Befehle'),
      key: sk('palette'),
      icon: <Command size={19} />,
      run: () => openDialog({ type: 'palette' }),
    },
    compareDirs: {
      label: $t('Verzeichnisse vergleichen'),
      short: $t('Vergleichen'),
      key: sk('compareDirs'),
      icon: <Columns size={19} />,
      run: toggleCompareDirs,
      active: compareOn,
    },
    selectMask: {
      label: $t('Auswählen nach Muster'),
      short: $t('Auswählen'),
      key: sk('selectMask'),
      icon: <Checks size={19} />,
      run: () => openDialog({ type: 'selectMask', side: focus }),
    },
  };
}
