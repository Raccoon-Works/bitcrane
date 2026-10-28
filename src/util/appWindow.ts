/**
 * Window controls for the custom Windows title bar.
 * In the browser prototype these do nothing visible except a short note.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LIVE, showToast } from '../state/store';
import { $t } from '../i18n';

const win = () => getCurrentWindow();

export function minimizeWindow() {
  if (LIVE) void win().minimize();
  else showToast($t('Im Prototyp lässt sich das Fenster nicht minimieren.'));
}

export function toggleMaximizeWindow() {
  if (LIVE) void win().toggleMaximize();
}

export function closeWindow() {
  if (LIVE) void win().close();
  else showToast($t('Im Prototyp lässt sich das Fenster nicht schließen.'));
}

/**
 * "Bitcrane beenden": quits even when the app would keep running in the
 * background. An update loaded in the background is installed first.
 */
export function quitApp() {
  if (!LIVE) {
    showToast($t('Im Prototyp lässt sich Bitcrane nicht beenden.'));
    return;
  }
  void import('../state/live')
    .then((m) => m.saveNow())
    .then(() => import('../state/updates'))
    .then((u) => u.installOnQuit())
    .catch(() => undefined)
    .finally(() => invoke('app_quit'));
}

/** Starts moving the window (title bar drag). */
export function startWindowDrag() {
  if (LIVE) void win().startDragging();
}
