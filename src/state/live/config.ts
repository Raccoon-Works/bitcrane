/**
 * Loading and saving the configuration (servers, settings, tabs) through the backend.
 */
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { type Server, type Watch, type Transfer, type Tab } from '../../backend/types';
import { emptyTab, showToast, getState, setState, uid } from '../core';
import type { AppState, SavedTab } from '../appState';
import { oldDefaultToolbars } from '../defaults';
import { savedTabs, tabsFromSaved } from '../tools';
import { $t, LANG, rememberLanguage } from '../../i18n';
import { updateSettings } from '../settings';
import { openDialog } from '../panels';
import { toBackendError } from '../../backend/api';
import { showError } from '../errors';
import { addLog } from '../log';
import { withTerminalButton, firstStartOffers, connectServer, autoConnect } from './connections';
import { reopenTerminals } from '../terminal';
import { selectTab } from '../tabs';
import { pump } from './transfers';

export interface StoredConfig {
  version: 1;
  servers: Server[];
  watches: Watch[];
  settings: AppState['settings'];
  toolbar: AppState['toolbar'];
  toolbarLabels: AppState['toolbarLabels'];
  /** Unfinished manual transfers; they continue after a restart. Watches catch up on their own. */
  queue?: Transfer[];
  /** Open tabs of the last session ("Beim Start öffnen: Zuletzt geöffnete Tabs"). */
  tabs?: SavedTab[];
  activeTab?: number;
}

let loaded = false;

/** The first tab after starting: "Beim Start öffnen" in the settings. */
function startTab(servers: Server[], settings: AppState['settings']): Tab {
  const tab = emptyTab(settings.startLocal?.trim() || '~', settings.newTabRight);
  const srv = settings.startServer ? servers.find((x) => x.id === settings.startServer) : undefined;
  return srv ? { ...tab, serverId: srv.id, remotePath: srv.remoteStart, rightLocal: undefined } : tab;
}

/** True once the saved configuration has been read. */
export const isConfigLoaded = () => loaded;
let saveTimer: number | undefined;
let lastSaved = '';

function snapshot(s: AppState): string {
  const cfg: StoredConfig = {
    version: 1,
    servers: s.servers.filter((x) => !x.temporary).map((x) => ({ ...x, online: false })),
    watches: s.watches.map((w) => ({ ...w, state: w.state === 'paused' ? 'paused' : 'active' })),
    settings: s.settings,
    toolbar: s.toolbar,
    toolbarLabels: s.toolbarLabels,
    tabs: savedTabs(s.tabs),
    activeTab: Math.max(
      0,
      s.tabs.findIndex((t) => t.id === s.activeTabId),
    ),
    // Progress is left out, so the file is not rewritten on every progress step.
    queue: s.transfers
      .filter(
        (t) =>
          t.direction !== 'command' &&
          !t.watchId &&
          t.editMtime === undefined &&
          (t.state === 'queued' || t.state === 'running' || t.state === 'paused'),
      )
      .filter((t) => !s.servers.find((x) => x.id === t.serverId)?.temporary)
      .map((t) => ({
        ...t,
        state: t.state === 'paused' && !t.hold ? 'paused' : 'queued',
        done: 0,
        error: undefined,
        errorDetail: undefined,
        hold: undefined,
      })),
  };
  return JSON.stringify(cfg);
}

export function scheduleSave(s: AppState) {
  if (!loaded) return;
  const snap = snapshot(s);
  // Cancel first: a change that was undone again must not be written later.
  window.clearTimeout(saveTimer);
  if (snap === lastSaved) return;
  saveTimer = window.setTimeout(() => {
    lastSaved = snap;
    backend
      .configSave(JSON.parse(snap))
      .catch(() => showToast($t('Einstellungen konnten nicht gespeichert werden.'), 'error'));
  }, 400);
}

