/**
 * "Server importieren": shows the servers saved in FileZilla, WinSCP and the
 * SSH configuration; ticked ones are added to Bitcrane. Passwords are never
 * taken over (they are asked for on the first connection).
 */
import { Loader2 } from '../glyphs';
import { useEffect, useState } from 'react';
import type { ImportedServer } from '../../backend/api';
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { closeDialog, getState, importServers, LIVE } from '../../state/store';
import { Button, Checkbox } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

const DEMO: ImportedServer[] = [
  { source: 'SSH-Konfiguration', name: 'bots', group: '', host: 'bots.example', port: 22, user: 'ubuntu', protocol: 'sftp', implicitTls: false, auth: 'key', keyPath: '~/.ssh/cloud_ed25519' },
  { source: 'FileZilla', name: 'Webseite', group: 'Community', host: 'web.community.example', port: 21, user: 'web', protocol: 'ftps', implicitTls: false, auth: 'password' },
  { source: 'WinSCP', name: 'NAS', group: 'Privat', host: 'nas.local', port: 22, user: 'admin', protocol: 'sftp', implicitTls: false, auth: 'password' },
];

const protoLabel = (s: ImportedServer) => (s.protocol === 'ftps' ? (s.implicitTls ? $t('FTPS (implizit)') : 'FTPS') : s.protocol.toUpperCase());
// Same server = same protocol, user, host, port and key file; host and user without regard to case.
const keyOf = (s: { host: string; port: number; user: string; protocol?: string; keyPath?: string; auth?: string }) =>
  `${s.protocol ?? 'sftp'}|${s.user.toLowerCase()}@${s.host.toLowerCase()}:${s.port}|${s.auth === 'key' ? (s.keyPath ?? '') : ''}`;

/** Index of the first entry with the same server (protocol, user, host, port). */
const firstIndex = (list: ImportedServer[], s: ImportedServer) => list.findIndex((x) => keyOf(x) === keyOf(s));

export function ImportDialog() {
  const [found, setFound] = useState<{ servers: ImportedServer[]; sources: string[] } | null>(LIVE ? null : { servers: DEMO, sources: ['SSH-Konfiguration', 'FileZilla', 'WinSCP'] });
  const existing = new Set(getState().servers.filter((x) => !x.temporary).map(keyOf));
  const [picked, setPicked] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (LIVE) backend.importFind().then(setFound).catch(() => setFound({ servers: [], sources: [] }));
  }, []);
  useEffect(() => {
    // Preselect each new server once; the same server from a second program stays unticked.
    if (found) setPicked(new Set(found.servers.map((s, i) => [s, i] as const).filter(([s, i]) => !existing.has(keyOf(s)) && firstIndex(found.servers, s) === i).map(([, i]) => i)));
    // Only when the list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found]);

  const sources = found ? [...new Set(found.servers.map((s) => s.source))] : [];
  const toggle = (i: number) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(i)) n.delete(i); else n.add(i);
    return n;
  });

  return (
    <Dialog
      label={$t('Server importieren')}
      title={$t('Server importieren')}
      subtitle={$t('Aus FileZilla, WinSCP und der SSH-Konfiguration. Passwörter werden nicht übernommen; Bitcrane fragt beim ersten Verbinden danach.')}
      width={760}
      maxHeight={680}
      footer={<><span className="small muted">{picked.size ? $t('{0} ausgewählt', picked.size) : ''}</span><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!picked.size} onClick={() => found && importServers(found.servers.filter((_, i) => picked.has(i)))}>{$t('Übernehmen')}</Button></>}
    >
      {!found && <span className="row-inline muted"><Loader2 size={14} className="spin" aria-hidden="true" />{$t('Wird gesucht …')}</span>}
      {found && !found.servers.length && (
        <p className="muted">{$t('Keine gespeicherten Server gefunden. Gesucht wurde in: FileZilla (sitemanager.xml), WinSCP (Registry bzw. WinSCP.ini) und ~/.ssh/config.')}</p>
      )}
      {found && found.servers.length > 0 && (
        <div className="form-stack">
          {sources.map((src) => (
            <section key={src} className="import-group" aria-label={src}>
              <span className="caption-strong">{src}</span>
              <div className="import-list">
                {found.servers.map((s, i) => (s.source !== src ? null : (
                  <label key={i} className={`import-row${existing.has(keyOf(s)) ? ' is-known' : ''}`}>
                    <Checkbox checked={picked.has(i)} onChange={() => toggle(i)} label="" />
                    <span className="col-text min-w-0">
                      <span className="strong-500 ellipsis">{s.group ? `${s.group} / ` : ''}{s.name}</span>
                      <span className="small muted mono ellipsis">{s.user ? `${s.user}@` : ''}{s.host}:{s.port}{s.remoteDir ? ` · ${s.remoteDir}` : ''}</span>
                    </span>
                    <span className="small muted">{protoLabel(s)}</span>
                    <span className="small muted">{s.auth === 'key' ? $t('Schlüssel') : s.auth === 'agent' ? $t('Agent') : $t('Passwort')}</span>
                    {existing.has(keyOf(s)) ? <span className="tag">{$t('schon vorhanden')}</span> : firstIndex(found.servers, s) !== i && <span className="tag">{$t('doppelt')}</span>}
                  </label>
                )))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
