/**
 * Built-in code editor: the open documents and what happens with them.
 *
 * The editor takes the place of the two file halves (sidebar, toolbar and
 * activity stay), so there is room to work; "Dateien" brings the halves back
 * and the documents stay open. Files of this computer and of servers open
 * alike; saving writes straight back (in place, so a server file keeps its
 * permissions). Before saving, the file's time is compared with the time it
 * was read, so a change by someone else is not overwritten unasked.
 *
 * The CodeMirror state of each document (text, undo history, selection) lives
 * in the component (CodeEditor.tsx); this module keeps the list, the names
 * and whether a document has unsaved changes.
 */
import { invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import { $t } from '../i18n';
import * as paths from '../util/paths';
import { addLog } from './log';
import { LIVE, getState, serverById, setState, showToast, updateSettings } from './store';
import { isConnected } from './live';

export interface EditorDoc {
  id: string;
  /** Server of the file; '' for a file of this computer, null for a new, unsaved document. */
  serverId: string | null;
  path: string;
  name: string;
  /** Text as read (CodeMirror takes it over when the document is first shown). */
  initial: string;
  mtime: number;
  eol: '\n' | '\r\n';
  bom: boolean;
  dirty: boolean;
  loading: boolean;
  error?: string;
  /** Set when the file changed elsewhere since it was read (asked before overwriting). */
  conflict?: boolean;
}

interface EditorState {
  open: boolean;
  docs: EditorDoc[];
  active: string | null;
  /** Document whose closing waits for "Sichern / Verwerfen". */
  confirmClose: string | null;
}

let st: EditorState = { open: false, docs: [], active: null, confirmClose: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<EditorState>) => {
  st = { ...st, ...patch };
  listeners.forEach((l) => l());
};
const patchDoc = (id: string, patch: Partial<EditorDoc>) => set({ docs: st.docs.map((d) => (d.id === id ? { ...d, ...patch } : d)) });

export function useEditor(): EditorState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => st);
}
export const editorState = () => st;

/** Text getters of the documents, registered by the component (the live CodeMirror text). */
const textOf = new Map<string, () => string>();
export function registerText(id: string, get: (() => string) | null) {
  if (get) textOf.set(id, get);
  else textOf.delete(id);
}

let counter = 0;
const newId = () => `doc-${Date.now().toString(36)}-${++counter}`;

/** Shows the editor (over the file halves); with no document a new, empty one is made. */
export function showEditor() {
  if (!st.docs.length && !restoreDocs()) newDocument();
  set({ open: true });
}

/**
 * The documents that were open last time come back when the editor is first
 * shown: files of this computer always, server files when that server is
 * connected. Returns true when something was opened.
 */
let restored = false;
function restoreDocs(): boolean {
  if (restored) return false;
  restored = true;
  const list = getState().settings.editorDocs ?? [];
  const ok = list.filter((d) => !d.serverId || (LIVE ? isConnected(d.serverId) : true));
  for (const d of ok) void openFile(d.serverId, d.path);
  return ok.length > 0;
}

// Remembers the open files (not new, unsaved documents) for the next start.
let lastSaved = '';
listeners.add(() => {
  const list = st.docs.filter((d) => d.serverId !== null && !d.error).map((d) => ({ serverId: d.serverId as string, path: d.path }));
  const key = JSON.stringify(list);
  if (key === lastSaved || (!restored && !list.length)) return;
  lastSaved = key;
  restored = true;
  updateSettings({ editorDocs: list });
});

/** Back to the file halves; the documents stay open. */
export function hideEditor() {
  set({ open: false });
}

export function toggleEditor() {
  if (st.open) hideEditor();
  else showEditor();
}

/** A new, empty document ("Unbenannt"), saved later with "Sichern unter". */
export function newDocument() {
  const n = st.docs.filter((d) => d.serverId === null).length + 1;
  const doc: EditorDoc = { id: newId(), serverId: null, path: '', name: n === 1 ? $t('Unbenannt') : `${$t('Unbenannt')} ${n}`, initial: '', mtime: 0, eol: '\n', bom: false, dirty: false, loading: false };
  set({ docs: [...st.docs, doc], active: doc.id, open: true });
}

