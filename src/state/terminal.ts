/**
 * Built-in SSH terminal (see src-tauri/src/terminal.rs).
 *
 * A terminal session belongs to a tab and its server. It is shown in the
 * panel below the two halves, or alone in a tab of its own ("In eigenem Tab").
 * The xterm.js instances live outside React in `live`, so switching tabs or
 * hiding the panel keeps their content; React only moves their element.
 *
 * Ideas taken from Tabby (MIT): snippets, colour schemes, per-server profile
 * settings. The colour values are the published palettes of the schemes.
 */
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Tab } from '../backend/types';
import { $t } from '../i18n';
import { isSftp } from './live';
import { Suggester } from './termSuggest';
import { activeTab, getState, LIVE, openExternal, serverById, setState, showToast, subscribeStore, uid } from './store';

export interface TermSession {
  id: string;
  serverId: string;
  tabId: string;
  /** Number shown in the panel's tab ("bot-host 2"). */
  number: number;
  alive: boolean;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  /** Press Enter after inserting (otherwise the command waits for a look). */
  run: boolean;
  /** Group in the snippet menu and the settings ("KRT Orbit"); none: at the top. */
  group?: string;
  /** Kept in the settings but left out of the snippet menu. */
  hidden?: boolean;
}

export interface TerminalSettings {
  scheme: string;
  fontFamily: string;
  fontSize: number;
  cursor: 'block' | 'bar' | 'underline';
  copyOnSelect: boolean;
  /** Start in the folder the server half shows. */
  startInFolder: boolean;
  /** Dimmed suggestions from the history while typing (termSuggest.ts). */
  suggestions: boolean;
}

/** Tab state of the terminal: panel shown, session in front, whole tab. */
export interface TabTerminal {
  open: boolean;
  active?: string;
  full?: boolean;
}

/* --------------------------------------------------------------- Schemes */

const base16 = (c: string[]): Partial<ITheme> => ({
  black: c[0], red: c[1], green: c[2], yellow: c[3], blue: c[4], magenta: c[5], cyan: c[6], white: c[7],
  brightBlack: c[8], brightRed: c[9], brightGreen: c[10], brightYellow: c[11], brightBlue: c[12], brightMagenta: c[13], brightCyan: c[14], brightWhite: c[15],
});

const DARK = base16(['#1d1d20', '#ef6b63', '#63c486', '#e5c07b', '#5aa2f5', '#c678dd', '#56b6c2', '#d2d2d7', '#5e5e64', '#ff8a80', '#7ee2a0', '#f2d48f', '#82bbff', '#d99ae8', '#7fd3dd', '#ffffff']);
const LIGHT = base16(['#1d1d1f', '#c4302b', '#2f8a4e', '#9a6a00', '#1e63d0', '#9b3fb5', '#1b7f8c', '#d0d0d5', '#6e6e75', '#d9443e', '#3aa45f', '#b58200', '#2f78e6', '#b04fcc', '#2496a4', '#ffffff']);
const SOLARIZED = base16(['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']);

