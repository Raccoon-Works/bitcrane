/**
 * Host key check: the first connection to a server, or a server whose
 * fingerprint changed since the last one.
 */
import { useState } from 'react';
import type { HostKey } from '../../backend/types';
import { rejectHostKey, trustHostKey } from '../../state/store';
import { ShieldAlert, ShieldCheck } from '../glyphs';
import { Button } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function Fingerprint({
  mode,
  keyInfo,
  serverId,
}: {
  mode: 'new' | 'changed';
  keyInfo: HostKey;
  serverId: string;
}) {
  const [details, setDetails] = useState(false);
  const cert = keyInfo.algorithm === 'TLS-Zertifikat';
  if (mode === 'new') {
    return (
      <Dialog
        label={$t('Erste Verbindung')}
        title={$t('Erste Verbindung zu {0}', keyInfo.host)}
        subtitle={
          cert
            ? $t(
                'Der Server verschlüsselt mit einem eigenen Zertifikat, das keine bekannte Stelle bestätigt hat (bei eigenen Servern üblich). Vergleiche den Fingerabdruck mit dem, den dein Anbieter nennt. Danach merkt sich Bitcrane ihn und warnt, falls er sich ändert.',
              )
            : $t(
                'Bitcrane kennt diesen Server noch nicht. Vergleiche den Fingerabdruck mit dem, den dein Server-Anbieter anzeigt. Danach merkt sich Bitcrane ihn und warnt, falls er sich ändert.',
              )
        }
        icon={
          <span className="icon-tile tone-accent">
            <ShieldCheck size={20} strokeWidth={1.75} />
          </span>
        }
        width={600}
        onClose={() => rejectHostKey(serverId)}
        footer={
          <>
            <span className="flex-1" />
            <Button onClick={() => rejectHostKey(serverId)}>{$t('Abbrechen')}</Button>
            <Button variant="primary" onClick={() => trustHostKey(serverId)}>
              {$t('Vertrauen und verbinden')}
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <dl className="kv-card mono-values">
            <dt>{cert ? $t('Art') : $t('Verfahren')}</dt>
            <dd>{keyInfo.algorithm}</dd>
            <dt>{$t('Fingerabdruck')}</dt>
            <dd className="mono break">{keyInfo.fingerprint}</dd>
          </dl>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog
      label={$t('Fingerabdruck geändert')}
      title={$t('Fingerabdruck hat sich geändert')}
      subtitle={$t(
        'Der Server meldet sich anders als beim letzten Mal. Das passiert nach einer Neuinstallation, kann aber auch ein Angriff sein. Bitcrane verbindet nicht, bis du es bestätigst.',
      )}
      icon={
        <span className="icon-tile tone-danger">
          <ShieldAlert size={20} strokeWidth={1.75} />
        </span>
      }
      width={620}
      footer={
        <>
          <Button variant="ghost" aria-expanded={details} onClick={() => setDetails(!details)}>
            {details ? $t('Weniger') : $t('Details')}
          </Button>
          <span className="flex-1" />
          <Button onClick={() => trustHostKey(serverId)}>{$t('Neuen übernehmen')}</Button>
          <Button variant="primary" onClick={() => rejectHostKey(serverId)}>
            {$t('Nicht verbinden')}
          </Button>
        </>
      }
    >
      <dl className="kv-card">
        <dt>{$t('Server')}</dt>
        <dd>{keyInfo.host}</dd>
        <dt>{$t('Bisher')}</dt>
        <dd className="mono break muted">{keyInfo.previous}</dd>
        <dt>{$t('Jetzt')}</dt>
        <dd className="mono break tone-danger">{keyInfo.fingerprint}</dd>
      </dl>
      {details && (
        <div className="form-stack small details-help">
          <p>
            {$t(
              'So prüfst du, ob der neue Fingerabdruck echt ist: Melde dich über die Web-Konsole deines Server-Anbieters an (nicht über SSH) und gib dort ein:',
            )}
          </p>
          <pre className="mono code-box">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</pre>
          <p>
            {$t(
              'Stimmt die ausgegebene Zeichenfolge mit „Jetzt“ überein, wurde der Server nur neu eingerichtet und du kannst den neuen Fingerabdruck übernehmen. Stimmt sie nicht überein, verbinde dich nicht und sprich mit deinem Anbieter.',
            )}
          </p>
        </div>
      )}
    </Dialog>
  );
}
