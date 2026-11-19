/**
 * "Schnell verbinden" in a half's server list (Transmit's Quick Connect): protocol, address, user,
 * password and start folder, without saving the server.
 */
import { useState } from 'react';
import { Lightning } from '@phosphor-icons/react';
import { type PaneSide } from '../backend/types';
import { quickConnect, useStore } from '../state/store';
import { Button, Select, TextField } from './ui';
import { $t } from '../i18n';
import { parseQuickAddress, QUICK_SCHEMES, schemeProtocol } from '../util/serverAddress';

type QuickProtocol = (typeof QUICK_SCHEMES)[number];

/**
 * "Schnell verbinden" (Transmit's Quick Connect): protocol, address, user,
 * password and start folder. For SFTP an empty password means SSH agent or key.
 */
export function QuickForm({ side }: { side: PaneSide }) {
  const [protocol, setProtocol] = useState<QuickProtocol>('sftp');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const platform = useStore((s) => s.platform);
  const [path, setPath] = useState('');
  const recent = useStore((s) => s.settings.recentAddresses);
  const address = () => {
    const h = host.trim();
    if (!h) return '';
    const p = port.trim() && Number(port) !== schemeProtocol(protocol).defaultPort ? `:${port.trim()}` : '';
    const dir = path.trim() ? (path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`) : '';
    return `${protocol}://${user.trim() ? `${user.trim()}@` : ''}${h}${p}${dir}`;
  };
  const go = (save: boolean, terminal = false) => {
    const a = address();
    if (!a) return;
    quickConnect(a, save, 'auto', side, password || undefined, terminal ? 'terminal' : undefined);
  };
  // A recent address fills the form again (read like any typed address: the last "@" ends the user).
  const fill = (a: string) => {
    const q = parseQuickAddress(a);
    if (!q) return;
    setProtocol((QUICK_SCHEMES as readonly string[]).includes(q.scheme) ? (q.scheme as QuickProtocol) : 'sftp');
    setUser(q.user ?? '');
    setHost(q.host.includes(':') ? `[${q.host}]` : q.host);
    setPort(q.port ? String(q.port) : '');
    setPath(q.path ?? '');
  };
  return (
    <form
      className="quick-form"
      onSubmit={(e) => {
        e.preventDefault();
        go(false);
      }}
    >
      <span className="quick-icon">
        <Lightning size={34} weight="fill" />
      </span>
      <h2 className="headline">{$t('Verbinden über {0}', protocolLabel(protocol))}</h2>
      <div className="quick-grid">
        <label htmlFor="q-proto">{$t('Protokoll#protocol')}</label>
        <Select
          id="q-proto"
          value={protocol}
          onChange={(v) => setProtocol(v as QuickProtocol)}
          label={$t('Protokoll#protocol')}
          options={QUICK_SCHEMES.map((p) => ({ value: p, label: protocolLabel(p) }))}
        />
        <label htmlFor="q-host">{$t('Adresse')}</label>
        <span className="quick-host">
          <TextField id="q-host" value={host} onChange={setHost} placeholder="server.example" mono autoFocus />
          <TextField
            value={port}
            onChange={(v) => setPort(v.replace(/\D/g, ''))}
            placeholder={String(schemeProtocol(protocol).defaultPort)}
            mono
            className="quick-port"
            label={$t('Port')}
          />
        </span>
        <label htmlFor="q-user">{$t('Benutzer')}</label>
        <TextField id="q-user" value={user} onChange={setUser} placeholder={protocol === 'sftp' ? 'ubuntu' : ''} mono />
        <label htmlFor="q-pass">{$t('Passwort')}</label>
        <TextField
          id="q-pass"
          type="password"
          value={password}
          onChange={setPassword}
          placeholder={protocol === 'sftp' ? $t('Leer: SSH-Schlüssel oder Agent') : ''}
        />
        <label htmlFor="q-path">{$t('Startordner')}</label>
        <TextField
          id="q-path"
          value={path}
          onChange={setPath}
          placeholder={protocol === 'smb' ? '/daten/ordner' : '/var/www'}
          mono
        />
      </div>
      <p className="small muted quick-note">
        {platform === 'mac'
          ? $t(
              'Das Passwort gilt nur für diese Verbindung. Mit „Zu Servern hinzufügen“ wird es im Schlüsselbund gesichert.',
            )
          : $t(
              'Das Passwort gilt nur für diese Verbindung. Mit „Zu Servern hinzufügen“ wird es in der Windows-Anmeldeinformationsverwaltung gesichert.',
            )}
      </p>
      <div className="quick-buttons">
        <Button onClick={() => go(true)} disabled={!host.trim()}>
          {$t('Zu Servern hinzufügen')}
        </Button>
        {/* SSH only: straight into a terminal tab, without the file view. */}
        {protocol === 'sftp' && (
          <Button onClick={() => go(false, true)} disabled={!host.trim()}>
            {$t('Terminal')}
          </Button>
        )}
        <Button variant="primary" type="submit" className="btn-go" disabled={!host.trim()}>
          {$t('Verbinden')}
        </Button>
      </div>
      {recent.length > 0 && (
        <div className="quick-recent">
          <span className="caption-strong">{$t('Zuletzt eingegeben')}</span>
          {recent.slice(0, 5).map((a) => (
            <button key={a} type="button" className="link small mono" onClick={() => fill(a)}>
              {a}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

function protocolLabel(p: QuickProtocol): string {
  return {
    sftp: 'SFTP / SSH',
    ftp: 'FTP',
    ftpes: $t('FTPS (explizit)'),
    ftps: $t('FTPS (implizit)'),
    davs: 'WebDAV (HTTPS)',
    dav: 'WebDAV (HTTP)',
    smb: $t('SMB (Windows-Freigabe, NAS)'),
  }[p];
}
