/**
 * The browser prototype: scenario buttons of the prototype bar and the simulation loop
 * that moves transfers, watches and connection drops along (never runs in the app).
 */

import { type ImportedServer } from '../backend/api';
import * as fs from '../backend/mockFs';
import * as live from './live';
import type { Server, Transfer } from '../backend/types';

import { formatSize } from '../util/format';
import * as paths from '../util/paths';
import { DEMO_CLIP, DEMO_THEME, listenForDemoMessages } from '../util/demo';
import { $t } from '../i18n';
import { emptyTab, setState, initialState, state, subscribeStore, showToast, uid, activeTab, openServerIn, LIVE, sampleServers, detectTheme } from './core';
import { openDialog } from './panels';
import { offerCloudPlaces } from './places';
import { forced } from './transfers';
import { pendingCommand, simulateLocalChange } from './watches';

/** Version shown by the prototype (About, Settings): the one the screenshots stand for. */
export const PROTOTYPE_VERSION = '0.3.0';

/** Shows the first-start screen as if no server was saved yet. */
export function showFirstRun() {
  fs.resetAll();
  const tab = emptyTab('~');
  setState({ ...initialState(), platform: state.platform, theme: state.theme, servers: [], tabs: [tab], watches: [], transfers: [], activeTabId: tab.id });
  // As on a real first start: offer the servers of other programs, then the cloud folders (simulated here).
  window.setTimeout(() => {
    openDialog({ type: 'import', firstStart: true });
    const stop = subscribeStore(() => { if (state.dialog?.type !== 'import') { stop(); void offerCloudPlaces(false); } });
  }, 400);
  setState((s) => ({ settings: { ...s.settings, syncFavorites: [], recentAddresses: [] } }));
}

/** Restores the sample data. */
export function resetPrototype() {
  fs.resetAll();
  forced.clear();
  pendingCommand.clear();
  setState({ ...initialState(), platform: state.platform, theme: state.theme });
  showToast($t('Beispieldaten wiederhergestellt.'));
}

/** Two letters for the server tile: initials of two words, else the first two letters. */
export function monoFor(name: string): string {
  const words = name.replace(/[^A-Za-z0-9ÄÖÜäöüß ]/g, ' ').split(/\s+/).filter(Boolean);
  const m = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? name).slice(0, 2);
  return (m || 'SV').toUpperCase();
}

