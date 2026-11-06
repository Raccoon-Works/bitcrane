/**
 * Server management: list of saved servers on the left, the selected
 * server's settings on the right. Opens for a new server when no id is given.
 * This module keeps the server being edited, the protocol switch, the
 * connection test and saving; the sections of the form live next to it.
 */
import { useEffect, useState } from 'react';
import { Check, Trash2 } from '../../glyphs';
import { tauriBackend as backend } from '../../../backend/tauriBackend';
import { isCloudProtocol, type Protocol, type Server } from '../../../backend/types';
import { proxyAccount, testServer } from '../../../state/live';
import {
  askRemoveServer,
  closeDialog,
  getState,
  LIVE,
  monoFor,
  newServerTemplate,
  openDialog,
  saveServer,
  showToast,
  useStore,
} from '../../../state/store';
import { CLOUD_NAMES, googleKey, saveGoogleKey, showCloudNotSetUp } from '../../../state/cloud';
import { Button } from '../../ui';
import { Dialog } from '../Dialog';
import { $t } from '../../../i18n';
import { CloudFields } from './CloudFields';
import { CommonFields } from './CommonFields';
import { ConnectionFields } from './ConnectionFields';
import { DetailHead } from './DetailHead';
import { cloudDefaults, familyOf, S3_PROVIDERS, STANDARD_PORTS, type Fam, type SetField } from './model';
import { MoreSettings } from './MoreSettings';
import { ServerListPane } from './ServerListPane';
import { SftpAuth } from './SftpAuth';

