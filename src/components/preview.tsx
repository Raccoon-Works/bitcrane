/**
 * File preview: the start of a text file or an image, local or on the
 * server. Used by the info column and by the preview window (space bar).
 * The preview window also shows PDFs and plays audio and video (after
 * ForkLift): local files through the "media" address scheme, server files
 * after copying them into a temporary file.
 */
import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { toBackendError, type Preview } from '../backend/api';
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { PaneSide } from '../backend/types';
import { LIVE } from '../state/store';
import { $t } from '../i18n';

const DEMO_TEXT = 'import discord\nfrom discord.ext import commands\n\nPREFIX = "!"\nDEBUG = False\n\nbot = commands.Bot(command_prefix=PREFIX)\n\n@bot.event\nasync def on_ready():\n    print("Taskbot online")\n';

/** Loads a preview; `null` while loading. */
/** MIME type of PDF, audio and video files (the same list as local::media_mime). */
export function mediaMime(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = { pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
  return map[ext] ?? null;
}

/** `media`: also load PDFs, audio and video (the preview window; the info column does not). */
export function usePreview(side: PaneSide, serverId: string, path: string | null, media = false): { preview: Preview | null; error: string } {
  const [state, setState] = useState<{ key: string; preview: Preview | null; error: string }>({ key: '', preview: null, error: '' });
  const key = `${side}|${serverId}|${path}`;
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    if (!LIVE) {
      const image = /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
      setState({ key, preview: image ? { kind: 'binary', mime: '', data: '', truncated: false } : { kind: 'text', mime: '', data: DEMO_TEXT, truncated: false }, error: '' });
      return;
    }
    setState({ key, preview: null, error: '' });
    const mime = media ? mediaMime(path) : null;
    if (mime) {
      (side === 'local' ? Promise.resolve(path) : backend.remoteMedia(serverId, path))
        .then((local) => { if (!cancelled) setState({ key, preview: { kind: 'media', mime, data: convertFileSrc(local, 'media'), truncated: false }, error: '' }); })
        .catch((e) => { if (!cancelled) setState({ key, preview: null, error: toBackendError(e).message }); });
      return () => { cancelled = true; };
    }
    (side === 'local' ? backend.localPreview(path) : backend.remotePreview(serverId, path))
      .then((p) => { if (!cancelled) setState({ key, preview: p, error: '' }); })
      .catch((e) => { if (!cancelled) setState({ key, preview: null, error: toBackendError(e).message }); });
    return () => { cancelled = true; };
  }, [key, path, side, serverId, media]);
  return state.key === key ? { preview: state.preview, error: state.error } : { preview: null, error: '' };
}

/** Renders a loaded preview. `maxLines` shortens text (info column). */
export function PreviewView({ preview, maxLines, className = '' }: { preview: Preview; maxLines?: number; className?: string }) {
  if (preview.kind === 'image') {
    return <img className={`preview-image ${className}`} alt="" src={`data:${preview.mime};base64,${preview.data}`} />;
  }
  if (preview.kind === 'media') {
    if (preview.mime === 'application/pdf') return <iframe className={`preview-pdf ${className}`} title={$t('PDF-Vorschau')} src={preview.data} />;
    if (preview.mime.startsWith('audio/')) return <audio className={`preview-audio ${className}`} controls autoPlay src={preview.data} />;
    return <video className={`preview-video ${className}`} controls autoPlay src={preview.data} />;
  }
  if (preview.kind === 'text') {
    const text = maxLines ? preview.data.split('\n').slice(0, maxLines).join('\n') : preview.data;
    return (
      <pre className={`preview-text mono ${className}`}>
        {text || ' '}
        {preview.truncated && !maxLines && <span className="preview-cut">{$t('… Die Datei ist länger; gezeigt wird der Anfang.')}</span>}
      </pre>
    );
  }
  return <p className={`muted small ${className}`}>{preview.truncated ? $t('Zu groß für eine Vorschau.') : $t('Keine Vorschau für diese Art Datei.')}</p>;
}
