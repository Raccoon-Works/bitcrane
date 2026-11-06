/**
 * The made-up terminal of the browser prototype and the website demo: a prompt
 * that echoes typing and answers a few everyday commands, without a backend.
 */
import type { Terminal } from '@xterm/xterm';
import type { Server } from '../../backend/types';
import { $t } from '../../i18n';
import { DEMO_CLIP } from '../../util/demo';
import type { TermSession } from './types';

/** Preview only: the prompt and the line being typed of each made-up session. */
const previewLine = new WeakMap<Terminal, { prompt: string; server: boolean; line: string }>();

const PM2_TABLE = (restarts: number) => [
  '┌────┬──────────┬────────┬────┬──────────┬──────────┐',
  '│ id │ name     │ mode   │ ↺  │ status   │ memory   │',
  '├────┼──────────┼────────┼────┼──────────┼──────────┤',
  `│ 0  │ webshop  │ fork   │ ${String(restarts).padEnd(2)} │ \x1b[32monline\x1b[0m   │ 84.2mb   │`,
  '│ 1  │ blog     │ fork   │ 3  │ \x1b[32monline\x1b[0m   │ 41.7mb   │',
  '└────┴──────────┴────────┴────┴──────────┴──────────┘',
];
let previewRestarts = 12;

/** Preview only: made-up answers to a few everyday commands, so the demo terminal feels real. */
function previewAnswer(cmd: string, server: boolean): string[] {
  const c = cmd.trim().replace(/\s+/g, ' ');
  if (!c) return [];
  if (server) {
    if (/^pm2 (status|ls|list)$/.test(c)) return PM2_TABLE(previewRestarts);
    const restart = /^pm2 restart (\S+)$/.exec(c);
    if (restart) {
      if (restart[1] === 'webshop') previewRestarts++;
      return [
        `[PM2] Applying action restartProcessId on app [${restart[1]}](ids: [ 0 ])`,
        `[PM2] [${restart[1]}](0) \x1b[32m✓\x1b[0m`,
        ...PM2_TABLE(previewRestarts),
      ];
    }
    if (/^(pm2 logs|tail)\b/.test(c))
      return [
        '\x1b[2m[23:41:07]\x1b[0m GET /cart 200 12ms',
        '\x1b[2m[23:41:09]\x1b[0m POST /cart/items 200 31ms',
        '\x1b[2m[23:41:12]\x1b[0m GET /products/mug-blue 200 8ms',
      ];
    if (/^ls\b/.test(c))
      return ['\x1b[34madmin\x1b[0m  app.py  config.py  data.db  \x1b[34mlogs\x1b[0m  \x1b[34mroutes\x1b[0m'];
    if (/^git pull\b/.test(c)) return ['Already up to date.'];
    if (c === 'clear') return ['\x1b[2J\x1b[H'];
    return [`bash: ${c.split(' ')[0]}: command not found`];
  }
  if (/^ls\b/.test(c)) return ['\x1b[34mProjekte\x1b[0m  \x1b[34mDownloads\x1b[0m  \x1b[34mSchreibtisch\x1b[0m'];
  if (c === 'clear') return ['\x1b[2J\x1b[H'];
  return [`zsh: command not found: ${c.split(' ')[0]}`];
}

/** A minimal echo of the typed input, so typing and suggestions can be tried. */
export function previewEcho(term: Terminal, d: string) {
  const st = previewLine.get(term) ?? { prompt: '$ ', server: false, line: '' };
  previewLine.set(term, st);
  for (const ch of d.startsWith('\x1b') ? '' : d) {
    if (ch === '\r') {
      term.write('\r\n');
      for (const out of previewAnswer(st.line, st.server)) term.write(out === '\x1b[2J\x1b[H' ? out : out + '\r\n');
      st.line = '';
      term.write(st.prompt);
    } else if (ch === '\x7f') {
      if (st.line) {
        st.line = st.line.slice(0, -1);
        term.write('\b \b');
      }
    } else if (ch >= ' ') {
      st.line += ch;
      term.write(ch);
    }
  }
}

/** Starts a made-up session that shows what the panel is for. */
export function startPreviewSession(
  term: Terminal,
  session: TermSession,
  srv: Server | undefined,
  folder: string | undefined,
) {
  const prompt = session.serverId
    ? `\x1b[32m${srv?.user || 'deploy'}@${(srv?.host || 'server').split('.')[0]}\x1b[0m:\x1b[34m${(folder || '~').replace(/^\/home\/[^/]+/, '~')}\x1b[0m$ `
    : `\x1b[32malex@MacBook\x1b[0m \x1b[34m${folder || '~'}\x1b[0m % `;
  if (session.serverId) {
    // A website clip starts on an empty prompt; otherwise a short history shows what the panel is for.
    if (!DEMO_CLIP) {
      term.writeln(`${prompt}pm2 status`);
      for (const out of previewAnswer('pm2 status', true)) term.writeln(out);
      term.writeln(`${prompt}tail -n 3 logs/app.log`);
      for (const out of previewAnswer('tail -n 3 logs/app.log', true)) term.writeln(out);
    }
  } else {
    term.writeln(`\x1b[2m${$t('Bitcrane – Terminal (Vorschau)')}\x1b[0m`);
  }
  term.write(prompt);
  previewLine.set(term, { prompt, server: !!session.serverId, line: '' });
}
