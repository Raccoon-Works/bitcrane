/*
 * Product shots and clips. Every shot exists per platform, design and language; the page's
 * design is the resting one and a click wipes in the other. Clips are short silent loops that
 * play while they are in view. The magnifier opens the large view with its own design switch.
 */
import { state, pageTheme, otherTheme, platformName, reducedMotion, isTouch, tr, onRefresh } from './core.js';

const ALT = {
  de: {
    save: 'Video: Im Editor wird app.py geändert und gesichert, Bitcrane lädt die Datei hoch und startet die App auf dem Server neu',
    term: 'Video: Das Terminal öffnet sich unter den Dateien, pm2 restart webshop wird ausgeführt',
    main: 'Bitcrane-Hauptfenster: links der eigene Ordner, rechts der Server',
    editor: 'Eingebauter Editor', compare: 'Ordnervergleich', import: 'Server aus anderen Programmen übernehmen',
    light: 'Hell', dark: 'Dunkel'
  },
  en: {
    save: 'Video: app.py is changed and saved in the editor, Bitcrane uploads it and restarts the app on the server',
    term: 'Video: the terminal opens below the files and runs pm2 restart webshop',
    main: 'Bitcrane main window: your folder on the left, the server on the right',
    editor: 'Built-in editor', compare: 'Folder comparison', import: 'Taking over servers from other apps',
    light: 'Light', dark: 'Dark'
  }
};
/* Titles of the clips in the large view (the alt texts above describe the whole video). */
const CLIP_TITLE = { de: { save: 'Speichern und hochladen', term: 'SSH-Terminal' }, en: { save: 'Save and upload', term: 'SSH terminal' } };

/* Raise CLIP_V after recording the clips again, so browsers do not keep the old ones. */
const CLIP_V = '1';
/* Width the clips were recorded at, the window's corner radius there, and the frame's shape. */
const CLIP_W = 1011;
const CLIP_RADIUS = { mac: 16, win: 8 };
const CLIP_RATIO = { mac: '1600 / 936', win: '1600 / 972' };

export const imgSrc = (view, theme, suffix = '') => `img/${view}-${state.platform}-${theme}-${state.lang}${suffix}.webp`;
const clipSrc = (view, theme, ext) => `vid/${view}-${state.platform}-${theme}-${state.lang}.${ext}?v=${CLIP_V}`;
const describe = (view, theme) => `${ALT[state.lang][view]} (${platformName(state.platform)}, ${ALT[state.lang][theme]})`;

const shots = [...document.querySelectorAll('.shot')].map((fig) => ({
  fig,
  view: fig.dataset.view,
  isClip: 'clip' in fig.dataset,
  suffix: 'crop' in fig.dataset ? '-c' : '',
  frame: fig.querySelector('.shot-frame'),
  base: fig.querySelector('.shot-base'),
  over: fig.querySelector('.shot-over'),
  cap: fig.querySelector('.shot-cap'),
  play: fig.querySelector('.shot-play')
}));
const clips = shots.filter((s) => s.isClip);

/* The hint under a shot names the design a click brings in. */
function caption(s) {
  if (!s.cap) return;
  const shown = s.fig.classList.contains('flipped') ? otherTheme(pageTheme()) : pageTheme();
  const next = otherTheme(shown);
  s.cap.textContent = tr(
    `${isTouch() ? 'Tippen' : 'Klicken'} für das ${next === 'dark' ? 'dunkle' : 'helle'} Design`,
    `${isTouch() ? 'Tap' : 'Click'} for ${next} mode`
  );
}

function playLabel(s) {
  const paused = s.fig.classList.contains('paused');
  s.play.setAttribute('aria-label', paused ? tr('Video abspielen', 'Play video') : tr('Video anhalten', 'Pause video'));
}

/* The window's rounded corners, scaled to the shown size. */
function clipRadius(s) {
  const w = s.frame.clientWidth;
  if (w) s.frame.style.setProperty('--vr', (CLIP_RADIUS[state.platform] * w / CLIP_W).toFixed(2) + 'px');
}

function renderClip(s, theme) {
  s.frame.style.setProperty('--ar', CLIP_RATIO[state.platform]);
  [[s.base, theme], [s.over, otherTheme(theme)]].forEach(([video, t]) => {
    const want = clipSrc(s.view, t, 'mp4');
    video.poster = clipSrc(s.view, t, 'webp');
    video.dataset.src = want;
    /* Already loaded: switch at once and keep the position. */
    const current = video.getAttribute('src');
    if (current && current !== want) {
      const at = video.currentTime;
      video.src = want;
      video.currentTime = at;
      if (s.fig.classList.contains('playing')) video.play().catch(() => {});
    }
  });
  s.frame.setAttribute('role', 'img');
  s.frame.setAttribute('aria-label', describe(s.view, theme));
  clipRadius(s);
  playLabel(s);
}

