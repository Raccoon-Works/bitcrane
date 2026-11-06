/**
 * What the list says instead of files: not connected (or connecting), an
 * error reading the folder, reading, or an empty folder or search.
 */
import type { PaneSide, Server, Tab } from '../../backend/types';
import { createMissingFolder, reconnect, toggleSyncBrowse, type paneStatus } from '../../state/store';
import { Loader2, PlugZap } from '../glyphs';
import { Button } from '../ui';
import { $t } from '../../i18n';

export function ListStatus({
  side,
  tab,
  path,
  status,
  server,
  serverId,
  empty,
  search,
  deep,
  bothLocal,
  offline,
}: {
  side: PaneSide;
  tab: Tab;
  path: string;
  status: ReturnType<typeof paneStatus>;
  server: Server | undefined;
  serverId: string;
  /** The listing has no entries. */
  empty: boolean;
  search: string;
  /** A search through subfolders shows its own results. */
  deep: boolean;
  bothLocal: boolean;
  offline: boolean;
}) {
  return (
    <>
      {!offline && status.notConnected && (
        <div className="empty-list">
          {status.connecting ? (
            <span className="row-inline">
              <Loader2 size={14} strokeWidth={1.75} className="spin" aria-hidden="true" />
              {$t('Verbinde mit')} {server?.name ?? $t('dem Server')} …
            </span>
          ) : (
            <>
              <span className="row-inline">
                <PlugZap size={14} strokeWidth={1.75} aria-hidden="true" />
                {$t('Nicht verbunden')}
              </span>
              <span className="row-buttons">
                <Button variant="primary" onClick={() => reconnect(serverId)}>
                  {$t('Verbinden')}
                </Button>
              </span>
            </>
          )}
        </div>
      )}
      {!status.notConnected && status.error && (
        <div className="empty-list">
          {status.error}
          {status.hint && <span className="small muted">{status.hint}</span>}
          <span className="small muted mono">{path}</span>
          {tab.syncBrowse && status.missing && (
            <span className="row-buttons">
              <Button variant="primary" onClick={() => createMissingFolder(side)}>
                {$t('Ordner anlegen')}
              </Button>
              <Button onClick={toggleSyncBrowse}>{$t('Synchron blättern beenden')}</Button>
            </span>
          )}
        </div>
      )}
      {!status.notConnected && !status.error && status.loading && empty && (
        <div className="empty-list">
          <span className="row-inline">
            <Loader2 size={14} strokeWidth={1.75} className="spin" aria-hidden="true" />
            {$t('Wird gelesen …')}
          </span>
        </div>
      )}
      {!deep && !status.notConnected && !status.error && !status.loading && empty && (
        <div className="empty-list">
          {search ? $t('Nichts gefunden für „{0}“.', search) : $t('Dieser Ordner ist leer.')}
          <span className="small muted">
            {tab.leftServerId || bothLocal
              ? $t('Dateien aus der anderen Hälfte hierher ziehen, um sie zu übertragen.')
              : side === 'remote'
                ? $t('Dateien von links hierher ziehen, um sie hochzuladen.')
                : $t('Dateien von rechts hierher ziehen, um sie herunterzuladen.')}
          </span>
        </div>
      )}
    </>
  );
}
