/*
 * Stand-alone demo window (demo.html): a thin bar with platform, design and language, the app
 * below it. The state comes from the address (set by the start page), else from the choices
 * stored by the site, and is written back to the address, so a reload or a shared link keeps it.
 */
import { detectPlatform, pressed } from './util.js';

const root = document.documentElement;
const query = new URLSearchParams(location.search);
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/* Design and language were set before the first paint (js/prefs.js); the demo also needs a
   fixed design when the site follows the system. */
const systemTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const state = {
  platform: pick(query.get('platform'), ['mac', 'win'], detectPlatform() || 'mac'),
  theme: pick(root.getAttribute('data-theme'), ['light', 'dark'], systemTheme),
  lang: root.dataset.lang
};
let frame = null;
let frameLang = null;

const settings = () => `platform=${state.platform}&theme=${state.theme}&lang=${state.lang}`;

function apply() {
  root.dataset.lang = root.lang = state.lang;
  root.setAttribute('data-theme', state.theme);
  document.title = state.lang === 'de' ? 'Bitcrane Demo' : 'Bitcrane demo';
  pressed('[data-pf]', (b) => b.dataset.pf === state.platform);
  pressed('[data-th]', (b) => b.dataset.th === state.theme);
  pressed('[data-lang]', (b) => b.dataset.lang === state.lang);
  history.replaceState(null, '', '?' + settings());
  if (!frame) return;
  /* Platform and design switch live; the language needs the app to start again. */
  if (frameLang !== state.lang) {
    frame.src = `demo/index.html?demo&${settings()}`;
    frameLang = state.lang;
  } else {
    frame.contentWindow.postMessage({ bitcraneDemo: true, platform: state.platform, theme: state.theme }, '*');
  }
}
function start() {
  if (frame) return;
  frame = document.createElement('iframe');
  frame.title = 'Bitcrane Demo';
  frame.src = `demo/index.html?demo&${settings()}`;
  frameLang = state.lang;
  document.getElementById('stage').appendChild(frame);
}

document.querySelectorAll('[data-pf]').forEach((b) => b.addEventListener('click', () => { state.platform = b.dataset.pf; apply(); }));
document.querySelectorAll('[data-th]').forEach((b) => b.addEventListener('click', () => { state.theme = b.dataset.th; apply(); }));
document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => { state.lang = b.dataset.lang; apply(); }));
document.getElementById('force').addEventListener('click', () => { document.body.classList.add('force'); start(); });
apply();
/* The app is made for large screens: on phones a note first (see demo.css). */
if (matchMedia('(min-width: 761px)').matches) start();
