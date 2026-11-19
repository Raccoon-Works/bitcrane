/**
 * Web addresses of server files (the server's web address plus the path below its web folder), and
 * opening addresses in the browser.
 */
import * as live from './live';
import type { PaneSide } from '../backend/types';

import * as paths from '../util/paths';
import { $t } from '../i18n';
import { setState, activeTab, paneLoc, showToast, panePath, LIVE, serverById } from './core';

/** Web address of a server file, from the server's "Web-Adresse" setting. */
export function webUrlFor(serverId: string, remotePath: string): string | undefined {
  const srv = serverById(serverId);
  if (!srv?.webUrl) return undefined;
  const root = (srv.webRoot || '/').replace(/\/+$/, '') || '';
  if (root && remotePath !== root && !remotePath.startsWith(root + '/')) return undefined;
  const rest = remotePath.slice(root.length).split('/').map(encodeURIComponent).join('/');
  return srv.webUrl.replace(/\/+$/, '') + (rest.startsWith('/') ? rest : `/${rest}`);
}

export function copyWebUrl(serverId: string, remotePath: string) {
  const url = webUrlFor(serverId, remotePath);
  if (!url) return;
  void navigator.clipboard.writeText(url).then(
    () => showToast($t('Kopiert: {0}', url), 'ok'),
    () => showToast(url),
  );
}

export function openWebUrl(serverId: string, remotePath: string) {
  const url = webUrlFor(serverId, remotePath);
  if (url) openExternal(url);
}

/** Opens a web address in the default browser. */
export function openExternal(url: string) {
  if (LIVE) void live.openUrl(url);
  else window.open(url, '_blank', 'noopener');
}

/** "Link kopieren": sharing link of a file or folder on a cloud service. */
export function copyShareLink(side: PaneSide, name: string) {
  const t = activeTab();
  if (!t) return;
  setState({ contextMenu: null });
  const [, serverId] = paneLoc(side, t);
  if (!LIVE) {
    void navigator.clipboard.writeText('https://www.dropbox.com/scl/fi/beispiel');
    showToast($t('Link kopiert.'), 'ok');
    return;
  }
  void live.copyShareLink(serverId, paths.join(panePath(side), name));
}
