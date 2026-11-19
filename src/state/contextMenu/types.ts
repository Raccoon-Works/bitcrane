/**
 * What the context menu builders share: the shape of an entry, what they are
 * built from, and the facts about the clicked half most menus need.
 */
import type { Place, Platform, Tab } from '../../backend/types';
import type { ContextMenuState } from '../appState';
import { keyLabel } from '../keys';
import { getState, isDirEntry, isPackage, paneLoc, panePath } from '../store';
import { join } from '../../util/paths';
import { isSftp } from '../../util/protocols';

/** Symbol before an entry (places and servers in the location menu); drawn by the menu. */
export type MenuIcon =
  | { kind: 'computer' }
  | { kind: 'place'; place: Place }
  | { kind: 'drive'; place: Place; first: boolean };

export interface MenuItem {
  label: string;
  /** Shortcut shown at the right. */
  key?: string;
  run: () => void;
  danger?: boolean;
  /** A tick: shown checked or unchecked. */
  checked?: boolean;
  /** Colour dot before the label (Finder tags). */
  dot?: string;
  icon?: MenuIcon;
}

export interface MenuContext {
  menu: ContextMenuState;
  tab: Tab | undefined;
  platform: Platform;
}

/** Shortcut texts: `k` for fixed ones per system, `sk` for those the user can change. */
export function menuKeys(platform: Platform) {
  return {
    k: (mac: string, win: string) => (platform === 'mac' ? mac : win),
    sk: (id: string) => keyLabel(id, platform),
  };
}

/** The clicked half and the clicked entries: where they are and what they are. */
export function paneFacts({ menu, tab }: MenuContext) {
  const s = getState();
  // Where the clicked half's files are: this computer or a server (server to server: also the left half).
  const [ls, sid] = paneLoc(menu.side, tab);
  const onServer = ls === 'remote';
  const paneServer = onServer ? s.servers.find((x) => x.id === sid) : undefined;
  const sftpTab = !paneServer || isSftp(paneServer);
  const one = menu.names.length === 1 ? menu.names[0] : undefined;
  const folder = one && tab ? isDirEntry(ls, sid, join(panePath(menu.side), one)) : false;
  // A package (app, library) is offered like a file, with "Paketinhalt zeigen" to go in.
  const pkg = !!one && folder && isPackage(menu.side, { name: one, kind: 'dir' });
  const leftServer = tab?.leftServerId ? s.servers.find((x) => x.id === tab.leftServerId) : undefined;
  return {
    ls,
    sid,
    onServer,
    paneServer,
    sftpTab,
    remoteTerminal: !onServer || sftpTab,
    one,
    folder,
    pkg,
    isDir: folder && !pkg,
    leftServer,
    clip: s.clipboard,
    otherName: (side: 'local' | 'remote') =>
      (side === 'local' ? s.servers.find((x) => x.id === tab?.serverId)?.name : leftServer?.name) ?? '',
    /** The other half for "verschieben": its server, or its folder on this computer. */
    otherPlace: (side: 'local' | 'remote') => {
      const o = side === 'local' ? 'remote' : 'local';
      const [ols, osid] = paneLoc(o, tab);
      const dir = panePath(o);
      if (ols === 'remote') return s.servers.find((x) => x.id === osid)?.name ?? '';
      // The home folder by its name ("chris"), not "~".
      if (dir === '~') return s.homeName;
      return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
    },
    // Own commands (Einstellungen › Erweitert) run on SFTP servers only (they need SSH).
    commands:
      onServer && sftpTab && !!paneServer
        ? (s.settings.customCommands ?? []).filter((c) => c.name.trim() && c.command.trim())
        : [],
  };
}
