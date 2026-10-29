/**
 * Suggestions while typing in the terminal (like the fish shell or Termius):
 * a list below the line with earlier commands of the same server, snippets,
 * common commands (termCatalog.ts) and the files and folders of the server
 * (read over the connection Bitcrane already has). The first one appears
 * dimmed behind the cursor; ↑/↓ choose, → takes it over, Esc closes the list.
 * Tab stays the shell's own completion.
 *
 * Bitcrane does not know what the shell is doing, so it reads the line from
 * the screen instead of counting key presses: when the first key of a line is
 * pressed, the cursor position is remembered ("anchor"); the input is the text
 * between the anchor and the cursor. That stays right after Tab completion,
 * Backspace, or the shell's own history. Typing that is not echoed (password
 * prompts) leaves the line empty, so it is neither suggested nor remembered.
 * Full-screen programs (vim, top, less) use the alternate buffer and are left
 * alone.
 *
 * The history is kept per server on this computer only (localStorage), at most
 * HISTORY_MAX lines per server. Lines that start with a space are not
 * remembered, as in bash with HISTCONTROL=ignorespace.
 */
import type { Terminal } from '@xterm/xterm';
import type { Snippet } from './terminal';
import { $t } from '../i18n';
import { tauriBackend as backend } from '../backend/tauriBackend';
import { homeOf } from './live';
import { LIVE } from './store';
import { COMMAND_CATALOG, PATH_COMMANDS } from './termCatalog';

const STORAGE_KEY = 'bitcrane.termHistory';
const HISTORY_MAX = 300;

type History = Record<string, string[]>;

let cache: History | null = null;

function load(): History {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as History;
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache ?? {}));
  } catch {
    // Storage full or unavailable: the history simply is not kept.
  }
}

/** Key of a server's history; the terminal on this computer has its own. */
const keyFor = (serverId: string) => serverId || 'local';

/** Remembers a command as the newest of its server (an older copy moves up). */
export function rememberCommand(serverId: string, line: string) {
  if (!line.trim() || line.startsWith(' ')) return;
  const h = load();
  const k = keyFor(serverId);
  const list = (h[k] ?? []).filter((x) => x !== line);
  list.unshift(line);
  h[k] = list.slice(0, HISTORY_MAX);
  persist();
}

/** Number of remembered commands over all servers (for the settings). */
export function historyCount(): number {
  return Object.values(load()).reduce((n, l) => n + l.length, 0);
}

/** Forgets the history of every server. */
export function clearHistory() {
  cache = {};
  persist();
}

export type CandidateKind = 'history' | 'snippet' | 'command' | 'folder' | 'file';

/** A suggestion: the whole input line it leads to. */
export interface Candidate {
  text: string;
  kind: CandidateKind;
  /** Shown instead of the text (snippet name, file name). */
  label?: string;
}

const MAX_SHOWN = 8;

/** Folder listings for path completion: path → names (folders end with "/"). */
const dirCache = new Map<string, { at: number; names: string[] }>();

/** The word being typed and where it starts. */
function lastToken(input: string): { token: string; start: number } {
  const i = Math.max(input.lastIndexOf(' '), input.lastIndexOf('\t')) + 1;
  return { token: input.slice(i), start: i };
}

/** Whether the word being typed is probably a file or folder. */
function wantsPath(input: string): boolean {
  const { token, start } = lastToken(input);
  if (/^(~|\.{1,2}|\/)/.test(token) || token.includes('/')) return true;
  if (start === 0) return false;
  const words = input.slice(0, start).trim().split(/\s+/);
  const cmd = words[0] === 'sudo' ? words[1] : words[0];
  return !!cmd && PATH_COMMANDS.has(cmd);
}

