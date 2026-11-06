/**
 * Loads file previews: the start of a text file or an image, local or on the
 * server. The preview window also shows PDFs and plays audio and video (after
 * ForkLift): local files through the "media" address scheme, server files
 * after copying them into a temporary file.
 */
import { LIVE } from '../state/store';
import { tauriBackend as backend } from '../backend/tauriBackend';
import { toBackendError, type Preview } from '../backend/api';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import type { PaneSide } from '../backend/types';

const DEMO_TEXT =
  'from flask import Flask\n\nfrom .routes import cart, checkout, products\n\nDEBUG = False\nLOG_LEVEL = "info"\n\napp = Flask(__name__)\napp.register_blueprint(cart)\napp.register_blueprint(products)\napp.register_blueprint(checkout)\n\n\n@app.get("/health")\ndef health():\n    return "Webshop ok"\n';

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
 * Loads a preview; `null` while loading. `media`: also load PDFs, audio and video
 * (the preview window; the info column does not).
 */
export function usePreview(
  side: PaneSide,
  serverId: string,
  path: string | null,
  media = false,
): { preview: Preview | null; error: string } {
  const [state, setState] = useState<{ key: string; preview: Preview | null; error: string }>({
    key: '',
    preview: null,
    error: '',
  });
  const key = `${side}|${serverId}|${path}`;
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    if (!LIVE) {
      const image = /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
      setState({
        key,
        preview: image
          ? { kind: 'binary', mime: '', data: '', truncated: false }
          : { kind: 'text', mime: '', data: DEMO_TEXT, truncated: false },
        error: '',
      });
      return;
    }
    setState({ key, preview: null, error: '' });
    const mime = media ? mediaMime(path) : null;
    if (mime) {
      (side === 'local' ? Promise.resolve(path) : backend.remoteMedia(serverId, path))
        .then((local) => {
          if (!cancelled)
            setState({
              key,
              preview: { kind: 'media', mime, data: convertFileSrc(local, 'media'), truncated: false },
              error: '',
            });
        })
        .catch((e) => {
          if (!cancelled) setState({ key, preview: null, error: toBackendError(e).message });
        });
      return () => {
        cancelled = true;
      };
    }
    (side === 'local' ? backend.localPreview(path) : backend.remotePreview(serverId, path))
      .then((p) => {
        if (!cancelled) setState({ key, preview: p, error: '' });
      })
      .catch((e) => {
        if (!cancelled) setState({ key, preview: null, error: toBackendError(e).message });
      });
    return () => {
      cancelled = true;
    };
  }, [key, path, side, serverId, media]);
  return state.key === key ? { preview: state.preview, error: state.error } : { preview: null, error: '' };
}
