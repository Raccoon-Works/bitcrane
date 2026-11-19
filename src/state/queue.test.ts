import { describe, expect, it } from 'vitest';
import type { Transfer } from '../backend/types';
import { mergeIntoQueue } from './queue';

let n = 0;
const tr = (target: string, patch: Partial<Transfer> = {}): Transfer => ({
  id: `t${n++}`,
  name: target,
  direction: 'up',
  serverId: 's',
  folder: '',
  source: `/local${target}`,
  target,
  size: 1,
  done: 0,
  state: 'queued',
  ...patch,
});

describe('mergeIntoQueue', () => {
  it('does not queue a file that already waits for the same target', () => {
    const waiting = tr('/a.txt');
    const paused = tr('/b.txt', { state: 'paused' });
    const again = [tr('/a.txt'), tr('/b.txt'), tr('/c.txt')];
    const { added, standing } = mergeIntoQueue([waiting, paused], again);
    expect(added.map((t) => t.target)).toEqual(['/c.txt']);
    expect(standing.map((t) => t.id)).toEqual([waiting.id, paused.id, again[2].id]);
  });

  it('queues a file again when its earlier transfer runs, ended or went elsewhere', () => {
    const queue = [
      tr('/a.txt', { state: 'running' }),
      tr('/b.txt', { state: 'done' }),
      tr('/c.txt', { state: 'error' }),
      tr('/d.txt', { serverId: 'other' }),
      tr('/e.txt', { direction: 'down' }),
    ];
    const items = ['/a.txt', '/b.txt', '/c.txt', '/d.txt', '/e.txt'].map((t) => tr(t));
    expect(mergeIntoQueue(queue, items).added.length).toBe(5);
  });

  it('keeps one of two equal new items, and every command', () => {
    const cmd = () => tr('', { direction: 'command', name: 'systemctl restart bot', source: '' });
    const { added } = mergeIntoQueue([cmd()], [tr('/a.txt'), tr('/a.txt'), cmd(), cmd()]);
    expect(added.map((t) => t.direction)).toEqual(['up', 'command', 'command']);
  });
});