/** Candidates for the typed line, best first. `names` lists the folder of the word being typed. */
export function candidatesFor(serverId: string, input: string, snippets: Snippet[], names: string[] | null): Candidate[] {
  if (!input.trim()) return [];
  const out: Candidate[] = [];
  const seen = new Set<string>([input]);
  const push = (c: Candidate) => {
    if (seen.has(c.text) || out.length >= MAX_SHOWN) return;
    seen.add(c.text);
    out.push(c);
  };
  if (names) {
    const { token } = lastToken(input);
    const base = token.slice(token.lastIndexOf('/') + 1);
    for (const n of names) if (n.startsWith(base) && n !== base && !(base === '' && n.startsWith('.'))) push({ text: input + n.slice(base.length), kind: n.endsWith('/') ? 'folder' : 'file', label: n });
  }
  for (const c of load()[keyFor(serverId)] ?? []) if (c.startsWith(input)) push({ text: c, kind: 'history' });
  for (const sn of snippets) if (sn.command.startsWith(input)) push({ text: sn.command, kind: 'snippet', label: sn.name || undefined });
  for (const c of COMMAND_CATALOG) if (c.startsWith(input)) push({ text: c, kind: 'command' });
  return out;
}

/** Kept for the ghost-only mode: the rest of the best candidate. */
export function suggestionFor(serverId: string, input: string, snippets: Snippet[]): string {
  const best = candidatesFor(serverId, input, snippets, null)[0];
  return best ? best.text.slice(input.length) : '';
}

const KIND_LABEL: Record<CandidateKind, () => string> = {
  history: () => $t('Verlauf'),
  snippet: () => $t('Snippet'),
  command: () => $t('Befehl'),
  folder: () => $t('Ordner'),
  file: () => $t('Datei'),
};

/** Absolute buffer position (row counts from the top of the scrollback). */
interface Pos {
  row: number;
  col: number;
}

export interface SuggesterOptions {
  /** 'off', 'ghost' (only the dimmed rest) or 'list' (dimmed rest and the list). */
  mode: () => 'off' | 'ghost' | 'list';
  snippets: () => Snippet[];
  /** Folder the session started in (fallback when the prompt does not show one). */
  startDir: () => string;
}

/**
 * Per-session helper: tracks the anchor, reads the line, shows the dimmed
 * rest at the cursor and the list below the line.
 */
export class Suggester {
  private anchor: Pos | null = null;
  private items: Candidate[] = [];
  private sel = 0;
  private typed = '';
  /** Esc closed the list; it stays closed until the line changes. */
  private dismissed: string | null = null;
  private ghost: HTMLSpanElement;
  private list: HTMLDivElement;
  private frame = 0;
  private term: Terminal;
  private host: HTMLElement;
  private serverId: string;
  private opts: SuggesterOptions;
  private send: (data: string) => void;

