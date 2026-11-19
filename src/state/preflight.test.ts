import { describe, expect, it } from 'vitest';
import { existingDecision, watchDecision } from './preflight';

const T = 1_750_000_000_000;
const TOL = 1500;
const file = (size: number, mtime = T) => ({ size, mtime });

describe('existingDecision', () => {
  it('skips a file that is already there when asked to', () => {
    expect(existingDecision('overwrite', true, file(5), file(5, T + 1000), TOL, 'up')).toEqual({
      do: 'skip',
      skipped: 'unchanged',
    });
    expect(existingDecision('overwrite', false, file(5), file(5), TOL, 'up')).toEqual({ do: 'transfer' });
    expect(existingDecision('overwrite', true, file(5), file(6), TOL, 'up')).toEqual({ do: 'transfer' });
  });

  it('follows the rule for existing files', () => {
    expect(existingDecision('skip', false, file(5), file(6), TOL, 'up')).toEqual({ do: 'skip', skipped: 'exists' });
    expect(existingDecision('keepBoth', false, file(5), file(6), TOL, 'up')).toEqual({ do: 'keepBoth' });
  });

  it('transfers with "newer" only a clearly newer source', () => {
    expect(existingDecision('newer', false, file(5, T + 60000), file(6), TOL, 'up')).toEqual({ do: 'transfer' });
    expect(existingDecision('newer', false, file(5, T + 1000), file(6), TOL, 'up')).toEqual({
      do: 'skip',
      skipped: 'notNewer',
    });
  });

  it('warns when the server file is newer, and only asks for downloads', () => {
    expect(existingDecision('ask', false, file(5), file(6, T + 60000), TOL, 'up')).toEqual({
      do: 'ask',
      reason: 'newer',
    });
    expect(existingDecision('ask', false, file(5), file(6, T + 60000), TOL, 'down')).toEqual({
      do: 'ask',
      reason: 'exists',
    });
    expect(existingDecision('ask', false, file(5, T + 60000), file(6), TOL, 'up')).toEqual({
      do: 'ask',
      reason: 'exists',
    });
  });
});

describe('watchDecision', () => {
  const both = { onlyExisting: true, warnIfServerNewer: true };

  it('drops a new file when only existing ones are updated', () => {
    expect(watchDecision(both, file(5), null, TOL)).toEqual({ do: 'drop' });
    expect(watchDecision({ ...both, onlyExisting: false }, file(5), null, TOL)).toEqual({ do: 'transfer' });
  });

  it('asks when the server file is newer than the rounding allows', () => {
    expect(watchDecision(both, file(5), file(5, T + 60000), TOL)).toEqual({ do: 'ask', reason: 'newer' });
    expect(watchDecision(both, file(5), file(5, T + 1000), TOL)).toEqual({ do: 'transfer' });
    expect(watchDecision({ ...both, warnIfServerNewer: false }, null, file(5, T + 60000), TOL)).toEqual({
      do: 'transfer',
    });
  });
});
