/**
 * Password encryption for export files: PBKDF2-SHA256 derives an AES-256-GCM
 * key from the password. Uses the browser's Web Crypto, nothing custom.
 */

export interface Sealed {
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

const ITERATIONS = 310_000;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function keyFor(password: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(text: string, password: string): Promise<Sealed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(password, salt, ITERATIONS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  // Chunked base64 for large files (spread arguments have a limit).
  let out = '';
  for (let i = 0; i < data.length; i += 0x8000) out += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return { kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: btoa(out) };
}

/** Throws when the password is wrong (AES-GCM checks integrity). */
export async function unseal(s: Sealed, password: string): Promise<string> {
  const key = await keyFor(password, unb64(s.salt), s.iterations);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(s.iv) }, key, unb64(s.data));
  return new TextDecoder().decode(plain);
}
