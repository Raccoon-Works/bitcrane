/**
 * Connection tabs. Mac: wide rectangular tabs in the toolbar (after Transmit
 * and Safari's compact tabs). Windows: tabs in the title bar like Explorer
 * in Windows 11, the selected one joined to the toolbar below.
 *
 * A tab without a server is called "Neuer Tab". Closing the last tab leaves an
 * empty one. Middle click closes a tab, a double click on the free space next
 * to the tabs opens a new one.
 */
import { Plus, Settings as Gear, X } from './glyphs';
import { addressOf } from './ServerList';
import { LocalTile, ServerTile } from './ServerTile';
import { IconButton, Tooltip } from './ui';
import { useKeyLabel } from '../state/keys';
import { closeTab, newTab, selectTab, serverById, tabTitle, useStore } from '../state/store';
import type { Tab } from '../backend/types';
import { $t } from '../i18n';

/** Tooltip of a tab: what both halves show. */
function tabTip(t: Tab): string {
  if (t.settings) return $t('Einstellungen');
  const right = t.serverId ? serverById(t.serverId) : undefined;
  const left = t.leftServerId ? serverById(t.leftServerId) : undefined;
  const r = right ? `${right.name} (${addressOf(right)}): ${t.remotePath || '/'}` : $t('kein Server');
  const l = left ? `${left.name}: ${t.localPath}` : t.localPath;
  return `${l}  ↔  ${r}`;
}

export function ConnectionTabs({ variant }: { variant: 'mac' | 'win' }) {
  const sk = useKeyLabel();
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeTabId);
  const servers = useStore((s) => s.servers);
  const offline = useStore((s) => s.offline);
  void servers; // re-render when names or connection states change
  const cls = variant === 'mac' ? 'mac-tab' : 'win-tab';
  return (
    <div role="tablist" aria-label={$t('Verbindungen')} className={variant === 'mac' ? 'mac-tabs' : 'win-tabs'} data-tauri-drag-region
      onDoubleClick={(e) => { if (e.target === e.currentTarget) newTab(); }}>
      {tabs.map((t) => {
        const sel = t.id === activeId;
        const srv = t.serverId ? serverById(t.serverId) : undefined;
        const title = tabTitle(t);
        const state = !srv ? '' : offline[srv.id] ? ' is-warn' : srv.online ? ' is-ok' : '';
        return (
          <Tooltip key={t.id} text={tabTip(t)}>
            <div
              role="tab"
              aria-selected={sel}
              tabIndex={sel ? 0 : -1}
              className={`${cls}${sel ? ' is-sel' : ''}`}
              onClick={() => selectTab(t.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') selectTab(t.id);
                // Arrow keys move between tabs (ARIA tabs pattern).
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  const i = tabs.findIndex((x) => x.id === t.id) + (e.key === 'ArrowRight' ? 1 : -1);
                  const next = tabs[(i + tabs.length) % tabs.length];
                  selectTab(next.id);
                  window.setTimeout(() => document.querySelector<HTMLElement>(`.${cls}.is-sel`)?.focus(), 0);
                }
              }}
            >
              {t.settings ? <span className="tab-gear" aria-hidden="true"><Gear size={16} strokeWidth={1.75} /></span> : srv ? <ServerTile server={srv} size={18} /> : <LocalTile size={18} />}
              <span className="tab-name">{title}</span>
              {state && <span className={`dot${state}`} aria-hidden="true" />}
              <button type="button" className="tab-close" tabIndex={-1} aria-label={$t('Tab „{0}“ schließen', title)} onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>
                <X size={variant === 'mac' ? 10 : 11} strokeWidth={2.2} />
              </button>
            </div>
          </Tooltip>
        );
      })}
      <IconButton label={$t('Neuer Tab')} shortcut={sk('newTab')} className="tab-new" onClick={newTab}><Plus size={14} strokeWidth={1.75} /></IconButton>
    </div>
  );
}
