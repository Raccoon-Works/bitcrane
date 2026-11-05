/*
 * Impressum, Datenschutz and the 404 page: the language switch (remembered like on the start
 * page; the title carries its English form in data-en) and the e-mail address.
 */
import { revealMail } from './mail.js';
import { store, pressed } from './util.js';

const root = document.documentElement;
const title = document.querySelector('title');
const titles = { de: title.textContent, en: title.dataset.en };

function show() {
  document.title = titles[root.lang];
  pressed('.langs button', (b) => b.dataset.lang === root.lang);
}
document.querySelectorAll('.langs button').forEach((b) => b.addEventListener('click', () => {
  root.dataset.lang = root.lang = b.dataset.lang;
  store.set('bc-site-lang', b.dataset.lang);
  show();
}));
revealMail();
show();
