"""Variant B of the start page: a large "Bitcrane" wordmark as the head of the page.

The logo stands for the B; each time the page opens the remaining letters rise out of the
baseline as bits (0 and 1) and settle as letters, then the rest of the head fades in. Built from index.html by build.py, so
both variants share everything else and can be compared side by side
(index.html and index-b.html).
"""

CSS = """
/* Variant B: wordmark head */
.hero h1.wm-hero {
  display: inline-flex; align-items: baseline; gap: 0; margin: 6px 0 0;
  font: 800 clamp(60px, 11vw, 148px)/.9 var(--font-display); letter-spacing: -0.045em; color: var(--ink);
}
/* The logo is the B: its light front face (64 % of the image) is as tall as a capital and
   stands on the baseline, the darker edge below it like a shadow; the transparent sides of
   the image are pulled in so it reads as one word. */
.wm-hero .wm-logo { height: 1.09em; width: auto; margin: 0 -.185em 0 -.18em; display: block; position: relative; top: .118em; }
.wm-hero .wm-word { display: inline-flex; white-space: nowrap; }
.wm-hero .wm-l { display: inline-block; text-align: center; overflow: clip; padding: .22em 0 .06em; margin: -.22em 0 -.06em; }
.wm-hero .wm-l .g { display: inline-block; }
.wm-hero .wm-l.thin { font-weight: 300; letter-spacing: -0.02em; }
.wm-hero .wm-l.bits { color: var(--accent); }
.wm-hero .wm-l.bits .g { display: inline-flex; justify-content: center; width: 100%; }
.wm-hero .wm-l .b { font-style: normal; display: inline-block; }
.wm-tag { font: 600 clamp(20px, 2.6vw, 30px)/1.2 var(--font-display); letter-spacing: -0.02em; margin-top: -4px; }
.wm-tag em { font-style: normal; color: var(--accent); }

/* Intro: only while it plays (class set before first paint, removed at the end). */
html.intro .wm-hero .wm-logo { opacity: 0; transform: translateY(14px) scale(.9); }
html.intro .reveal { opacity: 0; transform: translateY(12px); }
html.intro-run .wm-hero .wm-logo { opacity: 1; transform: none; transition: opacity 380ms ease-out, transform 520ms cubic-bezier(.23, 1, .32, 1); }
html.intro-rest .reveal { opacity: 1; transform: none; transition: opacity 500ms ease-out, transform 600ms cubic-bezier(.23, 1, .32, 1); transition-delay: calc(var(--i, 0) * 70ms); }
"""

HEAD_OLD = (
    '        <h1><span class="de">Speichern. <em>Schon ist es auf dem Server.</em></span>'
    '<span class="en">Save. <em>It’s already on the server.</em></span></h1>\n'
)

HEAD_NEW = (
    '        <h1 class="wm-hero" aria-label="Bitcrane">'
    '<img class="wm-logo" src="img/icon-180.png" alt="" width="180" height="180">'
    '<span class="wm-word" id="wm-word" aria-hidden="true">'
    + ''.join(f'<span class="wm-l{" thin" if i > 1 else ""}"><span class="g">{c}</span></span>' for i, c in enumerate('itcrane'))
    + '</span></h1>\n'
    '        <p class="wm-tag reveal" style="--i:0"><span class="de">Speichern. <em>Schon ist es auf dem Server.</em></span>'
    '<span class="en">Save. <em>It’s already on the server.</em></span></p>\n'
)

# Runs right after the head is parsed, before it is painted: hide what will animate in.
EARLY = """
<script>
(function () {
  var root = document.documentElement, still = false;
  try { still = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* old browser */ }
  if (!still) root.classList.add('intro');
})();
</script>
"""

# The bits: every letter shows random 0/1 until its turn, then settles; the rest follows.
INTRO = r"""
  /* Variant B intro: the logo appears, then each letter rises out of the baseline like an
     upload, flickering as bits (0/1) on the way up and settling as the letter at the top;
     after that the rest of the head fades in. */
  (function () {
    var word = document.getElementById('wm-word');
    if (!word) return;
    var letters = [].slice.call(word.querySelectorAll('.wm-l'));
    /* Keep every letter as wide as its final glyph, so the word does not jump while bits change. */
    letters.forEach(function (l) { var g = l.firstChild; l.dataset.ch = g.textContent; l.style.width = l.getBoundingClientRect().width + 'px'; });
    if (!root.classList.contains('intro')) return;
    /* A digit is wider than i or t: squeeze the bits in narrow letters so they never overlap. */
    letters.forEach(function (l) {
      var probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
      probe.className = l.className;
      probe.textContent = '0';
      word.appendChild(probe);
      var dw = probe.getBoundingClientRect().width, w = parseFloat(l.style.width);
      probe.remove();
      l.dataset.sx = dw > w ? (w / dw).toFixed(3) : '1';
      l.classList.add('bits');
      l.firstChild.style.transform = 'translateY(110%)';
    });
    function setBit(l) { l.firstChild.innerHTML = '<i class="b" style="transform:scaleX(' + l.dataset.sx + ')">' + (Math.random() < .5 ? '0' : '1') + '</i>'; }
    letters.forEach(setBit);
    requestAnimationFrame(function () { root.classList.add('intro-run'); });
    var RISE = 520, start = performance.now(), last = 0;
    function ease(p) { return 1 - Math.pow(1 - p, 3); }
    function tick(now) {
      var t = now - start, done = 0, flick = now - last > 50;
      letters.forEach(function (l, i) {
        var from = 220 + i * 80, p = Math.max(0, Math.min(1, (t - from) / RISE)), g = l.firstChild;
        if (p >= 1) {
          if (l.classList.contains('bits')) { l.classList.remove('bits'); g.textContent = l.dataset.ch; g.style.transform = ''; }
          done++;
          return;
        }
        g.style.transform = 'translateY(' + (110 * (1 - ease(p))).toFixed(1) + '%)';
        if (flick) setBit(l);
      });
      if (flick) last = now;
      if (done < letters.length) { requestAnimationFrame(tick); return; }
      root.classList.add('intro-rest');
      setTimeout(function () { root.classList.remove('intro', 'intro-run', 'intro-rest'); }, 1400);
    }
    requestAnimationFrame(tick);
  })();
"""


def make(page: str) -> str:
    """Returns variant B of the given start page (index.html as written in website/)."""
    assert HEAD_OLD in page, 'hero headline not found'
    page = page.replace(HEAD_OLD, HEAD_NEW, 1)
    page = page.replace('</style>', CSS + '</style>\n' + EARLY, 1)
    # Everything below the wordmark fades in after it, one after another.
    for i, cls in enumerate(['<p class="lede"', '<div class="cta"', '<p class="meta"', '<a class="gh-link"', '<div class="switch-row"', '<figure class="shot hero-shot'], start=1):
        assert cls in page, cls
        tag, rest = cls.split(' class="', 1)
        page = page.replace(cls, f'{tag} style="--i:{i}" class="reveal {rest}', 1)
    assert '  setLang(lang);\n' in page
    page = page.replace('  setLang(lang);\n', '  setLang(lang);\n' + INTRO, 1)
    return page
