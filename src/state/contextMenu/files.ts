/**
 * Context menus of a file list: the chosen entries, the empty area of a folder and the branch chip.
 */
import { archiveFolder, isArchiveName, join } from '../../util/paths';
import {
  showPackageContents,
  paneLoc,
  compareFiles,
  copyShareLink,
  openWithDefaultApp,
  compressEntries,
  extractArchive,
  askDelete,
  computeFolderSizes,
  newFolderWithSelection,
  copyPath,
  copyWebUrl,
  openWebUrl,
  webUrlFor,
  copySelection,
  cutSelection,
  revealEntry,
  addLocalPlace,
  addPlace,
  moveToOtherSide,
  paneShowsServers,
  download,
  getState,
  isDirEntry,
  pasteClipboard,
  newFile,
  newFolder,
  openInEditor,
  openTerminal,
  newTab,
  openDialog,
  openEntry,
  panePath,
  setState,
  startRename,
  upload,
} from '../store';
import { $t } from '../../i18n';
import { isCloudProtocol } from '../../backend/types';
import { gitFor, gitRun } from '../git';
import { TAG_COLORS, tagName, tagsFor, toggleTag } from '../tags';
import { runCustomCommand } from '../tools';
import { paneFacts, menuKeys, type MenuContext, type MenuItem } from './types';

