/**
 * Built-in terminal (see src-tauri/src/terminal.rs), in one import.
 *
 * A terminal session belongs to a tab and its server, or to this computer. It
 * is shown in the panel below the two halves, or alone in a tab of its own
 * ("In eigenem Tab"). The modules in `terminal/` hold the areas: the data
 * types, colour schemes and settings, the xterm.js instances, the sessions,
 * snippets and the made-up terminal of the browser prototype.
 *
 * Ideas taken from Tabby (MIT): snippets, colour schemes, per-server profile
 * settings.
 */
export type { Snippet, TermSession, TerminalSettings } from './terminal/types';
export { SCHEMES } from './terminal/schemes';
export { terminalSettings, themeFor } from './terminal/settings';
export { clearTerminal, findInTerminal, fitTerminal } from './terminal/instances';
export {
  attachTerminal,
  closeTerminal,
  initTerminals,
  localShells,
  newTerminal,
  openServerTerminal,
  reopenTerminals,
  setActiveTerminal,
  terminalBackToPanel,
  terminalInOwnTab,
  toggleTerminal,
} from './terminal/sessions';
export { importTabbySnippets, sendSnippet } from './terminal/snippets';
