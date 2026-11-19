/**
 * SSH key files for the server window: what a key is, creating a new one and
 * adding its public key to the server. The prototype answers with a made-up key.
 */
import type { KeyInfo } from '../backend/api';
import { tauriBackend as backend } from '../backend/tauriBackend';
import { $t } from '../i18n';
import { LIVE, showToast } from './core';
import { hasSecret, installPublicKey, passphraseRef } from './live';

/** A key file: its type and protection, and whether its passphrase is in the keychain. */
export interface KeyDetails {
  info: KeyInfo;
  passphraseStored: boolean;
}

/** Type and protection of the key file at `keyPath`. */
export async function keyDetails(keyPath: string): Promise<KeyDetails> {
  if (!LIVE)
    return { info: { exists: true, invalid: false, encrypted: true, algorithm: 'ED25519' }, passphraseStored: true };
  const [info, passphraseStored] = await Promise.all([backend.keyInfo(keyPath), hasSecret(passphraseRef(keyPath))]);
  return { info, passphraseStored };
}

/**
 * Creates an ED25519 key at `path` and returns its public key. With `keepPassphrase`
 * the passphrase also goes into the keychain; failing that only costs a toast.
 */
export async function generateKey(path: string, comment: string, passphrase: string, keepPassphrase: boolean) {
  if (!LIVE) return `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBitcranePrototypBeispielSchluessel ${comment}`;
  const publicKey = await backend.keyGenerate(path, comment, passphrase || undefined);
  if (passphrase && keepPassphrase)
    await backend
      .secretStore(passphraseRef(path), passphrase)
      .catch(() => showToast($t('Die Passphrase konnte nicht im Schlüsselbund gesichert werden.'), 'error'));
  return publicKey;
}

/**
 * Adds the public key to the server's authorized_keys; the answer is the
 * error text, or null when it worked (the prototype always succeeds).
 */
export function installKey(serverId: string, publicKey: string): Promise<string | null> {
  return LIVE ? installPublicKey(serverId, publicKey) : Promise.resolve(null);
}
