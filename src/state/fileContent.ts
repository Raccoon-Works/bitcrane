/**
 * Reading file contents for the interface: the text of a file (comparisons)
 * and previews (info column, preview window). The prototype shows the demo
 * webshop's app.py instead of real contents.
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Preview, TextContent } from '../backend/api';
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { PaneSide } from '../backend/types';
import { LIVE } from './core';
import { DEMO_APP_PY } from './demoData';

/** Reads a text file on this computer (`serverId` unused) or on a server. */
export function readText(side: PaneSide, serverId: string, path: string): Promise<TextContent> {
  if (!LIVE) return Promise.resolve({ text: DEMO_APP_PY[side], truncated: false });
  return side === 'local' ? backend.localReadText(path) : backend.remoteReadText(serverId, path);
}

/** MIME type of PDF, audio and video files (the same list as local::media_mime). */
function mediaMime(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/mp4',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
  };
  return map[ext] ?? null;
}

/**
 * Loads the preview of a file: the start of a text file or an image, and with
 * `media` also PDFs, audio and video (local files through the "media" address
 * scheme, server files after copying them into a temporary file).
 */
export async function loadPreview(side: PaneSide, serverId: string, path: string, media: boolean): Promise<Preview> {
  if (!LIVE)
    return /\.(png|jpe?g|gif|webp|svg)$/i.test(path)
      ? { kind: 'binary', mime: '', data: '', truncated: false }
      : { kind: 'text', mime: '', data: DEMO_APP_PY.local, truncated: false };
  const mime = media ? mediaMime(path) : null;
  if (mime) {
    const local = side === 'local' ? path : await backend.remoteMedia(serverId, path);
    return { kind: 'media', mime, data: convertFileSrc(local, 'media'), truncated: false };
  }
  return side === 'local' ? backend.localPreview(path) : backend.remotePreview(serverId, path);
}
