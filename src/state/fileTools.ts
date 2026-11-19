/**
 * Small file tools behind the dialogs: checksums, signed S3 links, symbolic
 * links on the server and choosing a program. In the app they call the Rust
 * core; in the browser prototype they return made-up results of the right shape.
 */
import type { ChecksumAlgo } from '../backend/api';
import { tauriBackend as backend } from '../backend/tauriBackend';
import { chooseProgram } from '../backend/dialogs';
import type { PaneSide } from '../backend/types';
import { $t } from '../i18n';
import { basename, join } from '../util/paths';
import { closeDialog, invalidateRemote } from './panels';
import { LIVE, showToast } from './core';

/** Length of a checksum in hex digits, per algorithm. */
export const HEX_LEN: Record<ChecksumAlgo, number> = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };

/** A pasted checksum without spaces, in lower case. */
export const cleanSum = (text: string) => text.trim().toLowerCase().replace(/\s+/g, '');

/** The algorithm a pasted value belongs to, by its length (32 = MD5, 40 = SHA-1 ...). */
export const algoOfSum = (text: string): ChecksumAlgo | undefined => {
  const v = cleanSum(text);
  return (Object.keys(HEX_LEN) as ChecksumAlgo[]).find((a) => HEX_LEN[a] === v.length && /^[0-9a-f]+$/.test(v));
};

/** Demo value for the browser prototype (right length for the algorithm). */
async function demoSum(seed: string, algo: ChecksumAlgo): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(seed));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, HEX_LEN[algo]);
}

/** Checksum of a file on this computer (`serverId` unused) or on a server. */
export function checksum([side, serverId]: [PaneSide, string], path: string, algo: ChecksumAlgo): Promise<string> {
  if (!LIVE) return demoSum(basename(path), algo);
  return side === 'local' ? backend.localChecksum(path, algo) : backend.remoteChecksum(serverId, path, algo);
}

/** A link that lets anyone download the S3 file until it expires after `secs`. */
export function presignedLink(serverId: string, path: string, secs: number): Promise<string> {
  if (!LIVE) return Promise.resolve(`https://bucket.s3.example.com${path}?X-Amz-Expires=${secs}&X-Amz-Signature=…`);
  return backend.remotePresign(serverId, path, secs);
}

/** Creates the symbolic link `name` in `dir` on the server, pointing to `target`, and closes the dialog. */
export async function createSymlink(serverId: string, dir: string, name: string, target: string) {
  if (LIVE) {
    await backend.remoteSymlink(serverId, join(dir, name), target);
    invalidateRemote(serverId, dir);
  }
  showToast($t('Verknüpfung „{0}“ zeigt auf {1}.', name, target), 'ok');
  closeDialog();
}

/** Lets the user pick a program (an .app on the Mac, an .exe on Windows); null when cancelled. */
export function pickProgram(title: string, mac: boolean): Promise<string | null> {
  if (!LIVE)
    return Promise.resolve(
      mac ? '/Applications/Visual Studio Code.app' : 'C:/Program Files/Microsoft VS Code/Code.exe',
    );
  return chooseProgram(title, mac);
}

/** Program name without folder and extension, e.g. "Visual Studio Code". */
export const programName = (path: string) => basename(path.replace(/\\/g, '/')).replace(/\.(app|exe)$/i, '');
