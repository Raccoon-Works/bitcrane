/*
 * Small helpers shared by the scripts of all pages.
 */

/* Remembered choices; storage can be blocked (private windows, strict settings). */
export const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } }
};

/* The visitor's own desktop system: 'mac', 'win', or null for phones, tablets and others.
   iPads report themselves as a Mac, but have a touch screen. */
export function detectPlatform() {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'win';
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints < 2) return 'mac';
  return null;
}

/* Marks the buttons matching `selector` as pressed or not. */
export function pressed(selector, isOn) {
  document.querySelectorAll(selector).forEach((b) => b.setAttribute('aria-pressed', String(isOn(b))));
}

export const clamp01 = (v) => Math.max(0, Math.min(1, v));
