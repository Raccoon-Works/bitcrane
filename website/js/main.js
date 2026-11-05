/*
 * Start page of bitcrane.de. Each part of the page lives in its own module; this file wires
 * the header switches (design, language, platform) and starts the parts in order.
 */
import { root, store, state, refresh, onRefresh } from './core.js';
import { initShots } from './shots.js';
import { initDemo } from './demo.js';
import { initDownloads } from './downloads.js';
import { initContact } from './contact.js';
import { initProgress } from './progress.js';
import { initStream } from './stream.js';
import { initReveal } from './reveal.js';
import { initIntro } from './intro.js';

const pressed = (selector, isOn) => document.querySelectorAll(selector).forEach((b) => b.setAttribute('aria-pressed', String(isOn(b))));

/* Design: light, dark or as the system; a choice is remembered on this device. */
function setTheme(theme) {
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme); else root.removeAttribute('data-theme');
  refresh();
}
document.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => {
  store.set('bc-site-theme', b.dataset.themeSet);
  setTheme(b.dataset.themeSet);
}));

/* Language: both are in the page; the root's data-lang shows one of them. */
function setLang(lang) {
  state.lang = lang;
  root.dataset.lang = root.lang = lang;
  refresh();
}
document.querySelectorAll('.langs:not(.themes) button').forEach((b) => b.addEventListener('click', () => {
  store.set('bc-site-lang', b.dataset.lang);
  setLang(b.dataset.lang);
}));

/* Platform of the screenshots and clips. */
document.querySelectorAll('.switch-row [data-platform]').forEach((b) => b.addEventListener('click', () => {
  state.platform = b.dataset.platform;
  refresh();
}));

/* State of the switches, and accessible names: German in the markup, English in data-label-en. */
onRefresh(() => {
  pressed('[data-theme-set]', (b) => b.dataset.themeSet === (root.getAttribute('data-theme') || 'auto'));
  pressed('.langs:not(.themes) button', (b) => b.dataset.lang === state.lang);
  pressed('[data-platform]', (b) => b.dataset.platform === state.platform);
  document.querySelectorAll('[data-label-en]').forEach((el) => {
    if (!el.dataset.labelDe) el.dataset.labelDe = el.getAttribute('aria-label');
    el.setAttribute('aria-label', state.lang === 'de' ? el.dataset.labelDe : el.dataset.labelEn);
  });
});

initShots();
initDemo();
initDownloads();
initContact();
initProgress();
initStream();
initReveal();
refresh();
initIntro();
