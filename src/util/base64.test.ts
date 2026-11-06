import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from './base64';

describe('base64', () => {
  it('encodes known values', () => {
    expect(toBase64(new TextEncoder().encode('Bitcrane'))).toBe('Qml0Y3JhbmU=');
    expect(toBase64(new Uint8Array())).toBe('');
    expect(fromBase64('')).toEqual(new Uint8Array());
  });

  it('round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it('round-trips data larger than one encoding chunk', () => {
    // Larger than the 0x8000 chunk and not a multiple of it, so the last chunk is partial.
    const bytes = Uint8Array.from({ length: 0x8000 * 3 + 17 }, (_, i) => (i * 7919) % 256);
    const text = toBase64(bytes);
    expect(text).toHaveLength(Math.ceil(bytes.length / 3) * 4);
    expect(fromBase64(text)).toEqual(bytes);
  });
});