/** Reads the drives and volumes of this computer for the sidebar. */
async function loadDrives() {
  const drives = await backend.localDrives().catch(() => []);
  const cur = getState().drives;
  if (drives.length !== cur.length || drives.some((d, i) => d.path !== cur[i].path || d.name !== cur[i].name))
    setState({ drives });
}

/** Writes pending changes at once (before quitting). */
/** After an update (installed on quit or with a restart) a short message names the new version once. */
export async function announceUpdate() {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    const now = await getVersion();
    const before = getState().settings.lastVersion;
    if (before === now) return;
    updateSettings({ lastVersion: now });
    if (before) showToast($t('Bitcrane wurde auf {0} aktualisiert.', now), 'update');
  } catch {
    // Unknown version: no message.
  }
}

export async function saveNow() {
  if (!loaded) return;
  window.clearTimeout(saveTimer);
  const snap = snapshot(getState());
  if (snap === lastSaved) return;
  lastSaved = snap;
  await backend.configSave(JSON.parse(snap)).catch(() => undefined);
}

/**
 * Start at login ("--autostart"): with "Beim Start nur im Infobereich" the window stays hidden and
 * only the status icon is there; otherwise it opens now. A normal start already showed it (Rust).
 */
/** Mac: one-time hint about "Festplattenvollzugriff" (Full Disk Access). */
export function showDiskAccessHint() {
  setState((st) => ({ settings: { ...st.settings, diskAccessHinted: true } }));
  openDialog({
    type: 'confirm',
    title: $t('Zugriff auf deine Ordner'),
    text: $t(
      'macOS fragt bei jedem geschützten Ordner (Schreibtisch, Dokumente, Downloads, iCloud, Cloud-Ordner) einzeln, ob Bitcrane ihn lesen darf. Statt vieler einzelner Fragen kannst du Bitcrane einmal den „Festplattenvollzugriff“ geben: Systemeinstellungen › Datenschutz & Sicherheit › Festplattenvollzugriff › Bitcrane einschalten. Das geht auch später unter Einstellungen › Allgemein.',
    ),
    confirm: $t('Systemeinstellungen öffnen'),
    run: () => {
      void backend.openFullDiskAccess().catch(() => undefined);
    },
  });
}

async function decideStartWindow() {
  try {
    const atLogin = await backend.startInfo();
    if (atLogin && getState().settings.startHidden) setState({ startedHidden: true });
    else if (atLogin) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().show();
    }
    await backend.startDecided();
  } catch {
    // Rust shows the window by itself after a while.
  }
}

