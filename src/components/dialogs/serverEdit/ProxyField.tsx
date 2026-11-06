/**
 * Server editor › Weitere Einstellungen › Proxy: kind, address, user and the
 * proxy password, which goes to the keychain only.
 */
import { useEffect, useState } from 'react';
import type { Server } from '../../../backend/types';
import { tauriBackend as backend } from '../../../backend/tauriBackend';
import { proxyAccount } from '../../../state/live';
import { LIVE, useStore } from '../../../state/store';
import { Select, TextField } from '../../ui';
import { $t } from '../../../i18n';
import { keychainShort, type SetField } from './model';

export function ProxyField({
  draft,
  set,
  proxyPassword,
  setProxyPassword,
}: {
  draft: Server;
  set: SetField;
  proxyPassword: string;
  setProxyPassword: (v: string) => void;
}) {
  const platform = useStore((s) => s.platform);
  const [proxyStored, setProxyStored] = useState(false);
  useEffect(() => {
    const p = draft.proxy;
    if (!LIVE || !p?.user || !p.host) {
      setProxyStored(false);
      return;
    }
    backend
      .secretGet(proxyAccount(p))
      .then((v) => setProxyStored(v !== null))
      .catch(() => setProxyStored(false));
  }, [draft.proxy]);

  return (
    <>
      <label htmlFor="s-proxy">{$t('Proxy')}</label>
      <div className="col-text">
        <div className="field-row">
          <Select
            id="s-proxy"
            label={$t('Proxy')}
            value={draft.proxy?.kind ?? 'none'}
            onChange={(v) =>
              set(
                'proxy',
                v === 'none'
                  ? undefined
                  : {
                      host: '',
                      port: v === 'http' ? 8080 : 1080,
                      ...draft.proxy,
                      kind: v as 'socks5' | 'http',
                    },
              )
            }
            options={[
              { value: 'none', label: $t('Kein Proxy') },
              { value: 'socks5', label: 'SOCKS5' },
              { value: 'http', label: 'HTTP (CONNECT)' },
            ]}
          />
          {draft.proxy && (
            <>
              <TextField
                label={$t('Proxy-Adresse')}
                value={draft.proxy.host}
                onChange={(v) => set('proxy', { ...draft.proxy!, host: v.trim() })}
                placeholder="proxy.example"
                className="flex-1"
              />
              <TextField
                label={$t('Proxy-Port')}
                value={String(draft.proxy.port)}
                onChange={(v) => set('proxy', { ...draft.proxy!, port: Number(v.replace(/\D/g, '')) || 1080 })}
                className="port-field"
              />
            </>
          )}
        </div>
        {draft.proxy && (
          <div className="field-row">
            <TextField
              label={$t('Proxy-Benutzer')}
              value={draft.proxy.user ?? ''}
              onChange={(v) => set('proxy', { ...draft.proxy!, user: v.trim() || undefined })}
              placeholder={$t('Benutzer (falls nötig)')}
              className="flex-1"
            />
            {draft.proxy.user && (
              <TextField
                type="password"
                label={$t('Proxy-Passwort')}
                value={proxyPassword}
                onChange={setProxyPassword}
                placeholder={proxyStored ? $t('{0} gespeichert', keychainShort(platform)) : $t('Passwort')}
                className="flex-1"
              />
            )}
          </div>
        )}
        {draft.jumpServerId && draft.proxy && (
          <span className="small muted">{$t('Mit Sprungserver gilt dessen Proxy-Einstellung.')}</span>
        )}
      </div>
    </>
  );
}