  constructor(term: Terminal, host: HTMLElement, serverId: string, opts: SuggesterOptions, send: (data: string) => void) {
    this.term = term;
    this.host = host;
    this.serverId = serverId;
    this.opts = opts;
    this.send = send;
    this.ghost = document.createElement('span');
    this.ghost.className = 'term-ghost';
    this.ghost.setAttribute('aria-hidden', 'true');
    this.list = document.createElement('div');
    this.list.className = 'term-complete';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', $t('Vorschläge'));
    // Clicking an entry takes it over; the terminal keeps the focus.
    this.list.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (el) this.accept(Number(el.dataset.i));
    });
    host.appendChild(this.ghost);
    host.appendChild(this.list);
    term.onWriteParsed(() => this.schedule());
    term.onCursorMove(() => this.schedule());
    term.onScroll(() => this.schedule());
  }

  private enabled() {
    return this.opts.mode() !== 'off';
  }

  private cursor(): Pos {
    const b = this.term.buffer.active;
    return { row: b.baseY + b.cursorY, col: b.cursorX };
  }

  /** Text from the anchor to `to`, following wrapped rows. */
  private textBetween(from: Pos, to: Pos): string {
    const b = this.term.buffer.active;
    let out = '';
    for (let row = from.row; row <= to.row; row++) {
      const line = b.getLine(row);
      if (!line) return '';
      if (row > from.row && !line.isWrapped) return '';
      const start = row === from.row ? from.col : 0;
      const end = row === to.row ? to.col : this.term.cols;
      out += line.translateToString(false, start, end);
    }
    return out;
  }

  /** The whole input line (anchor to the end of its text), for remembering on Enter. */
  private wholeLine(): string {
    if (!this.anchor) return '';
    const b = this.term.buffer.active;
    let last = this.anchor.row;
    while (b.getLine(last + 1)?.isWrapped) last++;
    return this.textBetween(this.anchor, { row: last, col: this.term.cols }).trimEnd();
  }

  /** Whether the line can be read reliably right now. */
  private usable(): boolean {
    const b = this.term.buffer.active;
    if (b.type !== 'normal' || !this.anchor) return false;
    const c = this.cursor();
    return c.row > this.anchor.row || (c.row === this.anchor.row && c.col >= this.anchor.col);
  }

  /** Folder the shell is in, read from the prompt ("user@host:~/bots$ ", "PS C:\Users\x> "). */
  private promptDir(): string {
    if (!this.anchor) return this.opts.startDir();
    const prompt = this.term.buffer.active.getLine(this.anchor.row)?.translateToString(false, 0, this.anchor.col) ?? '';
    const unix = /:\s*(~[^\s$#>]*|\/[^\s$#>]*)\s*[$#%]\s*$/.exec(prompt) ?? /\s(~[^\s$#>]*|\/[^\s$#>]*)\s*[$#%>]\s*$/.exec(prompt);
    if (unix) return unix[1];
    const ps = /PS ([A-Za-z]:\\[^>]*)>\s*$/.exec(prompt);
    if (ps) return ps[1].replace(/\\/g, '/');
    return this.opts.startDir();
  }

  /** The folder to list for the word being typed, as the backend wants it. */
  private dirFor(input: string): string | null {
    if (!wantsPath(input)) return null;
    const { token } = lastToken(input);
    const cut = token.lastIndexOf('/');
    let dir = cut >= 0 ? token.slice(0, cut + 1) || '/' : '';
    const here = this.promptDir();
    if (!dir.startsWith('/') && !dir.startsWith('~') && !/^[A-Za-z]:/.test(dir)) dir = `${here.replace(/\/$/, '')}/${dir}`;
    if (this.serverId && dir.startsWith('~')) {
      const home = homeOf(this.serverId);
      if (!home) return null;
      dir = home.replace(/\/$/, '') + dir.slice(1);
    }
    return dir.length > 1 ? dir.replace(/\/+$/, '') || '/' : dir;
  }

  /** Names in a folder (cached for a minute); null while they are being read. */
  private names(dir: string): string[] | null {
    const key = `${this.serverId}|${dir}`;
    const hit = dirCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.names;
    if (!hit) {
      dirCache.set(key, { at: 0, names: [] });
      const read = !LIVE ? Promise.resolve([{ name: 'logs', kind: 'dir' }, { name: 'cogs', kind: 'dir' }, { name: 'bot.py', kind: 'file' }, { name: 'config.py', kind: 'file' }])
        : this.serverId ? backend.remoteList(this.serverId, dir) : backend.localList(dir);
      void read.then((entries) => {
        dirCache.set(key, { at: Date.now(), names: entries.map((e) => (e.kind === 'dir' ? `${e.name}/` : e.name)).sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b)) });
        this.schedule();
      }).catch(() => dirCache.set(key, { at: Date.now(), names: [] }));
    }
    return hit?.names.length ? hit.names : null;
  }

  /** Arrow keys and Esc while the list is open. Returns true when the key was used here. */
  handleKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown' || e.ctrlKey || e.metaKey || e.altKey) return false;
    const open = this.list.style.display === 'block';
    if (e.key === 'ArrowRight' && this.items.length && this.atEnd()) {
      this.accept(this.sel);
      return true;
    }
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = this.items.length;
      this.sel = (this.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      this.render();
      return true;
    }
    if (e.key === 'Escape') {
      this.dismissed = this.typed;
      this.hide();
      return true;
    }
    return false;
  }

  private atEnd(): boolean {
    const b = this.term.buffer.active;
    const c = this.cursor();
    return !(b.getLine(c.row)?.translateToString(true, c.col) ?? '').trim();
  }

  private accept(i: number) {
    const c = this.items[i];
    if (!c || !c.text.startsWith(this.typed)) return;
    const rest = c.text.slice(this.typed.length);
    this.hide();
    if (rest) this.send(rest);
  }

  /** Called with every piece of input before it goes to the shell. */
  input(data: string): string {
    if (!this.enabled()) {
      this.anchor = null;
      this.hide();
      return data;
    }
    if (data.includes('\r')) {
      if (this.usable()) rememberCommand(this.serverId, this.wholeLine());
      this.anchor = null;
      this.dismissed = null;
      this.hide();
      return data;
    }
    // Ctrl+C, Ctrl+D and Ctrl+L start over: the prompt may be redrawn elsewhere.
    if (data === '\x03' || data === '\x04' || data === '\x0c') {
      this.anchor = null;
      this.hide();
      return data;
    }
    // Escape sequences are keys like the arrows, or the terminal's own answers to the
    // shell (cursor position reports at start-up); neither begins a typed line.
    if (data.startsWith('\x1b')) return data;
    if (!this.anchor && this.term.buffer.active.type === 'normal') this.anchor = this.cursor();
    return data;
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  private hide() {
    this.items = [];
    this.ghost.textContent = '';
    this.ghost.style.display = 'none';
    this.list.style.display = 'none';
  }

  /** Recomputes the suggestions for the line as it is on the screen. */
  update() {
    const b = this.term.buffer.active;
    if (!this.enabled() || !this.usable() || b.viewportY !== b.baseY || !this.atEnd()) return this.hide();
    const typed = this.textBetween(this.anchor!, this.cursor());
    if (typed !== this.typed) {
      this.typed = typed;
      this.sel = 0;
      if (this.dismissed !== null && this.dismissed !== typed) this.dismissed = null;
    }
    const dir = this.dirFor(typed);
    this.items = candidatesFor(this.serverId, typed, this.opts.snippets(), dir === null ? null : this.names(dir));
    if (!this.items.length) return this.hide();
    this.sel = Math.min(this.sel, this.items.length - 1);
    this.render();
  }

  private render() {
    const b = this.term.buffer.active;
    const screen = this.host.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return this.hide();
    const cw = screen.clientWidth / this.term.cols;
    const ch = screen.clientHeight / this.term.rows;
    const box = screen.getBoundingClientRect();
    const hostBox = this.host.getBoundingClientRect();
    const left = box.left - hostBox.left + b.cursorX * cw;
    const top = box.top - hostBox.top + b.cursorY * ch;
    const font = { family: String(this.term.options.fontFamily), size: `${this.term.options.fontSize}px` };
    const rest = this.items[this.sel].text.slice(this.typed.length);
    this.ghost.textContent = rest;
    this.ghost.style.display = rest ? 'block' : 'none';
    Object.assign(this.ghost.style, { left: `${left}px`, top: `${top}px`, height: `${ch}px`, lineHeight: `${ch}px`, maxWidth: `${Math.max(0, (this.term.cols - b.cursorX) * cw)}px`, fontFamily: font.family, fontSize: font.size });
    if (this.opts.mode() !== 'list' || this.dismissed !== null) {
      this.list.style.display = 'none';
      return;
    }
    this.list.replaceChildren(...this.items.map((c, i) => {
      const row = document.createElement('div');
      row.className = `term-complete-item${i === this.sel ? ' is-sel' : ''}`;
      row.dataset.i = String(i);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === this.sel));
      const text = document.createElement('span');
      text.className = 'term-complete-text';
      text.textContent = c.label && c.kind !== 'snippet' ? c.label : c.text;
      const kind = document.createElement('span');
      kind.className = `term-complete-kind is-${c.kind}`;
      kind.textContent = c.kind === 'snippet' && c.label ? c.label : KIND_LABEL[c.kind]();
      row.append(text, kind);
      return row;
    }));
    this.list.style.fontFamily = font.family;
    this.list.style.fontSize = font.size;
    this.list.style.display = 'block';
    const anchorLeft = box.left - hostBox.left + (this.anchor ? Math.max(0, this.anchor.col) : b.cursorX) * cw;
    // Below the line, or above it when there is more room there; scrolls when neither fits.
    const below = top + ch + 2;
    this.list.style.maxHeight = '';
    const h = this.list.offsetHeight;
    const roomBelow = this.host.clientHeight - below - 4;
    const roomAbove = top - 6;
    const down = roomBelow >= h || roomBelow >= roomAbove;
    const room = down ? roomBelow : roomAbove;
    if (h > room) this.list.style.maxHeight = `${Math.max(ch * 2, room)}px`;
    this.list.style.top = `${down ? below : top - Math.min(h, room) - 2}px`;
    this.list.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
    this.list.style.left = `${Math.max(0, Math.min(anchorLeft, this.host.clientWidth - this.list.offsetWidth - 4))}px`;
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.ghost.remove();
    this.list.remove();
  }
}