/** Opens a file in the editor (or switches to it when it is open already). */
export async function openFile(serverId: string, path: string) {
  // The files of last time come along (like most editors), the new one comes on top.
  if (!restored) restoreDocs();
  const known = st.docs.find((d) => d.serverId === serverId && d.path === path);
  if (known) {
    set({ active: known.id, open: true });
    return;
  }
  const doc: EditorDoc = { id: newId(), serverId, path, name: paths.basename(path) || path, initial: '', mtime: 0, eol: '\n', bom: false, dirty: false, loading: true };
  // A single empty, untouched new document is replaced by the file (like most editors).
  const keep = st.docs.filter((d) => !(d.serverId === null && !d.dirty && !(textOf.get(d.id)?.() ?? d.initial)));
  set({ docs: [...keep, doc], active: doc.id, open: true });
  if (!LIVE) {
    patchDoc(doc.id, { loading: false, initial: sampleText(doc.name) });
    return;
  }
  try {
    const f = await invoke<{ text: string; mtime: number; eol: string; bom: boolean }>('editor_read', { serverId: serverId || null, path });
    patchDoc(doc.id, { loading: false, initial: f.text, mtime: f.mtime, eol: f.eol === '\r\n' ? '\r\n' : '\n', bom: f.bom });
    if (serverId) addLog('info', $t('Im Editor geöffnet: {0}', path), serverId);
  } catch (e) {
    patchDoc(doc.id, { loading: false, error: (e as { message?: string }).message ?? String(e) });
  }
}

export function setActive(id: string) {
  set({ active: id });
}

export function markDirty(id: string, dirty: boolean) {
  const d = st.docs.find((x) => x.id === id);
  if (d && d.dirty !== dirty) patchDoc(id, { dirty });
}

export function setEol(id: string, eol: '\n' | '\r\n') {
  patchDoc(id, { eol, dirty: true });
}

/** Where a document lives, for the status bar and tooltips. */
export function docPlace(d: EditorDoc): string {
  if (d.serverId === null) return $t('Neu, noch nicht gesichert');
  if (!d.serverId) return d.path;
  const s = serverById(d.serverId);
  return `${s?.name ?? $t('Server')}: ${d.path}`;
}

/** Saves a document; `force` overwrites a file that changed elsewhere. */
export async function saveDoc(id: string, force = false): Promise<boolean> {
  const d = st.docs.find((x) => x.id === id);
  const get = textOf.get(id);
  if (!d || !get) return false;
  if (d.serverId === null) return saveAs(id);
  if (!LIVE) {
    patchDoc(id, { dirty: false, conflict: false });
    showToast($t('„{0}“ gesichert.', d.name), 'ok');
    return true;
  }
  const serverId = d.serverId || null;
  try {
    if (!force && d.mtime) {
      const now = await invoke<number>('editor_mtime', { serverId, path: d.path }).catch(() => d.mtime);
      // Seconds are enough: FTP servers report whole seconds or minutes.
      if (Math.abs(now - d.mtime) > 1500) {
        patchDoc(id, { conflict: true });
        return false;
      }
    }
    const mtime = await invoke<number>('editor_write', { serverId, path: d.path, text: get(), eol: d.eol, bom: d.bom });
    patchDoc(id, { dirty: false, conflict: false, mtime });
    if (serverId) addLog('ok', $t('Gesichert und hochgeladen: {0}', d.path), serverId);
    showToast(serverId ? $t('„{0}“ gesichert und auf den Server geladen.', d.name) : $t('„{0}“ gesichert.', d.name), 'ok');
    // The file lists show the new size and time.
    setState((s) => ({ fsRev: s.fsRev + 1 }));
    return true;
  } catch (e) {
    showToast((e as { message?: string }).message ?? String(e), 'error');
    return false;
  }
}

