/**
 * Terminal sessions of the tabs: starting them (on this computer or an SSH
 * server), restoring them at the start, ending them, and where they are shown
 * (the panel below the halves or a tab of their own).
 */
import { listen } from '@tauri-apps/api/event';
import { tauriBackend as backend } from '../../backend/tauriBackend';
import type { LocalShell } from '../../backend/api';
import type { Tab } from '../../backend/types';
import { $t } from '../../i18n';
import { fromBase64 } from '../../util/base64';
import { connectNow, isSftp } from '../live';
import { activeTab, getState, LIVE, serverById, setState, showToast, subscribeStore, uid } from '../store';
import { applySettings, live, makeTerminal } from './instances';
import { startPreviewSession } from './preview';
import { terminalSettings } from './settings';
import type { TabTerminal, TermSession } from './types';

/** Whether the tab's server can have a terminal (SSH). */
function canHaveTerminal(t: Tab | undefined = activeTab()): boolean {
  const srv = t?.serverId ? serverById(t.serverId) : undefined;
  return !!srv && isSftp(srv);
}

function patchTab(tabId: string, patch: Partial<TabTerminal>) {
  setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, terminal: { open: false, ...t.terminal, ...patch } } : t)),
  }));
}

/** Recreates the terminals of a restored tab; they start when the tab shows them. */
export function reopenTerminals(tabId: string, serverIds: string[], open: boolean, full = false) {
  const sessions: TermSession[] = [];
  for (const serverId of serverIds) {
    if (serverId && !serverById(serverId)) continue;
    const number =
      [...getState().terminals, ...sessions]
        .filter((x) => x.serverId === serverId)
        .reduce((n, x) => Math.max(n, x.number), 0) + 1;
    const session: TermSession = { id: uid('term'), serverId, tabId, number, alive: true };
    live.set(session.id, makeTerminal(session));
    sessions.push(session);
  }
  if (!sessions.length) return;
  setState((s) => ({ terminals: [...s.terminals, ...sessions] }));
  patchTab(tabId, { open: open || full, active: sessions[0].id, ...(full ? { full: true } : {}) });
}

/**
 * Starts a terminal: on the tab's SSH server when it is connected (and the
 * server half has the focus), otherwise on this computer like Tabby or the
 * system terminal. `where` forces one of the two.
 */
export function newTerminal(where?: 'local' | 'server', full = false, shell?: string) {
  const t = activeTab();
  if (!t) return;
  const srv = t.serverId ? serverById(t.serverId) : undefined;
  const sshReady = !!srv && canHaveTerminal(t) && (srv.online || !LIVE);
  const onServer = where === 'server' || (where !== 'local' && sshReady && getState().focusSide === 'remote');
  if (onServer && !sshReady) {
    showToast(
      srv && canHaveTerminal(t)
        ? $t('Erst mit {0} verbinden.', srv.name)
        : $t('Ein SSH-Terminal gibt es für SSH-Server (SFTP).'),
    );
    return;
  }
  const serverId = onServer ? t.serverId : '';
  const own = !serverId && shell ? shell : '';
  const number =
    getState()
      .terminals.filter((x) => x.serverId === serverId && (x.shell ?? '') === own)
      .reduce((n, x) => Math.max(n, x.number), 0) + 1;
  const shellName = own ? shellList?.find((x) => x.id === own)?.name : undefined;
  const session: TermSession = {
    id: uid('term'),
    serverId,
    tabId: t.id,
    number,
    alive: true,
    ...(own ? { shell: own, ...(shellName ? { shellName } : {}) } : {}),
  };
  live.set(session.id, makeTerminal(session));
  setState((s) => ({ terminals: [...s.terminals, session] }));
  patchTab(t.id, { open: true, active: session.id, full: full || t.terminal?.full });
}

