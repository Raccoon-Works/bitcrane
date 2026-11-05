// Feature shots for the website: only the dialog or panel that matters, on a transparent
// background, so no part of the window behind shows at the edges.
const { chromium } = require('playwright');
const OUT = '/tmp/bc/site-cut';
require('fs').mkdirSync(OUT, { recursive: true });
const ev = (p, code) => p.evaluate(`(async () => { const m = await import('/src/state/store.ts'); ${code}; })()`);
const V = [
  ['main', '.window', async (p) => { await p.locator('section[data-side="local"] .row[data-name="app.py"]').first().click(); await p.waitForTimeout(300); }],
  ['import', '.dialog', async (p) => { await p.evaluate(async () => { const m = await import('/src/state/store.ts'); m.showFirstRun(); }); await p.waitForTimeout(900); }],
  ['editor', '.code-editor', async (p) => { await ev(p, `m.openInEditor('local','app.py')`); await p.waitForTimeout(800); }],
  ['compare', '.dialog', async (p) => { await ev(p, `m.openDialog({ type: 'compare' })`); await p.waitForTimeout(700); }],
];
(async () => {
  const b = await chromium.launch();
  for (const lang of ['de', 'en']) {
    const ctx = await b.newContext({ locale: lang === 'de' ? 'de-DE' : 'en-US', viewport: { width: 1300, height: 800 }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.setDefaultTimeout(5000);
    for (const [id, sel, fn] of V) {
      if (process.argv[2] && !process.argv[2].split(',').includes(id)) continue;
      for (const plat of ['mac', 'win']) for (const th of ['light', 'dark']) {
        try {
          await p.setViewportSize(id === 'terminal' ? { width: 1100, height: 800 } : { width: 1300, height: 800 });
          await p.goto(`http://localhost:5179/?demo&platform=${plat}&theme=${th}&lang=${lang}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await p.waitForTimeout(1300);
          await fn(p);
          await p.waitForTimeout(400);
          await p.mouse.move(1295, 795);
          await p.addStyleTag({ content: `
            html, body, #root, .page, .stage-wrap, .stage, .window-area, .scrim { background: transparent !important; backdrop-filter: none !important; }
            * { visibility: hidden !important; }
            ${sel}, ${sel} * { visibility: visible !important; }
            ${sel} [style*="visibility: hidden"] { visibility: hidden !important; }
            ${sel} { box-shadow: none !important; }
            .code-editor { height: 395px !important; flex: none !important; }` });
          await p.waitForTimeout(150);
          await p.locator(sel).first().screenshot({ path: `${OUT}/${id}-${plat}-${th}-${lang}.png`, omitBackground: true });
        } catch (e) { console.log('FAIL', id, plat, th, lang, e.message.split('\n')[0]); }
      }
      console.log('ok', id, lang);
    }
    await ctx.close();
  }
  await b.close();
})();
