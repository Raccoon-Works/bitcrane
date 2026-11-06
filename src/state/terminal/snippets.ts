/**
 * Snippets: sending one into a session (with Tabby's escapes for control
 * characters and pauses) and taking over Tabby's Quick Commands.
 */
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { getState, LIVE, setState, uid } from '../store';
import { live } from './instances';
import type { Snippet } from './types';

/**
 * Splits a snippet into what is typed and pauses. Understands the escapes of
 * Tabby's Quick Commands: \\xHH for a control character (\\x03 is Ctrl+C) and
 * \\s<ms> for a pause; several lines are sent one after another.
 */
function snippetParts(command: string): Array<string | number> {
  const parts: Array<string | number> = [];
  let text = '';
  const re = /\\x([0-9a-f]{2})|\\s(\d+)/gi;
  let last = 0;
  for (let m = re.exec(command); m; m = re.exec(command)) {
    text += command.slice(last, m.index);
    if (m[1]) text += String.fromCharCode(parseInt(m[1], 16));
    else {
      if (text) parts.push(text);
      text = '';
      parts.push(Math.min(60000, Number(m[2])));
    }
    last = m.index + m[0].length;
  }
  text += command.slice(last);
  if (text) parts.push(text.replace(/\r?\n/g, '\r'));
  return parts;
}

export async function sendSnippet(id: string, snippet: Snippet) {
  const l = live.get(id);
  if (!l) return;
  l.term.focus();
  const parts = snippetParts(snippet.command);
  if (snippet.run) parts.push('\r');
  for (const p of parts) {
    if (typeof p === 'number') {
      await new Promise((r) => setTimeout(r, p));
      continue;
    }
    if (LIVE) await backend.termWrite(id, p).catch(() => undefined);
    else l.term.write(p === '\r' ? '\r\n$ ' : p);
  }
}

/**
 * Takes over the commands of Tabby's Quick Commands plugin (config.yaml,
 * `qc.cmds` and `qc.groups`) as snippets with their groups. Commands already
 * here (same name and command) are skipped. Returns how many were added, or
 * null when Tabby or its quick commands were not found.
 */
export async function importTabbySnippets(): Promise<number | null> {
  const text = LIVE ? await backend.tabbyConfig().catch(() => null) : PREVIEW_TABBY;
  if (!text) return null;
  const { load } = await import('js-yaml');
  let qc:
    | {
        cmds?: Array<{ name?: string; text?: string; appendCR?: boolean; group?: string; hidden?: boolean }>;
        groups?: Array<{ name?: string; hidden?: boolean }>;
      }
    | undefined;
  try {
    qc = (load(text) as { qc?: typeof qc } | null)?.qc;
  } catch {
    return null;
  }
  if (!qc?.cmds?.length) return null;
  const s = getState().settings;
  const have = s.snippets ?? [];
  const hiddenGroups = new Set((qc.groups ?? []).filter((g) => g.hidden && g.name).map((g) => g.name));
  const added: Snippet[] = [];
  for (const c of qc.cmds) {
    if (!c.text) continue;
    const name = c.name ?? '';
    if (
      have.some((x) => x.name === name && x.command === c.text) ||
      added.some((x) => x.name === name && x.command === c.text)
    )
      continue;
    added.push({
      id: uid('sn'),
      name,
      command: c.text,
      run: !!c.appendCR,
      group: c.group || undefined,
      hidden: !!c.hidden || (!!c.group && hiddenGroups.has(c.group)) || undefined,
    });
  }
  const groups = [...(s.snippetGroups ?? [])];
  for (const g of [...(qc.groups ?? []).map((x) => x.name), ...added.map((x) => x.group)])
    if (g && !groups.includes(g)) groups.push(g);
  setState((st) => ({ settings: { ...st.settings, snippets: [...have, ...added], snippetGroups: groups } }));
  return added.length;
}

/** Sample for the prototype (no Tabby there). */
const PREVIEW_TABBY = `qc:
  groups:
    - name: Webshop
  cmds:
    - name: App neu starten
      text: cd ~/apps/webshop && pm2 restart webshop
      appendCR: true
      group: Webshop
    - name: Zustand ansehen
      text: pm2 status
      appendCR: true
      group: Webshop
    - name: Letzte Log-Zeilen der App
      text: pm2 logs webshop --lines 40
      appendCR: true
      group: Webshop
`;