export async function loadConfig() {
  let cfg: Partial<StoredConfig> | null = null;
  try {
    cfg = (await backend.configLoad()) as Partial<StoredConfig> | null;
  } catch (e) {
    // The backend kept a copy of the broken file, so starting empty loses nothing.
    const err = toBackendError(e);
    cfg = null;
    window.setTimeout(() => showError(err, { log: 'done' }), 500);
    addLog('error', err.message, undefined, err.detail);
  }
  // Old bookmarks (folder pairs) become places of their server.
  // Up to 0.2.14 the import gave every server a colour in turn; nobody chose them. Reset once to "no colour".
  const resetColours = !!cfg && !cfg.settings?.coloursReset;
  const servers = (cfg?.servers ?? [])
    .map((x) =>
      x.bookmarks?.length && !x.places
        ? { ...x, places: x.bookmarks.map((b) => ({ name: b.name, path: b.remote })), bookmarks: undefined }
        : x,
    )
    .map((x) => (resetColours ? { ...x, color: 'gray' as const } : x));
  // The language is read before the settings file at start; keep both in step.
  if (cfg?.settings?.language && cfg.settings.language !== LANG) rememberLanguage(cfg.settings.language);
  setState((s) => ({
    servers,
    // Watches run again after a start, unless paused or set not to start with Bitcrane.
    watches: (cfg?.watches ?? []).map((w) => ({
      ...w,
      state: w.state === 'paused' || w.options?.startWithApp === false ? 'paused' : 'active',
    })),
    // Older versions had a single switch "Automatisch nach Updates suchen".
    settings: {
      ...s.settings,
      ...(cfg?.settings ?? {}),
      toolbarTerminalAdded: true,
      ...(cfg?.settings && !cfg.settings.updateMode && (cfg.settings as { autoUpdate?: boolean }).autoUpdate === false
        ? { updateMode: 'off' as const }
        : {}),
      coloursReset: true,
    },
    // A toolbar never changed by hand moves to the new standard set.
    toolbar: withTerminalButton(
      cfg,
      (cfg?.toolbar && !oldDefaultToolbars.some((old) => old.join() === cfg.toolbar!.join())
        ? cfg.toolbar
        : s.toolbar
      ).filter((x) => (x as string) !== 'sidebar'),
    ),
    toolbarLabels: cfg?.toolbarLabels ?? s.toolbarLabels,
    // The server list in the right half greets new users; no separate first-run screen.
    firstRun: false,
    // Unfinished transfers of the last session continue (from their partial files).
    transfers: (cfg?.queue ?? [])
      .filter((t) => servers.some((x) => x.id === t.serverId))
      .map((t) => ({ ...t, id: uid('t') })),
    // Bitcrane starts locally without a server (like WinSCP's "Neuer Tab"), unless a start server is set
    // or "Tabs vom letzten Mal wieder öffnen" is on.
    tabs: [startTab(servers, { ...s.settings, ...(cfg?.settings ?? {}) })],
  }));
  const restored = cfg?.settings?.restoreTabs && cfg.tabs?.length ? tabsFromSaved(cfg.tabs) : [];
  if (restored.length) {
    setState({ tabs: restored });
    // Terminals of the last session come back with their tabs (they start when shown).
    restored.forEach((t, i) => {
      const saved = cfg?.tabs?.[i];
      if (saved?.terminals?.length) reopenTerminals(t.id, saved.terminals, !!saved.terminalOpen, !!saved.terminalFull);
    });
    // Selecting the tab connects its server(s); the other tabs connect when they are opened.
    selectTab(restored[Math.min(cfg?.activeTab ?? 0, restored.length - 1)].id);
  } else setState((s) => ({ activeTabId: s.tabs[0]?.id ?? '' }));
  lastSaved = snapshot(getState());
  loaded = true;
  void decideStartWindow();
  // Mac: macOS asks once per protected folder (Schreibtisch, Dokumente, Downloads, iCloud …).
  // Explain once how to allow all of them at once.
  // Real macOS only (the Linux test build shows the Mac look as well).
  if (
    getState().platform === 'mac' &&
    navigator.userAgent.includes('Macintosh') &&
    !getState().settings.diskAccessHinted
  ) {
    // Waits until no other window (e.g. the cloud folders offer) is open.
    const tryHint = () => (getState().dialog ? window.setTimeout(tryHint, 3000) : showDiskAccessHint());
    window.setTimeout(tryHint, 2500);
  }
  // Saved comparisons with a schedule run by themselves from now on.
  void import('../scheduler').then((m) => m.startScheduler());
  // Which cloud services this build can add (app keys are put in at build time).
  void import('../cloud').then((m) => m.loadCloudServices());
  try {
    const [places, home] = await Promise.all([backend.localPlaces(), backend.localStat('~')]);
    setState({ homeName: home.name, ...(places.length ? { places } : {}) });
  } catch {
    // Keep the default places.
  }
  void loadDrives();
  // First start: offer the servers of other programs, then the cloud folders as places (Transmit).
  window.setTimeout(() => void firstStartOffers(), 800);
  // A USB stick or network drive may come and go; look again when the window gets the focus.
  window.addEventListener('focus', () => void loadDrives());
  const activeTabNow = getState().tabs.find((t) => t.id === getState().activeTabId);
  const activeServer = activeTabNow?.serverId;
  // Server to server: the left server connects after the right one, so two password prompts never overlap.
  const leftServer = activeTabNow?.leftServerId;
  if (activeServer)
    void connectServer(activeServer).then(() => {
      if (leftServer) autoConnect(leftServer);
    });
  if (getState().transfers.length) pump();
  addLog(
    'info',
    $t(
      'Bitcrane gestartet, {0} {1}, {2} Überwachungen',
      servers.length,
      servers.length === 1 ? $t('Server') : $t('Server'),
      getState().watches.length,
    ),
  );
}

