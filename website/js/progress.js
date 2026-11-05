/*
 * Reading position as an upload of the page (right edge, wide screens): a column of chunk
 * ticks fills as you read, the block in transfer glows, sections are marked with their names,
 * and a click or drag along the column moves through the page. Below it, back to the top.
 */
import { root, scrollBehavior, onRefresh } from './core.js';
import { clamp01 } from './util.js';

const STOPS = [
  ['top', 'Start', 'Start'], ['funktionen', 'Funktionen', 'Features'], ['mehr', 'Mehr', 'More'],
  ['demo', 'Demo', 'Demo'], ['download', 'Download', 'Download'], ['neu', 'Neu', 'New'], ['fragen', 'Fragen', 'Questions']
];
const TICK = 7;          /* px from one chunk tick to the next, as drawn in the CSS */
const NAME_GAP = 8;      /* px between a mark and the start of its name */
const WAVE = 6;          /* ticks on each side of the block in transfer that swing out */

const bar = document.getElementById('upload');
const fill = document.getElementById('upload-fill');
const cursor = document.getElementById('upload-cursor');
const totop = document.getElementById('totop');

const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);

let stops = [];
let current = -1;

/* Each mark sits where its section starts to be read (40 % down the screen). */
function placeStops() {
  const max = maxScroll();
  stops.forEach((s) => {
    s.at = clamp01((s.section.getBoundingClientRect().top + scrollY - innerHeight * 0.4) / max);
    s.li.style.top = (s.at * 100) + '%';
  });
}

/* The current name always shows: downwards if it fits before the column ends, else upwards.
   Any other name that would reach the next mark or touch the current one stays hidden until
   pointed at. */
function squeeze() {
  const h = bar.clientHeight;
  const info = stops.map((s, i) => {
    const name = [...s.a.children].find((span) => span.offsetHeight);
    return {
      at: s.at * h,
      len: name ? name.offsetHeight : 0,
      next: i + 1 < stops.length ? stops[i + 1].at * h : h,
      flip: false,
      hide: false
    };
  });
  const cur = info[current];
  if (cur) {
    cur.flip = cur.at + NAME_GAP + cur.len > h && cur.at - NAME_GAP - cur.len >= 0;
    cur.from = cur.flip ? cur.at - NAME_GAP - cur.len : cur.at + NAME_GAP;
    cur.to = cur.from + cur.len;
  }
  info.forEach((n) => {
    if (n === cur) return;
    const from = n.at + NAME_GAP, to = from + n.len;
    n.hide = to > n.next - 4 || (cur && from < cur.to + 6 && to > cur.from - 6);
  });
  info.forEach((n, i) => {
    stops[i].li.classList.toggle('flip', n.flip);
    stops[i].li.classList.toggle('squeezed', n.hide);
  });
}

function update() {
  const p = clamp01(scrollY / maxScroll());
  fill.style.clipPath = `inset(0 0 ${((1 - p) * 100).toFixed(2)}% 0)`;
  cursor.style.transform = `translateY(${(p * bar.clientHeight).toFixed(1)}px)`;
  bar.classList.toggle('complete', p > 0.995);
  let cur = 0;
  stops.forEach((s, i) => {
    const reached = p + 0.002 >= s.at;
    if (reached) cur = i;
    s.a.classList.toggle('done', reached);
  });
  if (cur !== current) {
    current = cur;
    stops.forEach((s, i) => s.li.classList.toggle('current', i === cur));
    /* Measure after the name has grown into its current size. */
    setTimeout(squeeze, 320);
  }
  totop.classList.toggle('show', scrollY > innerHeight * 0.8);
}

/* While you scroll, the ticks around the block in transfer swing out with the scroll speed and
   settle again. Small and only ever driven by your own scrolling, so it stays on with reduced
   motion too. */
function createWave() {
  const host = document.getElementById('upload-wave');
  const ticks = [];
  for (let k = -WAVE; k <= WAVE; k++) {
    const el = document.createElement('i');
    host.appendChild(el);
    ticks.push({ el, fall: Math.exp(-(k * k) / 10), k });
  }
  let energy = 0, lastY = scrollY, running = false;
  function frame() {
    energy *= 0.92;
    const p = clamp01(scrollY / maxScroll());
    const base = Math.round(p * bar.clientHeight / TICK) * TICK;
    ticks.forEach((t) => {
      const e = Math.min(1, energy) * t.fall;
      t.el.style.top = (base + t.k * TICK) + 'px';
      t.el.style.transform = `scaleX(${(1 + e * 1.6).toFixed(3)})`;
      t.el.style.opacity = (e * 0.95).toFixed(3);
    });
    if (energy > 0.01) requestAnimationFrame(frame); else running = false;
  }
  return function push() {
    energy = Math.min(1.5, energy + Math.abs(scrollY - lastY) / 90);
    lastY = scrollY;
    if (!running) { running = true; requestAnimationFrame(frame); }
  };
}

function relayout() { placeStops(); update(); squeeze(); }

export function initProgress() {
  const list = document.getElementById('upload-stops');
  stops = STOPS.map(([id, de, en]) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#' + id;
    a.innerHTML = `<span class="de">${de}</span><span class="en">${en}</span>`;
    li.appendChild(a);
    list.appendChild(li);
    return { li, a, section: document.getElementById(id), at: 0 };
  });
  const wave = createWave();

  /* Click or drag along the column to move through the page; while dragging the page follows
     the pointer directly instead of gliding. */
  const seek = (e) => {
    const r = bar.getBoundingClientRect();
    scrollTo(0, clamp01((e.clientY - r.top) / r.height) * maxScroll());
  };
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('a')) return;
    bar.setPointerCapture(e.pointerId);
    root.style.scrollBehavior = 'auto';
    seek(e);
    const end = () => {
      root.style.scrollBehavior = '';
      bar.removeEventListener('pointermove', seek);
      bar.removeEventListener('pointerup', end);
      bar.removeEventListener('pointercancel', end);
    };
    bar.addEventListener('pointermove', seek);
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  });
  totop.addEventListener('click', (e) => {
    e.preventDefault();
    scrollTo({ top: 0, behavior: scrollBehavior() });
  });
  addEventListener('scroll', () => { update(); wave(); }, { passive: true });
  addEventListener('resize', relayout);
  /* The page grows while pictures and fonts arrive: the marks follow. */
  new ResizeObserver(relayout).observe(document.body);
  /* A new language changes the length of the names. */
  onRefresh(() => { update(); squeeze(); });
}
