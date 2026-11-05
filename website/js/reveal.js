/*
 * Content glides in once as it comes into view. Off with reduced motion; anything already on
 * screen (or jumped to by a link) shows at once.
 */
import { root, reducedMotion } from './core.js';

/* Groups of elements; items in a row or a list follow each other a little (delay steps). */
const GROUPS = [
  ['.protocols .proto'], ['.feature .copy'], ['.feature .shot', () => 1], ['.section-head'],
  ['.fact', (i) => i % 3], ['.dl', (i) => i % 3], ['.news-list li', (i) => i % 3], ['.faq dl > div', (i) => i % 3],
  ['.demo-band']
];

export function initReveal() {
  if (reducedMotion()) return;
  const items = [];
  GROUPS.forEach(([selector, delay]) => {
    document.querySelectorAll(selector).forEach((el, i) => {
      if (el.closest('.hero')) return;
      el.classList.add('rv');
      if (delay) el.style.setProperty('--d', String(delay(i)));
      items.push(el);
    });
  });
  root.classList.add('rv-on');
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px' });
  items.forEach((el) => io.observe(el));
  setTimeout(() => items.forEach((el) => { if (el.getBoundingClientRect().top < innerHeight) el.classList.add('in'); }), 50);
}