export function entriesMenu(ctx: MenuContext): MenuItem[][] {
  const { menu, tab, platform } = ctx;
  const { k, sk } = menuKeys(platform);
  const { sid, onServer, paneServer, sftpTab, one, folder, pkg, isDir, leftServer, otherName, otherPlace, commands } =
    paneFacts(ctx);
  const groups: MenuItem[][] = [];
  const first: MenuItem[] = [];
  if (one)
    first.push({
      label: isDir ? $t('Öffnen') : onServer ? $t('Im Editor öffnen') : $t('Öffnen'),
      key: k('⌘↓', 'Enter'),
      run: () => (pkg ? openWithDefaultApp(menu.side, one) : openEntry(menu.side, one)),
    });
  if (pkg && one) first.push({ label: $t('Paketinhalt zeigen'), run: () => showPackageContents(menu.side, one) });
  if (one && !isDir && !pkg && !onServer)
    first.push({ label: $t('Im Editor öffnen'), run: () => openInEditor(menu.side, one) });
  if (one && !isDir && !pkg)
    first.push({
      label: $t('Bearbeiten mit …'),
      run: () => {
        setState({ contextMenu: null });
        openDialog({ type: 'editWith', side: menu.side, name: one });
      },
    });
  if (one && !isDir && !pkg)
    first.push({
      label: $t('Vorschau'),
      key: k($t('Leertaste'), $t('Leertaste')),
      run: () => {
        setState({ contextMenu: null });
        openDialog({ type: 'preview', side: menu.side });
      },
    });
  if (leftServer)
    first.push({
      label: $t('Zu „{0}“ übertragen', otherName(menu.side)),
      key: sk(menu.side === 'remote' ? 'download' : 'upload'),
      run: () => (menu.side === 'remote' ? download(menu.names) : upload(menu.names)),
    });
  else if (menu.side === 'remote')
    first.push({ label: $t('Herunterladen'), key: sk('download'), run: () => download(menu.names) });
  // Upload only when the other half shows a server (not with the server list or two local halves).
  else if (tab?.serverId) first.push({ label: $t('Hochladen'), key: sk('upload'), run: () => upload(menu.names) });
  // Moving into the other half: on one computer or server a plain move, between them transfer and remove (after a question).
  if (!paneShowsServers(menu.side === 'local' ? 'remote' : 'local'))
    first.push({
      label: $t('Nach „{0}“ verschieben …', otherPlace(menu.side)),
      key: sk('moveToOther'),
      run: () => {
        setState({ contextMenu: null });
        moveToOtherSide(menu.side);
      },
    });
  groups.push(first);
  const second: MenuItem[] = [
    { label: $t('Kopieren'), key: sk('copy'), run: () => copySelection(menu.side) },
    {
      label: $t('Ausschneiden'),
      key: sk('cut'),
      run: () => {
        setState({ contextMenu: null });
        cutSelection(menu.side);
      },
    },
    {
      label: $t('Kopieren nach …'),
      key: sk('copyTo'),
      run: () => openDialog({ type: 'copyTo', side: menu.side, names: menu.names }),
    },
    { label: $t('Pfad kopieren'), key: sk('copyPath'), run: () => copyPath(menu.side, one) },
  ];
  if (one && !onServer)
    second.push({
      label: platform === 'mac' ? $t('Im Finder zeigen') : $t('Im Explorer zeigen'),
      run: () => revealEntry(menu.side, one),
    });
  const web = one && tab && onServer ? webUrlFor(sid, join(panePath(menu.side), one)) : undefined;
  if (web && tab && one) {
    second.push({ label: $t('Web-Adresse kopieren'), run: () => copyWebUrl(sid, join(panePath(menu.side), one)) });
    second.push({ label: $t('Im Browser öffnen'), run: () => openWebUrl(sid, join(panePath(menu.side), one)) });
  }
  // Cloud services: a sharing link (Transmit "Copy Link").
  if (one && paneServer && isCloudProtocol(paneServer.protocol))
    second.push({ label: $t('Link zum Teilen kopieren'), run: () => copyShareLink(menu.side, one) });
  if (one && !folder && paneServer?.protocol === 's3')
    second.push({
      label: $t('Link mit Ablaufdatum …'),
      run: () => openDialog({ type: 'presign', side: menu.side, name: one }),
    });
  if (one) second.push({ label: $t('Umbenennen'), key: k('↩', 'F2'), run: () => startRename(menu.side, one) });
  else
    second.push({
      label: $t('{0} Objekte umbenennen …', menu.names.length),
      run: () => openDialog({ type: 'batchRename', side: menu.side, names: menu.names }),
    });
  if (one && !folder)
    second.push({
      label: $t('Prüfsumme …'),
      run: () => openDialog({ type: 'checksum', side: menu.side, name: one }),
    });
  const chosenDirs = tab
    ? menu.names.filter((n) => isDirEntry(...paneLoc(menu.side, tab), join(panePath(menu.side), n)))
    : [];
  if (chosenDirs.length)
    second.push({
      label: chosenDirs.length === 1 ? $t('Größe berechnen') : $t('Größe von {0} Ordnern berechnen', chosenDirs.length),
      run: () => void computeFolderSizes(menu.side, chosenDirs),
    });
  // "Dateien vergleichen" (after ForkLift): two files of this half, or this file and the one picked in the other half.
  const other: 'local' | 'remote' = menu.side === 'local' ? 'remote' : 'local';
  const otherPick = getState().selection[other].names;
  const isFile = (side: 'local' | 'remote', name: string) =>
    !!tab && !isDirEntry(...paneLoc(side, tab), join(panePath(side), name));
  if (menu.names.length === 2 && menu.names.every((n) => isFile(menu.side, n))) {
    second.push({
      label: $t('Dateien vergleichen'),
      run: () => compareFiles({ side: menu.side, name: menu.names[0] }, { side: menu.side, name: menu.names[1] }),
    });
  } else if (one && !folder && otherPick.length === 1 && isFile(other, otherPick[0])) {
    const [a, b] =
      menu.side === 'local'
        ? [
            { side: menu.side, name: one },
            { side: other, name: otherPick[0] },
          ]
        : [
            { side: other, name: otherPick[0] },
            { side: menu.side, name: one },
          ];
    second.push({ label: $t('Mit „{0}“ vergleichen', otherPick[0]), run: () => compareFiles(a, b) });
  }
  // Zip archives on this computer (after ForkLift).
  // Inside an opened archive nothing can be added, so no "komprimieren" there.
  if (!onServer && !archiveFolder(panePath(menu.side))) {
    second.push({
      label: one ? $t('„{0}“ komprimieren', one) : $t('{0} Objekte komprimieren', menu.names.length),
      run: () => compressEntries(menu.side, menu.names),
    });
    if (one && !folder && isArchiveName(one)) {
      second.push({ label: $t('Entpacken'), run: () => extractArchive(menu.side, one) });
      second.push({ label: $t('Mit Standardprogramm öffnen'), run: () => openWithDefaultApp(menu.side, one) });
    }
  }
  if (one && menu.side === 'remote' && sftpTab)
    second.push({
      label: $t('Symbolischen Link erstellen …'),
      run: () => openDialog({ type: 'symlink', target: join(panePath('remote'), one) }),
    });
  if (one)
    second.push({
      label: $t('Informationen und Rechte …'),
      key: k('⌘I', 'Strg+I'),
      run: () => openDialog({ type: 'perms', side: menu.side, path: join(panePath(menu.side), one) }),
    });
  groups.push(second);
  // Finder tags (Mac, this computer): the seven colours, ticked when every chosen file has it.
  if (!onServer && platform === 'mac') {
    const dir = panePath(menu.side);
    const have = tagsFor(dir);
    groups.push(
      TAG_COLORS.map((c) => ({
        label: tagName(c),
        dot: c.css,
        checked: menu.names.every((n) => (have[n] ?? []).some((t) => t.color === c.color)),
        run: () => {
          setState({ contextMenu: null });
          void toggleTag(dir, menu.names, c);
        },
      })),
    );
  }
  // In a git working copy on this computer: add the chosen files for the next commit.
  const gst = !onServer ? gitFor(panePath(menu.side)) : null;
  if (gst) {
    const rel = menu.names.map((n) => join(panePath(menu.side), n).slice(gst.root.length + 1));
    groups.push([
      {
        label: $t('Git: Für Commit hinzufügen'),
        run: () => {
          setState({ contextMenu: null });
          void gitRun(gst.root, 'add', { paths: rel });
        },
      },
      { label: $t('Git: Commit …'), run: () => openDialog({ type: 'gitCommit', root: gst.root }) },
    ]);
  }
  const third: MenuItem[] = [
    { label: $t('Neuer Ordner'), key: sk('newFolder'), run: () => newFolder(menu.side) },
    {
      label: $t('Neuer Ordner mit Auswahl'),
      key: sk('newFolderWithSelection'),
      run: () => void newFolderWithSelection(menu.side),
    },
    { label: $t('Neue Datei'), key: sk('newFile'), run: () => newFile(menu.side) },
  ];
  if (isDir && one)
    third.push({
      label: $t('In neuem Tab öffnen'),
      run: () => {
        newTab();
        setState({ contextMenu: null });
        window.setTimeout(() => openEntry(menu.side, one), 0);
      },
    });
  // Explorer "An Schnellzugriff anheften", Finder "Zur Seitenleiste hinzufügen".
  if (isDir && one) {
    const target = join(panePath(menu.side), one);
    third.push(
      onServer
        ? {
            label: $t('Zu den Orten hinzufügen'),
            run: () => {
              setState({ contextMenu: null });
              addPlace(menu.side, target);
            },
          }
        : {
            label: $t('Zu den Favoriten hinzufügen'),
            run: () => {
              setState({ contextMenu: null });
              addLocalPlace(target);
            },
          },
    );
  }
  groups.push(third);
  if (commands.length)
    groups.push(
      commands.map((c) => ({
        label: c.name || c.command,
        run: () => void runCustomCommand(c, menu.side, menu.names),
      })),
    );
  groups.push([
    {
      label: onServer ? $t('Vom Server löschen …') : $t('In den Papierkorb …'),
      key: k('⌘⌫', $t('Entf')),
      run: () => askDelete(menu.side, menu.names),
      danger: true,
    },
  ]);
  return groups;
}

