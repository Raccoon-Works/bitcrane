/**
 * The application menus: one definition for the Mac menu bar, the Windows "…"
 * menu and the native Mac menu (see shell.ts).
 */
import { $t } from '../i18n';
import { keyLabel } from './keys';
import { quitApp } from '../util/appWindow';
import {
  computeFolderSizes,
  newFolderWithSelection,
  selectedNames,
  setSearchContent,
  showToast,
  pasteMove,
  goLocal,
  openInOtherHalf,
  revealSelection,
  openTerminal,
  activeTab,
  askDelete,
  stepZoom,
  closeTab,
  copySelection,
  cutSelection,
  editPath,
  getState,
  pasteClipboard,
  setDeepSearch,
  toggleSyncBrowse,
  selectAll,
  copyPath,
  download,
  goBack,
  goForward,
  goUp,
  newFile,
  newFolder,
  undoLast,
  updateSettings,
  newTab,
  openDialog,
  pauseAllTransfers,
  pauseAllWatches,
  addBookmark,
  exportConfig,
  importConfig,
  refresh,
  runWatchCommand,
  toggleActivity,
  togglePermsColumn,
  toggleSwapSides,
  toggleHidden,
  toggleInspector,
  togglePopover,
  upload,
  setViewMode,
  setPaneServerList,
  toggleSingleHalf,
  focusOtherHalf,
} from './store';
import { invertSelection, toggleCompareDirs } from './tools';
import { checkForUpdates } from './updates';

export interface MenuItem {
  label: string;
  mac?: string;
  win?: string;
  run?: () => void;
  danger?: boolean;
  sep?: boolean;
}
export interface MenuDef {
  id: string;
  label: string;
  items: MenuItem[];
}

/** A separator line between groups of entries. */
export const sep: MenuItem = { label: '', sep: true };
/** Shortcut labels of an action for both platforms (they follow the user's settings). */
export const sc = (id: string) => ({ mac: keyLabel(id, 'mac'), win: keyLabel(id, 'win') });

