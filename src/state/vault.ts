/**
 * Cryptomator vaults (see src-tauri/src/vault.rs). An unlocked vault is a
 * temporary "server" with the protocol 'vault': it opens in a new tab and
 * works like any other server, the backend encrypts and decrypts on the fly.
 * The password prompt is the normal one; locking is closing the tab.
 */
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { Server } from '../backend/types';
import { $t } from '../i18n';
import { basename, join } from '../util/paths';
import type { PaneSide } from '../backend/types';
import { closeDialog, getState, LIVE, newServerTemplate, openServerInNewTab, paneLoc, panePath, refresh, setState, showToast } from './store';

/** Whether a folder listing is the inside of a Cryptomator vault. */
export const isVaultListing = (names: string[]) => names.includes('vault.cryptomator') && names.includes('masterkey.cryptomator');

/** Server the folder of a half lies on, or undefined for this computer. */
function storageOf(side: PaneSide): string | undefined {
  const [kind, id] = paneLoc(side);
  return kind === 'remote' ? id : undefined;
}

/** Unlocks the vault shown in a half: opens it in a new tab (asks for the password). */
export function unlockVault(side: PaneSide) {
  const location = panePath(side);
  const storage = storageOf(side);
  const existing = getState().servers.find((x) => x.protocol === 'vault' && x.host === location && x.vaultStorageId === storage);
  if (existing) {
    openServerInNewTab(existing.id);
    return;
  }
  const name = basename(location) || $t('Tresor');
  const srv: Server = {
    ...newServerTemplate(),
    name, mono: name.slice(0, 2).toUpperCase(), protocol: 'vault', host: location, port: 0,
    // Part of the keychain entry, so equal paths on different servers do not mix.
    user: storage ?? 'local', auth: 'password', keyPath: '', remoteStart: '/', group: '', proxy: undefined,
    temporary: true, vaultStorageId: storage,
  };
  setState((s) => ({ servers: [...s.servers, srv] }));
  openServerInNewTab(srv.id);
}

/** Creates a new vault in the folder of a half and shows it. */
export async function createVault(side: PaneSide, name: string, password: string): Promise<boolean> {
  const location = join(panePath(side), name.trim());
  if (!LIVE) {
    showToast($t('Tresor „{0}“ angelegt.', name), 'ok');
    closeDialog();
    return true;
  }
  try {
    await backend.vaultCreate(location, storageOf(side), password);
  } catch (e) {
    showToast((e as { message?: string }).message ?? String(e), 'error');
    return false;
  }
  closeDialog();
  refresh();
  showToast($t('Tresor „{0}“ angelegt. Zum Öffnen hineingehen und „Entsperren“ wählen.', name), 'ok');
  return true;
}
