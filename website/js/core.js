/*
 * Shared state of the start page: language, platform, design, and one refresh hook that every
 * part of the page registers with. Whenever the language, the platform or the design changes,
 * refresh() runs all of them, so no part has to know about the others.
 */

export const root = document.documentElement;
export const REPO = 'Raccoon-Works/bitcrane';

import { detectPlatform } from './util.js';

export { store } from './util.js';

/* The visitor's own system decides which download and which screenshots come first
   (null on phones and tablets: then the Mac screenshots and no direct download). */
export const ownPlatform = detectPlatform();

export const state = {
  lang: root.dataset.lang === 'en' ? 'en' : 'de',   /* set before the first paint by js/prefs.js */
  platform: ownPlatform || 'mac'
};

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const touchQuery = matchMedia('(hover: none)');

export const reducedMotion = () => motionQuery.matches;
export const isTouch = () => touchQuery.matches;
export const scrollBehavior = () => (reducedMotion() ? 'auto' : 'smooth');

/* The design in use: the visitor's choice, else the system's. */
export function pageTheme() {
  const chosen = root.getAttribute('data-theme');
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return darkQuery.matches ? 'dark' : 'light';
}
export const otherTheme = (theme) => (theme === 'dark' ? 'light' : 'dark');
export const platformName = (platform) => (platform === 'win' ? 'Windows' : 'macOS');

/* Picks the text for the current language. */
export const tr = (de, en) => (state.lang === 'de' ? de : en);

const listeners = [];
export function onRefresh(fn) { listeners.push(fn); }
export function refresh() { listeners.forEach((fn) => fn()); }

darkQuery.addEventListener('change', refresh);
