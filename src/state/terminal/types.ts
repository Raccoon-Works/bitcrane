/**
 * Data of the built-in terminal kept in the store and the settings: sessions,
 * snippets and the terminal settings. The terminal state of a tab is saved with
 * the tab and lives with it in backend/types.ts.
 */

export interface TermSession {
  id: string;
  serverId: string;
  tabId: string;
  /** Number shown in the panel's tab ("Webshop 2"). */
  number: number;
  alive: boolean;
  /** Terminals on this computer: the shell chosen in the "+" menu; missing = the setting. */
  shell?: string;
  /** Its name for the session tab ("Git Bash" instead of "Lokal"). */
  shellName?: string;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  /** Press Enter after inserting (otherwise the command waits for a look). */
  run: boolean;
  /** Group in the snippet menu and the settings ("Webshop"); none: at the top. */
  group?: string;
  /** Kept in the settings but left out of the snippet menu. */
  hidden?: boolean;
}

export interface TerminalSettings {
  scheme: string;
  fontFamily: string;
  fontSize: number;
  cursor: 'block' | 'bar' | 'underline';
  copyOnSelect: boolean;
  /** Start in the folder the server half shows. */
  startInFolder: boolean;
  /** Old switch (0.2.48): on meant the dimmed suggestions; `suggest` replaces it. */
  suggestions?: boolean;
  /** Suggestions while typing (termSuggest.ts): off, only the dimmed rest, or with the list. */
  suggest: 'off' | 'ghost' | 'list';
  /** Lines kept for scrolling back. */
  scrollback: number;
  /** Right click: copy the selection, or paste when nothing is selected (PuTTY, Windows Terminal). */
  rightClick: 'smart' | 'off';
  /** Ask before pasting text with several lines (each line would run at once). */
  pasteWarn: boolean;
  /** Shell of the terminal on this computer (term_shells); '' = the default. */
  localShell: string;
  /** Open the terminals of the tabs again at the next start (with "Tabs vom letzten Mal"). */
  restore: boolean;
}
