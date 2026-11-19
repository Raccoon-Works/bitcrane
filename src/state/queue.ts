/**
 * Rules of the transfer queue as pure functions (used by state/transfers.ts, tested in
 * queue.test.ts).
 */
import type { Transfer } from '../backend/types';

/** What a transfer does: the same key means the same file copied to the same place. */
export const transferKey = (t: Transfer) =>
  [t.direction, t.sourceServerId ?? '', t.serverId, t.source, t.target].join('\u0000');

/**
 * New transfers against the queue: a file already waiting (queued or paused) for the same target is
 * not added again, and neither is a second copy within `items`. Commands are always added. Returns
 * the transfers to add and, for each item, the queue entry that stands for it.
 */
export function mergeIntoQueue(queue: Transfer[], items: Transfer[]): { added: Transfer[]; standing: Transfer[] } {
  const waiting = new Map(
    queue
      .filter((t) => t.direction !== 'command' && (t.state === 'queued' || t.state === 'paused'))
      .map((t) => [transferKey(t), t]),
  );
  const added: Transfer[] = [];
  const standing = items.map((t) => {
    const same = t.direction === 'command' ? undefined : waiting.get(transferKey(t));
    if (same) return same;
    if (t.direction !== 'command') waiting.set(transferKey(t), t);
    added.push(t);
    return t;
  });
  return { added, standing };
}
