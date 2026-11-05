/*
 * E-mail addresses are put together in the browser, so harvesters reading the source do not
 * find them: an element with data-mail="name|domain" becomes a mailto link.
 */
export function revealMail(scope = document) {
  scope.querySelectorAll('[data-mail]').forEach((el) => {
    const [name, domain] = el.dataset.mail.split('|');
    const a = document.createElement('a');
    a.href = `mailto:${name}@${domain}`;
    a.textContent = `${name}@${domain}`;
    el.replaceChildren(a);
  });
}
