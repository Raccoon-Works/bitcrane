/**
 * Quick connect: opens a server from a typed address without saving it, and
 * lists the recently used servers and addresses.
 */
import { useState } from 'react';
import type { Server } from '../../backend/types';
import { closeDialog, LIVE, openServer, quickConnect, useStore } from '../../state/store';
import { addressOf } from '../../util/serverAddress';
import { formatAgo } from '../../util/format';
import { Zap } from '../glyphs';
import { ServerTile } from '../ServerTile';
import { Button, Checkbox, Segmented, Select, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function QuickConnect({ terminal = false }: { terminal?: boolean }) {
  const [address, setAddress] = useState(LIVE ? '' : 'deploy@shop.example:22');
  const [as, setAs] = useState<'files' | 'terminal'>(terminal ? 'terminal' : 'files');
  // FTP, WebDAV and SMB have no terminal; the choice only shows for SSH addresses.
  const sshAddress = !/^(ftps?|davs?|https?|smb):\/\//i.test(address.trim());
  const [auth, setAuth] = useState('auto');
  const [save, setSave] = useState(false);
  const go = () =>
    quickConnect(
      address,
      save,
      auth as 'auto' | 'key' | 'password',
      undefined,
      undefined,
      as === 'terminal' && sshAddress ? 'terminal' : undefined,
    );
  const servers = useStore((s) => s.servers);
  const addresses = useStore((s) => s.settings.recentAddresses);
  const now = useStore((s) => s.now);
  // Recently opened servers first, then typed addresses that are not a known server.
  const used = servers
    .filter((x) => x.lastUsed)
    .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
    .slice(0, 5);
  const addr = (x: Server) => `${x.user ? `${x.user}@` : ''}${x.host}${x.port !== 22 ? `:${x.port}` : ''}`;
  const recent = [
    ...used.map((x) => ({
      key: x.id,
      server: x,
      label: x.name,
      sub: addressOf(x),
      when: formatAgo(x.lastUsed!, now),
      run: () => {
        closeDialog();
        if (as === 'terminal' && (!x.protocol || x.protocol === 'sftp'))
          void import('../../state/terminal').then((m) => m.openServerTerminal(x.id));
        else openServer(x.id);
      },
    })),
    ...addresses
      .filter((a) => !used.some((x) => addr(x) === a.replace(/\/.*$/, '')))
      .slice(0, 8 - used.length)
      .map((a) => ({
        key: `a:${a}`,
        server: undefined,
        label: a,
        sub: $t('Adresse'),
        when: '',
        run: () => setAddress(a),
      })),
  ];
  return (
    <Dialog
      label={terminal ? $t('Neue SSH-Verbindung') : $t('Schnell verbinden')}
      title={terminal ? $t('Neue SSH-Verbindung') : $t('Schnell verbinden')}
      subtitle={$t(
        'Ohne den Server zu speichern. Adresse wie im Terminal eingeben, auch als „ssh benutzer@server“; für FTP, WebDAV oder SMB mit ftp://, ftps://, davs:// oder smb:// davor.',
      )}
      icon={
        <span className="icon-tile tone-accent">
          <Zap size={18} strokeWidth={1.75} />
        </span>
      }
      width={560}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={closeDialog}>{$t('Abbrechen')}</Button>
          <Button variant="primary" onClick={go}>
            {$t('Verbinden')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <TextField
          value={address}
          onChange={setAddress}
          mono
          autoFocus
          placeholder={terminal ? 'benutzer@server' : undefined}
          prefix={
            terminal || /^[a-z]+:\/\/|^ssh\s/i.test(address.trim()) ? undefined : <span className="muted">sftp://</span>
          }
          onEnter={go}
          className="big-field"
        />
        <div className="row-inline">
          <span className="muted">{$t('Anmeldung')}</span>
          <Select
            value={auth}
            onChange={setAuth}
            label={$t('Anmeldung')}
            options={[
              { value: 'auto', label: $t('Automatisch (Agent, Schlüssel, Passwort)') },
              { value: 'key', label: $t('SSH-Schlüssel') },
              { value: 'password', label: $t('Passwort') },
            ]}
          />
        </div>
        {sshAddress && (
          <div className="row-inline">
            <span className="muted">{$t('Öffnen')}</span>
            <Segmented<'files' | 'terminal'>
              label={$t('Öffnen')}
              value={as}
              onChange={setAs}
              options={[
                { value: 'files', label: $t('Dateien') },
                { value: 'terminal', label: $t('Terminal') },
              ]}
            />
          </div>
        )}
        <Checkbox checked={save} onChange={setSave} label={$t('Nach dem Verbinden als Server speichern')} />
        {recent.length > 0 && (
          <section className="form-stack-tight" aria-label={$t('Zuletzt verwendet')}>
            <span className="caption-strong">{$t('Zuletzt verwendet')}</span>
            <div className="recent-list">
              {recent.map((r) => (
                <button key={r.key} type="button" className="recent-item" onClick={r.run}>
                  {r.server ? (
                    <ServerTile server={r.server} size={20} />
                  ) : (
                    <span className="recent-dot">
                      <Zap size={12} strokeWidth={1.75} />
                    </span>
                  )}
                  <span className="col-text min-w-0 flex-1">
                    <span className="ellipsis">{r.label}</span>
                    <span className="small muted mono ellipsis">{r.sub}</span>
                  </span>
                  <span className="small muted">{r.when}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
}
