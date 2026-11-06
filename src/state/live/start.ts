/**
 * Start of the real backend: loads the configuration and keeps it saved.
 */
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { listen } from '@tauri-apps/api/event';

import { type AppState, subscribeStore, getState, setState } from '../core';
import { addLog } from '../log';
import { $t } from '../../i18n';
import { openDialog } from '../panels';
import { ensureVisible } from './listing';
import { discardRemoved, pump, takeBytesMoved } from './transfers';
import { reconcileWatches } from './watches';
import { scheduleSave, loadConfig, announceUpdate } from './config';
import { retryOffline } from './connections';
import { startUpdateChecks } from '../updates';

let started = false;
let prev: AppState | null = null;

/** Starts live mode once: loads the config and wires the store to the backend. */
export function startLive() {
  if (started) return;
  started = true;
  // Questions of a server during login (one-time code etc.) open a dialog.
  void listen<{
    id: string;
    serverId: string;
    host: string;
    name: string;
    instructions: string;
    prompts: Array<{ text: string; echo: boolean }>;
  }>('auth-prompt', (e) => {
    addLog(
      'info',
      $t('Der Server fragt: {0}', e.payload.prompts.map((p) => p.text.trim()).join(' / ')),
      e.payload.serverId || undefined,
    );
    openDialog({ type: 'authPrompt', ...e.payload });
  });
  subscribeStore(() => {
    const s = getState();
    if (prev && prev === s) return;
    const p = prev;
    prev = s;
    ensureVisible(s);
    if (p && p.transfers !== s.transfers) discardRemoved(p.transfers, s.transfers);
    if (!p || p.transfers !== s.transfers || p.settings.parallel !== s.settings.parallel) pump();
    if (!p || p.watches !== s.watches) reconcileWatches(s);
    if (
      !p ||
      p.servers !== s.servers ||
      p.watches !== s.watches ||
      p.settings !== s.settings ||
      p.toolbar !== s.toolbar ||
      p.toolbarLabels !== s.toolbarLabels ||
      p.tabs !== s.tabs ||
      p.activeTabId !== s.activeTabId ||
      p.transfers !== s.transfers
    )
      scheduleSave(s);
  });
  window.setInterval(() => {
    const now = Date.now();
    setState({ now, speed: takeBytesMoved() });
    void retryOffline(now);
  }, 1000);
  void loadConfig().then(() => {
    reconcileWatches(getState());
    void announceUpdate();
    startUpdateChecks();
    // No sleep while transfers run (keepawake in the backend; Settings › Übertragungen).
    let awake = false;
    subscribeStore(() => {
      const s = getState();
      const busy =
        s.settings.keepAwake !== false && s.transfers.some((t) => t.state === 'running' || t.state === 'queued');
      if (busy !== awake) {
        awake = busy;
        void backend.keepAwake(busy).catch(() => undefined);
      }
    });
    // Servers and shared settings between the user's computers (sync.ts).
    void import('../sync').then((m) => m.startSync());
  });
}
