/**
 * Base64 to bytes. `atob` works on binary strings, whose characters' char codes are the bytes.
 */

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
