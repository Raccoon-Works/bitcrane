/**
 * The xterm.js instances of the sessions. They live outside React, so
 * switching tabs or hiding the panel keeps their content; React only moves
 * their element. Here: creating one with its input handling (paste, copy,
 * right click, suggestions), sizing, searching and applying changed settings.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { $t } from '../../i18n';
import { getState, LIVE, openDialog, openExternal } from '../store';
import { Suggester } from '../termSuggest';
import { previewEcho } from './preview';
import { terminalSettings, themeFor } from './settings';
import type { TermSession } from './types';

export interface Live {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  opened: boolean;
  suggest: Suggester;
}

/** The instance of every session, by session id. */
export const live = new Map<string, Live>();

export function makeTerminal(session: TermSession): Live {
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
  host.addEventListener(
    'paste',
    (e) => {
      const text = e.clipboardData?.getData('text/plain');
      e.preventDefault();
      e.stopPropagation();
      if (text) pasteInto(term, text);
    },
    true,
  );
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
    if (LIVE) void backend.termWrite(session.id, d).catch(() => undefined);
    else previewEcho(term, d);
  };
  const suggest = new Suggester(
    term,
    host,
    session.serverId,
    {
      mode: () => terminalSettings().suggest,
      snippets: () => getState().settings.snippets ?? [],
      startDir: () => {
        const t = getState().tabs.find((x) => x.id === session.tabId);
        return (session.serverId ? t?.remotePath : t?.localPath) || '~';
      },
    },
    (d) => {
      suggest.input(d);
      write(d);
    },
  );
  term.onData((input) => write(suggest.input(input)));
  term.onResize(({ cols, rows }) => {
    if (LIVE) void backend.termResize(session.id, cols, rows).catch(() => undefined);
  });
  term.onSelectionChange(() => {
    if (terminalSettings().copyOnSelect && term.hasSelection())
      void navigator.clipboard?.writeText(term.getSelection());
  });
  // Windows and Linux: Strg+C without a selection stays "interrupt"; with one it copies, Strg+V pastes.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Arrow keys and Esc belong to the suggestion list while it is open.
    if (suggest.handleKey(e)) {
      e.preventDefault();
      return false;
    }
    const mac = getState().platform === 'mac';
    // Windows as in Windows Terminal: Strg+V pastes, Strg+C copies while text is selected (else it interrupts).
    const copy = mac ? e.metaKey && e.key === 'c' : e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'c';
    const paste = mac ? e.metaKey && e.key === 'v' : e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'v';
    if (copy && term.hasSelection()) {
      void navigator.clipboard?.writeText(term.getSelection());
      term.clearSelection();
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
    run: () => {
      term.paste(text);
      term.focus();
    },
  });
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
export function applySettings() {
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
