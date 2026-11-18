import { describe, expect, it } from 'vitest';
import { fromBase64 } from './base64';

describe('base64', () => {
  it('decodes known values', () => {
    expect(fromBase64('Qml0Y3JhbmU=')).toEqual(new TextEncoder().encode('Bitcrane'));
    expect(fromBase64('')).toEqual(new Uint8Array());
  });

  it('decodes every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64(btoa(String.fromCharCode(...bytes)))).toEqual(bytes);
  });
});
