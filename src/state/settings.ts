/**
 * Settings, toolbar and the look of the app (design, zoom).
 */

import { tauriBackend as backend } from '../backend/tauriBackend';
import type { Platform, Theme } from '../backend/types';

import { $t, rememberLanguage } from '../i18n';
import { LIVE, showToast, setState, getState } from './core';
import type { AppState, Settings, TransferRule, ToolId } from './appState';
import { detectTheme } from './defaults';

/** Stable empty rule list for store selectors (a new [] on every render would redraw endlessly). */
export const NO_RULES: TransferRule[] = [];

export function updateSettings(patch: Partial<Settings>) {
  if (patch.language && patch.language !== getState().settings.language) {
    rememberLanguage(patch.language);
    if (!LIVE) {
      // The prototype simply reloads in the new language.
      window.setTimeout(() => window.location.reload(), 50);
    } else {
      showToast($t('Die Sprache wechselt beim nächsten Start von Bitcrane.'));
    }
  }
  setState((s) => ({ settings: { ...s.settings, ...patch } }));
}

export function setToolbar(toolbar: ToolId[]) {
  setState({ toolbar });
}

/* ------------------------------------------------------------------------ */
/* Look                                                                     */
/* ------------------------------------------------------------------------ */

export function setPlatform(platform: Platform) {
  setState({ platform, appMenu: null, contextMenu: null });
}

export function setTheme(theme: Theme) {
  setState((s) => ({ theme, settings: { ...s.settings, themeSetting: theme } }));
}

export function setThemeSetting(themeSetting: 'system' | Theme) {
  setState((s) => ({
    settings: { ...s.settings, themeSetting },
    theme: themeSetting === 'system' ? detectTheme() : themeSetting,
  }));
}

/** Zoom steps of the window, like a browser. */
export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2];

/** Standard zoom: Mac programs are more compact than Windows ones, so the Mac starts at 90 %. */
export function defaultZoom(s: AppState = getState()): number {
  return s.platform === 'mac' ? 0.9 : 1;
}

/** The zoom in use: the user's choice, or the standard of the system. */
export function currentZoom(s: AppState = getState()): number {
  return s.settings.zoom ?? defaultZoom(s);
}

/** Strg + Plus / Minus / 0: one zoom step larger, smaller, or back to the standard. */
export function stepZoom(dir: 1 | -1 | 0) {
  const cur = currentZoom();
  // Nearest step to the current zoom, then one step in the wanted direction.
  const at = ZOOM_STEPS.reduce((best, z, i) => (Math.abs(z - cur) < Math.abs(ZOOM_STEPS[best] - cur) ? i : best), 0);
  const next = dir === 0 ? defaultZoom() : ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, at + dir))];
  setState((s) => ({ settings: { ...s.settings, zoom: next } }));
  showToast($t('Zoom: {0} %', Math.round(next * 100)));
}

export const togglePermsColumn = () =>
  setState((s) => ({ settings: { ...s.settings, showPerms: !s.settings.showPerms } }));

export const toggleSwapSides = () =>
  setState((s) => ({ settings: { ...s.settings, swapSides: !s.settings.swapSides } }));

/** Where the program lives, for `bitcrane upload …` in scripts; empty in the prototype. */
export function cliPath(): Promise<string> {
  return LIVE ? backend.cliPath() : Promise.resolve('');
}

/** Shows the log file in the Finder or Explorer. */
export async function revealLogFile() {
  await backend.localReveal(await backend.logPath());
}

/** Whether macOS lets Bitcrane read every folder; null when it cannot be told (prototype). */
export function fullDiskAccess(): Promise<boolean | null> {
  return LIVE ? backend.macFullDiskAccess() : Promise.resolve(null);
}

/** Opens a page of the macOS System Settings ("fullDisk", "notifications", ...). */
export function openMacSettings(page: string): Promise<void> {
  return backend.openMacSettings(page);
}

/** Whether the system lets Bitcrane show notifications; null when it cannot be told (prototype). */
export async function notificationsAllowed(): Promise<boolean | null> {
  if (!LIVE) return null;
  const m = await import('@tauri-apps/plugin-notification');
  return m.isPermissionGranted();
}