/** Cloud storage folders of this computer (empty when the lookup fails). */
export async function cloudPlaces() {
  return backend.localCloudPlaces().catch(() => []);
}

/**
 * "Schnell verbinden": parses "user@host:port/path". Host names from
 * ~/.ssh/config (aliases) are resolved when that setting is on.
 */
export async function quickConnect(
  address: string,
  save: boolean,
  auth: 'auto' | 'key' | 'password',
): Promise<Server | null> {
  // Optional scheme: sftp:// (default), ftp://, ftps://, ftpes:// (explicit TLS), webdav:// / davs://, smb://.
  const scheme =
    address
      .trim()
      .match(/^([a-z]+):\/\//i)?.[1]
      ?.toLowerCase() ?? 'sftp';
  const protocol: Server['protocol'] =
    scheme === 'ftp'
      ? 'ftp'
      : scheme === 'ftps' || scheme === 'ftpes'
        ? 'ftps'
        : scheme === 'webdav' || scheme === 'davs' || scheme === 'dav'
          ? 'webdav'
          : scheme === 'smb'
            ? 'smb'
            : 'sftp';
  const m = address
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .match(/^(?:([^@]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/);
  if (!m) {
    showToast($t('Adresse nicht erkannt. Beispiele: ubuntu@server.example:22, ftp://web@host.example'), 'error');
    return null;
  }
  const [, userPart, hostPart, portPart, path] = m;
  let host = hostPart;
  let user = userPart ?? '';
  const defaultPort =
    protocol === 'ftp'
      ? 21
      : protocol === 'ftps'
        ? scheme === 'ftps'
          ? 990
          : 21
        : protocol === 'webdav'
          ? scheme === 'dav'
            ? 80
            : 443
          : protocol === 'smb'
            ? 445
            : 22;
  let port = portPart ? Number(portPart) : defaultPort;
  let keyPath = '~/.ssh/id_ed25519';
  let method: Server['auth'] = auth === 'password' ? 'password' : auth === 'key' ? 'key' : 'auto';
  if (protocol !== 'sftp') {
    return {
      id: uid('srv'),
      name: hostPart,
      mono: hostPart.slice(0, 2).toUpperCase(),
      color: 'gray',
      host,
      port,
      user,
      auth: 'password',
      keyPath,
      group: '',
      localStart: '~',
      remoteStart: protocol === 'webdav' ? '' : path || '',
      online: false,
      temporary: !save,
      protocol,
      implicitTls: scheme === 'ftps' || undefined,
      davPath: protocol === 'webdav' ? path || '/' : undefined,
      davHttps: protocol === 'webdav' ? scheme !== 'dav' : undefined,
      smbShare: protocol === 'smb' ? path?.split('/').filter(Boolean)[0] : undefined,
    };
  }
  if (getState().settings.readSshConfig) {
    const alias = (await backend.sshConfigHosts().catch(() => [])).find((h) => h.alias === hostPart);
    if (alias) {
      host = alias.host;
      user = userPart ?? alias.user;
      port = portPart ? port : alias.port;
      if (alias.identityFile) {
        keyPath = alias.identityFile;
        if (auth === 'auto') method = 'key';
      }
    }
  }
  if (!user) {
    showToast($t('Bitte einen Benutzer angeben, zum Beispiel ubuntu@server.example.'), 'error');
    return null;
  }
  return {
    id: uid('srv'),
    name: hostPart,
    mono: hostPart.slice(0, 2).toUpperCase(),
    color: 'gray',
    host,
    port,
    user,
    auth: method,
    keyPath,
    group: '',
    localStart: '~',
    remoteStart: path || '',
    online: false,
    temporary: !save,
  };
}
