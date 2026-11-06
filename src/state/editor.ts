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
import { showError } from './errors';
import { invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import { $t } from '../i18n';
import * as paths from '../util/paths';
import { addLog } from './log';
import { LIVE, getState, serverById, setState, showToast, updateSettings } from './store';
import { isConnected, refreshVisible } from './live';

export interface EditorDoc {
  id: string;
  /** Server of the file; '' for a file of this computer, null for a new, unsaved document. */
  serverId: string | null;
  path: string;
  name: string;
  /** Text as read or last saved: the reference for "unsaved changes". */
  initial: string;
  /** The text as edited, kept while the editor is closed (the editor view keeps it otherwise). */
  text?: string;
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
const patchDoc = (id: string, patch: Partial<EditorDoc>) =>
  set({ docs: st.docs.map((d) => (d.id === id ? { ...d, ...patch } : d)) });

export function useEditor(): EditorState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => st,
  );
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
  const list = st.docs
    .filter((d) => d.serverId !== null && !d.error)
    .map((d) => ({ serverId: d.serverId as string, path: d.path }));
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
  const doc: EditorDoc = {
    id: newId(),
    serverId: null,
    path: '',
    name: n === 1 ? $t('Unbenannt') : `${$t('Unbenannt')} ${n}`,
    initial: '',
    mtime: 0,
    eol: '\n',
    bom: false,
    dirty: false,
    loading: false,
  };
  set({ docs: [...st.docs, doc], active: doc.id, open: true });
}

/** Opens a file in the editor (or switches to it when it is open already). */
export async function openFile(serverId: string, path: string) {
  // The files of last time come along (like most editors), the new one comes on top.
  if (!restored) restoreDocs();
  const known = st.docs.find((d) => d.serverId === serverId && d.path === path);
  if (known) {
    set({ active: known.id, open: true });
    // Without own changes the file is read again if it changed in the meantime (another program, a watch, a download).
    if (LIVE && !known.dirty && known.mtime) {
      const now = await invoke<number>('editor_mtime', { serverId: serverId || null, path }).catch(() => known.mtime);
      if (Math.abs(now - known.mtime) > 1500) await reloadDoc(known.id);
    }
    return;
  }
  const doc: EditorDoc = {
    id: newId(),
    serverId,
    path,
    name: paths.basename(path) || path,
    initial: '',
    mtime: 0,
    eol: '\n',
    bom: false,
    dirty: false,
    loading: true,
  };
  // A single empty, untouched new document is replaced by the file (like most editors).
  const keep = st.docs.filter((d) => !(d.serverId === null && !d.dirty && !(textOf.get(d.id)?.() ?? d.initial)));
  set({ docs: [...keep, doc], active: doc.id, open: true });
  if (!LIVE) {
    patchDoc(doc.id, { loading: false, initial: sampleText(doc.name) });
    return;
  }
  try {
    const f = await invoke<{ text: string; mtime: number; eol: string; bom: boolean }>('editor_read', {
      serverId: serverId || null,
      path,
    });
    patchDoc(doc.id, {
      loading: false,
      initial: f.text,
      mtime: f.mtime,
      eol: f.eol === '\r\n' ? '\r\n' : '\n',
      bom: f.bom,
    });
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
    // Same message as the app, so the preview shows that a server file goes straight back.
    showToast(
      d.serverId ? $t('„{0}“ gesichert und auf den Server geladen.', d.name) : $t('„{0}“ gesichert.', d.name),
      'ok',
    );
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
    const text = get();
    const mtime = await invoke<number>('editor_write', { serverId, path: d.path, text, eol: d.eol, bom: d.bom });
    // The saved text is the new reference; the editor shows it again after being closed and reopened.
    patchDoc(id, { dirty: false, conflict: false, mtime, initial: text, text: undefined });
    if (serverId) addLog('ok', $t('Gesichert und hochgeladen: {0}', d.path), serverId);
    showToast(
      serverId ? $t('„{0}“ gesichert und auf den Server geladen.', d.name) : $t('„{0}“ gesichert.', d.name),
      'ok',
    );
    // The file lists show the new size and time.
    setState((s) => ({ fsRev: s.fsRev + 1 }));
    refreshVisible();
    return true;
  } catch (e) {
    showError(e);
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
  const picked = await save({ title: $t('Sichern unter'), defaultPath: d.serverId === null ? d.name : d.name }).catch(
    () => null,
  );
  if (!picked) return false;
  const path = await invoke<string>('path_to_ui', { path: picked });
  try {
    const text = get();
    const mtime = await invoke<number>('editor_write', { serverId: null, path, text, eol: d.eol, bom: d.bom });
    patchDoc(id, {
      serverId: '',
      path,
      name: paths.basename(path) || path,
      dirty: false,
      conflict: false,
      mtime,
      initial: text,
      text: undefined,
    });
    showToast($t('„{0}“ gesichert.', paths.basename(path)), 'ok');
    setState((s) => ({ fsRev: s.fsRev + 1 }));
    return true;
  } catch (e) {
    showError(e);
    return false;
  }
}

/** Keeps the edited text of documents while the editor view is closed (called when it unmounts). */
export function keepTexts(texts: Map<string, string>) {
  for (const [id, text] of texts) {
    const d = st.docs.find((x) => x.id === id);
    if (d) patchDoc(id, { text: text !== d.initial ? text : undefined });
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
  const active = st.active === id ? ((docs[i] ?? docs[i - 1])?.id ?? null) : st.active;
  set({
    docs,
    active,
    confirmClose: st.confirmClose === id ? null : st.confirmClose,
    open: docs.length ? st.open : false,
  });
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
  if (/\.py$/i.test(name))
    return 'from flask import Blueprint, jsonify, request\n\nfrom .models import Cart, Product\n\ncart = Blueprint("cart", __name__)\n\n\n@cart.post("/cart/items")\ndef add_item():\n    """Adds a product to the cart of the visitor."""\n    data = request.get_json()\n    product = Product.query.get_or_404(data["id"])\n    Cart.current().add(product, qty=data.get("qty", 1))\n    return jsonify(ok=True)\n';
  if (/\.(json)$/i.test(name))
    return '{\n  "name": "webshop",\n  "version": "1.4.2",\n  "currency": "EUR",\n  "shipping": {\n    "free_from": 50,\n    "countries": ["DE", "AT", "CH"]\n  }\n}\n';
  if (/\.(md)$/i.test(name))
    return '# Webshop\n\nEin kleiner Shop mit Flask.\n\n## Start\n\n```bash\nflask --app app run\n```\n';
  if (/^\.env$|\.ini$|\.conf$/i.test(name)) return 'SECRET_KEY=…\nDATABASE_URL=sqlite:///data.db\nLOG_LEVEL=info\n';
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
  showToast(
    n === 1
      ? $t('Ein Dokument im Editor ist noch nicht gesichert. Nochmal beenden verwirft die Änderungen.')
      : $t('{0} Dokumente im Editor sind noch nicht gesichert. Nochmal beenden verwirft die Änderungen.', n),
    'error',
  );
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
document.addEventListener(
  'focusin',
  (e) => {
    focusInEditor = !!(e.target as HTMLElement).closest('.cm-editor');
  },
  true,
);
export function editorMenuKey(key: string): boolean {
  if (!st.open || !menuKeyHandler) return false;
  if (!focusInEditor && !document.activeElement?.closest('.cm-editor')) return false;
  return menuKeyHandler(key);
}
