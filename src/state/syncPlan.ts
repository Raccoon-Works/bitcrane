/**
 * Comparing two folders ("Ordner abgleichen"), shared by the comparison window
 * and the scheduled comparisons: reading both sides, deciding per file what
 * would happen, and turning that into sync actions.
 *
 * A place is this computer ('' as server id) or a server, with a folder. The
 * left place is the one "upload" copies from, the right one "download" copies
 * from; this covers computer ↔ server, server ↔ server and two local folders.
 */
import * as live from './live';
import { matchesExclude } from '../util/format';
import { $t } from '../i18n';
import type { Platform } from '../backend/types';
import { demoWalk, getState, LIVE, ruleFor, serverById, watchForLocal, type SyncAction } from './store';

export type Direction = 'up' | 'down' | 'both';

export interface Side {
  size: number;
  mtime: number;
  path: string;
  /** Path below the place's folder with the names this computer stores (see `WalkItem.localRelative`). */
  localRel: string;
}
/** 'conflict': both sides changed since the last sync; the user decides (never done by itself). */
export interface Line {
  rel: string;
  local?: Side;
  remote?: Side;
  action: SyncAction['kind'] | 'none' | 'conflict';
}
/** One half as a place: this computer ('') or a server id, with the folder. */
export interface Place {
  serverId: string;
  dir: string;
  name: string;
}

/** A place for one half: this computer ('') or a server, with the name shown for it. */
export function comparePlace(serverId: string, dir: string, platform: Platform = getState().platform): Place {
  const here = platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC');
  return { serverId, dir, name: serverId ? (serverById(serverId)?.name ?? $t('Server')) : here };
}

/**
 * Left out of a comparison: the patterns of the watch on the local folder (or
 * the general ones) plus those of the servers' rules. `useChoice`: the rule
 * chosen in the activity area counts (in the window, not in scheduled runs).
 */
export function compareExcludes(left: Place, right: Place, useChoice: boolean): string[] {
  const s = getState();
  const own = (!left.serverId ? watchForLocal(left.dir)?.excludes : undefined) ?? s.settings.defaultExcludes;
  const rules = [left.serverId, right.serverId]
    .filter(Boolean)
    .flatMap((sid) => ruleFor(sid, undefined, s, useChoice)?.excludes ?? []);
  return [...new Set([...own, ...rules])];
}

/** A note per server whose clock is off by more than a few seconds (corrected when comparing). */
export function clockOffsetNotes(places: Place[]): string[] {
  if (!LIVE) return [];
  return places
    .filter((p) => p.serverId && Math.abs(live.clockOffset(p.serverId)) > 2000)
    .map((p) => {
      const off = live.clockOffset(p.serverId);
      return $t(
        'Die Uhr von „{0}“ geht {1} Sek. {2}; das wird beim Vergleich ausgeglichen.',
        p.name,
        Math.round(Math.abs(off) / 1000),
        off > 0 ? $t('vor') : $t('nach'),
      );
    });
}

/** Connects the servers of both places when needed (a saved comparison may start before them) and reads both. */
export async function readPlaces(left: Place, right: Place): Promise<[Map<string, Side>, Map<string, Side>]> {
  for (const sid of [left.serverId, right.serverId].filter(Boolean)) {
    if (!serverById(sid)) throw new Error($t('Der Server dieses Abgleichs gibt es nicht mehr.'));
    if (LIVE && !live.isConnected(sid) && !(await live.connectServer(sid)))
      throw new Error($t('Keine Verbindung zu {0}.', serverById(sid)?.name ?? sid));
  }
  return Promise.all([walkPlace(left), walkPlace(right)]);
}

interface PlanOptions {
  direction: Direction;
  bySize: boolean;
  deletes: boolean;
  /** Only files changed within this many days (0 = all). */
  days: number;
  excludes: string[];
  /** Checksum results for files of equal size (true = content differs), when "Inhalt prüfen" is on. */
  differs?: Map<string, boolean> | null;
  /** "Beide Richtungen": the state both sides last agreed on (see learnBase). */
  base?: Base | null;
}

