// Records the website clip "The terminal sits right below your files": the panel opens on the
// server, a command is typed and answers. Same frame capture as rec-save.cjs.
const { chromium } = require('playwright');
const fs = require('fs');
const [plat, th, lang] = process.argv.slice(2);
const OUT = `/tmp/bc/clip/raw-term-${plat}-${th}-${lang}`;
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const b = await chromium.launch({ args: ['--force-device-scale-factor=2'] });
  const ctx = await b.newContext({ viewport: { width: 1040, height: 640 }, deviceScaleFactor: 2, locale: lang === 'de' ? 'de-DE' : 'en-US' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto(`http://localhost:5179/?demo&clip&platform=${plat}&theme=${th}&lang=${lang}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  await p.addStyleTag({ content: `.window { box-shadow: none !important; } html, body { background: ${th === 'dark' ? '#000' : '#fff'} !important; }` });
  // Focus on the server half, as when you have just looked at its files.
  await p.locator('section[data-side="remote"] .row[data-name="app.py"]').first().click();
  await p.mouse.move(1035, 635);
  await p.waitForTimeout(500);
  const box = await p.locator('.window').first().boundingBox();
  fs.writeFileSync(OUT + '/box.json', JSON.stringify(box));
  await p.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;z-index:99999'; document.body.appendChild(d); let k = 0; (function f() { d.style.background = (k++ % 2) ? '#010101' : '#020202'; requestAnimationFrame(f); })(); });
  const cdp = await ctx.newCDPSession(p);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => { frames.push({ t: f.metadata.timestamp, data: f.data }); try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch (e) {} });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1 });
  const t0 = Date.now();
  await p.waitForTimeout(1000);
  await p.evaluate(async () => { const t = await import('/src/state/terminal.ts'); t.toggleTerminal('server'); });
  await p.waitForTimeout(900);
  await p.keyboard.type('pm2 restart webshop', { delay: 70 });
  await p.waitForTimeout(350);
  await p.keyboard.press('Escape');
  await p.keyboard.press('Enter');
  const end = await p.evaluate(() => Date.now() / 1000 + 2.4);
  await p.waitForTimeout(3600);
  await cdp.send('Page.stopScreencast');
  const dur = (Date.now() - t0) / 1000;
  frames.forEach((f, i) => fs.writeFileSync(`${OUT}/f${String(i).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64')));
  fs.writeFileSync(OUT + '/times.json', JSON.stringify({ times: frames.map((f) => f.t), dur, end }));
  console.log(plat, th, lang, frames.length, 'frames', dur.toFixed(1), 's');
  await b.close();
})();
