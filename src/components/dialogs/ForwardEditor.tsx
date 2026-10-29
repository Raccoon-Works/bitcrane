/**
 * Server bearbeiten › Weitere Einstellungen › Tunnel: the server's SSH port
 * forwards (state/forward.ts). Each row: kind, the port that is opened, the
 * target, "beim Verbinden" and, while the server is connected, on/off.
 */
import type { PortForward } from '../../backend/types';
import { $t } from '../../i18n';
import { startForward, stopForward } from '../../state/forward';
import { uid, useStore } from '../../state/store';
import { Plus, X } from '../glyphs';
import { Button, Checkbox, IconButton, Select, Switch, TextField } from '../ui';

const port = (v: string, fallback: number) => Math.min(65535, Number(v.replace(/\D/g, '')) || fallback);

export function ForwardEditor({ serverId, value, onChange }: { serverId: string; value: PortForward[]; onChange: (v: PortForward[]) => void }) {
  const online = useStore((s) => !!s.servers.find((x) => x.id === serverId)?.online);
  const running = useStore((s) => s.tunnels);
  const saved = useStore((s) => s.servers.find((x) => x.id === serverId)?.forwards);
  const set = (id: string, patch: Partial<PortForward>) => onChange(value.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const add = () => onChange([...value, { id: uid('fw'), kind: 'local', bindHost: '127.0.0.1', bindPort: 8080, destHost: '127.0.0.1', destPort: 80, auto: true }]);
  return (
    <div className="col-text fw-list">
      {value.map((f) => {
        const on = running.includes(f.id);
        // Starting needs the saved version (the backend reads nothing from the draft).
        const unsaved = JSON.stringify(saved?.find((x) => x.id === f.id)) !== JSON.stringify(f);
        return (
          <div key={f.id} className="fw-card">
            <div className="fw-line">
              <Select<PortForward['kind']> label={$t('Art des Tunnels')} value={f.kind} onChange={(v) => set(f.id, { kind: v })}
                options={[{ value: 'local', label: $t('Lokal → Server') }, { value: 'remote', label: $t('Server → Lokal') }, { value: 'dynamic', label: $t('SOCKS-Proxy') }]} />
              <span className="flex-1" />
              <Checkbox checked={!!f.auto} onChange={(v) => set(f.id, { auto: v || undefined })} label={$t('beim Verbinden')} />
              <Switch checked={on} disabled={!online || (unsaved && !on)} onChange={(v) => void (v ? startForward(serverId, f) : stopForward(f))}
                label={!online ? $t('Erst verbinden') : unsaved && !on ? $t('Erst speichern') : on ? $t('Tunnel läuft') : $t('Tunnel starten')} />
              <IconButton label={$t('Entfernen')} onClick={() => { if (on) void stopForward(f); onChange(value.filter((x) => x.id !== f.id)); }}><X size={14} strokeWidth={1.75} /></IconButton>
            </div>
            <div className="fw-line">
              <TextField label={$t('Adresse, die geöffnet wird')} value={f.bindHost} onChange={(v) => set(f.id, { bindHost: v.trim() })} mono className="fw-host" />
              <span className="muted">:</span>
              <TextField label={$t('Port, der geöffnet wird')} value={String(f.bindPort)} onChange={(v) => set(f.id, { bindPort: port(v, 0) })} mono className="fw-port" />
              {f.kind !== 'dynamic' ? (
                <>
                  <span className="muted fw-arrow" aria-hidden="true">→</span>
                  <TextField label={$t('Ziel-Adresse')} value={f.destHost} onChange={(v) => set(f.id, { destHost: v.trim() })} mono className="fw-host" />
                  <span className="muted">:</span>
                  <TextField label={$t('Ziel-Port')} value={String(f.destPort)} onChange={(v) => set(f.id, { destPort: port(v, 1) })} mono className="fw-port" />
                </>
              ) : <span className="small muted">{$t('Programme nutzen ihn als SOCKS5-Proxy')}</span>}
            </div>
          </div>
        );
      })}
      <span className="row-inline">
        <Button small onClick={add}><Plus size={13} strokeWidth={2} /> {$t('Tunnel hinzufügen')}</Button>
      </span>
      <span className="small muted">
        {$t('Lokal → Server: ein Port auf diesem Computer führt über den Server zum Ziel, z. B. localhost:5433 → 127.0.0.1:5432 für die Datenbank auf dem Server. Server → Lokal: umgekehrt. SOCKS-Proxy: alle Verbindungen eines Programms gehen vom Server aus.')}
      </span>
    </div>
  );
}
