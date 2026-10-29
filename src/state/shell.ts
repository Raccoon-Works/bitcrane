/**
 * Desktop integration of the app (live mode only):
 * - native menu bar on macOS, built from the same definitions as the
 *   Windows "…" menu,
 * - status icon in the menu bar / notification area,
 * - keep running in the background when the window is closed,
 * - system notifications and signal tones,
 * - progress and count on the app icon (Dock / taskbar),
 * - start at login.
 */
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, ProgressBarStatus } from '@tauri-apps/api/window';
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from '@tauri-apps/plugin-autostart';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { Transfer } from '../backend/types';
import { menuDefs } from '../components/AppMenu';
import { playDoneSound, playErrorSound } from '../util/sounds';
import { quitApp } from '../util/appWindow';
import { isConfigLoaded } from './live';
import { getState, newTab, openDialog, openServerInNewTab, openSftpLink, pauseAllWatches, subscribeStore, toggleWatch, updateSettings, type AppState } from './store';
import { checkForUpdates } from './updates';
import { applyShellIntegration, receiveUploadPaths, uploadPathsFromLink } from './tools';
import { initMounts } from './mount';
import { $t, menuText } from '../i18n';

/* ------------------------------------------------------------------------ */
/* macOS menu bar                                                           */
/* ------------------------------------------------------------------------ */

const KEY_NAMES: Record<string, string> = { '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right', '⌫': 'Backspace', '⌦': 'Delete', '↩': 'Enter', esc: 'Escape', '⇥': 'Tab', Leertaste: 'Space' };

/**
 * Converts a shortcut as shown in the menus ("⇧⌘N", "⌥⌘↓") into a Tauri
 * accelerator ("Shift+Cmd+N", "Alt+Cmd+Down").
 */
export function toAccelerator(mac: string): string {
  const parts: string[] = [];
  let key = '';
  for (const ch of mac) {
    if (ch === '⌘') parts.push('Cmd');
    else if (ch === '⇧') parts.push('Shift');
    else if (ch === '⌥') parts.push('Alt');
    else if (ch === '⌃') parts.push('Ctrl');
    else key += ch;
  }
  return [...parts, KEY_NAMES[key] ?? key.toUpperCase()].join('+');
}

/**
 * Shortcuts that also mean something while typing in a text field. They stay
 * visible in the menus of the web view but are not bound natively, so text
 * editing keeps working; the window's own key handling covers the file lists.
 */
const TEXT_KEYS = new Set(['⌘⌫', '⌘↑', '⌘A', '⌘↓']);