/**
 * The last agreed state of a folder pair, per file: size and time both sides
 * had when they were last seen equal. With it, "Beide Richtungen" can tell
 * which side changed a file (and a conflict when both did) and that a file
 * missing on one side was deleted there rather than new on the other.
 *
 * Only states actually seen on both sides are recorded, never a planned one:
 * a transfer that fails leaves the old entry, so the next comparison simply
 * offers it again instead of copying the stale side back.
 */
export type Base = Map<string, [number, number]>;

const BASE_PREFIX = 'bitcrane.syncBase.';

/** Key of a folder pair (the same pair from a favourite or by hand shares it). */
export function baseKey(left: Place, right: Place): string {
  return `${BASE_PREFIX}${left.serverId}|${left.dir}||${right.serverId}|${right.dir}`;
}

function loadBase(key: string): Base {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Map(Object.entries(JSON.parse(raw) as Record<string, [number, number]>)) : new Map();
  } catch {
    return new Map();
  }
}

/**
 * Updates the agreed state from what both sides show now: files equal on both
 * sides are recorded, files gone from both are dropped. Returns the base as it
 * was before (that is the one to plan with) and stores the new one.
 */
export function learnBase(key: string, local: Map<string, Side>, remote: Map<string, Side>): Base {
  const before = loadBase(key);
  const next: Base = new Map(before);
  for (const rel of new Set([...local.keys(), ...remote.keys(), ...before.keys()])) {
    const l = local.get(rel);
    const r = remote.get(rel);
    if (l && r && l.size === r.size && Math.abs(l.mtime - r.mtime) <= TOLERANCE_MS) next.set(rel, [l.size, l.mtime]);
    else if (!l && !r) next.delete(rel);
  }
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // Storage full or unavailable: two-way then works without the memory (newer file wins).
  }
  return before;
}

/** Whether a side differs from the agreed state. */
function changedSince(side: Side, agreed: [number, number]): boolean {
  return side.size !== agreed[0] || Math.abs(side.mtime - agreed[1]) > TOLERANCE_MS;
}

/** Margin for "same time": SFTP and FTP keep whole seconds or less. */
export const TOLERANCE_MS = 1500;
const DAY_MS = 24 * 3600 * 1000;

/** Whether a relative path has a segment matching one of the patterns (a name or "*.ext"). */
export function isExcluded(rel: string, excludes: string[]): boolean {
  return rel.split('/').some((seg) => matchesExclude(seg, excludes));
}

/**
 * All files below a place's folder, keyed by their path relative to it. Times of
 * a server are moved by its clock offset, so they compare with this computer's.
 */
export async function walkPlace(place: Place): Promise<Map<string, Side>> {
  const side = place.serverId ? 'remote' : 'local';
  const items = LIVE
    ? await live.walkFiles(side, place.serverId, place.dir)
    : demoWalk(side, place.serverId, place.dir);
  const offset = place.serverId ? live.clockOffset(place.serverId) : 0;
  const map = new Map<string, Side>();
  // Walk results start with the walked folder's own name; drop it.
  const below = (rel: string) => rel.split('/').slice(1).join('/');
  for (const it of items) {
    // Keys with the server's names, so a file stored on Windows as "a%3Ab.txt" meets "a:b.txt",
    // and in composed Unicode form (NFC): "ü" stored decomposed on one side (macOS) and composed
    // on the other is the same file. `path` keeps the real name.
    const key = below(it.relative);
    if (key)
      map.set(key.normalize('NFC'), {
        size: it.size,
        mtime: it.mtime - offset,
        path: it.path,
        localRel: below(it.localRelative),
      });
  }
  return map;
}

/** Checksums of files that have the same size on both sides (key: relative path; true = content differs). */
export async function contentDiffers(
  left: Place,
  right: Place,
  pairs: Array<{ rel: string; local: Side; remote: Side }>,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  // A few at a time, so a large folder does not open dozens of channels at once.
  for (let i = 0; i < pairs.length; i += 4) {
    await Promise.all(
      pairs.slice(i, i + 4).map(async (p) => {
        if (!LIVE) {
          out.set(p.rel, false);
          return;
        }
        const [a, b] = await Promise.all([
          live.checksumOf(left.serverId, p.local.path),
          live.checksumOf(right.serverId, p.remote.path),
        ]);
        out.set(p.rel, a !== b);
      }),
    );
  }
  return out;
}

