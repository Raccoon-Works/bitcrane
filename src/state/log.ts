/**
 * Connection log ("Protokoll") for troubleshooting: connections, transfers,
 * commands and errors with time stamps. Kept in memory (last 1000 entries),
 * shown in the log window, and also written to a file when the setting
 * "Protokoll für die Fehlersuche schreiben" is on.
 */
import { tauriBackend as backend } from '../backend/tauriBackend';
import { getState, LIVE } from './store';

/** "debug" entries are only kept with the setting "Ausführlich protokollieren". */
export type LogLevel = 'debug' | 'info' | 'ok' | 'warn' | 'error';

export interface LogEntry {
  time: number;
  level: LogLevel;
  /** Server name or "Lokal". */
  source: string;
  text: string;
  detail?: string;
}

const MAX = 1000;
let entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let pending: string[] = [];
let flushTimer: number | undefined;

function serverName(serverId?: string) {
  if (!serverId) return 'Bitcrane';
  return getState().servers.find((x) => x.id === serverId)?.name ?? serverId;
}

/** Formats an entry as one line of the log file. */
export function formatLogLine(e: LogEntry): string {
  const d = new Date(e.time);
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const level = { debug: 'DEBUG', info: 'INFO ', ok: 'OK   ', warn: 'WARN ', error: 'ERROR' }[e.level];
  return `${stamp} ${level} [${e.source}] ${e.text}${e.detail ? ` | ${e.detail.replace(/\s*\n\s*/g, ' / ')}` : ''}`;
}

/** Adds an entry. `serverId` names the server the entry belongs to. */
export function addLog(level: LogLevel, text: string, serverId?: string, detail?: string) {
  if (level === 'debug' && getState().settings.logLevel !== 'detail') return;
  const entry: LogEntry = { time: Date.now(), level, source: serverName(serverId), text, detail };
  entries = entries.length >= MAX ? [...entries.slice(entries.length - MAX + 1), entry] : [...entries, entry];
  listeners.forEach((l) => l());
  if (LIVE && getState().settings.writeLog) {
    pending.push(formatLogLine(entry));
    window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => {
      const lines = pending;
      pending = [];
      backend.logWrite(lines).catch(() => undefined);
    }, 500);
  }
}

export function getLog(): LogEntry[] {
  return entries;
}

export function subscribeLog(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function clearLog() {
  entries = [];
  listeners.forEach((l) => l());
}