async function installMacMenu() {
  const defs = menuDefs();
  const sub = async (id: string, text: string, items: Array<MenuItem | PredefinedMenuItem | Submenu>) => Submenu.new({ id, text: menuText(text), items });
  const custom = async (defId: string, skip: string[] = []) => {
    const def = defs.find((d) => d.id === defId)!;
    const out: Array<MenuItem | PredefinedMenuItem> = [];
    for (const it of def.items) {
      if (skip.includes(it.label)) continue;
      if (it.sep) {
        out.push(await PredefinedMenuItem.new({ item: 'Separator' }));
        continue;
      }
      out.push(await MenuItem.new({
        text: menuText(it.label),
        enabled: !!it.run,
        accelerator: it.mac && !TEXT_KEYS.has(it.mac) ? toAccelerator(it.mac) : undefined,
        action: () => it.run?.(),
      }));
    }
    return out;
  };
  const appDef = defs.find((d) => d.id === 'app')!;
  const item = (label: string) => appDef.items.find((i) => i.label === label)!;
  const sep = () => PredefinedMenuItem.new({ item: 'Separator' });

  const appMenu = await sub('app', 'Bitcrane', [
    await MenuItem.new({ text: menuText($t('Über Bitcrane')), action: () => item($t('Über Bitcrane')).run?.() }),
    // Like other Mac apps: "Nach Updates suchen …" right below "Über Bitcrane".
    await MenuItem.new({ text: menuText($t('Nach Updates suchen …')), action: () => item($t('Nach Updates suchen …')).run?.() }),
    await sep(),
    await MenuItem.new({ text: menuText($t('Einstellungen …')), accelerator: item($t('Einstellungen …')).mac ? toAccelerator(item($t('Einstellungen …')).mac!) : undefined, action: () => item($t('Einstellungen …')).run?.() }),
    await MenuItem.new({ text: menuText($t('Werkzeugleiste anpassen …')), action: () => item($t('Werkzeugleiste anpassen …')).run?.() }),
    await sep(),
    await PredefinedMenuItem.new({ item: 'Hide', text: menuText($t('Bitcrane ausblenden')) }),
    await PredefinedMenuItem.new({ item: 'HideOthers', text: menuText($t('Andere ausblenden')) }),
    await PredefinedMenuItem.new({ item: 'ShowAll', text: menuText($t('Alle einblenden')) }),
    await sep(),
    await MenuItem.new({ text: menuText($t('Bitcrane beenden')), accelerator: 'Cmd+Q', action: quitApp }),
  ]);
  // "Bearbeiten" needs the standard text commands, otherwise ⌘C / ⌘V do not work in text fields.
  const editMenu = await sub('edit', $t('Bearbeiten'), [
    await PredefinedMenuItem.new({ item: 'Undo', text: menuText($t('Widerrufen')) }),
    await PredefinedMenuItem.new({ item: 'Redo', text: menuText($t('Wiederholen')) }),
    await sep(),
    await PredefinedMenuItem.new({ item: 'Cut', text: menuText($t('Ausschneiden')) }),
    await PredefinedMenuItem.new({ item: 'Copy', text: menuText($t('Kopieren')) }),
    await PredefinedMenuItem.new({ item: 'Paste', text: menuText($t('Einsetzen')) }),
    await PredefinedMenuItem.new({ item: 'SelectAll', text: menuText($t('Alles auswählen')) }),
    await sep(),
    // "Alles auswählen" is the standard entry above; it also selects all files in a list.
    ...(await custom('edit', [$t('Alles auswählen'), $t('Kopieren'), $t('Einfügen')])),
  ]);
  const windowMenu = await sub('window', $t('Fenster'), [
    await PredefinedMenuItem.new({ item: 'Minimize', text: menuText($t('Im Dock ablegen')) }),
    await PredefinedMenuItem.new({ item: 'Maximize', text: menuText($t('Zoomen')) }),
    await PredefinedMenuItem.new({ item: 'Fullscreen', text: menuText($t('Vollbild')) }),
    await sep(),
    await PredefinedMenuItem.new({ item: 'CloseWindow', text: menuText($t('Fenster schließen')) }),
  ]);
  const menu = await Menu.new({
    items: [
      appMenu,
      await sub('file', $t('Ablage'), await custom('file')),
      editMenu,
      await sub('view', $t('Darstellung'), await custom('view')),
      await sub('go', $t('Gehe zu'), await custom('go')),
      await sub('server', $t('Server'), await custom('server')),
      await sub('watch', $t('Überwachung'), await custom('watch')),
      windowMenu,
      await sub('help', $t('Hilfe'), await custom('help')),
    ],
  });
  await menu.setAsAppMenu();
}

/* ------------------------------------------------------------------------ */
/* Status icon                                                              */
/* ------------------------------------------------------------------------ */

function trayStatus(s: AppState): { text: string; paused: boolean } {
  const active = s.transfers.filter((t) => t.state === 'running' || t.state === 'queued').length;
  const errors = s.transfers.filter((t) => t.state === 'error').length;
  const watching = s.watches.filter((w) => w.state !== 'paused').length;
  const paused = s.watches.length > 0 && watching === 0;
  if (errors) return { text: errors === 1 ? $t('1 Fehler, bitte ansehen') : $t('{0} Fehler, bitte ansehen', errors), paused };
  if (active) return { text: active === 1 ? $t('Überträgt 1 Datei') : $t('Überträgt {0} Dateien', active), paused };
  if (paused) return { text: menuText($t('Alle Überwachungen pausiert')), paused };
  if (watching) return { text: watching === 1 ? $t('1 Überwachung aktiv') : $t('{0} Überwachungen aktiv', watching), paused };
  return { text: menuText($t('Keine Überwachung aktiv')), paused };
}