/** Files present on both sides with equal size: the candidates for "Inhalt prüfen". */
export function sameSizePairs(local: Map<string, Side>, remote: Map<string, Side>, excludes: string[]) {
  return [...local.entries()].flatMap(([rel, l]) => {
    const r = remote.get(rel);
    return r && r.size === l.size && !isExcluded(rel, excludes) ? [{ rel, local: l, remote: r }] : [];
  });
}

/** What would happen with every file (left = `local`, right = `remote`). */
export function planLines(local: Map<string, Side>, remote: Map<string, Side>, o: PlanOptions): Line[] {
  const all = new Set([...local.keys(), ...remote.keys()]);
  const since = o.days > 0 ? Date.now() - o.days * DAY_MS : 0;
  const out: Line[] = [];
  for (const rel of [...all].sort((a, b) => a.localeCompare(b, 'de'))) {
    if (isExcluded(rel, o.excludes)) continue;
    const l = local.get(rel);
    const r = remote.get(rel);
    // "Nur die letzten X Tage": the newer of the two copies decides.
    if (since && Math.max(l?.mtime ?? 0, r?.mtime ?? 0) < since) continue;
    // With "Inhalt prüfen" files of equal size count as equal when their checksums match.
    const sameContent = l && r && l.size === r.size && o.differs?.get(rel) === false;
    const contentChanged = l && r && o.differs?.get(rel) === true;
    const differsNow =
      l &&
      r &&
      !sameContent &&
      (contentChanged ||
        (o.bySize ? l.size !== r.size : Math.abs(l.mtime - r.mtime) > TOLERANCE_MS || l.size !== r.size));
    const localNewer = l && r && l.mtime - r.mtime > TOLERANCE_MS;
    const remoteNewer = l && r && r.mtime - l.mtime > TOLERANCE_MS;
    let action: Line['action'] = 'none';
    const agreed = o.direction === 'both' ? o.base?.get(rel) : undefined;
    if (l && !r) {
      // Two-way: gone on the right although it was there and the left copy is unchanged = deleted there.
      if (agreed && !changedSince(l, agreed)) action = o.deletes ? 'deleteLocal' : 'upload';
      else action = o.direction === 'down' ? (o.deletes ? 'deleteLocal' : 'none') : 'upload';
    } else if (!l && r) {
      if (agreed && !changedSince(r, agreed)) action = o.deletes ? 'deleteRemote' : 'download';
      else action = o.direction === 'up' ? (o.deletes ? 'deleteRemote' : 'none') : 'download';
    } else if (differsNow) {
      if (o.direction === 'up') action = o.bySize || contentChanged || localNewer || !remoteNewer ? 'upload' : 'none';
      else if (o.direction === 'down')
        action = o.bySize || contentChanged || remoteNewer || !localNewer ? 'download' : 'none';
      else if (agreed && l && r) {
        // The side that changed since the last sync wins; both changed = conflict.
        const lc = changedSince(l, agreed);
        const rc = changedSince(r, agreed);
        action =
          lc && rc
            ? 'conflict'
            : lc
              ? 'upload'
              : rc
                ? 'download'
                : localNewer
                  ? 'upload'
                  : remoteNewer
                    ? 'download'
                    : 'conflict';
      } else action = localNewer ? 'upload' : remoteNewer ? 'download' : 'conflict';
    }
    out.push({ rel, local: l, remote: r, action });
  }
  return out;
}

/** Sync actions for the lines with something to do. */
export function actionsOf(lines: Line[]): SyncAction[] {
  return lines
    .filter((l) => l.action !== 'none' && l.action !== 'conflict')
    .map((l) => {
      const fromRight = l.action === 'download' || l.action === 'deleteRemote';
      const src = fromRight ? l.remote : l.local;
      const dst = fromRight ? l.local : l.remote;
      return {
        kind: l.action as SyncAction['kind'],
        rel: l.rel,
        localRel: src?.localRel ?? l.rel,
        size: src?.size ?? 0,
        from: src?.path,
        to: dst?.path,
      };
    });
}
