/**
 * Settings › Allgemein › Berechtigungen (Mac only): the permissions macOS asks
 * the user for, with their state and a way to the System Settings.
 */
import { useEffect, useState } from 'react';
import { tauriBackend as backend } from '../../../backend/tauriBackend';
import { showError } from '../../../state/errors';
import { LIVE, useStore } from '../../../state/store';
import { Button } from '../../ui';
import { $t } from '../../../i18n';
import { Group, Row } from './parts';

/**
 * Everything macOS asks the user to allow, in one place, each with its state
 * where it can be read and a button to the right page of the System Settings.
 * The state is read again when Bitcrane gets the focus back (after a visit to
 * the System Settings).
 */
export function MacPermissions() {
  const [fullDisk, setFullDisk] = useState<boolean | null>(null);
  const [notify, setNotify] = useState<boolean | null>(null);
  const startAtLogin = useStore((st) => st.settings.startAtLogin);
  useEffect(() => {
    if (!LIVE) return;
    const read = () => {
      void backend.macFullDiskAccess().then(setFullDisk);
      void import('@tauri-apps/plugin-notification')
        .then((m) => m.isPermissionGranted())
        .then(setNotify)
        .catch(() => setNotify(null));
    };
    read();
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, []);
  const open = (page: string) => void backend.openMacSettings(page).catch((e) => showError(e));
  const state = (ok: boolean | null) =>
    ok === null ? null : ok ? (
      <span className="small tone-ok perm-state">{$t('erlaubt')}</span>
    ) : (
      <span className="small tone-warn perm-state">{$t('nicht erlaubt')}</span>
    );
  return (
    <Group title={$t('Berechtigungen')}>
      <Row
        label={$t('Festplattenvollzugriff')}
        note={$t(
          'Damit Bitcrane alle Ordner lesen und überwachen kann (Schreibtisch, Dokumente, Downloads, iCloud Drive, externe Laufwerke), ohne dass macOS für jeden einzeln fragt.',
        )}
      >
        <span className="row-inline">
          {state(fullDisk)}
          <Button small onClick={() => open('fullDisk')}>
            {$t('Öffnen …')}
          </Button>
        </span>
      </Row>
      <Row label={$t('Mitteilungen')} note={$t('Für Meldungen zu Überwachungen, fertigen Übertragungen und Fehlern.')}>
        <span className="row-inline">
          {state(notify)}
          {notify === false ? (
            <Button
              small
              onClick={() =>
                void import('@tauri-apps/plugin-notification')
                  .then((m) => m.requestPermission())
                  .then((r) => setNotify(r === 'granted'))
                  .catch(() => open('notifications'))
              }
            >
              {$t('Erlauben …')}
            </Button>
          ) : (
            <Button small onClick={() => open('notifications')}>
              {$t('Öffnen …')}
            </Button>
          )}
        </span>
      </Row>
      <Row
        label={$t('Lokales Netzwerk')}
        note={$t(
          'Für Server im eigenen Netz (NAS, SMB-Freigaben, Raspberry Pi). macOS fragt beim ersten Verbinden; wurde es abgelehnt, hier wieder einschalten.',
        )}
      >
        <Button small onClick={() => open('localNetwork')}>
          {$t('Öffnen …')}
        </Button>
      </Row>
      <Row
        label={$t('Anmeldeobjekte')}
        note={
          startAtLogin
            ? $t('Bitcrane startet beim Anmelden. macOS zeigt es unter „Anmeldeobjekte“.')
            : $t('Für „Beim Anmelden am Mac starten“ (Überwachung). macOS zeigt es unter „Anmeldeobjekte“.')
        }
      >
        <Button small onClick={() => open('loginItems')}>
          {$t('Öffnen …')}
        </Button>
      </Row>
    </Group>
  );
}