/** Adds servers found in other programs (from the import window). */
export function importServers(list: ImportedServer[]) {
  // No colour (it is optional, see ServerTile); servers already there, or twice in the list, are skipped.
  // Same server = same protocol, user, host, port and key file (two entries with different keys are kept).
  const keyOf = (x: { host: string; port: number; user: string; protocol?: string; keyPath?: string; auth?: string }) =>
    `${x.protocol ?? 'sftp'}|${x.user.toLowerCase()}@${x.host.toLowerCase()}:${x.port}|${x.auth === 'key' ? (x.keyPath ?? '') : ''}`;
  const seen = new Set(state.servers.filter((x) => !x.temporary).map(keyOf));
  list = list.filter((s) => { const k = keyOf(s); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!list.length) { setState({ dialog: null }); showToast($t('Diese Server sind schon vorhanden.')); return; }
  const created: Server[] = list.map((s) => ({
    id: uid('srv'), name: s.name, mono: monoFor(s.name),
    color: 'gray', host: s.host, port: s.port, user: s.user,
    auth: s.protocol === 'sftp' ? s.auth : 'password', keyPath: s.keyPath ?? '~/.ssh/id_ed25519', group: s.group,
    localStart: s.localDir ?? '~', remoteStart: s.remoteDir ?? '', online: false,
    protocol: s.protocol, implicitTls: s.implicitTls || undefined,
    // WebDAV from Cyberduck: plain http only on port 80.
    ...(s.protocol === 'webdav' ? { davHttps: s.port !== 80 } : {}),
  }));
  // ProxyJump names refer to other entries of the SSH configuration.
  const all = [...state.servers, ...created];
  list.forEach((s, i) => {
    if (!s.jump) return;
    const j = all.find((x) => x.name === s.jump || x.host === s.jump);
    if (j && j.id !== created[i].id) created[i].jumpServerId = j.id;
  });
  // Offered on the first start: the servers only go into the list; connecting stays the user's choice.
  const firstStart = state.dialog?.type === 'import' && !!state.dialog.firstStart;
  setState((st) => ({ servers: [...st.servers, ...created], dialog: null, firstRun: false }));
  showToast(created.length === 1 ? $t('„{0}“ übernommen.', created[0].name) : $t('{0} Server übernommen.', created.length), 'ok');
  const t = activeTab();
  if (!firstStart && (!t || !t.serverId) && created[0]) openServerIn('remote', created[0].id);
}

/** Adds the SSH-config servers on the welcome screen. */
export function importSshConfig() {
  if (LIVE) {
    openDialog({ type: 'import' });
    return;
  }
  const servers = sampleServers().slice(0, 3).map((x) => ({ ...x, online: false }));
  setState({ servers, firstRun: false });
  showToast($t('3 Server aus der SSH-Konfiguration übernommen.'), 'ok');
}

/* ------------------------------------------------------------------------ */
/* Simulation loop                                                          */
/* ------------------------------------------------------------------------ */

const TICK = 100;
let lastAuto = Date.now();

/** Returns an error text when the demo server refuses writing to a path. */
function writeError(tr: Transfer): { error: string; detail: string } | null {
  if (tr.direction !== 'up') return null;
  const dirPath = paths.parent(tr.target);
  const d = fs.stat('remote', tr.serverId, dirPath);
  if (d && d.owner === 'root' && !d.perms.endsWith('7')) {
    return {
      error: $t('Keine Schreibrechte'),
      detail: $t('Der Server verweigert das Schreiben in {0} (Permission denied). Prüfe die Ordnerrechte oder den Besitzer auf dem Server.', dirPath),
    };
  }
  return null;
}

function tick() {
  const s = state;
  const now = Date.now();
  let changed = false;
  let fsChanged = false;
  let transfers = s.transfers;
  let watches = s.watches;
  let conflicts = s.conflicts;
  let dialog = s.dialog;
  let speed = 0;

  // Retry countdown for dropped connections (the user can also click "Jetzt verbinden").
  let offline = s.offline;
  for (const [id, info] of Object.entries(s.offline)) {
    if (now >= info.nextRetry) {
      offline = { ...offline, [id]: { attempt: Math.min(10, info.attempt + 1), nextRetry: now + 5000 } };
      changed = true;
    }
  }

  const running = transfers.filter((x) => x.state === 'running').length;
  let slots = Math.max(0, s.settings.parallel - running);

  transfers = transfers.map((tr) => {
    if (tr.state === 'queued' && slots > 0 && !offline[tr.serverId]) {
      // Conflict check before writing a watched file.
      const watch = tr.watchId ? watches.find((w) => w.id === tr.watchId) : undefined;
      if (tr.direction === 'up' && watch?.options.warnIfServerNewer && !forced.has(tr.id)) {
        const remote = fs.stat('remote', tr.serverId, tr.target);
        const local = fs.stat('local', tr.serverId, tr.source);
        if (remote && local && remote.mtime > local.mtime && !conflicts.some((c) => c.transferId === tr.id)) {
          conflicts = [...conflicts, {
            transferId: tr.id, name: tr.name, serverId: tr.serverId, remoteFolder: paths.parent(tr.target),
            localSize: local.size, localTime: local.mtime, remoteSize: remote.size, remoteTime: remote.mtime, watchName: watch.name, more: 0,
          }];
          dialog = dialog ?? { type: 'conflict' };
          changed = true;
          return { ...tr, state: 'paused' as const, error: $t('Wartet auf Entscheidung'), hold: 'conflict' as const };
        }
      }
      slots--;
      changed = true;
      return { ...tr, state: 'running' as const };
    }
    if (tr.state === 'running') {
      changed = true;
      if (offline[tr.serverId] || (tr.sourceServerId && offline[tr.sourceServerId])) return { ...tr, state: 'queued' as const, done: 0 };
      if (tr.direction === 'command') {
        // The preview runs a command for 1.5 seconds; done counts the milliseconds of that.
        const done = tr.done + TICK;
        if (done >= 1500) {
          return { ...tr, done: tr.size, state: 'done' as const, finishedAt: now, output: $t('[PM2] Applying action restartProcessId on app [{0}]\n[PM2] [{1}](0) ✓', tr.name.split(' ').pop(), tr.name.split(' ').pop()) };
        }
        return { ...tr, done, size: 1500 };
      }
      const err = writeError(tr);
      if (err) {
        // The server refuses the write shortly after the transfer started.
        if (tr.done > 0) return { ...tr, state: 'error' as const, error: err.error, errorDetail: err.detail };
        return { ...tr, done: Math.round(tr.size * 0.2) };
      }
      // Simulated throughput: roughly 1.2 MB/s, small files finish quickly.
      // While a website clip is recorded, a small file takes about a second, so it can be seen.
      const rate = DEMO_CLIP ? 20 * 1024 : 1.2 * 1024 * 1024 * (0.8 + Math.random() * 0.4);
      const step = DEMO_CLIP ? (rate * TICK) / 1000 : Math.max(2048, (rate * TICK) / 1000);
      // The clip shows a usual speed, even though its file moves slowly enough to be seen.
      speed += DEMO_CLIP ? 2.4 * 1024 * 1024 * (0.9 + Math.random() * 0.2) : rate;
      const done = Math.min(tr.size, tr.done + step);
      if (done >= tr.size) {
        const targetSide = tr.direction === 'down' ? 'local' : 'remote';
        fs.writeFile(targetSide, tr.serverId, tr.target, tr.size);
        fsChanged = true;
        return { ...tr, done, state: 'done' as const, finishedAt: now };
      }
      return { ...tr, done };
    }
    return tr;
  });

  // Update watch "last upload" info and run post-upload commands once a batch is done.
  for (const w of watches) {
    const batch = transfers.filter((x) => x.watchId === w.id && x.direction === 'up');
    const busy = batch.some((x) => x.state === 'running' || x.state === 'queued' || x.state === 'paused');
    const lastDone = batch.filter((x) => x.state === 'done' && x.finishedAt).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
    if (lastDone && lastDone.finishedAt! > w.lastTime) {
      watches = watches.map((x) => (x.id === w.id ? { ...x, lastFile: lastDone.name, lastTime: lastDone.finishedAt! } : x));
      changed = true;
    }
    if (!busy && pendingCommand.has(w.id)) {
      pendingCommand.delete(w.id);
      const hadError = batch.some((x) => x.state === 'error');
      if (w.options.commandEnabled && w.options.command && !hadError) {
        transfers = [...transfers, { id: uid('t'), name: w.options.command, direction: 'command', serverId: w.serverId, folder: '', source: '', target: '', size: 1, done: 0, state: 'running', watchId: w.id }];
        changed = true;
      }
    }
  }

  // A gentle background event every 40 seconds keeps the active watch alive
  // (not while a website clip is recorded, where the script decides what happens).
  if (!DEMO_CLIP && now - lastAuto > 40000) {
    lastAuto = now;
    const active = watches.find((w) => w.state === 'active');
    if (active && !s.dialog) window.setTimeout(() => simulateLocalChange(active.id), 0);
  }

  // Keep the visible history short.
  const doneList = transfers.filter((x) => x.state === 'done');
  if (doneList.length > 40) {
    const drop = new Set(doneList.slice(0, doneList.length - 40).map((x) => x.id));
    transfers = transfers.filter((x) => !drop.has(x.id));
  }

  const nowSec = Math.floor(now / 1000) !== Math.floor(s.now / 1000);
  if (changed || fsChanged || nowSec) {
    setState({
      transfers, watches, conflicts, dialog, offline, speed,
      fsRev: fsChanged ? s.fsRev + 1 : s.fsRev,
      now: nowSec ? now : s.now,
    });
  }
}

let started = false;
/** Starts the simulation timer once. */
/** Prototype: a believable connection log, and one line per finished transfer. */
function simulateLog(addLog: typeof import('./log').addLog) {
  addLog('info', $t('Bitcrane gestartet, {0} {1}, {2} Überwachungen', state.servers.length, $t('Server'), state.watches.length));
  addLog('info', $t('Verbinde mit {0}@{1}:{2} ({3})', 'deploy', 'shop.example', 22, $t('SSH-Schlüssel')), 'ob');
  addLog('ok', $t('Verbunden, Startordner {0}', '/home/deploy'), 'ob');
  addLog('info', $t('Überwachung „{0}“ gestartet', 'webshop live'), 'ob');
  const seen = new Map<string, string>();
  subscribeStore(() => {
    for (const t of state.transfers) {
      const before = seen.get(t.id);
      if (before === t.state) continue;
      seen.set(t.id, t.state);
      if (before === undefined && t.state === 'done') continue;
      const what = t.direction === 'command' ? t.name : `${t.direction === 'up' ? '↑' : t.direction === 'down' ? '↓' : '↔'} ${t.target || t.name}`;
      if (t.state === 'running') addLog('info', t.direction === 'command' ? $t('Befehl: {0}', t.name) : $t('Übertrage {0}', what), t.serverId);
      if (t.state === 'done') addLog('ok', t.direction === 'command' ? $t('Befehl fertig: {0}', t.name) : $t('Fertig: {0} ({1})', what, formatSize(t.size)), t.serverId);
      if (t.state === 'error') addLog('error', `${t.name}: ${t.error ?? $t('Fehler')}`, t.serverId);
    }
  });
}

export function startSimulation() {
  if (started) return;
  started = true;
  if (LIVE) live.startLive();
  else {
    window.setInterval(tick, TICK);
    void import('./log').then((m) => simulateLog(m.addLog));
  }
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (state.settings.themeSetting === 'system' && !DEMO_THEME) setState({ theme: detectTheme() });
  });
  listenForDemoMessages((patch) => setState(patch));
}
