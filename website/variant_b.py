"""Variant B of the start page: a large "Bitcrane" wordmark as the head of the page.

The logo stands for the B; the remaining letters resolve out of bits (0 and 1) each time
the page opens, then the rest of the head fades in. Built from index.html by build.py, so
both variants share everything else and can be compared side by side
(index.html and index-b.html).
"""

CSS = """
/* Variant B: wordmark head */
.hero h1.wm-hero {
  display: inline-flex; align-items: flex-end; gap: .02em; margin: 6px 0 0;
  font: 800 clamp(60px, 11vw, 148px)/.9 var(--font-display); letter-spacing: -0.045em; color: var(--ink);
}
.wm-hero .wm-logo { height: 1.04em; width: auto; margin: 0 -.13em -.07em -.06em; display: block; }
.wm-hero .wm-word { display: inline-flex; white-space: nowrap; }
.wm-hero .wm-l { display: inline-block; text-align: center; }
.wm-hero .wm-l.thin { font-weight: 300; letter-spacing: -0.02em; }
.wm-hero .wm-l.bits { color: var(--accent); display: inline-flex; justify-content: center; }
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
    '<span class="wm-l">i</span><span class="wm-l">t</span>'
    '<span class="wm-l thin">c</span><span class="wm-l thin">r</span><span class="wm-l thin">a</span>'
    '<span class="wm-l thin">n</span><span class="wm-l thin">e</span></span></h1>\n'
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
  /* Variant B intro: the logo appears, the letters resolve out of bits, then the rest fades in. */
  (function () {
    var word = document.getElementById('wm-word');
    if (!word) return;
    var letters = [].slice.call(word.querySelectorAll('.wm-l'));
    /* Keep every letter as wide as its final glyph, so the word does not jump while bits change. */
    letters.forEach(function (l) { l.dataset.ch = l.textContent; l.style.width = l.getBoundingClientRect().width + 'px'; });
    if (!root.classList.contains('intro')) return;
    /* A digit is wider than i or t: squeeze the bits in narrow letters so they never overlap. */
    function setBit(l) { l.innerHTML = '<i class="b" style="transform:scaleX(' + l.dataset.sx + ')">' + (Math.random() < .5 ? '0' : '1') + '</i>'; }
    letters.forEach(function (l) {
      var probe = l.cloneNode(false);
      probe.style.cssText = 'position:absolute;visibility:hidden;width:auto';
      probe.textContent = '0';
      l.parentNode.appendChild(probe);
      var dw = probe.getBoundingClientRect().width, w = parseFloat(l.style.width);
      probe.remove();
      l.dataset.sx = dw > w ? (w / dw).toFixed(3) : '1';
      setBit(l); l.classList.add('bits');
    });
    requestAnimationFrame(function () { root.classList.add('intro-run'); });
    var start = performance.now(), last = 0;
    function tick(now) {
      var t = now - start, done = 0;
      letters.forEach(function (l, i) {
        var settle = 260 + i * 85;
        if (t >= settle) { if (l.classList.contains('bits')) { l.textContent = l.dataset.ch; l.classList.remove('bits'); } done++; }
        else if (now - last > 45) { setBit(l); }
      });
      if (now - last > 45) last = now;
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
