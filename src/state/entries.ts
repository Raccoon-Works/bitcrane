/**
 * Checks for servers and watches that come from outside: an export file, the sync file. They are
 * taken into the state only with the fields every part of Bitcrane relies on.
 */
import type { Server, Watch } from '../backend/types';
import { defaultWatchOptions } from './defaults';

export const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const strings = (v: Record<string, unknown>, keys: string[]) => keys.every((k) => typeof v[k] === 'string');

/** A server entry with the fields every part of Bitcrane relies on. */
export function isServerEntry(x: unknown): x is Server {
  return (
    isRecord(x) &&
    strings(x, ['id', 'name', 'host', 'user', 'keyPath', 'auth']) &&
    typeof x.port === 'number' &&
    Number.isInteger(x.port) &&
    x.port > 0 &&
    x.port < 65536
  );
}

/**
 * A watch from a file, completed where an older or shorter entry leaves fields out (options take
 * the defaults); null when it lacks what identifies it.
 */
export function watchEntry(x: unknown): Watch | null {
  if (!isRecord(x) || !strings(x, ['id', 'name', 'localPath', 'serverId', 'remotePath'])) return null;
  const excludes = Array.isArray(x.excludes) ? x.excludes.filter((e): e is string => typeof e === 'string') : [];
  return {
    ...(x as unknown as Watch),
    state: x.state === 'paused' ? 'paused' : 'active',
    lastFile: typeof x.lastFile === 'string' ? x.lastFile : '',
    lastTime: typeof x.lastTime === 'number' ? x.lastTime : 0,
    excludes,
    options: { ...defaultWatchOptions, ...(isRecord(x.options) ? x.options : {}) },
  };
}
