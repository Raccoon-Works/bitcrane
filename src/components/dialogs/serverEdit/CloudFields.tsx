/**
 * Server editor fields for a cloud service (Dropbox, Google Drive, OneDrive):
 * the service, Google's own app key and how the account is signed in.
 */
import type { Dispatch, SetStateAction } from 'react';
import type { Server } from '../../../backend/types';
import { CLOUD_NAMES, GDRIVE_GUIDE_URL } from '../../../state/cloud';
import { openExternal, useStore } from '../../../state/store';
import { Segmented, Select, TextField } from '../../ui';
import { $t } from '../../../i18n';
import { cloudDefaults, keychainLong, keychainShort, type Fam, type SetField } from './model';

export function CloudFields({
  draft,
  set,
  setDraft,
  isNew,
  setFamily,
  googleId,
  setGoogleId,
  googleSecret,
  setGoogleSecret,
  googleStored,
}: {
  draft: Server;
  set: SetField;
  setDraft: Dispatch<SetStateAction<Server>>;
  isNew: boolean;
  setFamily: (f: Fam) => void;
  googleId: string;
  setGoogleId: (v: string) => void;
  googleSecret: string;
  setGoogleSecret: (v: string) => void;
  googleStored: boolean;
}) {
  const platform = useStore((s) => s.platform);
  const service = draft.protocol === 'gdrive' || draft.protocol === 'onedrive' ? draft.protocol : 'dropbox';
  return (
    <>
      <span>{$t('Protokoll#protocol')}</span>
      <div className="row-inline">
        <Segmented<Fam>
          label={$t('Protokoll#protocol')}
          value="cloud"
          onChange={setFamily}
          options={
            isNew
              ? [
                  { value: 'sftp', label: 'SFTP / SSH' },
                  { value: 'ftp', label: 'FTP' },
                  { value: 'webdav', label: 'WebDAV' },
                  { value: 'smb', label: 'SMB' },
                  { value: 's3', label: 'S3' },
                  { value: 'cloud', label: $t('Cloud-Dienst') },
                ]
              : [{ value: 'cloud', label: $t('Cloud-Dienst') }]
          }
        />
      </div>
      <span>{$t('Dienst')}</span>
      <div className="col-text">
        <Select<'dropbox' | 'gdrive' | 'onedrive'>
          label={$t('Dienst')}
          value={service}
          onChange={(v) => isNew && setDraft((d) => ({ ...d, ...cloudDefaults(v) }))}
          options={
            isNew
              ? [
                  { value: 'dropbox', label: 'Dropbox' },
                  { value: 'gdrive', label: 'Google Drive' },
                  { value: 'onedrive', label: 'OneDrive' },
                ]
              : [{ value: service, label: CLOUD_NAMES[draft.protocol ?? ''] ?? '' }]
          }
        />
      </div>
      {draft.protocol === 'gdrive' && (
        <>
          <span>{$t('Client-ID')}</span>
          <div className="col-text">
            <TextField
              mono
              value={googleId}
              onChange={setGoogleId}
              placeholder="123456789-abc….apps.googleusercontent.com"
              label={$t('Client-ID')}
            />
          </div>
          <span>{$t('Client-Schlüssel')}</span>
          <div className="col-text">
            <TextField
              mono
              type="password"
              value={googleSecret}
              onChange={setGoogleSecret}
              placeholder={googleStored ? $t('gespeichert {0}', keychainShort(platform)) : 'GOCSPX-…'}
              label={$t('Client-Schlüssel')}
            />
            <span className="small muted">
              {$t(
                'Google Drive braucht einen eigenen, kostenlosen App-Schlüssel aus deinem Google-Konto. Einmal einrichten, etwa 10 Minuten.',
              )}{' '}
              <button type="button" className="link small" onClick={() => openExternal(GDRIVE_GUIDE_URL)}>
                {$t('Zur Anleitung')}
              </button>
            </span>
          </div>
          <label htmlFor="s-gdoc">{$t('Google-Dokumente')}</label>
          <div className="col-text">
            <Select<'office' | 'pdf'>
              id="s-gdoc"
              label={$t('Google-Dokumente')}
              value={draft.gdocExport ?? 'office'}
              onChange={(v) => set('gdocExport', v === 'office' ? undefined : v)}
              options={[
                { value: 'office', label: $t('Als Word, Excel und PowerPoint (Standard)') },
                { value: 'pdf', label: $t('Als PDF') },
              ]}
            />
            <span className="small muted">
              {$t(
                'Docs, Tabellen, Präsentationen und Zeichnungen werden beim Herunterladen umgewandelt. In der Liste stehen sie schon mit der passenden Endung.',
              )}
            </span>
          </div>
        </>
      )}
      <span>{$t('Konto')}</span>
      <span className="small muted">{draft.user || '–'}</span>
      <span>{$t('Anmeldung')}</span>
      <span className="small muted">
        {$t(
          'Über den Browser; gespeichert {0}. „Neu anmelden …“ unten, falls der Zugriff entzogen wurde.',
          keychainLong(platform),
        )}
      </span>
    </>
  );
}
