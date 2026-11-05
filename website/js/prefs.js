/*
 * Runs in the head, before the first paint: the design and language chosen on the start page,
 * so a page never flashes in the wrong one. The build inlines it into every page.
 */
(function () {
  var root = document.documentElement;
  var get = function (k) { try { return localStorage.getItem(k); } catch { return null; } };
  var theme = get('bc-site-theme');
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  root.dataset.lang = root.lang = (get('bc-site-lang') || (navigator.language || 'de').slice(0, 2).toLowerCase()) === 'de' ? 'de' : 'en';
})();
