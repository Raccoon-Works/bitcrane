/*
 * Wordmark intro, each time the page opens: the logo (the B) appears alone in the middle, then
 * moves to its place while the other letters slide out from behind it, flickering as bits
 * (0 and 1) until each settles as its letter; after that the rest of the head fades in.
 * Runs only when index.html set the "intro" class before the first paint (not with reduced
 * motion); that script also shows everything after a few seconds, whatever happens here.
 */
import { root } from './core.js';
import { clamp01 } from './util.js';

const POP = 380;        /* ms the logo takes to appear */
const SLIDE_AT = 520;   /* ms until it starts moving to its place */
const SLIDE = 720;      /* ms it takes to get there */
const LETTER = 640;     /* ms each letter takes to its place */
const STAGGER = 60;     /* ms between two letters */
const FLICKER = 50;     /* ms between two changes of the bits */
const LOGO_SIDE = 0.18; /* transparent share of the logo image on its right side */

const out = (p) => 1 - Math.pow(1 - p, 3);
const inOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

export function initIntro() {
  const hero = document.querySelector('.wm-hero');
  const word = document.getElementById('wm-word');
  const logo = hero.querySelector('.wm-logo');
  const letters = [...word.querySelectorAll('.wm-l')];
  if (!root.classList.contains('intro')) return;
  /* While it runs, every letter keeps the width of its final glyph, so the word does not jump
     while bits change. */
  letters.forEach((l) => {
    l.dataset.ch = l.firstChild.textContent;
    l.style.width = l.getBoundingClientRect().width + 'px';
  });

  /* Final positions, measured before anything moves. */
  const box = hero.getBoundingClientRect(), lr = logo.getBoundingClientRect();
  const shift = (box.left + box.width / 2) - (lr.left + lr.width / 2);   /* the logo starts in the middle */
  const edge = lr.right - lr.width * LOGO_SIDE;                          /* visible right edge of the B */
  const pos = letters.map((l) => { const b = l.getBoundingClientRect(); return { left: b.left, w: b.width }; });

  /* A digit is wider than i or t: squeeze the bits in narrow letters so they never overlap. */
  letters.forEach((l) => {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
    probe.className = l.className;
    probe.textContent = '0';
    word.appendChild(probe);
    const digit = probe.getBoundingClientRect().width, w = parseFloat(l.style.width);
    probe.remove();
    l.dataset.sx = digit > w ? (w / digit).toFixed(3) : '1';
    l.classList.add('bits');
  });
  const setBit = (l) => {
    l.firstChild.innerHTML = `<i class="b" style="transform:scaleX(${l.dataset.sx})">${Math.random() < 0.5 ? '0' : '1'}</i>`;
  };
  letters.forEach(setBit);

  const start = performance.now();
  let lastFlick = 0;
  function frame(now) {
    const t = now - start, flick = now - lastFlick > FLICKER;
    let done = 0;
    /* 1. The logo pops in, in the middle, then slides to its place. */
    const pop = out(Math.min(1, t / POP));
    const slide = inOut(clamp01((t - SLIDE_AT) / SLIDE));
    const lx = shift * (1 - slide);
    logo.style.opacity = String(pop);
    logo.style.transform = `translateX(${lx.toFixed(1)}px) scale(${(0.88 + 0.12 * pop).toFixed(3)})`;
    const right = edge + lx;   /* where the B ends right now */
    /* 2. The letters come out from behind it, the last one first (it has the longest way), like
       the cars of a train, so they never run into each other. */
    letters.forEach((l, i) => {
      const g = l.firstChild;
      const p = clamp01((t - SLIDE_AT - (letters.length - 1 - i) * STAGGER) / LETTER);
      if (p >= 1 && slide >= 1) {
        if (l.classList.contains('bits')) {
          l.classList.remove('bits');
          g.textContent = l.dataset.ch;
          g.style.transform = g.style.clipPath = l.style.width = '';
          g.style.opacity = '1';
        }
        done++;
        return;
      }
      const from = right - pos[i].w;                     /* hidden just behind the B */
      const x = from + (pos[i].left - from) * out(p);    /* on its way to the final place */
      g.style.opacity = '1';
      g.style.transform = `translateX(${(x - pos[i].left).toFixed(1)}px)`;
      g.style.clipPath = `inset(-40% 0 -40% ${Math.max(0, right - x).toFixed(1)}px)`;
      if (flick) setBit(l);
    });
    if (flick) lastFlick = now;
    if (done < letters.length) { requestAnimationFrame(frame); return; }
    /* 3. The rest of the head fades in, one after another. */
    logo.style.opacity = '1';
    logo.style.transform = '';
    root.classList.add('intro-rest');
    setTimeout(() => {
      root.classList.remove('intro', 'intro-rest');
      logo.style.opacity = '';
      letters.forEach((l) => { l.firstChild.style.opacity = ''; });
    }, 1400);
  }
  requestAnimationFrame(frame);
}
