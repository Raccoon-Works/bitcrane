/**
 * Functions taken over from WinSCP's toolbar and menus, kept apart from the
 * main store to keep it readable:
 *
 * - "Verzeichnisse vergleichen": both halves mark what differs from the other half.
 * - "Dateien auswählen nach Maske": select (or deselect) entries by pattern.
 * - "Eigene Befehle": own commands run on the server for the selected files.
 * - "Arbeitsbereiche": named sets of tabs that can be opened again.
 * - "Nach Abschluss": disconnect, quit, sleep or shut down once all transfers are done.
 */
import { invoke } from '@tauri-apps/api/core';
import type { FileEntry, PaneSide, Tab } from '../backend/types';
import * as live from './live';
import {
  activeTab, disconnect, getState, LIVE, listEntries, openDialog, paneEntries, paneLoc, panePath, paneShowsServers,
  refresh, selectTab, serverById, setState, showToast, subscribeStore, uid, updateSettings,
  type AfterQueue, type CustomCommand, type SavedTab, type Workspace,
} from './store';
import { addLog } from './log';
import { TOLERANCE_MS } from './syncPlan';
import * as paths from '../util/paths';
import { $t } from '../i18n';

/* ------------------------------------------------------------------------ */
/* Compare directories                                                      */
/* ------------------------------------------------------------------------ */

/** How an entry differs from the entry of the same name in the other half. */
export type CompareMark = 'only' | 'newer' | 'older' | 'size';

export function toggleCompareDirs() {
  const on = !getState().compareDirs;
  setState({ compareDirs: on });
  if (on) {
    const t = activeTab();
    if (!t || paneShowsServers('local', t) || paneShowsServers('remote', t)) showToast($t('Zum Vergleichen müssen beide Hälften einen Ordner zeigen.'));
  }
}

/**
 * Marks for the top-level entries of a half compared with the other half's
 * folder: missing there, newer, older, or same time but a different size.
 * Times of a server are corrected by its clock offset. Equal entries get no mark.
 */
export function compareMarks(side: PaneSide): Map<string, CompareMark> | null {
  const s = getState();
  const t = activeTab(s);
  if (!s.compareDirs || !t || paneShowsServers('local', t) || paneShowsServers('remote', t)) return null;
  const other: PaneSide = side === 'local' ? 'remote' : 'local';
  const mine = listEntries(...paneLoc(side, t), panePath(side, s));
  const theirs = listEntries(...paneLoc(other, t), panePath(other, s));
  if (!mine || !theirs) return null;
  const offset = (p: PaneSide) => {
    const [ls, sid] = paneLoc(p, t);
    return LIVE && ls === 'remote' && sid ? live.clockOffset(sid) : 0;
  };
  const myOffset = offset(side);
  const theirOffset = offset(other);
  const byName = new Map<string, FileEntry>(theirs.map((e) => [e.name, e]));
  const out = new Map<string, CompareMark>();
  for (const e of mine) {
    const o = byName.get(e.name);
    if (!o || o.kind !== e.kind) { out.set(e.name, 'only'); continue; }
    if (e.kind === 'dir') continue;
    const diff = (e.mtime - myOffset) - (o.mtime - theirOffset);
    if (diff > TOLERANCE_MS) out.set(e.name, 'newer');
    else if (diff < -TOLERANCE_MS) out.set(e.name, 'older');
    else if (e.size !== o.size) out.set(e.name, 'size');
  }
  return out;
}

/** Selects in a half everything that is missing in the other half or newer (WinSCP selects these after comparing). */
export function selectDifferences(side: PaneSide) {
  const marks = compareMarks(side);
  if (!marks) return;
  const names = paneEntries(side).filter((e) => (e.depth ?? 0) === 0 && (marks.get(e.name) === 'only' || marks.get(e.name) === 'newer' || marks.get(e.name) === 'size')).map((e) => e.name);
  setState((s) => ({ focusSide: side, selection: { ...s.selection, [side]: { names, cursor: -1, anchor: -1 } } }));
}

/* ------------------------------------------------------------------------ */
/* Select by mask                                                           */
/* ------------------------------------------------------------------------ */