export function folderMenu(ctx: MenuContext): MenuItem[][] {
  const { menu, platform } = ctx;
  const { sk } = menuKeys(platform);
  const { sid, onServer, paneServer, sftpTab, remoteTerminal, commands, clip } = paneFacts(ctx);
  const groups: MenuItem[][] = [];
  groups.push([
    ...(clip
      ? [
          {
            label:
              clip.serverId === (onServer ? sid : '')
                ? $t('Hier einfügen (Kopie)')
                : !clip.serverId
                  ? $t('Hier einfügen (hochladen)')
                  : !onServer
                    ? $t('Hier einfügen (herunterladen)')
                    : $t('Hier einfügen (übertragen)'),
            key: sk('paste'),
            run: () => pasteClipboard(menu.side),
          },
        ]
      : []),
    { label: $t('Neuer Ordner'), key: sk('newFolder'), run: () => newFolder(menu.side) },
    { label: $t('Neue Datei'), key: sk('newFile'), run: () => newFile(menu.side) },
    { label: $t('Pfad dieses Ordners kopieren'), run: () => copyPath(menu.side) },
    {
      label: $t('Alle Ordnergrößen berechnen'),
      key: sk('folderSizes'),
      run: () => void computeFolderSizes(menu.side),
    },
    ...(paneServer?.protocol !== 'vault'
      ? [{ label: $t('Neuer Cryptomator-Tresor …'), run: () => openDialog({ type: 'vaultCreate', side: menu.side }) }]
      : []),
    {
      label: $t('Auswählen nach Muster …'),
      key: sk('selectMask'),
      run: () => openDialog({ type: 'selectMask', side: menu.side }),
    },
    ...(menu.side === 'remote' && sftpTab
      ? [{ label: $t('Symbolischen Link erstellen …'), run: () => openDialog({ type: 'symlink', target: '' }) }]
      : []),
    ...(!onServer || sftpTab
      ? [
          {
            label: $t('Terminal hier öffnen'),
            run: () => void import('../terminal').then((m) => m.newTerminal(onServer ? 'server' : 'local')),
          },
        ]
      : []),
    ...(remoteTerminal
      ? [
          {
            label: onServer ? $t('Im System-Terminal öffnen (SSH)') : $t('Im System-Terminal öffnen'),
            run: () => openTerminal(menu.side),
          },
        ]
      : []),
  ]);
  const folderCommands = commands.filter((c) => !/\{(file|files|name)\}/.test(c.command));
  if (folderCommands.length)
    groups.push(
      folderCommands.map((c) => ({ label: c.name || c.command, run: () => void runCustomCommand(c, menu.side, []) })),
    );
  if (!onServer)
    groups.push([
      { label: $t('Diesen Ordner überwachen …'), key: sk('newWatch'), run: () => openDialog({ type: 'watchSetup' }) },
    ]);
  return groups;
}

export function gitMenu(ctx: MenuContext): MenuItem[][] {
  const { menu } = ctx;
  const groups: MenuItem[][] = [];
  // The branch chip of a half: the everyday git commands of its working copy.
  const st = gitFor(panePath(menu.side));
  if (st) {
    groups.push([
      { label: $t('Commit …'), run: () => openDialog({ type: 'gitCommit', root: st.root }) },
      {
        label: $t('Alles hinzufügen'),
        run: () => {
          setState({ contextMenu: null });
          void gitRun(st.root, 'addAll');
        },
      },
    ]);
    groups.push([
      {
        label: st.behind ? $t('Pull ({0} neue)', st.behind) : $t('Pull'),
        run: () => {
          setState({ contextMenu: null });
          void gitRun(st.root, 'pull');
        },
      },
      {
        label: st.ahead ? $t('Push ({0} Commits)', st.ahead) : $t('Push'),
        run: () => {
          setState({ contextMenu: null });
          void gitRun(st.root, 'push');
        },
      },
    ]);
  }
  return groups;
}
