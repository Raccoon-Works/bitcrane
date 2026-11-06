/**
 * Settings › Allgemein › Zwischen Rechnern abgleichen: the sync folder and the
 * optional sync password (see state/sync.ts).
 */
import { useEffect, useState } from 'react';
import { tauriBackend as backend } from '../../../backend/tauriBackend';
import { chooseFolder } from '../../../backend/dialogs';
import type { CloudPlace } from '../../../backend/api';
import { runSync, setSyncFolder, setSyncPassword, syncStatus } from '../../../state/sync';
import { LIVE, useStore } from '../../../state/store';
import { Button, TextField } from '../../ui';
import { $t } from '../../../i18n';
import { Group, Row } from './parts';

/**
 * "Zwischen Rechnern abgleichen" (after Panic Sync): a folder the user's cloud
 * keeps in step; optional sync password for the passwords.
 */
export function SyncSettings() {
  const s = useStore((st) => st.settings);
  const platform = useStore((st) => st.platform);
  const [found, setFound] = useState<CloudPlace[]>([]);
  const [pw, setPw] = useState('');
  // Cloud folders of this computer as quick choices (the same detection as for the places bar).
  useEffect(() => {
    if (LIVE)
      void backend
        .localCloudPlaces()
        .then((l) => setFound(l.filter((c) => c.service !== 'other')))
        .catch(() => undefined);
  }, []);
  const choose = async () => {
    const picked = await chooseFolder($t('Ordner für den Abgleich'));
    if (picked) await setSyncFolder(picked);
  };
  const status = syncStatus();
  return (
    <Group title={$t('Zwischen Rechnern abgleichen')}>
      <Row
        label={$t('Ordner für den Abgleich')}
        note={
          s.syncFolder ? (
            <>
              <span className="mono">{s.syncFolder}</span>
              {status && (
                <>
                  <br />
                  <span className={s.syncError ? 'tone-danger' : ''}>{status}</span>
                </>
              )}
            </>
          ) : (
            $t(
              'Server, Gruppen, Regeln und eigene Befehle gleich auf Mac und PC. Wähle einen Ordner, den Dropbox, OneDrive, iCloud Drive oder Google Drive ohnehin abgleicht, und auf dem anderen Rechner denselben.',
            )
          )
        }
      >
        <span className="row-inline wrap">
          {!s.syncFolder &&
            found.map((f) => (
              <Button key={f.path} small onClick={() => void setSyncFolder(f.path)}>
                {f.name}
              </Button>
            ))}
          {s.syncFolder && (
            <Button small onClick={() => void runSync()}>
              {$t('Jetzt abgleichen')}
            </Button>
          )}
          {LIVE && (
            <Button small onClick={() => void choose()}>
              {s.syncFolder ? $t('Ändern …') : $t('Anderer Ordner …')}
            </Button>
          )}
          {s.syncFolder && (
            <Button small variant="ghost" onClick={() => void setSyncFolder(null)}>
              {$t('Aus')}
            </Button>
          )}
        </span>
      </Row>
      {s.syncFolder && (
        <Row
          label={$t('Passwörter mit abgleichen')}
          note={
            s.syncPasswords
              ? $t(
                  'An. Verschlüsselt mit deinem Abgleich-Passwort; das Passwort selbst liegt nur {0}.',
                  platform === 'mac' ? $t('im Schlüsselbund') : $t('in der Anmeldeinformationsverwaltung'),
                )
              : $t(
                  'Aus: Passwörter bleiben auf jedem Rechner für sich. Mit einem Abgleich-Passwort (auf allen Rechnern dasselbe) wandern sie verschlüsselt mit.',
                )
          }
        >
          {s.syncPasswords ? (
            <Button small variant="ghost" onClick={() => void setSyncPassword(null)}>
              {$t('Ausschalten')}
            </Button>
          ) : (
            <span className="row-inline">
              <TextField
                type="password"
                value={pw}
                onChange={setPw}
                placeholder={$t('Abgleich-Passwort')}
                label={$t('Abgleich-Passwort')}
                onEnter={() => {
                  if (pw.length >= 8) {
                    void setSyncPassword(pw);
                    setPw('');
                  }
                }}
              />
              <Button
                small
                disabled={pw.length < 8}
                onClick={() => {
                  void setSyncPassword(pw);
                  setPw('');
                }}
              >
                {$t('Einschalten')}
              </Button>
            </span>
          )}
        </Row>
      )}
    </Group>
  );
}
