/**
 * Server editor › Weitere Einstellungen, the options of single protocols:
 * SFTP transfer method, trash, terminal, agent forwarding and tunnels; SMB
 * encryption; the TLS version; FTP file names, time zone and transfer mode.
 */
import type { Server } from '../../../backend/types';
import { SCHEMES } from '../../../state/terminal';
import { Select, Switch, TextField } from '../../ui';
import { $t } from '../../../i18n';
import { ForwardEditor } from '../ForwardEditor';
import { SUDO_SFTP, TIMEZONES, type Fam, type SetField } from './model';

export function ProtocolOptions({ draft, set, family }: { draft: Server; set: SetField; family: Fam }) {
  return (
    <>
      {family === 'sftp' && (
        <>
          <label htmlFor="s-scp">{$t('Dateiübertragung')}</label>
          <div className="col-text">
            <Select<'sftp' | 'sudo' | 'scp'>
              id="s-scp"
              label={$t('Dateiübertragung')}
              value={draft.scp ? 'scp' : draft.sftpCommand !== undefined ? 'sudo' : 'sftp'}
              onChange={(v) => {
                set('scp', v === 'scp' || undefined);
                set('sftpCommand', v === 'sudo' ? SUDO_SFTP : undefined);
              }}
              options={[
                { value: 'sftp', label: $t('SFTP (Standard)') },
                { value: 'sudo', label: $t('SFTP mit Root-Rechten (sudo)') },
                { value: 'scp', label: $t('SCP über Shell-Befehle') },
              ]}
            />
            {draft.sftpCommand !== undefined && !draft.scp && (
              <TextField
                label={$t('SFTP-Befehl')}
                value={draft.sftpCommand}
                onChange={(v) => set('sftpCommand', v)}
                mono
              />
            )}
            <span className="small muted">
              {draft.sftpCommand !== undefined && !draft.scp
                ? $t(
                    'Bitcrane startet den SFTP-Server über sudo und darf dann alles, was root darf, auch in /etc. Der Benutzer muss den Befehl ohne Passwort ausführen dürfen (NOPASSWD in sudoers). Vorsicht: Fehler treffen dann auch Systemdateien.',
                  )
                : $t(
                    'Hat der Server kein SFTP, nimmt Bitcrane von selbst SCP. Nur für Router, NAS und sehr alte Server nötig.',
                  )}
            </span>
          </div>
        </>
      )}
      {(family === 'sftp' || family === 'ftp') && (
        <>
          <span>{$t('Papierkorb')}</span>
          <div className="col-text">
            <span className="row-inline">
              <Switch
                checked={draft.trashDir !== undefined}
                onChange={(v) => set('trashDir', v ? '.bitcrane-papierkorb' : undefined)}
                label={$t('Papierkorb auf dem Server')}
              />
              <span>{$t('Papierkorb auf dem Server')}</span>
            </span>
            {draft.trashDir !== undefined && (
              <TextField
                label={$t('Ordner des Papierkorbs')}
                value={draft.trashDir}
                onChange={(v) => set('trashDir', v)}
                mono
                placeholder=".bitcrane-papierkorb"
              />
            )}
            <span className="small muted">
              {$t(
                'Gelöschtes wird in diesen Ordner verschoben statt sofort entfernt. Ohne / am Anfang liegt er im Startordner. Im Papierkorb selbst löscht Bitcrane endgültig.',
              )}
            </span>
          </div>
        </>
      )}
      {family === 'sftp' && (
        <>
          <label htmlFor="s-termscheme">{$t('Terminal')}</label>
          <div className="col-text">
            <div className="field-row">
              <Select
                id="s-termscheme"
                label={$t('Farbschema des Terminals')}
                value={draft.termScheme ?? ''}
                onChange={(v) => set('termScheme', v || undefined)}
                options={[
                  { value: '', label: $t('Farbschema wie eingestellt') },
                  ...SCHEMES.map((x) => ({ value: x.id, label: $t(x.name) })),
                ]}
              />
              <TextField
                label={$t('Befehl beim Start')}
                value={draft.termStart ?? ''}
                onChange={(v) => set('termStart', v || undefined)}
                placeholder={$t('Befehl beim Start, z. B. tmux attach')}
                mono
                className="flex-1"
              />
            </div>
            <span className="small muted">
              {$t(
                'Für das eingebaute Terminal. Ein eigenes Farbschema (z. B. rot) zeigt sofort, auf welchem Server du tippst.',
              )}
            </span>
          </div>
          <span>{$t('SSH-Agent')}</span>
          <div className="col-text">
            <span className="row-inline">
              <Switch
                checked={!!draft.forwardAgent}
                onChange={(v) => set('forwardAgent', v || undefined)}
                label={$t('SSH-Agent an den Server weiterleiten')}
              />
              <span>{$t('SSH-Agent an den Server weiterleiten')}</span>
            </span>
            <span className="small muted">
              {$t(
                'Im Terminal auf dem Server können Programme wie git deine Schlüssel von diesem Computer nutzen, ohne dass dort ein Schlüssel liegt. Nur bei Servern einschalten, denen du vertraust.',
              )}
            </span>
          </div>
        </>
      )}
      {family === 'sftp' && (
        <>
          <label>{$t('Tunnel')}</label>
          <ForwardEditor
            serverId={draft.id}
            value={draft.forwards ?? []}
            onChange={(v) => set('forwards', v.length ? v : undefined)}
          />
        </>
      )}
      {family === 'smb' && (
        <>
          <label htmlFor="s-smbenc">{$t('Verschlüsselung')}</label>
          <div className="col-text">
            <Select<'auto' | 'required'>
              id="s-smbenc"
              label={$t('Verschlüsselung')}
              value={draft.smbEncrypt ? 'required' : 'auto'}
              onChange={(v) => set('smbEncrypt', v === 'required' || undefined)}
              options={[
                { value: 'auto', label: $t('Wie der Server es verlangt (Standard)') },
                { value: 'required', label: $t('Immer verschlüsseln (SMB 3)') },
              ]}
            />
            <span className="small muted">
              {$t('Älteren NAS-Geräten fehlt SMB 3; dann kommt keine Verbindung zustande.')}
            </span>
          </div>
        </>
      )}

      {(draft.protocol === 'ftps' ||
        (draft.protocol === 'webdav' && draft.davHttps !== false) ||
        (draft.protocol === 's3' && !draft.s3Http)) && (
        <>
          <label htmlFor="s-tlsver">TLS-Version</label>
          <Select<'any' | '13'>
            id="s-tlsver"
            label="TLS-Version"
            value={draft.tls13Only ? '13' : 'any'}
            onChange={(v) => set('tls13Only', v === '13' || undefined)}
            options={[
              { value: 'any', label: $t('TLS 1.2 und 1.3') },
              { value: '13', label: $t('Nur TLS 1.3') },
            ]}
          />
        </>
      )}
      {family === 'ftp' && (
        <>
          <label htmlFor="s-enc">{$t('Dateinamen')}</label>
          <div className="col-text">
            <Select<'utf8' | 'latin1'>
              id="s-enc"
              label={$t('Zeichensatz der Dateinamen')}
              value={draft.ftpEncoding ?? 'utf8'}
              onChange={(v) => set('ftpEncoding', v === 'utf8' ? undefined : v)}
              options={[
                { value: 'utf8', label: $t('UTF-8 (Standard)') },
                { value: 'latin1', label: $t('Latin-1 / Windows (ältere Server)') },
              ]}
            />
            <span className="small muted">{$t('Wenn Umlaute in Dateinamen falsch aussehen, Latin-1 wählen.')}</span>
          </div>
          <label htmlFor="s-tz">{$t('Zeitzone des Servers')}</label>
          <div className="col-text">
            <Select
              id="s-tz"
              label={$t('Zeitzone des Servers')}
              value={String(draft.ftpTimezone ?? 0)}
              onChange={(v) => set('ftpTimezone', Number(v) || undefined)}
              options={TIMEZONES}
            />
            <span className="small muted">
              {$t('Nur für Server ohne genaue Zeitangaben (kein MLSD): ihre Uhrzeiten sind Ortszeit.')}
            </span>
          </div>
          <label htmlFor="s-mode">{$t('Übertragungsart')}</label>
          <div className="col-text">
            <Select<'binary' | 'ascii' | 'auto'>
              id="s-mode"
              label={$t('Übertragungsart')}
              value={draft.ftpMode ?? 'binary'}
              onChange={(v) => set('ftpMode', v === 'binary' ? undefined : v)}
              options={[
                { value: 'binary', label: $t('Binär (Standard, Dateien bleiben unverändert)') },
                { value: 'auto', label: $t('Automatisch (Textdateien als Text)') },
                { value: 'ascii', label: $t('Text (Zeilenenden anpassen)') },
              ]}
            />
            <span className="small muted">
              {$t('Text passt Zeilenenden zwischen Windows und Linux an. Abgebrochene Textübertragungen beginnen neu.')}
            </span>
          </div>
        </>
      )}
    </>
  );
}
