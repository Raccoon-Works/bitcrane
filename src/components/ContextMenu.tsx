/**
 * Right-click menu for files. Shows only what fits the clicked entries
 * (design rule: no greyed-out items from later stages).
 */
import { placeLabel } from './PlacesBar';
import { Check } from './glyphs';
import { useEffect, useRef } from 'react';
import { keyLabel } from '../state/keys';
import { stagePoint } from './stage';
import { archiveFolder, crumbs, isArchiveName, join } from '../util/paths';
import {
  activeTab, LIVE, localPlaces, editLocalPlaces, SIDEBAR_SECTIONS, toggleSidebarHidden, type SidebarSection, isPackage, showPackageContents, paneLoc, compareFiles, copyShareLink, openWithDefaultApp, compressEntries, extractArchive, placesFor, setLeftServer, setRightLocal, openPlace, openServerIn, setPaneServerList, closePaneServer, removePlace, navigate, removeServerGroup, pickLocalFolder, editPath, askDelete, askRemoveServer, computeFolderSize, copyPath, copyWebUrl, openWebUrl, webUrlFor, copySelection, disconnect, download, duplicateServer, getState, keepServer, openServerInNewTab, isDirEntry, pasteClipboard, togglePermsColumn, updateSettings, newFile, newFolder, openInEditor, openTerminal, newTab, openDialog, openEntry, panePath, setState, startRename, upload, useStore,
} from '../state/store';
import { $t, menuText } from '../i18n';
import { isCloudProtocol } from '../backend/types';
import { addressOf } from './ServerList';
import { gitFor, gitRun } from '../state/git';
import { TAG_COLORS, tagName, tagsFor, toggleTag } from '../state/tags';
import { openExplorerFolder, setExplorerFolder } from '../state/mount';
import { runCustomCommand } from '../state/tools';

interface Item { label: string; key?: string; run: () => void; danger?: boolean; checked?: boolean; /** Colour dot before the label (Finder tags). */ dot?: string }

