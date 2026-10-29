/**
 * Suggestions while typing in the terminal (like the fish shell or Terminus):
 * the rest of an earlier command of the same server, or of a snippet, appears
 * dimmed behind the cursor; the right arrow key takes it over.
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

/** The newest command (then snippet) that continues `input`; '' when there is none. */
export function suggestionFor(serverId: string, input: string, snippets: Snippet[]): string {
  if (!input.trim()) return '';
  const from = [...(load()[keyFor(serverId)] ?? []), ...snippets.map((s) => s.command)];
  const hit = from.find((c) => c.length > input.length && c.startsWith(input));
  return hit ? hit.slice(input.length) : '';
}

/** Absolute buffer position (row counts from the top of the scrollback). */
interface Pos {
  row: number;
  col: number;
}

/**
 * Per-session helper: tracks the anchor, reads the line, and shows the
 * suggestion as a dimmed overlay at the cursor.
 */
export class Suggester {
  private anchor: Pos | null = null;
  private suffix = '';
  private ghost: HTMLSpanElement;
  private frame = 0;

  constructor(
    private term: Terminal,
    private host: HTMLElement,
    private serverId: string,
    private enabled: () => boolean,
    private snippets: () => Snippet[],
  ) {
    this.ghost = document.createElement('span');
    this.ghost.className = 'term-ghost';
    this.ghost.setAttribute('aria-hidden', 'true');
    host.appendChild(this.ghost);
    term.onWriteParsed(() => this.schedule());
    term.onCursorMove(() => this.schedule());
    term.onScroll(() => this.schedule());
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

  /**
   * Called with every piece of input before it goes to the shell. Returns
   * what to send instead (the suggestion when the right arrow takes it over).
   */
  input(data: string): string {
    if (!this.enabled()) {
      this.anchor = null;
      this.hide();
      return data;
    }
    // Right arrow (normal and application cursor mode) takes the suggestion over.
    if ((data === '\x1b[C' || data === '\x1bOC') && this.suffix) {
      const s = this.suffix;
      this.hide();
      return s;
    }
    if (data.includes('\r')) {
      if (this.usable()) rememberCommand(this.serverId, this.wholeLine());
      this.anchor = null;
      this.hide();
      return data;
    }
    // Ctrl+C, Ctrl+D, Ctrl+L and Escape start over: the prompt may be redrawn elsewhere.
    if (data === '\x03' || data === '\x04' || data === '\x0c' || data === '\x1b') {
      this.anchor = null;
      this.hide();
      return data;
    }
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
    this.suffix = '';
    this.ghost.textContent = '';
    this.ghost.style.display = 'none';
  }

  /** Recomputes and places the suggestion. */
  update() {
    const b = this.term.buffer.active;
    if (!this.enabled() || !this.usable() || b.viewportY !== b.baseY) return this.hide();
    const c = this.cursor();
    // Only at the end of the line: text right of the cursor means editing in the middle.
    const rest = b.getLine(c.row)?.translateToString(true, c.col) ?? '';
    if (rest.trim()) return this.hide();
    const typed = this.textBetween(this.anchor!, c);
    const suffix = suggestionFor(this.serverId, typed, this.snippets());
    if (!suffix) return this.hide();
    const screen = this.host.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return this.hide();
    const cw = screen.clientWidth / this.term.cols;
    const ch = screen.clientHeight / this.term.rows;
    const box = screen.getBoundingClientRect();
    const hostBox = this.host.getBoundingClientRect();
    this.suffix = suffix;
    this.ghost.textContent = suffix;
    this.ghost.style.display = 'block';
    this.ghost.style.left = `${box.left - hostBox.left + b.cursorX * cw}px`;
    this.ghost.style.top = `${box.top - hostBox.top + b.cursorY * ch}px`;
    this.ghost.style.height = `${ch}px`;
    this.ghost.style.lineHeight = `${ch}px`;
    this.ghost.style.maxWidth = `${Math.max(0, (this.term.cols - b.cursorX) * cw)}px`;
    this.ghost.style.fontFamily = String(this.term.options.fontFamily);
    this.ghost.style.fontSize = `${this.term.options.fontSize}px`;
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.ghost.remove();
  }
}
