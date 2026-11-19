/**
 * "Änderungen vom Abgleich prüfen": the other computer changed how servers are reached (address,
 * encryption, proxy, key file …). The shared file lies in a cloud folder, so such a change is
 * shown before it applies (state/syncMerge.ts heldForReview).
 */
import { useStore } from '../../state/store';
import { answerSyncReview } from '../../state/sync';
import { profileChanges, type ProfileField } from '../../state/syncMerge';
import { $t } from '../../i18n';
import { Info } from '../glyphs';
import { Button } from '../ui';
import { Dialog } from './Dialog';

export function SyncReview() {
  const held = useStore((s) => s.syncReview);
  const keep = () => answerSyncReview(false);
  const labels: Record<ProfileField, string> = {
    protocol: $t('Protokoll'),
    host: $t('Adresse'),
    port: $t('Port'),
    user: $t('Benutzer'),
    auth: $t('Anmeldung'),
    keyPath: $t('Schlüsseldatei'),
    proxy: $t('Proxy'),
    jump: $t('Sprungserver'),
    implicitTls: $t('Implizites TLS'),
    tls13Only: $t('Nur TLS 1.3'),
    davHttps: $t('WebDAV über HTTPS'),
    s3Http: $t('S3 über HTTP'),
    smbEncrypt: $t('SMB-Verschlüsselung'),
    sftpCommand: $t('SFTP-Befehl'),
    termStart: $t('Befehl nach dem Verbinden'),
    forwardAgent: $t('SSH-Agent weiterreichen'),
    forwards: $t('Tunnel'),
  };
  const shown = (v: string) => (v === 'on' ? $t('an') : v === 'off' ? $t('aus') : v || '–');
  return (
    <Dialog
      label={$t('Änderungen vom Abgleich prüfen')}
      title={$t('Änderungen vom Abgleich prüfen')}
      subtitle={$t(
        'Auf einem anderen Rechner wurde geändert, wie diese Server erreicht werden. Übernimm das nur, wenn du es selbst geändert hast: Wer den Abgleich-Ordner ändern kann, könnte gespeicherte Passwörter sonst umleiten.',
      )}
      width={560}
      onClose={keep}
      icon={
        <span className="icon-tile tone-accent">
          <Info size={20} strokeWidth={1.75} />
        </span>
      }
      footer={
        <>
          <span className="flex-1" />
          <Button autoFocus onClick={keep}>
            {$t('Nicht übernehmen')}
          </Button>
          <Button variant="primary" onClick={() => answerSyncReview(true)}>
            {$t('Übernehmen#Änderung')}
          </Button>
        </>
      }
    >
      <div className="sync-review">
        {held.map(({ theirs, ours }) => (
          <section key={theirs.id}>
            <h3 className="sync-review-name">
              {ours && ours.id !== theirs.id
                ? $t('Neu: „{0}“ mit der Anmeldung von „{1}“', theirs.name, ours.name)
                : theirs.name}
            </h3>
            <table className="sync-review-table">
              <tbody>
                {(ours
                  ? profileChanges(ours, theirs)
                  : [{ field: 'keyPath' as const, from: '', to: theirs.keyPath }]
                ).map((c) => (
                  <tr key={c.field}>
                    <th scope="row">{labels[c.field]}</th>
                    <td className="mono">{shown(c.from)}</td>
                    <td aria-hidden="true">→</td>
                    <td className="mono">{shown(c.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
