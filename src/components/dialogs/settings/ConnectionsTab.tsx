/**
 * Settings › Verbindungen: reconnecting, keep-alive and the stored host key
 * fingerprints.
 */
import { useEffect, useState } from 'react';
import { tauriBackend as backend } from '../../../backend/tauriBackend';
import type { KnownHost } from '../../../backend/api';
import { LIVE, updateSettings, useStore } from '../../../state/store';
import { Button, Switch } from '../../ui';
import { $t } from '../../../i18n';
import { Group, Row } from './parts';

/** Stored host key fingerprints with "Vergessen" (the next connection asks again). */
function KnownHostsList() {
  const [hosts, setHosts] = useState<KnownHost[] | null>(
    LIVE
      ? null
      : [
          { host: 'shop.example:22', fingerprint: 'SHA256:U2hvcC1leGFtcGxlLWZpbmdlcnByaW50AA' },
          { host: 'portfolio.example:22', fingerprint: 'SHA256:UG9ydGZvbGlvLWV4YW1wbGUtZmluZ2Vy' },
        ],
  );
  const load = () => {
    if (LIVE)
      backend
        .knownHostsList()
        .then(setHosts)
        .catch(() => setHosts([]));
  };
  useEffect(load, []);
  const forget = (host: string) => {
    if (LIVE) void backend.knownHostsRemove(host).then(load);
    else setHosts((h) => (h ?? []).filter((x) => x.host !== host));
  };
  if (!hosts) return <Row label={$t('Wird geladen …')} />;
  if (!hosts.length)
    return (
      <Row
        label={$t('Noch keine')}
        note={$t('Beim ersten Verbinden zu einem Server merkt sich Bitcrane dessen Fingerabdruck.')}
      />
    );
  return (
    <>
      {hosts.map((h) => (
        <div key={h.host} className="set-row">
          <div className="col-text flex-1 min-w-0">
            <span className="mono">{h.host}</span>
            <span className="small muted mono ellipsis" title={h.fingerprint}>
              {h.fingerprint}
            </span>
          </div>
          <Button small onClick={() => forget(h.host)}>
            {$t('Vergessen')}
          </Button>
        </div>
      ))}
    </>
  );
}

export function ConnectionSettings() {
  const s = useStore((st) => st.settings);
  return (
    <>
      <Group title={$t('Verbindungen')}>
        <Row
          label={$t('Bei Verbindungsabbruch neu verbinden')}
          note={$t('Erst nach 5 Sekunden, dann mit wachsenden Pausen bis zu einer Minute.')}
        >
          <Switch
            checked={s.autoReconnect}
            onChange={(v) => updateSettings({ autoReconnect: v })}
            label={$t('Neu verbinden')}
          />
        </Row>
        <Row
          label={$t('Verbindung offen halten')}
          note={$t('Sendet alle 30 Sekunden ein Lebenszeichen. Gilt ab der nächsten Verbindung.')}
        >
          <Switch
            checked={s.keepAlive}
            onChange={(v) => updateSettings({ keepAlive: v })}
            label={$t('Verbindung offen halten')}
          />
        </Row>
      </Group>
      <Group title={$t('Bekannte Fingerabdrücke')}>
        <KnownHostsList />
      </Group>
    </>
  );
}
