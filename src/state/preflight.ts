/**
 * Before a transfer starts: what happens when the target already exists.
 * Pure decisions over the two files' size and time, so they are tested apart
 * from reading them (live/transfers.ts preflight).
 */
import type { Transfer, WatchOptions } from '../backend/types';
import type { ExistingRule } from './appState';

/** Size and modification time of a file. */
interface Stamp {
  size: number;
  mtime: number;
}

export type Decision =
  | { do: 'transfer' }
  /** Not transferred, and why (shown in the activity). */
  | { do: 'skip'; skipped: NonNullable<Transfer['skipped']> }
  /** Transferred next to the existing file under a free name. */
  | { do: 'keepBoth' }
  /** Asked in the conflict window; "newer": the target is newer than the source. */
  | { do: 'ask'; reason: 'newer' | 'exists' }
  /** Not transferred and not listed (a watch that only updates existing files). */
  | { do: 'drop' };

/**
 * A transfer started by hand onto an existing file. `tolerance`: how far apart
 * two times may be and still count as equal (servers round to whole seconds).
 */
export function existingDecision(
  rule: ExistingRule,
  skipUnchanged: boolean,
  source: Stamp,
  target: Stamp,
  tolerance: number,
  direction: Transfer['direction'],
): Decision {
  // Same size and modification time: the file is already there.
  if (skipUnchanged && source.size === target.size && Math.abs(source.mtime - target.mtime) <= tolerance)
    return { do: 'skip', skipped: 'unchanged' };
  switch (rule) {
    case 'overwrite':
      return { do: 'transfer' };
    case 'skip':
      return { do: 'skip', skipped: 'exists' };
    case 'keepBoth':
      return { do: 'keepBoth' };
    case 'newer':
      return source.mtime - target.mtime > tolerance ? { do: 'transfer' } : { do: 'skip', skipped: 'notNewer' };
    case 'ask':
      // "Newer on the server" is a warning for uploads; a download onto a newer local file just asks.
      return {
        do: 'ask',
        reason: direction !== 'down' && target.mtime - source.mtime > tolerance ? 'newer' : 'exists',
      };
  }
}

/** An upload of a watch: `remote` is the server file (null when there is none yet). */
export function watchDecision(
  options: Pick<WatchOptions, 'onlyExisting' | 'warnIfServerNewer'>,
  local: Stamp | null,
  remote: Stamp | null,
  tolerance: number,
): Decision {
  if (!remote) return options.onlyExisting ? { do: 'drop' } : { do: 'transfer' };
  if (!options.warnIfServerNewer || !local || remote.mtime - local.mtime <= tolerance) return { do: 'transfer' };
  return { do: 'ask', reason: 'newer' };
}
