/**
 * Password encryption for export files: PBKDF2-SHA256 derives an AES-256-GCM
 * key from the password. Uses the browser's Web Crypto, nothing custom.
 */
import { fromBase64, toBase64 } from './base64';

export interface Sealed {
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

const ITERATIONS = 310_000;

async function keyFor(password: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(text: string, password: string): Promise<Sealed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(password, salt, ITERATIONS);
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)),
  );
  return { kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data) };
}

/** Throws when the password is wrong (AES-GCM checks integrity). */
export async function unseal(s: Sealed, password: string): Promise<string> {
  const key = await keyFor(password, fromBase64(s.salt), s.iterations);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(s.iv) }, key, fromBase64(s.data));
  return new TextDecoder().decode(plain);
}