/** One entry of the status icon's menu (see tray.rs); no id and no label = separator. */
interface TrayItem { id?: string; label?: string; enabled?: boolean; checked?: boolean; items?: TrayItem[] }
const SEP: TrayItem = {};

/**
 * Menu of the status icon (after Dropbox and Transmit): status, open, new tab,
 * quick connect, the saved servers, the watches (click pauses or resumes one),
 * transfers, updates, settings, hiding the icon, quit.
 */
function trayMenu(s: AppState, st: { text: string; paused: boolean }): TrayItem[] {
  const mac = s.platform === 'mac';
  const servers = s.servers.filter((x) => !x.temporary).slice(0, 20);
  const items: TrayItem[] = [
    { id: 'status', label: st.text, enabled: false },
    SEP,
    { id: 'open', label: menuText($t('Bitcrane öffnen')) },
    { id: 'newTab', label: menuText($t('Neuer Tab')) },
    { id: 'quick', label: menuText($t('Schnell verbinden …')) },
  ];
  if (servers.length) items.push({ id: 'servers', label: menuText($t('Server öffnen')), items: servers.map((x) => ({ id: `server:${x.id}`, label: x.name })) });
  if (s.watches.length) {
    items.push({
      id: 'watches',
      label: menuText($t('Überwachungen')),
      items: [
        ...s.watches.map((w) => ({ id: `watch:${w.id}`, label: w.name, checked: w.state !== 'paused' })),
        SEP,
        { id: 'pauseAll', label: menuText(st.paused ? $t('Alle Überwachungen fortsetzen') : $t('Alle Überwachungen pausieren')) },
      ],
    });
  }
  items.push(
    { id: 'transfers', label: menuText($t('Übertragungen …')) },
    SEP,
    { id: 'updates', label: menuText($t('Nach Updates suchen …')) },
    { id: 'settings', label: menuText($t('Einstellungen …')) },
    { id: 'hideIcon', label: menuText(mac ? $t('Symbol in der Menüleiste ausblenden') : $t('Symbol im Infobereich ausblenden')) },
    SEP,
    { id: 'quit', label: menuText($t('Bitcrane beenden')) },
  );
  return items;
}

let lastTray = '';
function syncTray(s: AppState) {
  const st = trayStatus(s);
  // A hidden start needs the status icon, otherwise Bitcrane could not be reached.
  const visible = s.settings.showMenuBarIcon || !!s.startedHidden;
  const items = trayMenu(s, st);
  const key = `${visible}|${JSON.stringify(items)}`;
  if (key === lastTray) return;
  lastTray = key;
  backend.trayUpdate(visible, st.text, items).catch(() => undefined);
}

/** Actions from the status icon's menu. */
function onTrayAction(id: string) {
  if (id === 'pauseAll') pauseAllWatches();
  else if (id === 'quit') void quitApp();
  else if (id === 'newTab') newTab();
  else if (id === 'quick') openDialog({ type: 'quickConnect' });
  else if (id === 'transfers') openDialog({ type: 'transfers' });
  else if (id === 'updates') void checkForUpdates(true);
  else if (id === 'settings') openDialog({ type: 'settings', tab: 'general' });
  else if (id === 'hideIcon') {
    updateSettings({ showMenuBarIcon: false });
    void notify('Bitcrane', getState().platform === 'mac'
      ? $t('Das Symbol ist ausgeblendet. Wieder einschalten: Einstellungen › Allgemein › Symbol in der Menüleiste.')
      : $t('Das Symbol ist ausgeblendet. Wieder einschalten: Einstellungen › Allgemein › Symbol im Infobereich.'));
  } else if (id.startsWith('server:')) openServerInNewTab(id.slice(7));
  else if (id.startsWith('watch:')) toggleWatch(id.slice(6));
}

