/**
 * File preview: the start of a text file or an image, local or on the
 * server. Used by the info column and by the preview window (space bar).
 */
import { useEffect, useState } from 'react';
import { toBackendError, type Preview } from '../backend/api';
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { PaneSide } from '../backend/types';
import { LIVE } from '../state/store';
import { $t } from '../i18n';

const DEMO_TEXT = 'import discord\nfrom discord.ext import commands\n\nPREFIX = "!"\nDEBUG = False\n\nbot = commands.Bot(command_prefix=PREFIX)\n\n@bot.event\nasync def on_ready():\n    print("Taskbot online")\n';

/** Loads a preview; `null` while loading. */
export function usePreview(side: PaneSide, serverId: string, path: string | null): { preview: Preview | null; error: string } {
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
    (side === 'local' ? backend.localPreview(path) : backend.remotePreview(serverId, path))
      .then((p) => { if (!cancelled) setState({ key, preview: p, error: '' }); })
      .catch((e) => { if (!cancelled) setState({ key, preview: null, error: toBackendError(e).message }); });
    return () => { cancelled = true; };
  }, [key, path, side, serverId]);
  return state.key === key ? { preview: state.preview, error: state.error } : { preview: null, error: '' };
}

/** Renders a loaded preview. `maxLines` shortens text (info column). */
export function PreviewView({ preview, maxLines, className = '' }: { preview: Preview; maxLines?: number; className?: string }) {
  if (preview.kind === 'image') {
    return <img className={`preview-image ${className}`} alt="" src={`data:${preview.mime};base64,${preview.data}`} />;
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
