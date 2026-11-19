/**
 * Context menus of the server list: a server and a group of servers.
 */
import {
  openServerIn,
  removeServerGroup,
  askRemoveServer,
  disconnect,
  duplicateServer,
  getState,
  keepServer,
  openServerInNewTab,
  openDialog,
  setState,
} from '../store';
import { $t } from '../../i18n';
import { isCloudProtocol } from '../../backend/types';
import { addressOf } from '../../util/serverAddress';
import { openExplorerFolder, setExplorerFolder } from '../mount';
import { isSftp } from '../../util/protocols';
import type { MenuContext, MenuItem } from './types';

export function serverMenu(ctx: MenuContext, id: string): MenuItem[][] {
  const { menu, tab } = ctx;
  const groups: MenuItem[][] = [];
  const srv = getState().servers.find((x) => x.id === id);
  const other: 'local' | 'remote' = menu.side === 'local' ? 'remote' : 'local';
  const ssh = !!srv && isSftp(srv);
  const termFirst = ssh && srv?.openAs === 'terminal';
  const openTerm = () => void import('../terminal').then((m) => m.openServerTerminal(id));
  groups.push([
    ...(termFirst
      ? [
          { label: $t('Terminal öffnen'), run: openTerm },
          { label: $t('Dateien öffnen'), run: () => openServerIn(menu.side, id) },
        ]
      : [
          { label: $t('Verbinden'), run: () => openServerIn(menu.side, id) },
          { label: $t('In neuem Tab öffnen'), run: () => openServerInNewTab(id) },
        ]),
    ...(tab && tab.serverId !== id && tab.leftServerId !== id
      ? [
          {
            label: other === 'local' ? $t('In der linken Hälfte öffnen') : $t('In der rechten Hälfte öffnen'),
            run: () => openServerIn(other, id),
          },
        ]
      : []),
    ...(srv?.online ? [{ label: $t('Verbindung trennen'), run: () => disconnect(id) }] : []),
    ...(ssh && !termFirst ? [{ label: $t('Terminal öffnen'), run: openTerm }] : []),
  ]);
  groups.push([
    ...(srv?.temporary
      ? [
          {
            label: srv.protocol === 'vault' ? $t('Tresor merken') : $t('Als Server speichern'),
            run: () => keepServer(id),
          },
        ]
      : srv?.protocol === 'vault'
        ? []
        : [{ label: $t('Bearbeiten …'), run: () => openDialog({ type: 'serverEdit', serverId: id }) }]),
    { label: $t('Duplizieren'), run: () => duplicateServer(id) },
    {
      label: $t('Adresse kopieren'),
      run: () => {
        if (srv) void navigator.clipboard.writeText(`${srv.protocol ?? 'sftp'}://${addressOf(srv)}`);
      },
    },
  ]);
  // Windows: the server as a folder in the Explorer (like OneDrive).
  if (srv && !srv.temporary && getState().platform === 'win' && !isCloudProtocol(srv.protocol)) {
    groups.push(
      srv.mountExplorer
        ? [
            ...(getState().explorerFolders[id]
              ? [{ label: $t('Ordner im Explorer öffnen'), run: () => openExplorerFolder(id) }]
              : []),
            { label: $t('Nicht mehr im Explorer zeigen'), run: () => setExplorerFolder(id, false) },
          ]
        : [{ label: $t('Im Explorer als Ordner zeigen'), run: () => setExplorerFolder(id, true) }],
    );
  }
  if (srv && !srv.temporary) groups.push([{ label: $t('Entfernen …'), danger: true, run: () => askRemoveServer(id) }]);
  return groups;
}

export function serverGroupMenu(g: string): MenuItem[][] {
  const groups: MenuItem[][] = [];
  groups.push([{ label: $t('Umbenennen'), run: () => setState({ renamingGroup: g }) }]);
  groups.push([{ label: $t('Gruppe auflösen'), run: () => removeServerGroup(g) }]);
  return groups;
}
