/*
 * Impressum, Datenschutz and the 404 page: the language switch (remembered like on the start
 * page; the title carries its English form in data-en) and the e-mail address.
 */
import { revealMail } from './mail.js';

const root = document.documentElement;
const title = document.querySelector('title');
const titles = { de: title.textContent, en: title.dataset.en };
const buttons = document.querySelectorAll('.langs button');

function show() {
  document.title = titles[root.lang];
  buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === root.lang)));
}
buttons.forEach((b) => b.addEventListener('click', () => {
  root.dataset.lang = root.lang = b.dataset.lang;
  try { localStorage.setItem('bc-site-lang', b.dataset.lang); } catch { /* storage blocked */ }
  show();
}));
revealMail();
show();