/* ------------------------------------------------------------------------ */
/* Notifications, tones and app icon progress                               */
/* ------------------------------------------------------------------------ */

let notifyAllowed: boolean | null = null;
export async function notify(title: string, body: string) {
  try {
    if (notifyAllowed === null) {
      notifyAllowed = await isPermissionGranted();
      if (!notifyAllowed) notifyAllowed = (await requestPermission()) === 'granted';
    }
    if (notifyAllowed) sendNotification({ title, body });
  } catch {
    // Notifications not available on this system.
  }
}

let seen = new Map<string, Transfer['state']>();
let batchDone = 0;
let batchHadError = false;

function onTransfers(s: AppState, focused: boolean) {
  const next = new Map(s.transfers.map((t) => [t.id, t.state] as const));
  for (const t of s.transfers) {
    const before = seen.get(t.id);
    if (before === t.state) continue;
    if (t.state === 'error' && before !== 'error') {
      batchHadError = true;
      if (s.settings.soundOnError) playErrorSound();
      if (s.settings.notify !== 'none') {
        const server = s.servers.find((x) => x.id === t.serverId)?.name ?? $t('Server');
        notify(`${t.name}: ${t.error ?? $t('Fehler')}`, $t('{0}, {1}. Bitcrane öffnen, um es zu beheben.', server, t.folder));
      }
    }
    if (t.state === 'done' && before && before !== 'done' && t.direction !== 'command') batchDone++;
  }
  seen = next;
  const busy = s.transfers.some((t) => t.state === 'running' || t.state === 'queued');
  if (!busy && batchDone > 0) {
    if (!batchHadError) {
      if (s.settings.soundOnDone) playDoneSound();
      if (s.settings.notify === 'all' && !focused) notify($t('Alles übertragen'), batchDone === 1 ? $t('1 Datei übertragen.') : $t('{0} Dateien übertragen.', batchDone));
    }
    batchDone = 0;
    batchHadError = false;
  }
}

let lastProgress = '';
function syncProgress(s: AppState) {
  const win = getCurrentWindow();
  const active = s.transfers.filter((t) => t.state === 'running' || t.state === 'queued');
  const total = active.reduce((a, t) => a + Math.max(1, t.size), 0);
  const done = active.reduce((a, t) => a + Math.min(t.done, t.size), 0);
  const show = s.settings.dockProgress && active.length > 0;
  const pct = show ? Math.max(1, Math.round((done / total) * 100)) : 0;
  const key = `${show}|${pct}|${active.length}`;
  if (key === lastProgress) return;
  lastProgress = key;
  win.setProgressBar(show ? { status: ProgressBarStatus.Normal, progress: pct } : { status: ProgressBarStatus.None }).catch(() => undefined);
  // The count badge exists on macOS (and some Linux docks), not on Windows.
  win.setBadgeCount(show ? active.length : undefined).catch(() => undefined);
}

/* ------------------------------------------------------------------------ */
/* Start                                                                    */
/* ------------------------------------------------------------------------ */

let started = false;

