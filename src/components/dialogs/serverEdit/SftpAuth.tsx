/**
 * Server editor fields for the SFTP login: the method and, for keys, the key
 * file with its type and whether its passphrase is stored.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, KeyRound } from '../../glyphs';
import type { KeyInfo } from '../../../backend/api';
import type { AuthMethod, Server } from '../../../backend/types';
import { tauriBackend as backend } from '../../../backend/tauriBackend';
import { chooseFile } from '../../../backend/dialogs';
import { hasStoredSecret } from '../../../state/live';
import { LIVE, useStore } from '../../../state/store';
import { KeyPanel } from '../../KeyPanel';
import { Button, Segmented, TextField } from '../../ui';
import { $t } from '../../../i18n';
import { keychainLong, keychainShort, type SetField } from './model';

export function SftpAuth({ draft, set }: { draft: Server; set: SetField }) {
  const platform = useStore((s) => s.platform);
  const store = keychainShort(platform);
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const [keyPanel, setKeyPanel] = useState(false);
  const [secretStored, setSecretStored] = useState(false);

  // Key type and whether its passphrase is in the keychain (desktop app only).
  useEffect(() => {
    if (!LIVE || (draft.auth !== 'key' && draft.auth !== 'auto')) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void backend.keyInfo(draft.keyPath).then((k) => {
        if (!cancelled) setKeyInfo(k);
      });
      void hasStoredSecret(draft).then((v) => {
        if (!cancelled) setSecretStored(v);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- checked again only when the key or the login method changes
  }, [draft.keyPath, draft.auth]);

  const chooseKey = async () => {
    const picked = await chooseFile($t('SSH-Schlüssel wählen'));
    if (picked) set('keyPath', picked);
  };

  return (
    <>
      <span>{$t('Anmeldung')}</span>
      <div className="row-inline">
        <Segmented<AuthMethod>
          label={$t('Anmeldung')}
          value={draft.auth}
          onChange={(v) => set('auth', v)}
          options={[
            { value: 'auto', label: $t('Automatisch') },
            { value: 'key', label: $t('SSH-Schlüssel') },
            { value: 'agent', label: 'SSH-Agent' },
            { value: 'password', label: $t('Passwort') },
          ]}
        />
      </div>

      {draft.auth === 'auto' && (
        <>
          <span>{$t('Reihenfolge')}</span>
          <span className="small muted">
            {$t(
              'Erst der SSH-Agent, dann der Schlüssel unten und die üblichen Schlüssel aus ~/.ssh, zuletzt das Passwort. Fragt der Server nach einem Einmalcode, fragt Bitcrane dich.',
            )}
          </span>
        </>
      )}
      {(draft.auth === 'key' || draft.auth === 'auto') && (
        <>
          <label htmlFor="s-key">{$t('Schlüssel')}</label>
          <div className="col-text">
            <div className="field-row">
              <TextField id="s-key" mono value={draft.keyPath} onChange={(v) => set('keyPath', v)} className="flex-1" />
              <Button onClick={() => (LIVE ? void chooseKey() : undefined)}>{$t('Auswählen …')}</Button>
              <Button onClick={() => setKeyPanel(!keyPanel)} aria-expanded={keyPanel}>
                {$t('Neu …')}
              </Button>
            </div>
            {keyPanel && (
              <KeyPanel server={draft} onCreated={(p) => set('keyPath', p)} onClose={() => setKeyPanel(false)} />
            )}
            {!LIVE && (
              <span className="small tone-ok row-inline">
                <Check size={12} strokeWidth={2.2} aria-hidden="true" />
                {$t('ED25519 · Passphrase {0} gespeichert', store)}
              </span>
            )}
            {/* "Automatisch" only tries the key; a missing one is normal there (agent or password follow). */}
            {LIVE &&
              keyInfo &&
              !keyInfo.exists &&
              (draft.auth === 'auto' ? (
                <span className="small muted">
                  {$t('Kein Schlüssel unter diesem Pfad. Dann versucht Bitcrane den Agent und das Passwort.')}
                </span>
              ) : (
                <span className="small tone-danger row-inline">
                  <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
                  {$t('Datei nicht gefunden')}
                </span>
              ))}
            {LIVE && keyInfo?.invalid && (
              <span className="small tone-danger row-inline">
                <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
                {$t('Das ist kein privater SSH-Schlüssel')}
              </span>
            )}
            {LIVE && keyInfo?.exists && !keyInfo.invalid && (
              <span className="small muted row-inline">
                <KeyRound size={12} strokeWidth={1.75} aria-hidden="true" />
                {[
                  keyInfo.algorithm,
                  keyInfo.encrypted
                    ? secretStored
                      ? $t('Passphrase {0} gespeichert', store)
                      : $t('mit Passphrase, wird beim Verbinden abgefragt')
                    : $t('ohne Passphrase'),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </div>
        </>
      )}
      {draft.auth === 'password' && (
        <>
          <span>{$t('Passwort')}</span>
          <span className="small muted">
            {$t('Wird beim ersten Verbinden abgefragt und')} {keychainLong(platform)}{' '}
            {$t('gespeichert, nie in Bitcrane selbst.')}
          </span>
        </>
      )}
      {draft.auth === 'agent' && (
        <>
          <span>{$t('Agent')}</span>
          <span className="small muted">
            {$t('Nutzt die Schlüssel, die im SSH-Agent geladen sind (z. B. aus 1Password, Bitwarden oder ssh-agent).')}
          </span>
        </>
      )}
    </>
  );
}
