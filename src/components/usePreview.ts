/**
 * Loads file previews for the info column and the preview window (see
 * state/fileContent.ts); a new file shows nothing until its preview is there.
 */
import { useEffect, useState } from 'react';
import { toBackendError, type Preview } from '../backend/api';
import type { PaneSide } from '../backend/types';
import { loadPreview } from '../state/store';

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
    setState({ key, preview: null, error: '' });
    loadPreview(side, serverId, path, media)
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
