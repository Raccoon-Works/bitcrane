/*
 * Runs in the head, before the first paint: the design and language given in the address
 * (the demo window gets them from the start page) or chosen earlier on the site, so a page
 * never flashes in the wrong one. The build inlines it into every page.
 */
(function () {
  var root = document.documentElement;
  var query = new URLSearchParams(location.search);
  var get = function (k) { try { return localStorage.getItem(k); } catch { return null; } };
  var theme = query.get('theme') || get('bc-site-theme');
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  var lang = query.get('lang') || get('bc-site-lang') || (navigator.language || 'de').slice(0, 2).toLowerCase();
  root.dataset.lang = root.lang = lang === 'de' ? 'de' : 'en';
})();
