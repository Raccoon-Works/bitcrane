// The test environment reports "en-US" (see vite.config.ts), so German messages are translated.
import { describe, expect, it } from 'vitest';
import { messageText, toBackendError } from './api';

describe('toBackendError', () => {
  it('translates errors of the Rust core and keeps the rest', () => {
    expect(
      toBackendError({ kind: 'notFound', key: 'Datei oder Ordner nicht gefunden.', detail: 'os error 2' }),
    ).toEqual({ kind: 'notFound', message: 'File or folder not found.', detail: 'os error 2' });
  });

  it('fills in parameters without translating them', () => {
    // A file named like a German interface text stays as it is.
    expect(
      toBackendError({ kind: 'alreadyExists', key: '„{0}“ gibt es hier schon.', params: ['Abbrechen'] }).message,
    ).toBe('“Abbrechen” already exists here.');
    // Nested messages are translated in turn; "{1}" inside a name is not a placeholder.
    expect(
      messageText({ key: '{0}: nicht gefunden.', params: [{ key: '„{0}“ lesen', params: ['Bericht {1}.pdf'] }] }),
    ).toBe('Reading “Bericht {1}.pdf”: not found.');
  });

  it('keeps errors the interface made and texts of Tauri plugins as they are', () => {
    expect(toBackendError({ kind: 'authFailed', message: 'Sign in again' })).toEqual({
      kind: 'authFailed',
      message: 'Sign in again',
    });
    expect(toBackendError('Datei nicht gefunden')).toEqual({ kind: 'other', message: 'Datei nicht gefunden' });
    expect(toBackendError(new Error('dialog closed'))).toEqual({ kind: 'other', message: 'dialog closed' });
  });

  it('falls back to a generic message', () => {
    for (const e of [undefined, null, 42, { message: 'no kind' }]) {
      expect(toBackendError(e)).toEqual({ kind: 'other', message: 'Unexpected error.' });
    }
  });
});
