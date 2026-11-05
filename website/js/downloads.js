/*
 * Downloads: fixed file names of the latest GitHub release, so the page itself never contacts
 * GitHub. The visitor's own system gets the main button and the highlighted card.
 */
import { REPO, ownPlatform } from './core.js';

const FILES = { mac: 'Bitcrane-macOS.dmg', win: 'Bitcrane-Windows-Setup.exe' };
const BASE = `https://github.com/${REPO}/releases/latest/download/`;

export function initDownloads() {
  document.getElementById('link-mac').href = BASE + FILES.mac;
  document.getElementById('link-win').href = BASE + FILES.win;
  /* On a phone or an unknown system the main button leads to the two cards instead. */
  if (ownPlatform) {
    const name = ownPlatform === 'win' ? 'Windows' : 'macOS';
    const label = document.getElementById('cta-label');
    document.getElementById('cta-main').href = BASE + FILES[ownPlatform];
    label.querySelector('.de').textContent = `Für ${name} laden`;
    label.querySelector('.en').textContent = `Download for ${name}`;
  }
  document.getElementById('dl-mac').classList.toggle('current', ownPlatform === 'mac');
  document.getElementById('dl-win').classList.toggle('current', ownPlatform === 'win');

  /* Copy button for the macOS first-start command; if the clipboard is refused, the command
     is selected so it can be copied by hand. */
  const button = document.getElementById('copy-xattr');
  const command = document.getElementById('xattr');
  button.addEventListener('click', () => {
    const copied = () => {
      button.querySelector('.de').textContent = 'Kopiert';
      button.querySelector('.en').textContent = 'Copied';
    };
    const select = () => {
      const range = document.createRange();
      range.selectNodeContents(command);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(command.textContent).then(copied, select); else select();
  });
}
