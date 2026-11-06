/**
 * Search over all settings areas: matching of the query and filtering of the
 * rendered rows.
 */

/** Lower case without accents, so "ubertragung" finds "Übertragung". */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss');
}

/** Every word of the query occurs in the text. */
export function matches(text: string, query: string): boolean {
  const t = fold(text);
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => t.includes(w));
}

/**
 * Shows only what fits the query in the search results: rows by their name and
 * description, whole groups or areas when their title fits. Returns whether
 * anything is left. Works on the rendered rows, so every area is covered
 * without a separate list of settings.
 */
export function filterSettings(root: HTMLElement, query: string): boolean {
  let any = false;
  root.querySelectorAll<HTMLElement>('.set-search-section').forEach((sec) => {
    const secMatch = sec.dataset.match === '1';
    let secAny = false;
    sec.querySelectorAll<HTMLElement>('.set-group').forEach((g) => {
      const caption = g.getAttribute('aria-label') ?? '';
      const groupMatch = secMatch || matches(caption, query);
      let groupAny = groupMatch;
      g.querySelectorAll<HTMLElement>('.set-card > *').forEach((el) => {
        let show = groupMatch;
        if (!show && el.classList.contains('set-row')) {
          // The name and description, not the buttons ("Ändern", "Wählen …").
          const text = el.querySelector('.col-text, .flex-1')?.textContent ?? '';
          show = matches(text, query);
        }
        el.hidden = !show;
        if (show) groupAny = true;
      });
      g.hidden = !groupAny;
      if (groupAny) secAny = true;
    });
    // Loose content outside groups (notes, lists) only with a matching area.
    sec.querySelectorAll<HTMLElement>(':scope > :not(.set-search-head):not(.set-group)').forEach((el) => {
      el.hidden = !secMatch;
    });
    sec.hidden = !(secAny || secMatch);
    if (!sec.hidden) any = true;
  });
  return any;
}