/** Shells this computer offers (term_shells), asked once; the prototype has none. */
let shellList: LocalShell[] | null = null;
export async function localShells(): Promise<LocalShell[]> {
  if (shellList) return shellList;
  if (!LIVE) return [];
  shellList = await backend.termShells().catch(() => []);
  return shellList;
}

/**
 * An SSH terminal on a saved server, for people who only want a console:
 * a tab of its own that the terminal fills, connecting first if needed (the
 * session waits for the connection). A tab of that server that already shows
 * only terminals is brought to the front instead.
 */
export function openServerTerminal(serverId: string) {
  const srv = serverById(serverId);
  if (!srv) return;
  if (!isSftp(srv)) {
    showToast($t('Ein SSH-Terminal gibt es für SSH-Server (SFTP / SSH).'));
    return;
  }
  const st = getState();
  setState((s) => ({
    contextMenu: null,
    firstRun: false,
    servers: s.servers.map((x) => (x.id === serverId ? { ...x, lastUsed: Date.now() } : x)),
  }));
  // Already shown in the panel of the current tab: another session right there.
  const cur = activeTab();
  if (cur?.serverId === serverId && (srv.online || !LIVE) && !cur.terminal?.full) {
    newTerminal('server');
    return;
  }
  const existing = st.tabs.find(
    (t) =>
      t.serverId === serverId &&
      t.terminal?.full &&
      st.terminals.some((x) => x.tabId === t.id && x.serverId === serverId && x.alive),
  );
  if (existing) {
    setState({ activeTabId: existing.id });
    if (LIVE && !srv.online) connectNow(serverId);
    return;
  }
  const number = st.terminals.filter((x) => x.serverId === serverId).reduce((n, x) => Math.max(n, x.number), 0) + 1;
  const tab: Tab = {
    id: uid('tab'),
    serverId,
    localPath: srv.localStart || '~',
    remotePath: srv.remoteStart,
    back: [],
    forward: [],
  };
  const session: TermSession = { id: uid('term'), serverId, tabId: tab.id, number, alive: true };
  live.set(session.id, makeTerminal(session));
  setState((s) => ({
    tabs: [...s.tabs, { ...tab, terminal: { open: true, active: session.id, full: true } }],
    activeTabId: tab.id,
    terminals: [...s.terminals, session],
  }));
  if (LIVE && !srv.online) connectNow(serverId);
}

/** Called once the session's element is on screen and has a size. */
export function attachTerminal(id: string, container: HTMLElement) {
  const l = live.get(id);
  const session = getState().terminals.find((x) => x.id === id);
  if (!l || !session) return;
  if (l.host.parentElement !== container) container.appendChild(l.host);
  if (!l.opened) {
    l.term.open(l.host);
    l.opened = true;
    l.fit.fit();
    const t = getState().tabs.find((x) => x.id === session.tabId);
    const srv = serverById(session.serverId);
    // A local terminal starts in the folder of the left half, one on the server in the server half's folder.
    const folder = session.serverId ? t?.remotePath : t?.localPath;
    const cwd = terminalSettings().startInFolder && folder ? folder : undefined;
    if (LIVE) {
      const start = () =>
        void backend
          .termOpen({
            id,
            serverId: session.serverId,
            cols: l.term.cols,
            rows: l.term.rows,
            cwd,
            startup: srv?.termStart || undefined,
            shell: session.serverId ? undefined : session.shell || terminalSettings().localShell || undefined,
          })
          .catch((e) => {
            l.term.writeln(`\x1b[31m${(e as { message?: string }).message ?? String(e)}\x1b[0m`);
            markEnded(id);
          });
      // A terminal reopened at the start waits until its server is connected.
      if (session.serverId && !srv?.online) {
        l.term.writeln(`\x1b[2m${$t('Warte auf die Verbindung zu {0} …', srv?.name ?? '')}\x1b[0m`);
        const stop = subscribeStore(() => {
          if (serverById(session.serverId)?.online) {
            stop();
            start();
          }
        });
      } else start();
    } else {
      // Browser prototype and website demo: no backend to start.
      startPreviewSession(l.term, session, srv, folder);
    }
  } else {
    l.fit.fit();
  }
  l.term.focus();
}

