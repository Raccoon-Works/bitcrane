/**
 * Starting values of the state: watch options, the toolbar, platform and
 * theme detection, and the sidebar width.
 */
import type { Platform, Theme, WatchOptions } from '../backend/types';
import { DEMO_PLATFORM, DEMO_THEME } from '../util/demo';
import { $t } from '../i18n';
import type { ToolId } from './appState';

export const defaultWatchOptions: WatchOptions = {
  includeSubfolders: true,
  syncOnStart: true,
  startWithApp: true,
  warnIfServerNewer: true,
  runInBackground: true,
  continueOnError: true,
  onlyExisting: false,
  onlySelectedSubfolders: false,
  setPermissions: false,
  mirrorDeletes: false,
  keepOldVersion: false,
  commandEnabled: false,
  command: '',
  delay: 2,
};

export const allTools: Array<{ id: ToolId; label: string }> = [
  { id: 'nav', label: $t('Zurück / Vor') },
  { id: 'newFolder', label: $t('Neuer Ordner') },
  { id: 'refresh', label: $t('Aktualisieren') },
  { id: 'info', label: $t('Informationen') },
  { id: 'activity', label: $t('Aktivität') },
  { id: 'upload', label: $t('Hochladen') },
  { id: 'download', label: $t('Herunterladen') },
  { id: 'delete', label: $t('Löschen') },
  { id: 'rename', label: $t('Umbenennen') },
  { id: 'perms', label: $t('Rechte') },
  { id: 'hidden', label: $t('Versteckte Dateien') },
  { id: 'terminal', label: $t('Terminal (SSH)') },
  { id: 'disconnect', label: $t('Trennen') },
  { id: 'copyPath', label: $t('Pfad kopieren') },
  { id: 'editor', label: $t('Im Editor öffnen') },
  { id: 'codeEditor', label: $t('Editor') },
  { id: 'sync', label: $t('Ordner abgleichen') },
  { id: 'syncBrowse', label: $t('Synchron blättern') },
  { id: 'compareDirs', label: $t('Verzeichnisse vergleichen') },
  { id: 'selectMask', label: $t('Auswählen nach Muster') },
  { id: 'palette', label: $t('Befehle') },
];

/**
 * Standard toolbar: the everyday actions, grouped (see Toolbar.tsx); everything
 * else is in the menus, the context menu and the command palette, and can be
 * added via "Werkzeugleiste anpassen".
 */
export const defaultToolbar: ToolId[] = [
  'nav',
  'upload',
  'download',
  'newFolder',
  'refresh',
  'sync',
  'syncBrowse',
  'terminal',
  'info',
  'activity',
];
/** Earlier standard toolbars (up to 0.2.38, up to 0.2.43): users who never changed theirs get the new one. */
export const oldDefaultToolbars: ToolId[][] = [
  ['nav', 'newFolder', 'refresh', 'info', 'activity'],
  ['nav', 'upload', 'download', 'newFolder', 'refresh', 'sync', 'syncBrowse', 'info', 'activity'],
];

export function detectPlatform(): Platform {
  if (DEMO_PLATFORM) return DEMO_PLATFORM;
  const p = (navigator.platform || '') + ' ' + navigator.userAgent;
  return /Win/i.test(p) ? 'win' : 'mac';
}

/**
 * A host page (e.g. the artifact viewer) may fix the theme on the root element.
 * Read once at load: the app itself writes data-theme on the root later, and
 * reading it then would turn "Wie das System" into the last chosen theme.
 */
const HOST_THEME = document.documentElement.dataset.theme;

export function detectTheme(): Theme {
  if (DEMO_THEME) return DEMO_THEME;
  if (HOST_THEME === 'dark' || HOST_THEME === 'light') return HOST_THEME;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
