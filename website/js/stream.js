/*
 * Data stream behind the hero: lanes run from the left (your folder) towards a point on the
 * right (the server); small packets travel along them, and now and then a file lights up.
 * Calmer around the headline and stopped once the page has scrolled past; with reduced motion
 * it is a still picture. Scrolling pushes the stream: it speeds up, then calms down again.
 */
import { root, pageTheme, reducedMotion, onRefresh } from './core.js';

export function initStream() {
  const host = document.getElementById('waves');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const color = {};
  let W = 0, H = 0, lanes = [], packets = [];
  let laneAlpha, dotAlpha;
  let boost = 0, lastY = scrollY, last = 0, frameId = 0;

  /* Fixed seed: the same picture on every visit. */
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  function readColors() {
    const cs = getComputedStyle(root);
    ['lane', 'dot', 'file'].forEach((k) => { color[k] = cs.getPropertyValue('--stream-' + k).trim(); });
    const dark = pageTheme() === 'dark';
    laneAlpha = dark ? 0.11 : 0.13;
    dotAlpha = dark ? 0.6 : 0.55;
  }
  /* A lane starts at y0 on the left and bends towards the server point on the right. */
  function laneY(l, x) {
    const t = x / W, ease = t * t * (3 - 2 * t);
    return l.y0 + (l.sy - l.y0) * Math.pow(ease, 1.6) + Math.sin(x * l.k + l.ph) * l.amp * (1 - ease);
  }
  function spawn(anywhere) {
    const file = rnd() < 0.2;
    return {
      lane: lanes[(rnd() * lanes.length) | 0],
      x: anywhere ? rnd() * W : -40 - rnd() * 200,
      v: (file ? 70 : 40) + rnd() * 70,
      len: file ? 26 + rnd() * 18 : 6 + rnd() * 14,
      file
    };
  }
  function setup() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = host.clientWidth;
    H = host.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed = 11;
    const n = W < 700 ? 12 : 22;
    lanes = [];
    for (let i = 0; i < n; i++) {
      lanes.push({
        y0: H * (0.06 + 0.9 * (i + rnd() * 0.6) / n), sy: H * (0.34 + (rnd() - 0.5) * 0.08),
        k: 0.002 + rnd() * 0.003, ph: rnd() * 6.28, amp: 10 + rnd() * 26
      });
    }
    packets = [];
    for (let j = 0; j < n * 5; j++) packets.push(spawn(true));
  }
  /* Quieter behind the headline and the buttons. */
  function calm(x, y) {
    const dx = (x - W / 2) / (Math.min(W, 1100) * 0.42), dy = (y - H * 0.36) / (H * 0.3);
    return Math.min(1, 0.35 + Math.max(0, Math.hypot(dx, dy) - 0.5) * 1.4);
  }
  function draw(dt) {
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${color.lane},${laneAlpha})`;
    lanes.forEach((l) => {
      ctx.beginPath();
      for (let x = 0; x <= W; x += 24) { const y = laneY(l, x); if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke();
    });
    packets.forEach((p, i) => {
      p.x += p.v * dt * (1 + boost);
      if (p.x > W + 40) { packets[i] = spawn(false); return; }
      const x0 = Math.max(0, p.x - p.len), y0 = laneY(p.lane, x0), y1 = laneY(p.lane, p.x);
      const arrive = Math.min(1, (W - p.x) / (W * 0.18));   /* packets fade out as they reach the server */
      const a = calm(p.x, y1) * Math.max(0, arrive);
      if (a <= 0.01 || p.x < 0) return;
      const c = p.file ? color.file : color.dot;
      const g = ctx.createLinearGradient(x0, y0, p.x, y1);
      g.addColorStop(0, `rgba(${c},0)`);
      g.addColorStop(1, `rgba(${c},${(p.file ? 1 : dotAlpha) * a})`);
      ctx.strokeStyle = g;
      ctx.lineWidth = p.file ? 2.6 : 1.8;
      if (p.file) { ctx.shadowColor = `rgba(${c},${0.9 * a})`; ctx.shadowBlur = 14; }
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(p.x, y1);
      ctx.stroke();
      ctx.shadowBlur = 0;
    });
  }

  /* Runs only while the stream can be seen. */
  const visible = () => !reducedMotion() && !document.hidden && scrollY < innerHeight * 1.1;
  function frame(ms) {
    const dt = last ? Math.min(0.05, (ms - last) / 1000) : 0;
    last = ms;
    boost *= Math.pow(0.15, dt);   /* calms down within about a second */
    draw(dt);
    frameId = visible() ? requestAnimationFrame(frame) : 0;
  }
  function wake() {
    if (!frameId && visible()) { last = 0; frameId = requestAnimationFrame(frame); }
  }

  readColors();
  setup();
  draw(0);
  wake();
  /* Phones fire resize when their toolbar collapses; the picture only starts over when the
     stream's own size changes. */
  addEventListener('resize', () => {
    if (host.clientWidth === W && host.clientHeight === H) return;
    setup();
    draw(0);
  });
  addEventListener('scroll', () => {
    boost = Math.min(8, boost + Math.abs(scrollY - lastY) * 0.06);
    lastY = scrollY;
    wake();
  }, { passive: true });
  document.addEventListener('visibilitychange', wake);
  onRefresh(() => { readColors(); draw(0); });
}