/** Turns "*.jpg; foto-??.png" into one case-insensitive regular expression per pattern. */
export function maskToRegexps(mask: string): RegExp[] {
  // "*.*" means every entry, as in Windows and WinSCP (also names without a dot).
  return mask.split(/[;,]/).map((p) => p.trim()).filter(Boolean).map((p) => (p === '*.*' ? '*' : p)).map((p) => {
    const body = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${body}$`, 'i');
  });
}

/** Names in a half (top level) that match the mask. */
export function matchingNames(side: PaneSide, mask: string, includeFolders: boolean): string[] {
  const res = maskToRegexps(mask);
  if (!res.length) return [];
  return paneEntries(side)
    .filter((e) => (e.depth ?? 0) === 0 && (includeFolders || e.kind === 'file') && res.some((r) => r.test(e.name)))
    .map((e) => e.name);
}

/** Applies a mask: "replace" selects only the matches, "add" adds them, "remove" takes them out. */
export function selectByMask(side: PaneSide, mask: string, mode: 'replace' | 'add' | 'remove', includeFolders: boolean) {
  const hits = matchingNames(side, mask, includeFolders);
  setState((s) => {
    const cur = s.selection[side].names;
    const names = mode === 'replace' ? hits : mode === 'add' ? [...new Set([...cur, ...hits])] : cur.filter((n) => !hits.includes(n));
    return { focusSide: side, dialog: null, selection: { ...s.selection, [side]: { names, cursor: -1, anchor: -1 } } };
  });
  showToast(hits.length === 1 ? $t('1 Eintrag passt.') : $t('{0} Einträge passen.', hits.length));
}

/** Selects what is not selected and the other way round. */
export function invertSelection(side: PaneSide) {
  const cur = new Set(getState().selection[side].names);
  const names = paneEntries(side).filter((e) => (e.depth ?? 0) === 0 && !cur.has(e.name)).map((e) => e.name);
  setState((s) => ({ selection: { ...s.selection, [side]: { names, cursor: -1, anchor: -1 } } }));
}

/* ------------------------------------------------------------------------ */
/* Custom commands                                                          */
/* ------------------------------------------------------------------------ */

/** Single quotes for the server's shell; a quote inside the name is closed, escaped and reopened. */
const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** The command with its placeholders filled in for these files. */
export function expandCommand(cmd: CustomCommand, dir: string, names: string[]): string {
  const full = names.map((n) => paths.join(dir, n));
  return cmd.command
    .replace(/\{files\}/g, full.map(shellQuote).join(' '))
    .replace(/\{file\}/g, full[0] ? shellQuote(full[0]) : "''")
    .replace(/\{name\}/g, names[0] ? shellQuote(names[0]) : "''")
    .replace(/\{dir\}/g, shellQuote(dir));
}

/** True when the half shows an SFTP server, where commands can run (SSH). */
export function canRunCommands(side: PaneSide): boolean {
  const t = activeTab();
  if (!t) return false;
  const [ls, sid] = paneLoc(side, t);
  const srv = ls === 'remote' ? serverById(sid) : undefined;
  return !!srv && live.isSftp(srv);
}

/**
 * Runs an own command on the half's server for the given files (or the folder
 * when none is selected). With "{file}" in the command it runs once per file.
 * The output goes to the log; the folder is read again afterwards.
 */
export async function runCustomCommand(cmd: CustomCommand, side: PaneSide, names: string[]) {
  const t = activeTab();
  if (!t) return;
  const [ls, sid] = paneLoc(side, t);
  if (ls !== 'remote' || !sid) return;
  const dir = panePath(side);
  const perFile = /\{(file|name)\}/.test(cmd.command) && names.length > 1;
  const commands = perFile ? names.map((n) => expandCommand(cmd, dir, [n])) : [expandCommand(cmd, dir, names)];
  if (!LIVE) {
    showToast($t('„{0}“ ausgeführt (Prototyp).', cmd.name), 'ok');
    return;
  }
  let failed = 0;
  for (const line of commands) {
    const r = await live.runRemoteCommand(sid, line);
    if ('error' in r) { showToast(r.error, 'error'); return; }
    if (r.code !== 0) failed++;
  }
  addLog(failed ? 'error' : 'ok', $t('Eigener Befehl „{0}“: {1}', cmd.name, failed ? $t('{0} mit Fehler', failed) : $t('fertig')), sid);
  showToast(failed ? $t('„{0}“ meldet einen Fehler. Die Ausgabe steht im Protokoll.', cmd.name) : $t('„{0}“ ausgeführt.', cmd.name), failed ? 'error' : 'ok');
  refresh();
}

export const newCommandId = () => uid('cmd');

/* ------------------------------------------------------------------------ */
/* Workspaces and restoring tabs                                            */
/* ------------------------------------------------------------------------ */

/** The open tabs in the form they are saved (temporary servers are left out). */
export function savedTabs(tabs: Tab[] = getState().tabs): SavedTab[] {
  const servers = getState().servers;
  const keep = (id?: string) => !!id && !servers.find((x) => x.id === id)?.temporary;
  return tabs
    .filter((t) => !t.serverId || keep(t.serverId))
    .map((t) => ({
      serverId: t.serverId,
      localPath: t.leftServerId && !keep(t.leftServerId) ? '~' : t.localPath,
      remotePath: t.remotePath,
      ...(keep(t.leftServerId) ? { leftServerId: t.leftServerId } : {}),
      ...(t.rightLocal ? { rightLocal: true } : {}),
    }));
}

/** Tabs built from saved ones; servers that no longer exist are dropped from them. */
export function tabsFromSaved(list: SavedTab[]): Tab[] {
  const exists = (id?: string) => !!id && !!serverById(id);
  return list.map((x) => ({
    id: uid('tab'),
    serverId: exists(x.serverId) ? x.serverId : '',
    localPath: x.leftServerId && !exists(x.leftServerId) ? '~' : x.localPath || '~',
    remotePath: exists(x.serverId) || x.rightLocal ? x.remotePath : '',
    back: [],
    forward: [],
    ...(exists(x.leftServerId) ? { leftServerId: x.leftServerId } : {}),
    ...(x.rightLocal && !exists(x.serverId) ? { rightLocal: true } : {}),
  }));
}

/** Saves the open tabs under a name (replaces a workspace of the same name). */
export function saveWorkspace(name: string) {
  const clean = name.trim();
  if (!clean) return;
  const s = getState();
  const list = s.settings.workspaces ?? [];
  const existing = list.find((w) => w.name.toLowerCase() === clean.toLowerCase());
  const ws: Workspace = { id: existing?.id ?? uid('ws'), name: clean, tabs: savedTabs(), active: Math.max(0, s.tabs.findIndex((t) => t.id === s.activeTabId)) };
  updateSettings({ workspaces: existing ? list.map((w) => (w.id === existing.id ? ws : w)) : [...list, ws] });
  showToast(existing ? $t('Arbeitsbereich „{0}“ aktualisiert.', clean) : $t('Arbeitsbereich „{0}“ gespeichert.', clean), 'ok');
}

/** Opens a workspace: its tabs replace the open ones, or are added to them. */
export function openWorkspace(id: string, replace: boolean) {
  const ws = getState().settings.workspaces?.find((w) => w.id === id);
  if (!ws) return;
  const tabs = tabsFromSaved(ws.tabs);
  if (!tabs.length) return;
  const first = tabs[Math.min(ws.active ?? 0, tabs.length - 1)];
  setState((s) => ({ tabs: replace ? tabs : [...s.tabs, ...tabs], dialog: null }));
  selectTab(first.id);
}

export function removeWorkspace(id: string) {
  updateSettings({ workspaces: (getState().settings.workspaces ?? []).filter((w) => w.id !== id) });
}

/* ------------------------------------------------------------------------ */
/* After the queue                                                          */
/* ------------------------------------------------------------------------ */

export function setAfterQueue(afterQueue: AfterQueue) {
  setState({ afterQueue });
}

/** Label for the choice (also used in the activity bar). */
export function afterQueueLabel(a: AfterQueue): string {
  const mac = getState().platform === 'mac';
  switch (a) {
    case 'disconnect': return $t('Verbindungen trennen');
    case 'quit': return $t('Bitcrane beenden');
    case 'sleep': return mac ? $t('Ruhezustand') : $t('Energie sparen');
    case 'shutdown': return mac ? $t('Mac ausschalten') : $t('PC herunterfahren');
    default: return $t('Nichts tun');
  }
}

/** Carries out the chosen action (after the countdown window). */
export async function runAfterQueue(action: AfterQueue) {
  setState({ afterQueue: 'none', dialog: null });
  if (action === 'disconnect') {
    for (const srv of getState().servers) if (srv.online) disconnect(srv.id);
    return;
  }
  if (action === 'quit') {
    const { quitApp } = await import('../util/appWindow');
    quitApp();
    return;
  }
  if (action === 'sleep' || action === 'shutdown') {
    if (!LIVE) { showToast($t('Im Prototyp passiert hier nichts.')); return; }
    const { saveNow } = await import('./live');
    await saveNow();
    try {
      await invoke('system_power', { action });
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    }
  }
}

let wasBusy = false;

/**
 * Watches the queue: when it runs empty while an action is chosen, a window
 * counts down before the action runs (it can be cancelled). With errors left
 * in the list nothing happens, so a failed upload is not left unseen.
 */
export function startAfterQueueWatch() {
  return subscribeStore(() => {
    const s = getState();
    const manual = s.transfers.filter((t) => !t.watchId && t.direction !== 'command');
    const busy = manual.some((t) => t.state === 'running' || t.state === 'queued');
    if (wasBusy && !busy && s.afterQueue !== 'none') {
      const paused = manual.some((t) => t.state === 'paused');
      const errors = manual.some((t) => t.state === 'error');
      if (errors) {
        setState({ afterQueue: 'none' });
        showToast($t('Übertragungen mit Fehlern beendet. „{0}“ wurde deshalb nicht ausgeführt.', afterQueueLabel(s.afterQueue)), 'error');
      } else if (!paused) {
        openDialog({ type: 'afterQueue', action: s.afterQueue });
      }
    }
    wasBusy = busy;
  });
}
