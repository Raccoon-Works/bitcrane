/**
 * Base64 decoding to bytes. `atob` returns a binary string; the bytes are the
 * char codes of its characters.
 */
export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