/** Starts the desktop integration once (live mode only). */
export async function startShell() {
  if (started) return;
  started = true;
  const win = getCurrentWindow();
  let focused = true;
  win.onFocusChanged(({ payload }) => { focused = payload; }).catch(() => undefined);

  if (getState().platform === 'mac') {
    await installMacMenu().catch(() => undefined);
    // Own shortcuts: rebuild the menu so it shows and uses the new keys.
    let keys = getState().settings.shortcuts;
    subscribeStore(() => {
      const next = getState().settings.shortcuts;
      if (next !== keys) {
        keys = next;
        void installMacMenu().catch(() => undefined);
      }
    });
  }

  // Closing the window keeps Bitcrane running when that is switched on.
  await win.onCloseRequested(async (e) => {
    if (getState().settings.runInBackground) {
      e.preventDefault();
      await win.hide();
      return;
    }
    // Closing quits Bitcrane: install an update that is already loaded first.
    if (getState().update?.status === 'ready') {
      e.preventDefault();
      quitApp();
    }
  });

  // sftp:// links: the first one may have started the app.
  const deepLink = await import('@tauri-apps/plugin-deep-link').catch(() => null);
  if (deepLink) {
    const open = (urls: string[] | null) => {
      for (const u of urls ?? []) {
        if (u.startsWith('sftp:')) openSftpLink(u);
        // Finder Quick Action "Mit Bitcrane hochladen".
        else if (u.startsWith('bitcrane://upload')) receiveUploadPaths(uploadPathsFromLink(u));
      }
    };
    const waitConfig = () => (isConfigLoaded() ? Promise.resolve() : new Promise<void>((r) => { const t = window.setInterval(() => { if (isConfigLoaded()) { window.clearInterval(t); r(); } }, 100); }));
    void waitConfig().then(() => deepLink.getCurrent().then(open).catch(() => undefined));
    await deepLink.onOpenUrl((urls) => { void waitConfig().then(() => open(urls)); }).catch(() => undefined);
    // Windows registers the link type when the setting is on (the Mac declares it in the app bundle).
    if (getState().platform === 'win') {
      let linksOn: boolean | null = null;
      const syncLinks = () => {
        const on = getState().settings.sftpLinks;
        if (!isConfigLoaded() || on === linksOn) return;
        linksOn = on;
        void (on ? deepLink.register('sftp') : deepLink.unregister('sftp')).catch(() => undefined);
      };
      subscribeStore(syncLinks);
      syncLinks();
    }
  }

  await listen<string>('tray-action', (e) => onTrayAction(e.payload));

  // "Mit Bitcrane hochladen" from the Explorer: paths of a second start, and the ones Bitcrane was started with.
  await listen<string[]>('upload-files', (e) => receiveUploadPaths(e.payload));
  const whenLoaded = () => (isConfigLoaded() ? Promise.resolve() : new Promise<void>((r) => { const t = window.setInterval(() => { if (isConfigLoaded()) { window.clearInterval(t); r(); } }, 100); }));
  void whenLoaded().then(async () => {
    const first = await backend.takePendingUploads().catch(() => [] as string[]);
    if (first.length) receiveUploadPaths(first);
    // The context-menu entry follows the setting.
    let shellOn: boolean | undefined;
    const syncShell = () => {
      const on = getState().settings.shellIntegration !== false;
      if (on === shellOn) return;
      shellOn = on;
      void applyShellIntegration();
    };
    subscribeStore(syncShell);
    syncShell();
    // Servers shown as folders in the Windows Explorer.
    void initMounts();
    void import('./terminal').then((m) => m.initTerminals());
  });

  // Start at login follows the setting.
  let autostart = await autostartEnabled().catch(() => false);
  let autostartSynced = false;

  let prev: AppState | null = null;
  const onChange = () => {
    const s = getState();
    if (prev === s) return;
    if (!prev || prev.transfers !== s.transfers) {
      onTransfers(s, focused);
      syncProgress(s);
    }
    if (!prev || prev.transfers !== s.transfers || prev.watches !== s.watches || prev.settings !== s.settings || prev.servers !== s.servers) syncTray(s);
    // Only after the saved settings are loaded, otherwise the defaults would switch it off.
    if (isConfigLoaded() && (!prev || prev.settings.startAtLogin !== s.settings.startAtLogin || !autostartSynced)) {
      autostartSynced = true;
      const want = s.settings.startAtLogin;
      // First sync after the start: register again, so an older entry gets the "--autostart" argument.
      if (want !== autostart || (want && !prev)) {
        autostart = want;
        (want ? enableAutostart() : disableAutostart()).catch(() => undefined);
      }
    }
    prev = s;
  };
  subscribeStore(onChange);
  onChange();
}
