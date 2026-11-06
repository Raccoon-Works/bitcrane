/**
 * Terminal settings with their defaults, and the colour scheme a session of a
 * server uses.
 */
import type { ITheme } from '@xterm/xterm';
import { getState, serverById } from '../store';
import { SCHEMES } from './schemes';
import type { TerminalSettings } from './types';

const defaultTerminalSettings = (): TerminalSettings => ({
  scheme: 'auto',
  fontFamily:
    getState().platform === 'mac'
      ? '"SF Mono", Menlo, Monaco, monospace'
      : '"Cascadia Mono", Consolas, "Courier New", monospace',
  fontSize: 13,
  cursor: 'block',
  copyOnSelect: false,
  startInFolder: true,
  suggest: 'list',
  scrollback: 10000,
  rightClick: getState().platform === 'mac' ? 'off' : 'smart',
  pasteWarn: true,
  localShell: '',
  restore: false,
});

export const terminalSettings = (): TerminalSettings => {
  const saved = getState().settings.terminal ?? {};
  return {
    ...defaultTerminalSettings(),
    ...saved,
    ...(saved.suggest ? {} : saved.suggestions ? { suggest: 'list' as const } : {}),
  };
};

/** Scheme for a server: its own, else the setting ("auto" follows Bitcrane's light/dark). */
export function themeFor(serverId: string): ITheme {
  const id = serverById(serverId)?.termScheme || terminalSettings().scheme;
  const chosen = id === 'auto' ? (getState().theme === 'light' ? 'bitcrane-light' : 'bitcrane-dark') : id;
  return (SCHEMES.find((s) => s.id === chosen) ?? SCHEMES[0]).theme;
}