function markEnded(id: string) {
  setState((s) => ({ terminals: s.terminals.map((x) => (x.id === id ? { ...x, alive: false } : x)) }));
}

/** Ends a session and removes it; the panel shows the next one or closes. */
export function closeTerminal(id: string) {
  const session = getState().terminals.find((x) => x.id === id);
  if (LIVE) void backend.termClose(id).catch(() => undefined);
  live.get(id)?.suggest.dispose();
  live.get(id)?.term.dispose();
  live.delete(id);
  setState((s) => ({ terminals: s.terminals.filter((x) => x.id !== id) }));
  if (!session) return;
  const rest = getState().terminals.filter((x) => x.tabId === session.tabId);
  const t = getState().tabs.find((x) => x.id === session.tabId);
  if (t?.terminal?.active === id)
    patchTab(
      session.tabId,
      rest.length ? { active: rest[rest.length - 1].id } : { open: false, active: undefined, full: false },
    );
}

/** Panel on/off (toolbar button and shortcut); the first time it starts a session. */
export function toggleTerminal(where?: 'local' | 'server') {
  const t = activeTab();
  if (!t) return;
  const has = getState().terminals.some((x) => x.tabId === t.id && (!where || (where === 'server') === !!x.serverId));
  if (!has) {
    newTerminal(where);
    return;
  }
  patchTab(t.id, { open: !t.terminal?.open });
}

/** Brings a session of the tab to the front. */
export function setActiveTerminal(tabId: string, id: string) {
  patchTab(tabId, { active: id });
}

/** Moves a session into a tab of its own, where it fills the window. */
export function terminalInOwnTab(id: string) {
  const session = getState().terminals.find((x) => x.id === id);
  const from = getState().tabs.find((x) => x.id === session?.tabId);
  if (!session || !from) return;
  const tab: Tab = {
    id: uid('tab'),
    serverId: from.serverId,
    localPath: from.localPath,
    remotePath: from.remotePath,
    back: [],
    forward: [],
    terminal: { open: true, active: id, full: true },
  };
  setState((s) => ({
    tabs: [...s.tabs, tab],
    activeTabId: tab.id,
    terminals: s.terminals.map((x) => (x.id === id ? { ...x, tabId: tab.id } : x)),
  }));
  const rest = getState().terminals.filter((x) => x.tabId === from.id);
  patchTab(from.id, rest.length ? { active: rest[0].id } : { open: false, active: undefined });
}

/** Back from the whole tab into the panel below the halves. */
export function terminalBackToPanel() {
  const t = activeTab();
  if (t) patchTab(t.id, { full: false, open: true });
}

/** Listens for output and ends; closes sessions of closed tabs. */
export async function initTerminals() {
  if (LIVE) {
    await listen<{ id: string; data: string }>('term-data', (e) =>
      live.get(e.payload.id)?.term.write(fromBase64(e.payload.data)),
    );
    await listen<{ id: string; code: number | null }>('term-exit', (e) => {
      const l = live.get(e.payload.id);
      l?.term.write(`\r\n\x1b[2m${$t('[Sitzung beendet]')}\x1b[0m\r\n`);
      markEnded(e.payload.id);
    });
  }
  let prev = getState();
  subscribeStore(() => {
    const s = getState();
    if (s.tabs !== prev.tabs) {
      const ids = new Set(s.tabs.map((t) => t.id));
      for (const x of s.terminals) if (!ids.has(x.tabId)) closeTerminal(x.id);
    }
    if (s.settings.terminal !== prev.settings.terminal || s.theme !== prev.theme || s.servers !== prev.servers)
      applySettings();
    prev = s;
  });
}