/** The schemes on offer: two that match Bitcrane plus well-known classics. */
export const SCHEMES: Array<{ id: string; name: string; theme: ITheme }> = [
  { id: 'bitcrane-dark', name: 'Bitcrane dunkel', theme: { background: '#141416', foreground: '#ededef', cursor: '#ededef', cursorAccent: '#141416', selectionBackground: '#3d5a80', ...DARK } },
  { id: 'bitcrane-light', name: 'Bitcrane hell', theme: { background: '#ffffff', foreground: '#1d1d1f', cursor: '#1d1d1f', cursorAccent: '#ffffff', selectionBackground: '#b8d4fb', ...LIGHT } },
  { id: 'solarized-dark', name: 'Solarized Dark', theme: { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642', ...SOLARIZED } },
  { id: 'solarized-light', name: 'Solarized Light', theme: { background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5', ...SOLARIZED } },
  { id: 'dracula', name: 'Dracula', theme: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a', ...base16(['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']) } },
  { id: 'nord', name: 'Nord', theme: { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e', ...base16(['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']) } },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', theme: { background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945', ...base16(['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']) } },
  { id: 'one-dark', name: 'One Dark', theme: { background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#282c34', selectionBackground: '#3e4451', ...base16(['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']) } },
  { id: 'tomorrow-night', name: 'Tomorrow Night', theme: { background: '#1d1f21', foreground: '#c5c8c6', cursor: '#c5c8c6', cursorAccent: '#1d1f21', selectionBackground: '#373b41', ...base16(['#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6', '#969896', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#ffffff']) } },
  // For production servers: unmistakably red, so nobody types into the wrong one.
  { id: 'production', name: 'Produktivserver (rot)', theme: { background: '#2b1517', foreground: '#f3dede', cursor: '#ff8a80', cursorAccent: '#2b1517', selectionBackground: '#5c2a2e', ...DARK } },
];

export const defaultTerminalSettings = (): TerminalSettings => ({
  scheme: 'auto',
  fontFamily: getState().platform === 'mac' ? '"SF Mono", Menlo, Monaco, monospace' : '"Cascadia Mono", Consolas, "Courier New", monospace',
  fontSize: 13,
  cursor: 'block',
  copyOnSelect: false,
  startInFolder: true,
  suggestions: false,
});

export const terminalSettings = (): TerminalSettings => ({ ...defaultTerminalSettings(), ...(getState().settings.terminal ?? {}) });

/** Scheme for a server: its own, else the setting ("auto" follows Bitcrane's light/dark). */
export function themeFor(serverId: string): ITheme {
  const id = serverById(serverId)?.termScheme || terminalSettings().scheme;
  const chosen = id === 'auto' ? (getState().theme === 'light' ? 'bitcrane-light' : 'bitcrane-dark') : id;
  return (SCHEMES.find((s) => s.id === chosen) ?? SCHEMES[0]).theme;
}

/* --------------------------------------------------------------- Sessions */

interface Live {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  opened: boolean;
  suggest: Suggester;
}

const live = new Map<string, Live>();

/** Whether the tab's server can have a terminal (SSH). */
export function canHaveTerminal(t: Tab | undefined = activeTab()): boolean {
  const srv = t?.serverId ? serverById(t.serverId) : undefined;
  return !!srv && isSftp(srv);
}

function patchTab(tabId: string, patch: Partial<TabTerminal>) {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, terminal: { open: false, ...t.terminal, ...patch } } : t)) }));
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function makeTerminal(session: TermSession): Live {
  const st = terminalSettings();
  const term = new Terminal({
    fontFamily: st.fontFamily,
    fontSize: st.fontSize,
    cursorStyle: st.cursor,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: themeFor(session.serverId),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, url) => openExternal(url)));
  const host = document.createElement('div');
  host.className = 'term-host';
  const suggest = new Suggester(term, host, session.serverId, () => terminalSettings().suggestions, () => getState().settings.snippets ?? []);
  term.onData((input) => {
    const d = suggest.input(input);
    if (LIVE) void invoke('term_write', { id: session.id, data: d }).catch(() => undefined);
    else previewEcho(term, d);
  });
  term.onResize(({ cols, rows }) => {
    if (LIVE) void invoke('term_resize', { id: session.id, cols, rows }).catch(() => undefined);
  });
  term.onSelectionChange(() => {
    if (terminalSettings().copyOnSelect && term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection());
  });
  // Windows and Linux: Strg+C stays "interrupt"; copying and pasting is Strg+Umschalt+C/V.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mac = getState().platform === 'mac';
    const copy = mac ? e.metaKey && e.key === 'c' : e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c';
    const paste = mac ? e.metaKey && e.key === 'v' : e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v';
    if (copy && term.hasSelection()) {
      void navigator.clipboard?.writeText(term.getSelection());
      return false;
    }
    if (paste) {
      void navigator.clipboard?.readText().then((t) => t && term.paste(t));
      return false;
    }
    // ⌘ shortcuts on the Mac belong to Bitcrane, not to the shell.
    if (mac && e.metaKey) return false;
    return true;
  });
  return { term, fit, search, host, opened: false, suggest };
}

/** Without the backend (prototype): a minimal echo, so typing and suggestions can be tried. */
function previewEcho(term: Terminal, d: string) {
  if (d === '\r') term.write('\r\n$ ');
  else if (d === '\x7f') term.write('\b \b');
  else if (!d.startsWith('\x1b')) term.write(d);
}

/** Starts a terminal for the active tab's server (in the folder it shows). */
/**
 * Starts a terminal: on the tab's SSH server when it is connected (and the
 * server half has the focus), otherwise on this computer like Tabby or the
 * system terminal. `where` forces one of the two.
 */
export function newTerminal(where?: 'local' | 'server', full = false) {
  const t = activeTab();
  if (!t) return;
  const srv = t.serverId ? serverById(t.serverId) : undefined;
  const sshReady = !!srv && canHaveTerminal(t) && (srv.online || !LIVE);
  const onServer = where === 'server' || (where !== 'local' && sshReady && getState().focusSide === 'remote');
  if (onServer && !sshReady) {
    showToast(srv && canHaveTerminal(t) ? $t('Erst mit {0} verbinden.', srv.name) : $t('Ein SSH-Terminal gibt es für SSH-Server (SFTP).'));
    return;
  }
  const serverId = onServer ? t.serverId : '';
  const number = getState().terminals.filter((x) => x.serverId === serverId).reduce((n, x) => Math.max(n, x.number), 0) + 1;
  const session: TermSession = { id: uid('term'), serverId, tabId: t.id, number, alive: true };
  live.set(session.id, makeTerminal(session));
  setState((s) => ({ terminals: [...s.terminals, session] }));
  patchTab(t.id, { open: true, active: session.id, full: full || t.terminal?.full });
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
      void invoke('term_open', { id, serverId: session.serverId, cols: l.term.cols, rows: l.term.rows, cwd, startup: srv?.termStart || null }).catch((e) => {
        l.term.writeln(`\x1b[31m${(e as { message?: string }).message ?? String(e)}\x1b[0m`);
        markEnded(id);
      });
    } else {
      l.term.writeln('Bitcrane – Terminal (Vorschau)');
      l.term.write('$ ');
    }
  } else {
    l.fit.fit();
  }
  l.term.focus();
}

/** Keeps the terminal the size of its area. */
export function fitTerminal(id: string) {
  const l = live.get(id);
  if (l?.opened) {
    try {
      l.fit.fit();
    } catch {
      // Not on screen right now.
    }
  }
}

export function focusTerminal(id: string) {
  live.get(id)?.term.focus();
}

function markEnded(id: string) {
  setState((s) => ({ terminals: s.terminals.map((x) => (x.id === id ? { ...x, alive: false } : x)) }));
}

/** Ends a session and removes it; the panel shows the next one or closes. */
export function closeTerminal(id: string) {
  const session = getState().terminals.find((x) => x.id === id);
  if (LIVE) void invoke('term_close', { id }).catch(() => undefined);
  live.get(id)?.suggest.dispose();
  live.get(id)?.term.dispose();
  live.delete(id);
  setState((s) => ({ terminals: s.terminals.filter((x) => x.id !== id) }));
  if (!session) return;
  const rest = getState().terminals.filter((x) => x.tabId === session.tabId);
  const t = getState().tabs.find((x) => x.id === session.tabId);
  if (t?.terminal?.active === id) patchTab(session.tabId, rest.length ? { active: rest[rest.length - 1].id } : { open: false, active: undefined, full: false });
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
  const tab: Tab = { id: uid('tab'), serverId: from.serverId, localPath: from.localPath, remotePath: from.remotePath, back: [], forward: [], terminal: { open: true, active: id, full: true } };
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

/**
 * Splits a snippet into what is typed and pauses. Understands the escapes of
 * Tabby's Quick Commands: \\xHH for a control character (\\x03 is Ctrl+C) and
 * \\s<ms> for a pause; several lines are sent one after another.
 */
export function snippetParts(command: string): Array<string | number> {
  const parts: Array<string | number> = [];
  let text = '';
  const re = /\\x([0-9a-f]{2})|\\s(\d+)/gi;
  let last = 0;
  for (let m = re.exec(command); m; m = re.exec(command)) {
    text += command.slice(last, m.index);
    if (m[1]) text += String.fromCharCode(parseInt(m[1], 16));
    else { if (text) parts.push(text); text = ''; parts.push(Math.min(60000, Number(m[2]))); }
    last = m.index + m[0].length;
  }
  text += command.slice(last);
  if (text) parts.push(text.replace(/\r?\n/g, '\r'));
  return parts;
}

export async function sendSnippet(id: string, snippet: Snippet) {
  const l = live.get(id);
  if (!l) return;
  l.term.focus();
  const parts = snippetParts(snippet.command);
  if (snippet.run) parts.push('\r');
  for (const p of parts) {
    if (typeof p === 'number') { await new Promise((r) => setTimeout(r, p)); continue; }
    if (LIVE) await invoke('term_write', { id, data: p }).catch(() => undefined);
    else l.term.write(p === '\r' ? '\r\n$ ' : p);
  }
}

/**
 * Takes over the commands of Tabby's Quick Commands plugin (config.yaml,
 * `qc.cmds` and `qc.groups`) as snippets with their groups. Commands already
 * here (same name and command) are skipped. Returns how many were added, or
 * null when Tabby or its quick commands were not found.
 */
export async function importTabbySnippets(): Promise<number | null> {
  const text = LIVE ? await invoke<string | null>('tabby_config').catch(() => null) : PREVIEW_TABBY;
  if (!text) return null;
  const { load } = await import('js-yaml');
  let qc: { cmds?: Array<{ name?: string; text?: string; appendCR?: boolean; group?: string; hidden?: boolean }>; groups?: Array<{ name?: string; hidden?: boolean }> } | undefined;
  try {
    qc = (load(text) as { qc?: typeof qc } | null)?.qc;
  } catch {
    return null;
  }
  if (!qc?.cmds?.length) return null;
  const s = getState().settings;
  const have = s.snippets ?? [];
  const hiddenGroups = new Set((qc.groups ?? []).filter((g) => g.hidden && g.name).map((g) => g.name));
  const added: Snippet[] = [];
  for (const c of qc.cmds) {
    if (!c.text) continue;
    const name = c.name ?? '';
    if (have.some((x) => x.name === name && x.command === c.text) || added.some((x) => x.name === name && x.command === c.text)) continue;
    added.push({ id: uid('sn'), name, command: c.text, run: !!c.appendCR, group: c.group || undefined, hidden: !!c.hidden || (!!c.group && hiddenGroups.has(c.group)) || undefined });
  }
  const groups = [...(s.snippetGroups ?? [])];
  for (const g of [...(qc.groups ?? []).map((x) => x.name), ...added.map((x) => x.group)]) if (g && !groups.includes(g)) groups.push(g);
  setState((st) => ({ settings: { ...st.settings, snippets: [...have, ...added], snippetGroups: groups } }));
  return added.length;
}

/** Sample for the prototype (no Tabby there). */
const PREVIEW_TABBY = `qc:
  groups:
    - name: KRT Orbit
  cmds:
    - name: Bot neu starten
      text: cd ~/krt-orbit-bot && bash restart.sh bot
      appendCR: true
      group: KRT Orbit
    - name: Zustand ansehen
      text: pm2 status
      appendCR: true
      group: KRT Orbit
    - name: Letzte Log-Zeilen des Bots
      text: pm2 logs krt-orbit-bot --lines 40
      appendCR: true
      group: KRT Orbit
`;

export function findInTerminal(id: string, text: string, back = false) {
  const l = live.get(id);
  if (!l || !text) return;
  if (back) l.search.findPrevious(text);
  else l.search.findNext(text);
}

export function clearTerminal(id: string) {
  live.get(id)?.term.clear();
}

/** Applies changed settings (font, scheme, cursor) to every open terminal. */
function applySettings() {
  const st = terminalSettings();
  for (const [id, l] of live) {
    const session = getState().terminals.find((x) => x.id === id);
    if (!session) continue;
    l.term.options.fontFamily = st.fontFamily;
    l.term.options.fontSize = st.fontSize;
    l.term.options.cursorStyle = st.cursor;
    l.term.options.theme = themeFor(session.serverId);
    if (l.opened) fitTerminal(id);
    l.suggest.update();
  }
}

/** Listens for output and ends; closes sessions of closed tabs. */
export async function initTerminals() {
  if (LIVE) {
    await listen<{ id: string; data: string }>('term-data', (e) => live.get(e.payload.id)?.term.write(decode(e.payload.data)));
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
    if (s.settings.terminal !== prev.settings.terminal || s.theme !== prev.theme || s.servers !== prev.servers) applySettings();
    prev = s;
  });
}
