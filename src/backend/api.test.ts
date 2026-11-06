// The test environment reports "en-US" (see vite.config.ts), so German messages are translated.
import { describe, expect, it } from 'vitest';
import { toBackendError } from './api';

describe('toBackendError', () => {
  it('keeps backend errors and translates their message', () => {
    expect(toBackendError({ kind: 'notFound', message: 'Datei nicht gefunden', detail: 'os error 2' })).toEqual({
      kind: 'notFound',
      message: 'File not found',
      detail: 'os error 2',
    });
  });

  it('translates messages with variable parts', () => {
    expect(toBackendError('/srv/www/a.txt: nicht gefunden.')).toEqual({
      kind: 'other',
      message: '/srv/www/a.txt: not found.',
    });
  });

  it('wraps strings and errors', () => {
    expect(toBackendError('Datei nicht gefunden')).toEqual({ kind: 'other', message: 'File not found' });
    expect(toBackendError('something else')).toEqual({ kind: 'other', message: 'something else' });
    expect(toBackendError(new Error('Datei nicht gefunden'))).toEqual({
      kind: 'other',
      message: 'Datei nicht gefunden',
    });
  });

  it('falls back to a generic message', () => {
    for (const e of [undefined, null, 42, { message: 'no kind' }]) {
      expect(toBackendError(e)).toEqual({ kind: 'other', message: 'Unexpected error.' });
    }
  });
});