/** "Sichern unter": a file of this computer, chosen in the system dialog. */
export async function saveAs(id: string): Promise<boolean> {
  const d = st.docs.find((x) => x.id === id);
  const get = textOf.get(id);
  if (!d || !get) return false;
  if (!LIVE) {
    patchDoc(id, { serverId: '', path: `~/${d.name}.txt`, name: `${d.name}.txt`, dirty: false });
    showToast($t('„{0}“ gesichert.', `${d.name}.txt`), 'ok');
    return true;
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const picked = await save({ title: $t('Sichern unter'), defaultPath: d.serverId === null ? d.name : d.name }).catch(() => null);
  if (!picked) return false;
  const path = await invoke<string>('path_to_ui', { path: picked });
  try {
    const mtime = await invoke<number>('editor_write', { serverId: null, path, text: get(), eol: d.eol, bom: d.bom });
    patchDoc(id, { serverId: '', path, name: paths.basename(path) || path, dirty: false, conflict: false, mtime });
    showToast($t('„{0}“ gesichert.', paths.basename(path)), 'ok');
    setState((s) => ({ fsRev: s.fsRev + 1 }));
    return true;
  } catch (e) {
    showToast((e as { message?: string }).message ?? String(e), 'error');
    return false;
  }
}

/** Reads a document again from its file (after a change elsewhere), dropping the edits. */
export async function reloadDoc(id: string) {
  const d = st.docs.find((x) => x.id === id);
  if (!d || d.serverId === null) return;
  const serverId = d.serverId;
  const path = d.path;
  closeNow(id);
  await openFile(serverId, path);
}

/** Closes a document; with unsaved changes it asks first (inside the editor). */
export function closeDoc(id: string) {
  const d = st.docs.find((x) => x.id === id);
  if (!d) return;
  if (d.dirty) {
    set({ active: id, confirmClose: id });
    return;
  }
  closeNow(id);
}

export function closeNow(id: string) {
  const i = st.docs.findIndex((x) => x.id === id);
  if (i < 0) return;
  const docs = st.docs.filter((x) => x.id !== id);
  textOf.delete(id);
  const active = st.active === id ? (docs[i] ?? docs[i - 1])?.id ?? null : st.active;
  set({ docs, active, confirmClose: st.confirmClose === id ? null : st.confirmClose, open: docs.length ? st.open : false });
}

export function cancelClose() {
  set({ confirmClose: null });
}

/** Unsaved documents (asked about before quitting). */
export function unsavedDocs(): EditorDoc[] {
  return st.docs.filter((d) => d.dirty);
}

/** Example text for the browser prototype, which reads no real files. */
function sampleText(name: string): string {
  if (/\.py$/i.test(name)) return 'import discord\nfrom discord.ext import commands\n\n\nclass Welcome(commands.Cog):\n    """Greets new members in the welcome channel."""\n\n    def __init__(self, bot: commands.Bot):\n        self.bot = bot\n\n    @commands.Cog.listener()\n    async def on_member_join(self, member: discord.Member):\n        channel = member.guild.system_channel\n        if channel is not None:\n            await channel.send(f"Willkommen, {member.mention}!")\n\n\nasync def setup(bot: commands.Bot):\n    await bot.add_cog(Welcome(bot))\n';
  if (/\.(json)$/i.test(name)) return '{\n  "name": "taskbot",\n  "version": "1.4.2",\n  "prefix": "!",\n  "channels": {\n    "welcome": 1203948576612,\n    "log": 1203948576613\n  }\n}\n';
  if (/\.(md)$/i.test(name)) return '# Taskbot\n\nEin kleiner Discord-Bot.\n\n## Start\n\n```bash\npython bot.py\n```\n';
  if (/^\.env$|\.ini$|\.conf$/i.test(name)) return 'TOKEN=…\nGUILD_ID=1203948576600\nLOG_LEVEL=info\n';
  return `${name}\n`;
}

let warnedAt = 0;
/**
 * Called before Bitcrane quits: with unsaved documents the first attempt shows
 * them and warns; quitting again within 15 seconds goes ahead.
 */
export function editorCanQuit(): boolean {
  const n = unsavedDocs().length;
  if (!n || Date.now() - warnedAt < 15000) return true;
  warnedAt = Date.now();
  set({ open: true, active: unsavedDocs()[0].id });
  showToast(n === 1 ? $t('Ein Dokument im Editor ist noch nicht gesichert. Nochmal beenden verwirft die Änderungen.') : $t('{0} Dokumente im Editor sind noch nicht gesichert. Nochmal beenden verwirft die Änderungen.', n), 'error');
  return false;
}


/**
 * The Mac's menu bar takes ⌘ shortcuts before the page sees them (⌘W closes the
 * tab, ⌘D adds a place …). While the editor has the keyboard, these go to the
 * editor instead. Returns true when the editor took the key.
 */
let menuKeyHandler: ((key: string) => boolean) | null = null;
export function setMenuKeyHandler(h: ((key: string) => boolean) | null) {
  menuKeyHandler = h;
}
// Where the keyboard was last: while a menu of the menu bar is in use, the page has
// no focused element, so the last element that received focus is what counts.
let focusInEditor = false;
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => { focusInEditor = !!(e.target as HTMLElement | null)?.closest?.('.cm-editor'); }, true);
}
export function editorMenuKey(key: string): boolean {
  if (!st.open || !menuKeyHandler) return false;
  if (!focusInEditor && !document.activeElement?.closest('.cm-editor')) return false;
  return menuKeyHandler(key);
}
