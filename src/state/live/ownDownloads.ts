/**
 * Files Bitcrane itself has just written into a folder on this computer
 * (downloads). A watch on that folder sees them appear like any other new
 * file; without this note it would send them straight back to the server they
 * came from. A file counts as Bitcrane's own only while its size and
 * modification time are still those of the download: once the user changes
 * it, the watch uploads it as usual.
 */
import type { FileEntry } from '../../backend/types';

/** Notes older than this are dropped: the watch's report arrives within seconds. */
const KEEP_MS = 10 * 60_000;

const written = new Map<string, { size: number; mtime: number; at: number }>();

/** Remembers a finished download with the size and time it has on this computer. */
export function noteDownloaded(path: string, entry: Pick<FileEntry, 'size' | 'mtime'>) {
  const now = Date.now();
  for (const [p, w] of written) if (now - w.at > KEEP_MS) written.delete(p);
  written.set(path, { size: entry.size, mtime: entry.mtime, at: now });
}

/** True when the file is still exactly as Bitcrane downloaded it; the note is used up. */
export function isOwnDownload(path: string, entry: Pick<FileEntry, 'size' | 'mtime'>): boolean {
  const w = written.get(path);
  if (!w || Date.now() - w.at > KEEP_MS) return false;
  written.delete(path);
  return w.size === entry.size && w.mtime === entry.mtime;
}
