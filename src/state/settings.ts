/**
 * Settings, toolbar and the look of the app (design, zoom).
 */

import type { Platform, Theme } from '../backend/types';

import { $t, rememberLanguage } from '../i18n';
import { state, LIVE, showToast, setState } from './core';
import type { Settings, TransferRule, ToolId } from './appState';
import { detectTheme } from './defaults';

/** Stable empty rule list for store selectors (a new [] on every render would redraw endlessly). */
export const NO_RULES: TransferRule[] = [];

export function updateSettings(patch: Partial<Settings>) {
  if (patch.language && patch.language !== state.settings.language) {
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
