/**
 * Website demo: the browser prototype embedded in a page of bitcrane.de.
 * The host page passes options in the address, e.g.
 *   index.html?demo&platform=win&theme=dark&lang=en
 * and can switch platform and theme later with a message:
 *   iframe.contentWindow.postMessage({ bitcraneDemo: true, platform: 'mac', theme: 'light' }, '*')
 * The desktop app never has a query string, so none of this applies there.
 */
import type { Platform, Theme } from '../backend/types';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

/** True when the prototype runs as the website demo (no prototype control bar). */
export const DEMO = params.has('demo');

function pick<T extends string>(key: string, values: readonly T[]): T | undefined {
  const v = params.get(key);
  return values.includes(v as T) ? (v as T) : undefined;
}

export const DEMO_PLATFORM: Platform | undefined = DEMO ? pick('platform', ['mac', 'win'] as const) : undefined;
export const DEMO_THEME: Theme | undefined = DEMO ? pick('theme', ['light', 'dark'] as const) : undefined;
export const DEMO_LANG: string | undefined = DEMO ? params.get('lang') ?? undefined : undefined;

/**
 * Listens for platform and theme changes from the host page. Only messages
 * from the embedding window are accepted, and only these two known values.
 */
export function listenForDemoMessages(apply: (patch: { platform?: Platform; theme?: Theme }) => void) {
  if (!DEMO || typeof window === 'undefined' || window.parent === window) return;
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const d = e.data as { bitcraneDemo?: boolean; platform?: string; theme?: string } | null;
    if (!d || d.bitcraneDemo !== true) return;
    const patch: { platform?: Platform; theme?: Theme } = {};
    if (d.platform === 'mac' || d.platform === 'win') patch.platform = d.platform;
    if (d.theme === 'light' || d.theme === 'dark') patch.theme = d.theme;
    if (patch.platform || patch.theme) apply(patch);
  });
}
