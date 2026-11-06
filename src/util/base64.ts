/**
 * Base64 between text and bytes. `atob` and `btoa` work on binary strings, whose
 * characters' char codes are the bytes.
 */

/** Encodes bytes; built in chunks, because spreading a large array into one call exceeds the argument limit. */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