/** All application menus with their shortcuts (design system, section 13). */
export function menuDefs(): MenuDef[] {
  // Menus run outside React render, so they read the current state directly.
  const focus = () => getState().focusSide;
  return [
    {
      id: 'app',
      label: 'Bitcrane',
      items: [
        { label: $t('Über Bitcrane'), run: () => openDialog({ type: 'about' }) },
        { label: $t('Nach Updates suchen …'), run: () => void checkForUpdates(true) },
        sep,
        {
          label: $t('Einstellungen …'),
          ...sc('settings'),
          run: () => openDialog({ type: 'settings', tab: 'general' }),
        },
        { label: $t('Werkzeugleiste anpassen …'), run: () => openDialog({ type: 'toolbar' }) },
        sep,
        { label: $t('Bitcrane beenden'), mac: '⌘Q', win: 'Alt+F4', run: quitApp },
      ],
    },
    {
      id: 'file',
      label: $t('Ablage'),
      items: [
        { label: $t('Neuer Tab'), ...sc('newTab'), run: newTab },
        { label: $t('Schnell verbinden …'), ...sc('quickConnect'), run: () => openDialog({ type: 'quickConnect' }) },
        { label: $t('Neue SSH-Verbindung …'), run: () => openDialog({ type: 'quickConnect', terminal: true }) },
        sep,
        { label: $t('Neuer Ordner'), ...sc('newFolder'), run: () => newFolder() },
        { label: $t('Neue Datei'), ...sc('newFile'), run: () => newFile() },
        {
          label: $t('Neuer Ordner mit Auswahl'),
          ...sc('newFolderWithSelection'),
          run: () => void newFolderWithSelection(),
        },
        { label: $t('Hochladen'), ...sc('upload'), run: () => upload() },
        { label: $t('Herunterladen'), ...sc('download'), run: () => download() },
        sep,
        {
          label: getState().platform === 'mac' ? $t('Im Finder zeigen') : $t('Im Explorer zeigen'),
          run: () => revealSelection(focus()),
        },
        { label: $t('Im Terminal öffnen'), run: () => openTerminal(focus()) },
        {
          label: $t('Prüfsumme …'),
          ...sc('checksum'),
          run: () => {
            const side = focus();
            const n = selectedNames(side);
            if (n.length === 1) openDialog({ type: 'checksum', side, name: n[0] });
            else showToast($t('Bitte genau eine Datei auswählen.'));
          },
        },
        {
          label: $t('Ordnergrößen berechnen'),
          ...sc('folderSizes'),
          run: () =>
            void computeFolderSizes(focus(), selectedNames(focus()).length ? selectedNames(focus()) : undefined),
        },
        sep,
        {
          label: $t('Tab schließen'),
          ...sc('closeTab'),
          run: () => {
            const t = activeTab();
            if (t) closeTab(t.id);
          },
        },
        { label: $t('Arbeitsbereiche …'), ...sc('workspaces'), run: () => openDialog({ type: 'workspaces' }) },
        sep,
        { label: $t('Server und Überwachungen exportieren …'), run: () => void exportConfig() },
        { label: $t('Exportdatei importieren …'), run: () => void importConfig() },
      ],
    },
    {
      id: 'edit',
      label: $t('Bearbeiten'),
      items: [
        { label: $t('Widerrufen'), ...sc('undo'), run: undoLast },
        sep,
        { label: $t('Ausschneiden'), ...sc('cut'), run: () => cutSelection(focus()) },
        { label: $t('Kopieren'), ...sc('copy'), run: () => copySelection(focus()) },
        { label: $t('Einfügen'), ...sc('paste'), run: () => pasteClipboard(focus()) },
        { label: $t('Hierher bewegen'), ...sc('pasteMove'), run: () => pasteMove(focus()) },
        { label: $t('Pfad kopieren'), ...sc('copyPath'), run: () => copyPath(focus()) },
        { label: $t('Alles auswählen'), mac: '⌘A', win: 'Strg+A', run: () => selectAll(focus()) },
        {
          label: $t('Auswählen nach Muster …'),
          ...sc('selectMask'),
          run: () => openDialog({ type: 'selectMask', side: focus() }),
        },
        { label: $t('Auswahl umkehren'), ...sc('invertSelection'), run: () => invertSelection(focus()) },
        sep,
        { label: $t('Löschen …'), mac: '⌘⌫', win: 'Entf', run: () => askDelete(focus()), danger: true },
      ],
    },
    {
      id: 'view',
      label: $t('Darstellung'),
      items: [
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
        { label: $t('Vergrößern'), ...sc('zoomIn'), run: () => stepZoom(1) },
        { label: $t('Verkleinern'), ...sc('zoomOut'), run: () => stepZoom(-1) },
        { label: $t('Originalgröße'), ...sc('zoomReset'), run: () => stepZoom(0) },
        sep,
        {
          label: $t('Editor ein/aus'),
          ...sc('codeEditor'),
          run: () => void import('../state/editor').then((m) => m.toggleEditor()),
        },
        {
          label: $t('Seitenleiste ein/aus'),
          ...sc('sidebar'),
          run: () => updateSettings({ sidebar: getState().settings.sidebar === false }),
        },
        {
          label: $t('Hälften untereinander ein/aus'),
          run: () => updateSettings({ stackHalves: !getState().settings.stackHalves }),
        },
        { label: $t('Nur eine Hälfte ein/aus'), ...sc('singleHalf'), run: toggleSingleHalf },
        { label: $t('Zur anderen Hälfte wechseln'), ...sc('otherHalf'), run: focusOtherHalf },
        { label: $t('Synchron blättern'), ...sc('syncBrowse'), run: toggleSyncBrowse },
        { label: $t('Verzeichnisse vergleichen'), ...sc('compareDirs'), run: toggleCompareDirs },
        { label: $t('Suche in Unterordnern'), ...sc('deepSearch'), run: () => setDeepSearch(!getState().deepSearchOn) },
        {
          label: $t('Suche im Inhalt'),
          ...sc('contentSearch'),
          run: () => setSearchContent(!getState().searchContent),
        },
        { label: $t('Aktualisieren'), ...sc('refresh'), run: refresh },
      ],
    },
    {
      id: 'go',
      label: $t('Gehe zu'),
      items: [
        { label: $t('Zurück'), ...sc('back'), run: goBack },
        { label: $t('Vor'), ...sc('forward'), run: goForward },
        { label: $t('Übergeordneter Ordner'), mac: '⌘↑', win: 'Alt+↑', run: () => goUp(focus()) },
        sep,
        { label: $t('In der anderen Hälfte öffnen'), ...sc('openOther'), run: () => openInOtherHalf(focus()) },
        sep,
        { label: $t('Startordner'), ...sc('goHome'), run: () => goLocal('~') },
        { label: $t('Schreibtisch'), ...sc('goDesktop'), run: () => goLocal('~/Desktop') },
        { label: $t('Dokumente'), ...sc('goDocuments'), run: () => goLocal('~/Documents') },
        { label: $t('Downloads'), ...sc('goDownloads'), run: () => goLocal('~/Downloads') },
        ...(getState().platform === 'mac' ? [{ label: $t('Programme'), run: () => goLocal('/Applications') }] : []),
        sep,
        { label: $t('Pfad eingeben …'), ...sc('editPath'), run: () => editPath(focus()) },
        sep,
        { label: $t('Ordner zu den Orten hinzufügen'), ...sc('bookmark'), run: addBookmark },
      ],
    },
    {
      id: 'server',
      label: $t('Server'),
      items: [
        { label: $t('Server hinzufügen …'), run: () => openDialog({ type: 'serverEdit' }) },
        { label: $t('Server importieren …'), run: () => openDialog({ type: 'import' }) },
        {
          label: $t('Diesen Server bearbeiten …'),
          run: () => openDialog({ type: 'serverEdit', serverId: activeTab()?.serverId }),
        },
        sep,
        {
          label: $t('Terminal ein/aus'),
          ...sc('terminal'),
          run: () => void import('../state/terminal').then((m) => m.toggleTerminal()),
        },
        {
          label: $t('Neues SSH-Terminal'),
          ...sc('terminalNew'),
          run: () => void import('../state/terminal').then((m) => m.newTerminal('server')),
        },
        {
          label: $t('Neues lokales Terminal'),
          run: () => void import('../state/terminal').then((m) => m.newTerminal('local')),
        },
        sep,
        { label: $t('Ordner abgleichen …'), run: () => openDialog({ type: 'compare' }) },
        { label: $t('Bearbeitete Dateien …'), run: () => openDialog({ type: 'edits' }) },
        sep,
        { label: $t('Alle Übertragungen pausieren'), run: pauseAllTransfers },
        { label: $t('Übertragungen …'), ...sc('transfers'), run: () => openDialog({ type: 'transfers' }) },
      ],
    },
    {
      id: 'watch',
      label: $t('Überwachung'),
      items: [
        { label: $t('Neue Überwachung …'), ...sc('newWatch'), run: () => openDialog({ type: 'watchSetup' }) },
        {
          label: $t('Überwachung für diesen Tab starten'),
          ...sc('watchTab'),
          run: () => openDialog({ type: 'watchSetup' }),
        },
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
      id: 'help',
      label: $t('Hilfe'),
      items: [
        { label: $t('Befehle suchen …'), ...sc('palette'), run: () => openDialog({ type: 'palette' }) },
        { label: $t('Tastenkürzel'), ...sc('shortcuts'), run: () => openDialog({ type: 'shortcuts' }) },
        { label: $t('Protokoll'), run: () => openDialog({ type: 'log' }) },
        { label: $t('Über Bitcrane'), run: () => openDialog({ type: 'about' }) },
      ],
    },
  ];
}
