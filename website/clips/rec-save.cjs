// Records the website clip "Save, and it is on the server": type a change in the built-in
// editor, save, the folder watch uploads the file and restarts the app on the server.
// Frames come from the DevTools screencast with their timestamps, cropped to the window later.
const { chromium } = require('playwright');
const fs = require('fs');
const [plat, th, lang] = process.argv.slice(2);
const OUT = `/tmp/bc/clip/raw-save-${plat}-${th}-${lang}`;
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const b = await chromium.launch({ args: ['--force-device-scale-factor=2'] });
  const ctx = await b.newContext({ viewport: { width: 1040, height: 640 }, deviceScaleFactor: 2, locale: lang === 'de' ? 'de-DE' : 'en-US' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto(`http://localhost:5179/?demo&clip&platform=${plat}&theme=${th}&lang=${lang}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);
  await p.evaluate(async () => {
    const m = await import('/src/state/store.ts');
    // Upload one second after saving, as a short delay of the watch.
    m.setState((s) => ({ watches: s.watches.map((w) => (w.id === 'w1' ? { ...w, options: { ...w.options, delay: 1 } } : w)) }));
    m.openInEditor('local', 'app.py');
  });
  await p.waitForTimeout(1200);
  await p.addStyleTag({ content: `.window { box-shadow: none !important; } html, body { background: ${th === 'dark' ? '#000' : '#fff'} !important; }` });
  // Caret behind "ok=True" in the last line.
  const line = p.locator('.cm-line', { hasText: 'return jsonify(ok=True)' }).first();
  await line.click();
  await p.keyboard.press('End'); await p.keyboard.press('ArrowLeft');
  await p.mouse.move(1035, 635);
  await p.waitForTimeout(400);
  const box = await p.locator('.window').first().boundingBox();
  fs.writeFileSync(OUT + '/box.json', JSON.stringify(box));

  // A 1-pixel ticker in the page corner (outside the cropped window) changes every frame,
  // so the screencast delivers frames continuously and the timing stays exact.
  await p.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;z-index:99999'; document.body.appendChild(d); let k = 0; (function f() { d.style.background = (k++ % 2) ? '#010101' : '#020202'; requestAnimationFrame(f); })(); });
  const cdp = await ctx.newCDPSession(p);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push({ t: f.metadata.timestamp, data: f.data });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch (e) {}
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1 });
  const t0 = Date.now();
  await p.waitForTimeout(900);
  await p.keyboard.type(', count=Cart.current().count()', { delay: 55 });
  await p.waitForTimeout(500);
  await p.locator('.code-editor button', { hasText: lang === 'de' ? 'Sichern' : 'Save' }).first().click();
  await p.mouse.move(1035, 635);
  const since = await p.evaluate(async () => { const m = await import('/src/state/store.ts'); m.simulateLocalChange('w1', 'app.py'); return Date.now(); });
  // Watch delay, upload, command, then a calm moment on "Alles übertragen".
  let doneAt = 0;
  for (let k = 0; k < 150 && !doneAt; k++) {
    doneAt = await p.evaluate(async (since) => { const m = await import('/src/state/store.ts'); const c = m.getState().transfers.find((c) => c.direction === 'command' && c.state === 'done' && c.finishedAt > since); return c ? c.finishedAt : 0; }, since);
    if (!doneAt) await p.waitForTimeout(100);
  }
  // Calm moment on the result, plus time for the last frames to arrive.
  await p.waitForTimeout(3200);
  await cdp.send('Page.stopScreencast');
  const dur = (Date.now() - t0) / 1000;
  frames.forEach((f, i) => fs.writeFileSync(`${OUT}/f${String(i).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64')));
  fs.writeFileSync(OUT + '/times.json', JSON.stringify({ times: frames.map((f) => f.t), dur, end: doneAt / 1000 + 1.8 }));
  console.log(plat, th, lang, frames.length, 'frames', dur.toFixed(1), 's');
  await b.close();
})();
