/**
 * Finder tags (Mac) of files on this computer: coloured dots next to the name
 * and the colours in the context menu, as in the Finder and ForkLift. The tags
 * live in the files' extended attributes (src-tauri/src/tags.rs), so the
 * Finder shows the same ones.
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { $t, LANG } from '../i18n';
import { getState, LIVE, showToast } from './store';

export interface Tag { name: string; color: number }

/** Finder colours by number, with the names the Finder gives them. */
export const TAG_COLORS: Array<{ color: number; css: string; de: string; en: string }> = [
  { color: 6, css: '#ff4d4f', de: 'Rot', en: 'Red' },
  { color: 7, css: '#ff9f0a', de: 'Orange', en: 'Orange' },
  { color: 5, css: '#ffd60a', de: 'Gelb', en: 'Yellow' },
  { color: 2, css: '#32d74b', de: 'Grün', en: 'Green' },
  { color: 4, css: '#0a84ff', de: 'Blau', en: 'Blue' },
  { color: 3, css: '#bf5af2', de: 'Lila', en: 'Purple' },
  { color: 1, css: '#98989d', de: 'Grau', en: 'Gray' },
];
export const tagName = (c: (typeof TAG_COLORS)[number]) => (LANG === 'de' ? c.de : c.en);
export const tagCss = (color: number) => TAG_COLORS.find((c) => c.color === color)?.css ?? 'var(--text-faint)';

const cache = new Map<string, Record<string, Tag[]>>();
const listeners = new Set<() => void>();

export async function refreshTags(dir: string) {
  if (!LIVE || !dir) return;
  const t = await invoke<Record<string, Tag[]>>('local_tags', { dir }).catch(() => ({}));
  cache.set(dir, t);
  listeners.forEach((l) => l());
}

/** Tags of the entries of a local folder (Mac only). */
export function useTags(dir: string, enabled: boolean): Record<string, Tag[]> | null {
  const [, setTick] = useState(0);
  const fsRev = getState().fsRev;
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => {
    if (enabled && dir) void refreshTags(dir);
  }, [dir, enabled, fsRev]);
  return enabled ? cache.get(dir) ?? null : null;
}

export function tagsFor(dir: string): Record<string, Tag[]> {
  return cache.get(dir) ?? {};
}

/** Turns a colour on for all chosen files, or off when all of them have it. */
export async function toggleTag(dir: string, names: string[], color: (typeof TAG_COLORS)[number]) {
  if (!LIVE) {
    showToast($t('Markierungen gehen im echten Programm.'));
    return;
  }
  const have = tagsFor(dir);
  const name = tagName(color);
  const on = !names.every((n) => (have[n] ?? []).some((t) => t.color === color.color));
  const paths = names.map((n) => `${dir.replace(/\/$/, '')}/${n}`);
  await invoke('local_tag', { paths, name, color: color.color, on }).catch((e) => showToast((e as { message?: string }).message ?? String(e), 'error'));
  await refreshTags(dir);
}
