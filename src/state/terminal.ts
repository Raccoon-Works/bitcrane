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
import { activeTab, getState, LIVE, openDialog, openExternal, serverById, setState, showToast, subscribeStore, uid } from './store';

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
  /** Old switch (0.2.48): on meant the dimmed suggestions; `suggest` replaces it. */
  suggestions?: boolean;
  /** Suggestions while typing (termSuggest.ts): off, only the dimmed rest, or with the list. */
  suggest: 'off' | 'ghost' | 'list';
  /** Lines kept for scrolling back. */
  scrollback: number;
  /** Right click: copy the selection, or paste when nothing is selected (PuTTY, Windows Terminal). */
  rightClick: 'smart' | 'off';
  /** Ask before pasting text with several lines (each line would run at once). */
  pasteWarn: boolean;
  /** Shell of the terminal on this computer (term_shells); '' = the default. */
  localShell: string;
  /** Open the terminals of the tabs again at the next start (with "Tabs vom letzten Mal"). */
  restore: boolean;
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
  { id: 'bitcrane-dark', name: 'Bitcrane dunkel', theme: { background: '#111111', foreground: '#ededef', cursor: '#5fb0ff', cursorAccent: '#111111', selectionBackground: '#28466b', ...DARK } },
  { id: 'bitcrane-light', name: 'Bitcrane hell', theme: { background: '#ffffff', foreground: '#1d1d1f', cursor: '#1d1d1f', cursorAccent: '#ffffff', selectionBackground: '#b8d4fb', ...LIGHT } },
  { id: 'solarized-dark', name: 'Solarized Dark', theme: { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642', ...SOLARIZED } },
  { id: 'solarized-light', name: 'Solarized Light', theme: { background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5', ...SOLARIZED } },
  { id: 'dracula', name: 'Dracula', theme: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a', ...base16(['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']) } },
  { id: 'nord', name: 'Nord', theme: { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e', ...base16(['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']) } },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', theme: { background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945', ...base16(['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']) } },
  { id: 'one-dark', name: 'One Dark', theme: { background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#282c34', selectionBackground: '#3e4451', ...base16(['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']) } },
  { id: 'tomorrow-night', name: 'Tomorrow Night', theme: { background: '#1d1f21', foreground: '#c5c8c6', cursor: '#c5c8c6', cursorAccent: '#1d1f21', selectionBackground: '#373b41', ...base16(['#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6', '#969896', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#ffffff']) } },
  { id: 'campbell', name: 'Campbell (Windows Terminal)', theme: { background: '#0c0c0c', foreground: '#cccccc', cursor: '#cccccc', cursorAccent: '#0c0c0c', selectionBackground: '#264f78', ...base16(['#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#0037da', '#881798', '#3a96dd', '#cccccc', '#767676', '#e74856', '#16c60c', '#f9f1a5', '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2']) } },
  { id: 'ubuntu', name: 'Ubuntu', theme: { background: '#300a24', foreground: '#eeeeec', cursor: '#eeeeec', cursorAccent: '#300a24', selectionBackground: '#5e2750', ...base16(['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf', '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec']) } },
  { id: 'monokai', name: 'Monokai', theme: { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', cursorAccent: '#272822', selectionBackground: '#49483e', ...base16(['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2', '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']) } },
  { id: 'tokyo-night', name: 'Tokyo Night', theme: { background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: '#33467c', ...base16(['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']) } },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e', selectionBackground: '#45475a', ...base16(['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']) } },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', theme: { background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', cursorAccent: '#eff1f5', selectionBackground: '#ccd0da', ...base16(['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be', '#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc']) } },
  { id: 'github-dark', name: 'GitHub Dark', theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9', cursorAccent: '#0d1117', selectionBackground: '#264f78', ...base16(['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4', '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc']) } },
  { id: 'github-light', name: 'GitHub Light', theme: { background: '#ffffff', foreground: '#24292f', cursor: '#24292f', cursorAccent: '#ffffff', selectionBackground: '#b6e3ff', ...base16(['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f']) } },
  { id: 'ayu-dark', name: 'Ayu Dark', theme: { background: '#0b0e14', foreground: '#bfbdb6', cursor: '#e6b450', cursorAccent: '#0b0e14', selectionBackground: '#273747', ...base16(['#01060e', '#ea6c73', '#7fd962', '#f9af4f', '#53bdfa', '#cda1fa', '#90e1c6', '#c7c7c7', '#686868', '#f07178', '#aad94c', '#ffb454', '#59c2ff', '#d2a6ff', '#95e6cb', '#ffffff']) } },
  { id: 'night-owl', name: 'Night Owl', theme: { background: '#011627', foreground: '#d6deeb', cursor: '#80a4c2', cursorAccent: '#011627', selectionBackground: '#1d3b53', ...base16(['#011627', '#ef5350', '#22da6e', '#addb67', '#82aaff', '#c792ea', '#21c7a8', '#ffffff', '#575656', '#ef5350', '#22da6e', '#ffeb95', '#82aaff', '#c792ea', '#7fdbca', '#ffffff']) } },
  { id: 'rose-pine', name: 'Rosé Pine', theme: { background: '#191724', foreground: '#e0def4', cursor: '#524f67', cursorAccent: '#e0def4', selectionBackground: '#403d52', ...base16(['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4', '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4']) } },
  { id: 'kanagawa', name: 'Kanagawa', theme: { background: '#1f1f28', foreground: '#dcd7ba', cursor: '#c8c093', cursorAccent: '#1f1f28', selectionBackground: '#2d4f67', ...base16(['#16161d', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093', '#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba']) } },
  { id: 'everforest', name: 'Everforest', theme: { background: '#2d353b', foreground: '#d3c6aa', cursor: '#d3c6aa', cursorAccent: '#2d353b', selectionBackground: '#543a48', ...base16(['#475258', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa', '#475258', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa']) } },
  { id: 'snazzy', name: 'Snazzy', theme: { background: '#282a36', foreground: '#eff0eb', cursor: '#97979b', cursorAccent: '#282a36', selectionBackground: '#3e404a', ...base16(['#282a36', '#ff5c57', '#5af78e', '#f3f99d', '#57c7ff', '#ff6ac1', '#9aedfe', '#f1f1f0', '#686868', '#ff5c57', '#5af78e', '#f3f99d', '#57c7ff', '#ff6ac1', '#9aedfe', '#eff0eb']) } },
  { id: 'cobalt2', name: 'Cobalt2', theme: { background: '#193549', foreground: '#ffffff', cursor: '#f0cc09', cursorAccent: '#193549', selectionBackground: '#18354f', ...base16(['#000000', '#ff0000', '#38de21', '#ffe50a', '#1460d2', '#ff005d', '#00bbbb', '#bbbbbb', '#555555', '#f40e17', '#3bd01d', '#edc809', '#5555ff', '#ff55ff', '#6ae3fa', '#ffffff']) } },
  { id: 'gruvbox-light', name: 'Gruvbox Light', theme: { background: '#fbf1c7', foreground: '#3c3836', cursor: '#3c3836', cursorAccent: '#fbf1c7', selectionBackground: '#d5c4a1', ...base16(['#fbf1c7', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#7c6f64', '#928374', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#3c3836']) } },
  { id: 'tomorrow', name: 'Tomorrow', theme: { background: '#ffffff', foreground: '#4d4d4c', cursor: '#4d4d4c', cursorAccent: '#ffffff', selectionBackground: '#d6d6d6', ...base16(['#000000', '#c82829', '#718c00', '#eab700', '#4271ae', '#8959a8', '#3e999f', '#d6d6d6', '#8e908c', '#c82829', '#718c00', '#eab700', '#4271ae', '#8959a8', '#3e999f', '#4d4d4c']) } },
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
  suggest: 'list',
  scrollback: 10000,
  rightClick: getState().platform === 'mac' ? 'off' : 'smart',
  pasteWarn: true,
  localShell: '',
  restore: false,
});

export const terminalSettings = (): TerminalSettings => {
  const saved = getState().settings.terminal ?? {};
  return { ...defaultTerminalSettings(), ...saved, ...(saved.suggest ? {} : saved.suggestions ? { suggest: 'list' as const } : {}) };
};

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
    scrollback: st.scrollback,
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
  // Every paste goes through pasteInto (warning for several lines), also the browser's own.
  host.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    e.preventDefault();
    e.stopPropagation();
    if (text) pasteInto(term, text);
  }, true);
  // Right click: copy the selection, or paste when nothing is selected.
  host.addEventListener('contextmenu', (e) => {
    if (terminalSettings().rightClick !== 'smart') return;
    e.preventDefault();
    e.stopPropagation();
    if (term.hasSelection()) {
      void navigator.clipboard?.writeText(term.getSelection());
      term.clearSelection();
    } else void navigator.clipboard?.readText().then((t) => t && pasteInto(term, t));
  });
  const write = (d: string) => {
    if (LIVE) void invoke('term_write', { id: session.id, data: d }).catch(() => undefined);
    else previewEcho(term, d);
  };
  const suggest = new Suggester(term, host, session.serverId, {
    mode: () => terminalSettings().suggest,
    snippets: () => getState().settings.snippets ?? [],
    startDir: () => { const t = getState().tabs.find((x) => x.id === session.tabId); return (session.serverId ? t?.remotePath : t?.localPath) || '~'; },
  }, (d) => { suggest.input(d); write(d); });
  term.onData((input) => write(suggest.input(input)));
  term.onResize(({ cols, rows }) => {
    if (LIVE) void invoke('term_resize', { id: session.id, cols, rows }).catch(() => undefined);
  });
  term.onSelectionChange(() => {
    if (terminalSettings().copyOnSelect && term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection());
  });
  // Windows and Linux: Strg+C stays "interrupt"; copying and pasting is Strg+Umschalt+C/V.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Arrow keys and Esc belong to the suggestion list while it is open.
    if (suggest.handleKey(e)) { e.preventDefault(); return false; }
    const mac = getState().platform === 'mac';
    const copy = mac ? e.metaKey && e.key === 'c' : e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c';
    const paste = mac ? e.metaKey && e.key === 'v' : e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v';
    if (copy && term.hasSelection()) {
      void navigator.clipboard?.writeText(term.getSelection());
      return false;
    }
    if (paste) {
      void navigator.clipboard?.readText().then((t) => t && pasteInto(term, t));
      return false;
    }
    // ⌘ shortcuts on the Mac belong to Bitcrane, not to the shell.
    if (mac && e.metaKey) return false;
    return true;
  });
  return { term, fit, search, host, opened: false, suggest };
}

/** Pastes text; with several lines it asks first, since each line would run at once. */
function pasteInto(term: Terminal, text: string) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length < 2 || !terminalSettings().pasteWarn) {
    term.paste(text);
    return;
  }
  const preview = lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n…' : '');
  openDialog({
    type: 'confirm',
    title: $t('{0} Zeilen einfügen?', String(lines.length)),
    text: $t('Jede Zeile wird sofort ausgeführt, als hättest du Enter gedrückt.'),
    detail: preview,
    confirm: $t('Einfügen'),
    run: () => { term.paste(text); term.focus(); },
  });
}

/** Without the backend (prototype): a minimal echo, so typing and suggestions can be tried. */
function previewEcho(term: Terminal, d: string) {
  if (d === '\r') term.write('\r\n$ ');
  else if (d === '\x7f') term.write('\b \b');
  else if (!d.startsWith('\x1b')) term.write(d);
}

/** Recreates the terminals of a restored tab; they start when the tab shows them. */
export function reopenTerminals(tabId: string, serverIds: string[], open: boolean) {
  const sessions: TermSession[] = [];
  for (const serverId of serverIds) {
    if (serverId && !serverById(serverId)) continue;
    const number = [...getState().terminals, ...sessions].filter((x) => x.serverId === serverId).reduce((n, x) => Math.max(n, x.number), 0) + 1;
    const session: TermSession = { id: uid('term'), serverId, tabId, number, alive: true };
    live.set(session.id, makeTerminal(session));
    sessions.push(session);
  }
  if (!sessions.length) return;
  setState((s) => ({ terminals: [...s.terminals, ...sessions] }));
  patchTab(tabId, { open, active: sessions[0].id });
}

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
      const start = () => void invoke('term_open', { id, serverId: session.serverId, cols: l.term.cols, rows: l.term.rows, cwd, startup: srv?.termStart || null, shell: session.serverId ? null : terminalSettings().localShell || null }).catch((e) => {
        l.term.writeln(`\x1b[31m${(e as { message?: string }).message ?? String(e)}\x1b[0m`);
        markEnded(id);
      });
      // A terminal reopened at the start waits until its server is connected.
      if (session.serverId && !srv?.online) {
        l.term.writeln(`\x1b[2m${$t('Warte auf die Verbindung zu {0} …', srv?.name ?? '')}\x1b[0m`);
        const stop = subscribeStore(() => { if (serverById(session.serverId)?.online) { stop(); start(); } });
      } else start();
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
    l.term.options.scrollback = st.scrollback;
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