function render() {
  const theme = pageTheme();
  shots.forEach((s) => {
    if (s.isClip) {
      renderClip(s, theme);
    } else {
      s.base.src = imgSrc(s.view, theme, s.suffix);
      s.over.src = imgSrc(s.view, otherTheme(theme), s.suffix);
      s.base.alt = describe(s.view, theme);
    }
    caption(s);
  });
}

/* Clips play while they are in view. With reduced motion they wait for the play button and
   show their finished moment meanwhile. */
function initClips() {
  const videos = (s) => [s.base, s.over];
  function load(s) {
    videos(s).forEach((v) => { if (!v.getAttribute('src')) { v.preload = 'auto'; v.src = v.dataset.src; } });
  }
  function play(s) {
    load(s);
    s.fig.classList.add('playing');
    videos(s).forEach((v) => v.play().catch(() => {
      s.fig.classList.add('paused');
      s.fig.classList.remove('playing');
      playLabel(s);
    }));
    /* Keep the hidden design in step with the shown one, for the wipe. */
    if (!s.sync) {
      s.sync = setInterval(() => {
        if (s.over.readyState > 0 && Math.abs(s.over.currentTime - s.base.currentTime) > 0.2) s.over.currentTime = s.base.currentTime;
      }, 250);
    }
  }
  function stop(s) {
    s.fig.classList.remove('playing');
    videos(s).forEach((v) => v.pause());
    clearInterval(s.sync);
    s.sync = null;
  }
  clips.forEach((s) => {
    if (reducedMotion()) s.fig.classList.add('paused');
    s.play.addEventListener('click', (e) => {
      e.stopPropagation();
      s.fig.classList.toggle('paused');
      playLabel(s);
      if (s.fig.classList.contains('paused')) stop(s); else play(s);
    });
  });
  const resize = new ResizeObserver(() => clips.forEach(clipRadius));
  clips.forEach((s) => resize.observe(s.frame));
  const view = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const s = clips.find((c) => c.fig === entry.target);
      if (entry.isIntersecting && entry.intersectionRatio >= 0.35) {
        if (!s.fig.classList.contains('paused')) play(s);
      } else if (s.fig.classList.contains('playing')) {
        stop(s);
      }
    });
  }, { threshold: [0, 0.35, 0.6] });
  clips.forEach((s) => view.observe(s.fig));
}

/* Large view: the whole window of a shot or clip, with its own light/dark switch. */
function initLightbox() {
  const box = document.getElementById('lightbox');
  const img = document.getElementById('lb-img');
  const video = document.getElementById('lb-video');
  const title = document.getElementById('lb-title');
  let view = '';
  let theme = 'light';

  function show() {
    const isClip = clips.some((s) => s.view === view);
    img.hidden = isClip;
    video.hidden = !isClip;
    if (isClip) {
      img.removeAttribute('src');
      video.poster = clipSrc(view, theme, 'webp');
      video.src = clipSrc(view, theme, 'mp4');
      video.setAttribute('aria-label', ALT[state.lang][view]);
      if (!reducedMotion()) video.play().catch(() => {});
    } else {
      video.pause();
      video.removeAttribute('src');
      img.src = imgSrc(view, theme);
      img.alt = describe(view, theme);
    }
    title.textContent = CLIP_TITLE[state.lang][view] || ALT[state.lang][view];
    box.querySelectorAll('[data-lb-theme]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lbTheme === theme)));
  }
  /* <dialog> came to Safari with 15.4; older versions on macOS 11 get the plain open attribute. */
  const close = () => { if (box.close) box.close(); else { box.removeAttribute('open'); video.pause(); } };
  function open(name) {
    view = name;
    theme = pageTheme();
    show();
    if (box.showModal) box.showModal(); else box.setAttribute('open', '');
  }
  box.querySelectorAll('[data-lb-theme]').forEach((b) => b.addEventListener('click', () => { theme = b.dataset.lbTheme; show(); }));
  document.getElementById('lb-close').addEventListener('click', close);
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  box.addEventListener('close', () => video.pause());
  return open;
}

export function initShots() {
  const openLightbox = initLightbox();
  /* A click on a shot wipes in the other design; the magnifier opens the large view. */
  shots.forEach((s) => {
    s.frame.addEventListener('click', (e) => {
      if (e.target.closest('.shot-zoom')) { openLightbox(s.view); return; }
      if (e.target.closest('.shot-play')) return;
      s.fig.classList.toggle('flipped');
      if (s.isClip && s.over.readyState > 0) s.over.currentTime = s.base.currentTime;
      caption(s);
    });
  });
  initClips();
  onRefresh(render);
}
