/*
 * Contact form: sent in the background and answered in place; without JavaScript the browser
 * posts it normally and kontakt.php answers with a short page.
 */
import { state } from './core.js';
import { revealMail } from './mail.js';

const MSG = {
  de: {
    sent: 'Danke! Deine Nachricht ist angekommen. Wir antworten per E-Mail.',
    email: 'Bitte prüfe deine E-Mail-Adresse.',
    short: 'Bitte schreib ein paar Worte mehr.',
    error: 'Das hat leider nicht geklappt. Schreib uns bitte direkt an info@bitcrane.de.',
    sending: 'Wird gesendet …'
  },
  en: {
    sent: 'Thank you! Your message has arrived. We will reply by email.',
    email: 'Please check your email address.',
    short: 'Please write a few more words.',
    error: 'Sorry, that did not work. Please write to info@bitcrane.de directly.',
    sending: 'Sending …'
  }
};

export function initContact() {
  revealMail();
  const form = document.getElementById('contact-form');
  const status = document.getElementById('cf-status');
  const send = document.getElementById('cf-send');
  const bug = document.getElementById('cf-bug');
  /* Time the page was loaded: the server drops forms sent faster than a person could. */
  const stamp = () => { form.elements.ts.value = String(Math.floor(Date.now() / 1000)); };
  const bugFields = () => { bug.hidden = form.elements.category.value !== 'bug'; };
  const show = (code, ok) => {
    status.textContent = MSG[state.lang][code] || MSG[state.lang].error;
    status.className = 'form-status ' + (ok ? 'ok' : 'err');
  };

  stamp();
  form.querySelectorAll('input[name="category"]').forEach((r) => r.addEventListener('change', bugFields));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const { email, message } = form.elements;
    email.removeAttribute('aria-invalid');
    message.removeAttribute('aria-invalid');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { email.setAttribute('aria-invalid', 'true'); email.focus(); show('email'); return; }
    if (message.value.trim().length < 10) { message.setAttribute('aria-invalid', 'true'); message.focus(); show('short'); return; }
    form.elements.lang.value = state.lang;
    send.disabled = true;
    status.className = 'form-status';
    status.textContent = MSG[state.lang].sending;
    fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) { show(res.code); return; }
        form.reset();
        bugFields();
        stamp();
        show('sent', true);
      })
      .catch(() => show('error'))
      .finally(() => { send.disabled = false; });
  });
}