export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const platform = useStore((s) => s.platform);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setState({ contextMenu: null }); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState({ contextMenu: null });
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [menu]);

  if (!menu) return null;
  const tab = activeTab();
  const k = (mac: string, win: string) => (platform === 'mac' ? mac : win);
  const sk = (id: string) => keyLabel(id, platform);
  const clip = getState().clipboard;
  // Where the clicked half's files are: this computer or a server (server to server: also the left half).
  const [ls, sid] = paneLoc(menu.side, tab);
  const onServer = ls === 'remote';
  const paneServer = onServer ? getState().servers.find((x) => x.id === sid) : undefined;
  const sftpTab = !paneServer?.protocol || paneServer.protocol === 'sftp';
  const remoteTerminal = !onServer || sftpTab;
  const one = menu.names.length === 1 ? menu.names[0] : undefined;
  const folder = one && tab ? isDirEntry(ls, sid, join(panePath(menu.side), one)) : false;
  // A package (app, library) is offered like a file, with "Paketinhalt zeigen" to go in.
  const pkg = !!one && folder && isPackage(menu.side, { name: one, kind: 'dir' });
  const isDir = folder && !pkg;
  const leftServer = tab?.leftServerId ? getState().servers.find((x) => x.id === tab.leftServerId) : undefined;
  const otherName = (side: 'local' | 'remote') => (side === 'local' ? getState().servers.find((x) => x.id === tab?.serverId)?.name : leftServer?.name) ?? '';
  const groups: Item[][] = [];
  // Own commands (Einstellungen › Erweitert) run on SFTP servers only (they need SSH).
  const commands = onServer && sftpTab && !!paneServer ? (getState().settings.customCommands ?? []).filter((c) => c.name.trim() && c.command.trim()) : [];

  if (menu.kind === 'server' && menu.serverId) {
    const id = menu.serverId;
    const srv = getState().servers.find((x) => x.id === id);
    const other: 'local' | 'remote' = menu.side === 'local' ? 'remote' : 'local';
    const ssh = !!srv && (!srv.protocol || srv.protocol === 'sftp');
    const termFirst = ssh && srv?.openAs === 'terminal';
    const openTerm = () => void import('../state/terminal').then((m) => m.openServerTerminal(id));
    groups.push([
      ...(termFirst ? [{ label: $t('Terminal öffnen'), run: openTerm }, { label: $t('Dateien öffnen'), run: () => openServerIn(menu.side, id) }] : [{ label: $t('Verbinden'), run: () => openServerIn(menu.side, id) }, { label: $t('In neuem Tab öffnen'), run: () => openServerInNewTab(id) }]),
      ...(tab && tab.serverId !== id && tab.leftServerId !== id ? [{ label: other === 'local' ? $t('In der linken Hälfte öffnen') : $t('In der rechten Hälfte öffnen'), run: () => openServerIn(other, id) }] : []),
      ...(srv?.online ? [{ label: $t('Verbindung trennen'), run: () => disconnect(id) }] : []),
      ...(ssh && !termFirst ? [{ label: $t('Terminal öffnen'), run: openTerm }] : []),
    ]);
    groups.push([
      ...(srv?.temporary ? [{ label: srv.protocol === 'vault' ? $t('Tresor merken') : $t('Als Server speichern'), run: () => keepServer(id) }] : srv?.protocol === 'vault' ? [] : [{ label: $t('Bearbeiten …'), run: () => openDialog({ type: 'serverEdit', serverId: id }) }]),
      { label: $t('Duplizieren'), run: () => duplicateServer(id) },
      { label: $t('Adresse kopieren'), run: () => { if (srv) void navigator.clipboard?.writeText(`${srv.protocol ?? 'sftp'}://${addressOf(srv)}`); } },
    ]);
    // Windows: the server as a folder in the Explorer (like OneDrive).
    if (srv && !srv.temporary && getState().platform === 'win' && !isCloudProtocol(srv.protocol)) {
      groups.push(srv.mountExplorer
        ? [
            ...(getState().explorerFolders[id] ? [{ label: $t('Ordner im Explorer öffnen'), run: () => openExplorerFolder(id) }] : []),
            { label: $t('Nicht mehr im Explorer zeigen'), run: () => setExplorerFolder(id, false) },
          ]
        : [{ label: $t('Im Explorer als Ordner zeigen'), run: () => setExplorerFolder(id, true) }]);
    }
    if (srv && !srv.temporary) groups.push([{ label: $t('Entfernen …'), danger: true, run: () => askRemoveServer(id) }]);
  } else if (menu.kind === 'git') {
    // The branch chip of a half: the everyday git commands of its working copy.
    const st = gitFor(panePath(menu.side));
    if (st) {
      groups.push([
        { label: $t('Commit …'), run: () => openDialog({ type: 'gitCommit', root: st.root }) },
        { label: $t('Alles hinzufügen'), run: () => { setState({ contextMenu: null }); void gitRun(st.root, 'addAll'); } },
      ]);
      groups.push([
        { label: st.behind ? $t('Pull ({0} neue)', st.behind) : 'Pull', run: () => { setState({ contextMenu: null }); void gitRun(st.root, 'pull'); } },
        { label: st.ahead ? $t('Push ({0} Commits)', st.ahead) : 'Push', run: () => { setState({ contextMenu: null }); void gitRun(st.root, 'push'); } },
      ]);
    }
  } else if (menu.kind === 'serverGroup' && menu.group) {
    const g = menu.group;
    groups.push([{ label: $t('Umbenennen'), run: () => setState({ renamingGroup: g }) }]);
    groups.push([{ label: $t('Gruppe auflösen'), run: () => removeServerGroup(g) }]);
  } else if (menu.kind === 'crumbs') {
    // Parent folders not shown in the path bar, nearest first.
    const all = crumbs(panePath(menu.side), getState().homeName);
    // From the "…" button: the folders not shown; from the folder name: all folders above it.
    const hidden = menu.place?.startsWith('h:') ? Number(menu.place.slice(2)) : all.length - 3;
    groups.push(all.slice(0, menu.place === 'all' ? -1 : hidden).reverse().map((c) => ({ label: c.name, run: () => navigate(menu.side, c.path) })));
  } else if (menu.kind === 'placesMore') {
    // Places that do not fit into the places bar ("»" at its end); place = number shown.
    const shown = Number(menu.place ?? 0);
    groups.push(placesFor(menu.side).slice(shown).map((p) => ({ label: placeLabel(p), run: () => navigate(menu.side, p.path) })));
  } else if (menu.kind === 'place' && menu.place) {
    const path = menu.place;
    groups.push([
      { label: $t('Öffnen'), run: () => navigate(menu.side, path) },
      { label: $t('Pfad kopieren'), run: () => void navigator.clipboard?.writeText(path) },
    ]);
    groups.push([{ label: $t('Aus der Ortsleiste entfernen'), danger: true, run: () => removePlace(menu.side, path) }]);
  } else if (menu.kind === 'sidebarSection') {
    // Which sections the sidebar shows (Finder: Settings > Sidebar), and the default order.
    const st = getState().settings;
    const hiddenNow = st.sidebarHidden ?? [];
    const names: Record<SidebarSection, string> = { favorites: $t('Favoriten'), recent: $t('Zuletzt verwendet'), devices: $t('Geräte'), shares: $t('Freigaben'), tags: $t('Tags') };
    groups.push(SIDEBAR_SECTIONS.filter((id) => id !== 'tags' || platform === 'mac')
      .map((id) => ({ label: names[id], checked: !hiddenNow.includes(id), run: () => toggleSidebarHidden(id) })));
    groups.push([
      { label: $t('Alle Bereiche aufklappen'), run: () => updateSettings({ sidebarCollapsed: [] }) },
      { label: $t('Reihenfolge zurücksetzen'), run: () => updateSettings({ sidebarOrder: [] }) },
    ]);
  } else if (menu.kind === 'sidebarPlace' && menu.place) {
    // A favourite in the sidebar.
    const path = menu.place;
    const list = localPlaces();
    const i = list.findIndex((p) => p.path === path);
    groups.push([
      { label: $t('Öffnen'), run: () => openPlace(path) },
      { label: $t('Pfad kopieren'), run: () => void navigator.clipboard?.writeText(path) },
    ]);
    groups.push([
      ...(i > 0 ? [{ label: $t('Nach oben'), run: () => editLocalPlaces(path, { before: list[i - 1].path }) }] : []),
      ...(i >= 0 && i < list.length - 1 ? [{ label: $t('Nach unten'), run: () => editLocalPlaces(path, { before: list[i + 2]?.path ?? null }) }] : []),
    ]);
    groups.push([{ label: $t('Aus den Favoriten entfernen'), danger: true, run: () => editLocalPlaces(path, { remove: true }) }]);
  } else if (menu.kind === 'paneSource') {
    // The location button of a half: this computer and its drives, or which server it shows.
    const servers = getState().servers.filter((x) => !x.temporary || x.online);
    if (menu.side === 'local') {
      groups.push([{ label: platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC'), checked: !tab?.leftServerId, run: () => setLeftServer('') }]);
      // Drives of this computer: switches back from a server if needed and opens the drive.
      // The browser prototype has no real drives; it shows typical ones.
      const drives = LIVE ? getState().drives : platform === 'mac'
        ? [{ name: 'Macintosh HD', path: '~' }, { name: 'USB-Stick', path: '~/Downloads' }]
        : [{ name: 'C:', path: '~' }, { name: 'D:', path: '~/Downloads' }, { name: 'F: (Google Drive)', path: '~/Projekte' }];
      if (drives.length) groups.push(drives.map((d) => ({ label: d.name, run: () => openPlace(d.path) })));
      // Any other folder: the system's folder dialog, or typing the path.
      groups.push([
        { label: $t('Anderer Ordner …'), run: () => void pickLocalFolder('local') },
        { label: $t('Pfad eingeben …'), key: sk('editPath'), run: () => editPath('local') },
      ]);
      const others = servers.filter((x) => x.id !== tab?.serverId);
      if (others.length) groups.push(others.map((x) => ({ label: x.name, checked: tab?.leftServerId === x.id, run: () => openServerIn('local', x.id) })));
    } else {
      // The right half: this computer (two local halves, Total Commander) or a server.
      groups.push([{ label: platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC'), checked: !!tab?.rightLocal && !tab.serverId, run: () => setRightLocal() }]);
      if (tab?.rightLocal && !tab.serverId) {
        const drives = LIVE ? getState().drives : platform === 'mac'
          ? [{ name: 'Macintosh HD', path: '~' }, { name: 'USB-Stick', path: '~/Downloads' }]
          : [{ name: 'C:', path: '~' }, { name: 'D:', path: '~/Downloads' }, { name: 'F: (Google Drive)', path: '~/Projekte' }];
        if (drives.length) groups.push(drives.map((d) => ({ label: d.name, run: () => setRightLocal(d.path) })));
        groups.push([
          { label: $t('Anderer Ordner …'), run: () => void pickLocalFolder('remote') },
          { label: $t('Pfad eingeben …'), key: sk('editPath'), run: () => editPath('remote') },
        ]);
      }
      const others = servers.filter((x) => x.id !== tab?.leftServerId);
      if (others.length) groups.push(others.map((x) => ({ label: x.name, checked: tab?.serverId === x.id, run: () => openServerIn('remote', x.id) })));
    }
    groups.push([
      { label: $t('Serverliste zeigen'), run: () => setPaneServerList(menu.side, true) },
      ...(onServer ? [{ label: $t('Trennen'), run: () => closePaneServer(menu.side) }] : []),
    ]);
  } else if (menu.kind === 'columns') {
    const st = getState().settings;
    const col = (c: 'mtime' | 'size' | 'kind' | 'owner') => () => updateSettings({ columns: { ...st.columns, [c]: !st.columns[c] } });
    // Same order as the columns. A creation date is missing on purpose: SFTP and FTP servers do not report one.
    groups.push([
      { label: $t('Geändert'), checked: st.columns.mtime, run: col('mtime') },
      { label: $t('Art'), checked: !!st.columns.kind, run: col('kind') },
      { label: $t('Rechte'), checked: st.showPerms, run: togglePermsColumn },
      { label: $t('Besitzer'), checked: !!st.columns.owner, run: col('owner') },
      { label: $t('Größe'), checked: st.columns.size, run: col('size') },
    ]);
  } else if (menu.names.length) {
    const first: Item[] = [];
    if (one) first.push({ label: isDir ? $t('Öffnen') : onServer ? $t('Im Editor öffnen') : $t('Öffnen'), key: k('⌘↓', 'Enter'), run: () => (pkg ? openWithDefaultApp(menu.side, one) : openEntry(menu.side, one)) });
    if (pkg && one) first.push({ label: $t('Paketinhalt zeigen'), run: () => showPackageContents(menu.side, one) });
    if (one && !isDir && !pkg && !onServer) first.push({ label: $t('Im Editor öffnen'), run: () => openInEditor(menu.side, one) });
    if (one && !isDir && !pkg) first.push({ label: $t('Vorschau'), key: k($t('Leertaste'), $t('Leertaste')), run: () => { setState({ contextMenu: null }); openDialog({ type: 'preview', side: menu.side }); } });
    if (leftServer) first.push({ label: $t('Zu „{0}“ übertragen', otherName(menu.side)), key: sk(menu.side === 'remote' ? 'download' : 'upload'), run: () => (menu.side === 'remote' ? download(menu.names) : upload(menu.names)) });
    else if (menu.side === 'remote') first.push({ label: $t('Herunterladen'), key: sk('download'), run: () => download(menu.names) });
    // Upload only when the other half shows a server (not with the server list or two local halves).
    else if (tab?.serverId) first.push({ label: $t('Hochladen'), key: sk('upload'), run: () => upload(menu.names) });
    groups.push(first);
    const second: Item[] = [
      { label: $t('Kopieren'), key: sk('copy'), run: () => copySelection(menu.side) },
      { label: $t('Kopieren nach …'), key: sk('copyTo'), run: () => openDialog({ type: 'copyTo', side: menu.side, names: menu.names }) },
      { label: $t('Pfad kopieren'), key: sk('copyPath'), run: () => copyPath(menu.side, one) },
    ];
    const web = one && tab && onServer ? webUrlFor(sid, join(panePath(menu.side), one)) : undefined;
    if (web && tab && one) {
      second.push({ label: $t('Web-Adresse kopieren'), run: () => copyWebUrl(sid, join(panePath(menu.side), one)) });
      second.push({ label: $t('Im Browser öffnen'), run: () => openWebUrl(sid, join(panePath(menu.side), one)) });
    }
    // Cloud services: a sharing link (Transmit "Copy Link").
    if (one && paneServer && isCloudProtocol(paneServer.protocol)) second.push({ label: $t('Link zum Teilen kopieren'), run: () => copyShareLink(menu.side, one) });
    if (one) second.push({ label: $t('Umbenennen'), key: k('↩', 'F2'), run: () => startRename(menu.side, one) });
    else second.push({ label: $t('{0} Objekte umbenennen …', menu.names.length), run: () => openDialog({ type: 'batchRename', side: menu.side, names: menu.names }) });
    if (one && !folder) second.push({ label: $t('Prüfsumme (SHA-256) …'), run: () => openDialog({ type: 'checksum', side: menu.side, name: one }) });
    if (one && folder) second.push({ label: $t('Größe berechnen'), run: () => void computeFolderSize(menu.side, one) });
    // "Dateien vergleichen" (after ForkLift): two files of this half, or this file and the one picked in the other half.
    const other: 'local' | 'remote' = menu.side === 'local' ? 'remote' : 'local';
    const otherPick = getState().selection[other].names;
    const isFile = (side: 'local' | 'remote', name: string) => !!tab && !isDirEntry(...paneLoc(side, tab), join(panePath(side), name));
    if (menu.names.length === 2 && menu.names.every((n) => isFile(menu.side, n))) {
      second.push({ label: $t('Dateien vergleichen'), run: () => compareFiles({ side: menu.side, name: menu.names[0] }, { side: menu.side, name: menu.names[1] }) });
    } else if (one && !folder && otherPick.length === 1 && isFile(other, otherPick[0])) {
      const [a, b] = menu.side === 'local' ? [{ side: menu.side, name: one }, { side: other, name: otherPick[0] }] : [{ side: other, name: otherPick[0] }, { side: menu.side, name: one }];
      second.push({ label: $t('Mit „{0}“ vergleichen', otherPick[0]), run: () => compareFiles(a, b) });
    }
    // Zip archives on this computer (after ForkLift).
    // Inside an opened archive nothing can be added, so no "komprimieren" there.
    if (!onServer && !archiveFolder(panePath(menu.side))) {
      second.push({ label: one ? $t('„{0}“ komprimieren', one) : $t('{0} Objekte komprimieren', menu.names.length), run: () => compressEntries(menu.side, menu.names) });
      if (one && !folder && isArchiveName(one)) {
        second.push({ label: $t('Entpacken'), run: () => extractArchive(menu.side, one) });
        second.push({ label: $t('Mit Standardprogramm öffnen'), run: () => openWithDefaultApp(menu.side, one) });
      }
    }
    if (one && menu.side === 'remote' && sftpTab) second.push({ label: $t('Symbolischen Link erstellen …'), run: () => openDialog({ type: 'symlink', target: join(panePath('remote'), one) }) });
    if (one) second.push({ label: $t('Informationen und Rechte …'), key: k('⌘I', 'Strg+I'), run: () => openDialog({ type: 'perms', side: menu.side, path: join(panePath(menu.side), one) }) });
    groups.push(second);
    // Finder tags (Mac, this computer): the seven colours, ticked when every chosen file has it.
    if (!onServer && platform === 'mac') {
      const dir = panePath(menu.side);
      const have = tagsFor(dir);
      groups.push(TAG_COLORS.map((c) => ({
        label: tagName(c), dot: c.css,
        checked: menu.names.every((n) => (have[n] ?? []).some((t) => t.color === c.color)),
        run: () => { setState({ contextMenu: null }); void toggleTag(dir, menu.names, c); },
      })));
    }
    // In a git working copy on this computer: add the chosen files for the next commit.
    const gst = !onServer ? gitFor(panePath(menu.side)) : null;
    if (gst) {
      const rel = menu.names.map((n) => join(panePath(menu.side), n).slice(gst.root.length + 1));
      groups.push([
        { label: $t('Git: Für Commit hinzufügen'), run: () => { setState({ contextMenu: null }); void gitRun(gst.root, 'add', { paths: rel }); } },
        { label: $t('Git: Commit …'), run: () => openDialog({ type: 'gitCommit', root: gst.root }) },
      ]);
    }
    const third: Item[] = [{ label: $t('Neuer Ordner'), key: sk('newFolder'), run: () => newFolder(menu.side) }, { label: $t('Neue Datei'), key: sk('newFile'), run: () => newFile(menu.side) }];
    if (isDir && one) third.push({ label: $t('In neuem Tab öffnen'), run: () => { newTab(); setState({ contextMenu: null }); window.setTimeout(() => openEntry(menu.side, one), 0); } });
    groups.push(third);
    if (commands.length) groups.push(commands.map((c) => ({ label: c.name || c.command, run: () => void runCustomCommand(c, menu.side, menu.names) })));
    groups.push([{ label: onServer ? $t('Vom Server löschen …') : $t('In den Papierkorb …'), key: k('⌘⌫', $t('Entf')), run: () => askDelete(menu.side, menu.names), danger: true }]);
  } else {
    groups.push([
      ...(clip ? [{ label: clip.serverId === (onServer ? sid : '') ? $t('Hier einfügen (Kopie)') : !clip.serverId ? $t('Hier einfügen (hochladen)') : !onServer ? $t('Hier einfügen (herunterladen)') : $t('Hier einfügen (übertragen)'), key: sk('paste'), run: () => pasteClipboard(menu.side) }] : []),
      { label: $t('Neuer Ordner'), key: sk('newFolder'), run: () => newFolder(menu.side) }, { label: $t('Neue Datei'), key: sk('newFile'), run: () => newFile(menu.side) },
      { label: $t('Pfad dieses Ordners kopieren'), run: () => copyPath(menu.side) },
      ...(paneServer?.protocol !== 'vault' ? [{ label: $t('Neuer Cryptomator-Tresor …'), run: () => openDialog({ type: 'vaultCreate', side: menu.side }) }] : []),
      { label: $t('Auswählen nach Muster …'), key: sk('selectMask'), run: () => openDialog({ type: 'selectMask', side: menu.side }) },
      ...(menu.side === 'remote' && sftpTab ? [{ label: $t('Symbolischen Link erstellen …'), run: () => openDialog({ type: 'symlink', target: '' }) }] : []),
      ...(!onServer || sftpTab ? [{ label: $t('Terminal hier öffnen'), run: () => void import('../state/terminal').then((m) => m.newTerminal(onServer ? 'server' : 'local')) }] : []),
      ...(remoteTerminal ? [{ label: onServer ? $t('Im System-Terminal öffnen (SSH)') : $t('Im System-Terminal öffnen'), run: () => openTerminal(menu.side) }] : []),
    ]);
    const folderCommands = commands.filter((c) => !/\{(file|files|name)\}/.test(c.command));
    if (folderCommands.length) groups.push(folderCommands.map((c) => ({ label: c.name || c.command, run: () => void runCustomCommand(c, menu.side, []) })));
    if (!onServer) groups.push([{ label: $t('Diesen Ordner überwachen …'), key: sk('newWatch'), run: () => openDialog({ type: 'watchSetup' }) }]);
  }
  // Groups left empty by conditions are dropped, so no double separators appear.
  for (let i = groups.length - 1; i >= 0; i--) if (!groups[i].length) groups.splice(i, 1);

  const anyCheck = groups.flat().some((it) => it.checked !== undefined);
  // Convert to stage coordinates and keep the menu inside the window.
  const pt = stagePoint(menu.x, menu.y);
  const height = 16 + groups.flat().length * 26 + groups.length * 9;
  const x = Math.min(pt.x, pt.w - 290);
  const y = Math.min(pt.y, pt.h - height - 8);

  return (
    <div ref={ref} role="menu" aria-label={$t('Kontextmenü')} className="menu context-menu" style={{ left: x, top: Math.max(8, y) }}>
      {groups.map((g, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="menu-sep" role="separator" />}
          {g.map((it) => (
            <button key={it.label} type="button" role={it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={it.checked} className={`menu-item${it.danger ? ' is-danger' : ''}`} onClick={() => { setState({ contextMenu: null }); it.run(); }}>
              {/* As in the system menus: once any item can carry a tick, all texts start at the same edge. */}
              {(it.checked !== undefined || anyCheck) && <span className="menu-check" aria-hidden="true">{it.checked ? <Check size={13} strokeWidth={2.2} /> : null}</span>}
              {it.dot && <span className="tag-dot menu-tag-dot" style={{ background: it.dot }} aria-hidden="true" />}
              <span className="flex-1">{menuText(it.label)}</span>
              {it.key && <span className="menu-key">{it.key}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
