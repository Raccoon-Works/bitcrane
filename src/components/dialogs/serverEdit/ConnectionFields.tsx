/**
 * Server editor fields for the protocols with an address (SFTP, FTP, WebDAV,
 * SMB, S3): protocol, encryption, address and port, the protocol's own place
 * (bucket, path, share) and the user. The SFTP login follows in SftpAuth.tsx.
 */
import type { Dispatch, SetStateAction } from 'react';
import type { Server } from '../../../backend/types';
import { davUrl } from '../../../state/live';
import { useStore } from '../../../state/store';
import { Segmented, Select, Switch, TextField } from '../../ui';
import { $t } from '../../../i18n';
import { keychainLong, S3_PROVIDERS, type Fam, type SetField } from './model';

export function ConnectionFields({
  draft,
  set,
  setDraft,
  family,
  isNew,
  testFailed,
  setFamily,
  setS3,
  setFtpTls,
}: {
  draft: Server;
  set: SetField;
  setDraft: Dispatch<SetStateAction<Server>>;
  family: Fam;
  isNew: boolean;
  testFailed: boolean;
  setFamily: (f: Fam) => void;
  setS3: (provider: string, region: string) => void;
  setFtpTls: (v: 'explicit' | 'implicit' | 'none') => void;
}) {
  const platform = useStore((s) => s.platform);
  const regions = S3_PROVIDERS[draft.s3Provider ?? 'aws']?.regions;
  return (
    <>
      <span>{$t('Protokoll#protocol')}</span>
      <div className="row-inline">
        <Segmented<Fam>
          label={$t('Protokoll#protocol')}
          value={family}
          onChange={setFamily}
          options={[
            { value: 'sftp', label: 'SFTP / SSH' },
            { value: 'ftp', label: 'FTP' },
            { value: 'webdav', label: 'WebDAV' },
            { value: 'smb', label: 'SMB' },
            { value: 's3', label: 'S3' },
            ...(isNew ? [{ value: 'cloud' as const, label: $t('Cloud-Dienst') }] : []),
          ]}
        />
      </div>

      {family === 'ftp' && (
        <>
          <label htmlFor="s-tls">{$t('Verschlüsselung')}</label>
          <div className="col-text">
            <Select<'explicit' | 'implicit' | 'none'>
              id="s-tls"
              label={$t('Verschlüsselung')}
              value={draft.protocol === 'ftp' ? 'none' : draft.implicitTls ? 'implicit' : 'explicit'}
              onChange={setFtpTls}
              options={[
                { value: 'explicit', label: $t('FTPS: TLS anfordern (empfohlen)') },
                { value: 'implicit', label: $t('FTPS: implizites TLS (eigener Port, meist 990)') },
                { value: 'none', label: $t('Keine (unverschlüsselt)') },
              ]}
            />
            {draft.protocol === 'ftp' && (
              <span className="small tone-warn">
                {$t(
                  'Ohne Verschlüsselung gehen Passwort und Dateien lesbar durchs Netz. Nur nutzen, wenn der Server nichts anderes kann.',
                )}
              </span>
            )}
          </div>
        </>
      )}

      {family === 's3' && (
        <>
          <label htmlFor="s-s3p">{$t('Anbieter')}</label>
          <div className="field-row">
            <Select
              id="s-s3p"
              label={$t('Anbieter')}
              value={draft.s3Provider ?? 'aws'}
              onChange={(v) => setS3(v, S3_PROVIDERS[v]?.region ?? '')}
              options={Object.entries(S3_PROVIDERS).map(([value, p]) => ({ value, label: p.label }))}
            />
            {regions ? (
              <Select
                label={$t('Region')}
                value={draft.s3Region ?? ''}
                onChange={(v) => setS3(draft.s3Provider ?? 'aws', v)}
                options={regions.map((r) => ({ value: r, label: r }))}
              />
            ) : (
              <TextField
                label={$t('Region')}
                value={draft.s3Region ?? ''}
                onChange={(v) => set('s3Region', v.trim() || undefined)}
                placeholder={draft.s3Provider === 'r2' ? 'auto' : 'us-east-1'}
                mono
                className="flex-1"
              />
            )}
          </div>
        </>
      )}

      <label htmlFor="s-host">{family === 's3' ? $t('Endpunkt') : $t('Server')}</label>
      <div className="field-row">
        <TextField
          id="s-host"
          value={draft.host}
          onChange={(v) => set('host', v)}
          placeholder={
            family === 'smb'
              ? $t('nas.local oder 192.168.1.20')
              : family === 's3'
                ? draft.s3Provider === 'r2'
                  ? $t('KONTO-ID.r2.cloudflarestorage.com')
                  : 'minio.example'
                : $t('server.example oder 203.0.113.10')
          }
          className="flex-1"
          invalid={!draft.host && testFailed}
          mono={family === 's3'}
        />
        <TextField
          value={String(draft.port)}
          onChange={(v) => set('port', Number(v.replace(/\D/g, '')) || 22)}
          className="port-field"
        />
      </div>

      {family === 's3' && (
        <>
          <label htmlFor="s-bucket">{$t('Bucket')}</label>
          <div className="col-text">
            <TextField
              id="s-bucket"
              value={draft.s3Bucket ?? ''}
              onChange={(v) => set('s3Bucket', v.trim() || undefined)}
              placeholder={$t('leer lassen für die Liste aller Buckets')}
              mono
            />
            {draft.s3Provider === 'other' && (
              <span className="row-inline wrap-row">
                <Switch
                  checked={draft.s3PathStyle ?? true}
                  onChange={(v) => set('s3PathStyle', v)}
                  label={$t('Bucket im Pfad (für MinIO und IP-Adressen)')}
                />
                <span className="small">{$t('Bucket im Pfad (für MinIO und IP-Adressen)')}</span>
                <Switch
                  checked={!!draft.s3Http}
                  onChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      s3Http: v || undefined,
                      port: d.port === (v ? 443 : 80) ? (v ? 80 : 443) : d.port,
                    }))
                  }
                  label={$t('Unverschlüsselt (http)')}
                />
                <span className="small">{$t('Unverschlüsselt (http)')}</span>
              </span>
            )}
          </div>
        </>
      )}

      {family === 'webdav' && (
        <>
          <label htmlFor="s-davpath">{$t('Pfad')}</label>
          <div className="col-text">
            <div className="field-row">
              <Select<'https' | 'http'>
                label={$t('https oder http')}
                value={draft.davHttps === false ? 'http' : 'https'}
                onChange={(v) =>
                  setDraft((d) => ({
                    ...d,
                    davHttps: v === 'https',
                    port: d.port === (v === 'https' ? 80 : 443) ? (v === 'https' ? 443 : 80) : d.port,
                  }))
                }
                options={[
                  { value: 'https', label: 'https' },
                  { value: 'http', label: $t('http (unverschlüsselt)') },
                ]}
              />
              <TextField
                id="s-davpath"
                mono
                value={draft.davPath ?? ''}
                onChange={(v) => set('davPath', v.trim() || undefined)}
                placeholder="/remote.php/dav/files/name"
                className="flex-1"
              />
            </div>
            <span className="small muted mono ellipsis">
              {draft.host ? davUrl(draft) : $t('Adresse erscheint, sobald der Server eingetragen ist.')}
            </span>
          </div>
        </>
      )}

      {family === 'smb' && (
        <>
          <label htmlFor="s-share">{$t('Freigabe')}</label>
          <div className="col-text">
            <TextField
              id="s-share"
              value={draft.smbShare ?? ''}
              onChange={(v) => set('smbShare', v.trim().replace(/^[\\/]+|[\\/]+$/g, '') || undefined)}
              placeholder={$t('z. B. daten')}
            />
            <span className="small muted">{$t('Leer lassen, um mit der Liste aller Freigaben zu beginnen.')}</span>
          </div>
        </>
      )}

      <label htmlFor="s-user">{family === 's3' ? $t('Zugriffsschlüssel') : $t('Benutzer')}</label>
      <TextField
        id="s-user"
        value={draft.user}
        onChange={(v) => set('user', v)}
        placeholder={
          family === 'ftp'
            ? $t('leer lassen für anonym')
            : family === 'smb'
              ? $t('leer lassen für Gast')
              : family === 's3'
                ? 'Access Key ID'
                : 'ubuntu'
        }
        mono={family === 's3'}
      />

      {family !== 'sftp' && (
        <>
          <span>{$t('Anmeldung')}</span>
          <span className="small muted">
            {family === 'ftp' && !draft.user
              ? $t('Ohne Benutzer meldet sich Bitcrane anonym an.')
              : family === 'smb' && !draft.user
                ? $t('Ohne Benutzer meldet sich Bitcrane als Gast an. Für Domänenkonten DOMÄNE\\name eintragen.')
                : family === 's3'
                  ? $t(
                      'Mit dem geheimen Schlüssel (Secret Access Key). Bitcrane fragt beim ersten Verbinden und speichert ihn {0}.',
                      keychainLong(platform),
                    )
                  : $t(
                      'Mit Passwort. Bitcrane fragt beim ersten Verbinden und speichert es {0}.',
                      keychainLong(platform),
                    )}
          </span>
        </>
      )}
    </>
  );
}
