/**
 * Free space of the disk that holds a folder of this computer, for the footer
 * of a half.
 */
import { useEffect, useState } from 'react';
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { LIVE } from '../../state/store';
import { LOCALE } from '../../i18n';

/** Free space of the disk that holds a folder of this computer, refreshed when files change. */
export function useFreeSpace(path: string, enabled: boolean, rev: number): number | null {
  const [free, setFree] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) {
      setFree(null);
      return;
    }
    if (!LIVE) {
      setFree(86.2e9);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      void backend.localFreeSpace(path).then((v) => {
        if (live) setFree(v ?? null);
      });
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [path, enabled, rev]);
  return free;
}

/** "86 GB", "1,2 TB", "512 MB". */
export function formatFree(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 1000) return `${(gb / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} TB`;
  if (gb >= 10) return `${Math.round(gb).toLocaleString(LOCALE)} GB`;
  if (gb >= 1) return `${gb.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} GB`;
  return `${Math.round(bytes / 1e6).toLocaleString(LOCALE)} MB`;
}