export function ServerEdit({
  serverId,
  cloud: presetCloud,
  terminal,
  preset,
}: {
  serverId?: string;
  cloud?: Protocol;
  terminal?: boolean;
  preset?: Partial<Server>;
}) {
  const servers = useStore((s) => s.servers).filter((x) => !x.temporary);
  const [currentId, setCurrentId] = useState<string | undefined>(serverId);
  const [draft, setDraft] = useState<Server>(
    () =>
      servers.find((x) => x.id === serverId) ??
      (presetCloud
        ? { ...newServerTemplate(), ...cloudDefaults(presetCloud) }
        : { ...newServerTemplate(), ...(terminal ? { openAs: 'terminal' as const } : {}), ...(preset ?? {}) }),
  );
  // The user's own Google app key (Google Drive only): the id from the settings, the secret only typed here.
  const [googleId, setGoogleId] = useState(() => getState().settings.googleClientId ?? '');
  const [googleSecret, setGoogleSecret] = useState('');
  const [googleStored, setGoogleStored] = useState(false);
  useEffect(() => {
    void googleKey().then((k) => setGoogleStored(!!k?.clientSecret));
  }, []);
  const [test, setTest] = useState<'idle' | 'running' | 'ok' | 'fail'>('idle');
  const [testText, setTestText] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');

  const isNew = !servers.some((x) => x.id === draft.id);
  /** Signs in to the chosen cloud service (Google Drive: keeps the entered app key first). */
  const signIn = async () => {
    const service = draft.protocol;
    if (!service) return;
    if (service === 'gdrive') await saveGoogleKey(googleId, googleSecret);
    if ((service === 'dropbox' || service === 'onedrive') && LIVE && !getState().cloudAvailable[service]) {
      showCloudNotSetUp(service);
      return;
    }
    openDialog({ type: 'cloudSignIn', service });
  };
  const cloud = isCloudProtocol(draft.protocol);
  const family = familyOf(draft.protocol);
  const setFamily = (f: Fam) => {
    setTest('idle');
    setDraft((d) => {
      // Cloud services (Transmit lists them with the protocols): signed in through the browser, no address or password.
      if (f === 'cloud') return { ...d, ...cloudDefaults('dropbox') };
      const port = (p: number) => (STANDARD_PORTS.includes(d.port) ? p : d.port);
      if (f === 'sftp')
        return {
          ...d,
          protocol: 'sftp',
          host: isCloudProtocol(d.protocol) ? '' : d.host,
          port: isCloudProtocol(d.protocol) ? 22 : port(22),
          auth: d.protocol && d.protocol !== 'sftp' ? 'auto' : d.auth,
        };
      if (f === 'ftp') return { ...d, protocol: 'ftps', implicitTls: false, port: port(21), auth: 'password' };
      if (f === 'smb') return { ...d, protocol: 'smb', port: port(445), auth: 'password', proxy: undefined };
      if (f === 's3') {
        const provider = d.s3Provider ?? 'aws';
        const region = d.s3Region ?? S3_PROVIDERS[provider].region;
        return {
          ...d,
          protocol: 's3',
          port: port(443),
          auth: 'password',
          s3Provider: provider,
          s3Region: region,
          host: S3_PROVIDERS[provider].host(region) || d.host,
        };
      }
      return {
        ...d,
        protocol: 'webdav',
        davHttps: d.davHttps ?? true,
        port: port(d.davHttps === false ? 80 : 443),
        auth: 'password',
      };
    });
  };
  /** S3: a provider or region change fills in the address of known providers. */
  const setS3 = (provider: string, region: string) => {
    setTest('idle');
    const p = S3_PROVIDERS[provider] ?? S3_PROVIDERS.other;
    setDraft((d) => ({
      ...d,
      s3Provider: provider,
      s3Region: region,
      host: p.host(region) || (S3_PROVIDERS[d.s3Provider ?? '']?.host(d.s3Region ?? '') === d.host ? '' : d.host),
      s3PathStyle: provider === 'other' ? (d.s3PathStyle ?? true) : undefined,
    }));
  };
  const setFtpTls = (v: 'explicit' | 'implicit' | 'none') => {
    setTest('idle');
    setDraft((d) => ({
      ...d,
      protocol: v === 'none' ? 'ftp' : 'ftps',
      implicitTls: v === 'implicit',
      port: v === 'implicit' ? (d.port === 21 ? 990 : d.port) : d.port === 990 ? 21 : d.port,
    }));
  };

  const pick = (srv: Server) => {
    setCurrentId(srv.id);
    setDraft(srv);
    setTest('idle');
  };
  const set: SetField = (k, v) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setTest('idle');
  };

  const valid = draft.host.trim() && draft.user.trim();
  const finish = (connect: boolean) => {
    if (!valid) {
      showToast($t('Bitte Server und Benutzer eintragen.'), 'error');
      return;
    }
    const name = draft.name.trim() || draft.host.trim();
    const mono = draft.mono || monoFor(name);
    // In the app an empty start folder means the user's home folder on the server.
    // The proxy password goes to the keychain only.
    if (LIVE && draft.proxy?.user && proxyPassword)
      void backend
        .secretSet(proxyAccount(draft.proxy), proxyPassword)
        .catch(() => showToast($t('Proxy-Passwort konnte nicht gespeichert werden.'), 'error'));
    saveServer(
      {
        ...draft,
        name,
        mono,
        proxy: draft.proxy?.host ? draft.proxy : undefined,
        remoteStart: draft.remoteStart || (LIVE ? '' : `/home/${draft.user}`),
      },
      connect,
    );
  };

  const runTest = () => {
    if (!valid) {
      showToast($t('Bitte Server und Benutzer eintragen.'), 'error');
      return;
    }
    setTest('running');
    if (LIVE) {
      void testServer({ ...draft, host: draft.host.trim(), user: draft.user.trim() }).then((r) => {
        setTest(r.ok ? 'ok' : 'fail');
        setTestText(r.text);
      });
      return;
    }
    window.setTimeout(() => {
      const ok = !draft.host.includes('fehler');
      setTest(ok ? 'ok' : 'fail');
      setTestText(
        ok ? $t('Erreichbar, Anmeldung erfolgreich') : $t('Server nicht erreichbar. Adresse und Port prüfen.'),
      );
    }, 900);
  };

  const footer = (
    <>
      {cloud ? (
        !isNew && (
          <Button
            onClick={() =>
              draft.protocol && openDialog({ type: 'cloudSignIn', service: draft.protocol, serverId: draft.id })
            }
          >
            {$t('Neu anmelden …')}
          </Button>
        )
      ) : (
        <Button onClick={runTest} disabled={test === 'running'}>
          {test === 'running' ? $t('Teste …') : $t('Verbindung testen')}
        </Button>
      )}
      {test === 'ok' && (
        <span className="small tone-ok row-inline test-result">
          <Check size={13} strokeWidth={2.2} aria-hidden="true" />
          {testText}
        </span>
      )}
      {test === 'fail' && <span className="small tone-danger test-result">{testText}</span>}
      <span className="flex-1" />
      {!isNew && (
        <Button variant="danger" onClick={() => askRemoveServer(draft.id)}>
          <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
          {$t('Entfernen')}
        </Button>
      )}
      <Button onClick={closeDialog}>{$t('Abbrechen')}</Button>
      {cloud && isNew ? (
        // A new cloud service is created by signing in (the browser gives Bitcrane the account).
        <Button
          variant="primary"
          disabled={draft.protocol === 'gdrive' && (!googleId.trim() || (!googleSecret.trim() && !googleStored))}
          onClick={() => void signIn()}
        >
          {$t('Bei {0} anmelden …', CLOUD_NAMES[draft.protocol ?? ''] ?? '')}
        </Button>
      ) : (
        <>
          <Button onClick={() => finish(false)}>{$t('Sichern')}</Button>
          <Button variant="primary" onClick={() => finish(true)}>
            {$t('Verbinden')}
          </Button>
        </>
      )}
    </>
  );

  return (
    <Dialog
      label={$t('Server verwalten')}
      windowLike
      windowTitle={$t('Server')}
      width={1000}
      maxHeight={680}
      footer={footer}
      className="server-dialog"
    >
      <div className="split">
        <ServerListPane
          servers={servers}
          currentId={currentId}
          draft={draft}
          isNew={isNew}
          onPick={pick}
          onNew={() => {
            setCurrentId(undefined);
            setDraft(newServerTemplate());
            setTest('idle');
          }}
        />

        <div className="split-detail">
          <DetailHead draft={draft} set={set} />

          <div className="form-grid">
            {cloud ? (
              <CloudFields
                draft={draft}
                set={set}
                setDraft={setDraft}
                isNew={isNew}
                setFamily={setFamily}
                googleId={googleId}
                setGoogleId={setGoogleId}
                googleSecret={googleSecret}
                setGoogleSecret={setGoogleSecret}
                googleStored={googleStored}
              />
            ) : (
              <>
                <ConnectionFields
                  draft={draft}
                  set={set}
                  setDraft={setDraft}
                  family={family}
                  isNew={isNew}
                  testFailed={test === 'fail'}
                  setFamily={setFamily}
                  setS3={setS3}
                  setFtpTls={setFtpTls}
                />
                {family === 'sftp' && <SftpAuth draft={draft} set={set} />}
              </>
            )}
            <CommonFields draft={draft} set={set} family={family} servers={servers} />
          </div>

          <MoreSettings
            draft={draft}
            set={set}
            family={family}
            proxyPassword={proxyPassword}
            setProxyPassword={setProxyPassword}
          />
        </div>
      </div>
    </Dialog>
  );
}
