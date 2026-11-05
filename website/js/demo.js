/*
 * Demo band: the browser demo opens in its own window (demo.html, with its own switches),
 * on request also right here in the page. Both follow the page's platform, design and language.
 */
import { state, pageTheme, scrollBehavior, onRefresh } from './core.js';
import { imgSrc } from './shots.js';

const query = () => `platform=${state.platform}&theme=${pageTheme()}&lang=${state.lang}`;

export function initDemo() {
  const poster = document.getElementById('demo-poster');
  const box = document.getElementById('demo-box');
  let frame = null;

  onRefresh(() => {
    poster.src = imgSrc('main', pageTheme());
    document.querySelectorAll('a[href^="demo.html"]').forEach((a) => { a.href = `demo.html?${query()}`; });
    /* The embedded demo switches platform and design live; a new language needs a reload. */
    if (frame) frame.contentWindow.postMessage({ bitcraneDemo: true, platform: state.platform, theme: pageTheme() }, '*');
  });

  document.getElementById('demo-start').addEventListener('click', () => {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.title = 'Bitcrane Demo';
      frame.src = `demo/index.html?demo&${query()}`;
      box.appendChild(frame);
    }
    box.hidden = false;
    box.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  });
}
