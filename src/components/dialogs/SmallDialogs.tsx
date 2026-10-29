/**
 * Smaller dialogs: quick connect, host key (fingerprint) checks, conflict,
 * permissions, delete confirmation, about and the shortcut overview.
 */
import { AlertTriangle, Cloud, Download, Info, KeyRound, ShieldAlert, ShieldCheck, Trash2, Zap } from '../glyphs';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import type { CloudPlace, ConflictChoice, HostKey, PaneSide, Server } from '../../backend/types';
import { activeTab, addCloudPlaces, closeDialog, deleteNames, LIVE, openDialog, openExternal, openServer, quickConnect, rejectHostKey, resolveConflict, savePerms, serverById, statEntry, submitSecret, trustHostKey, useStore, paneLoc, paneOnServer } from '../../state/store';
import { formatAgo, formatDate, formatSize, permsToText } from '../../util/format';
import { ServerTile } from '../ServerTile';
import { BMark, FileGlyph, FolderGlyph } from '../icons';
import { Button, Checkbox, Select, TextField } from '../ui';
import { Dialog } from './Dialog';
import { installUpdate } from '../../state/updates';
import { ACTIONS, FIXED, formatCombo, keysFor } from '../../state/keys';
import { $t } from '../../i18n';

/* ----------------------------------------------------------- Quick connect */

export function QuickConnect() {
  const [address, setAddress] = useState(LIVE ? '' : 'ubuntu@bots.example:22');
  const [auth, setAuth] = useState('auto');
  const [save, setSave] = useState(false);
  const servers = useStore((s) => s.servers);
  const addresses = useStore((s) => s.settings.recentAddresses);
  const now = useStore((s) => s.now);
  // Recently opened servers first, then typed addresses that are not a known server.
  const used = servers.filter((x) => x.lastUsed).sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0)).slice(0, 5);
  const addr = (x: Server) => `${x.user ? `${x.user}@` : ''}${x.host}${x.port !== 22 ? `:${x.port}` : ''}`;
  const recent = [
    ...used.map((x) => ({ key: x.id, server: x, label: x.name, sub: addr(x), when: formatAgo(x.lastUsed!, now), run: () => { closeDialog(); openServer(x.id); } })),
    ...addresses.filter((a) => !used.some((x) => addr(x) === a.replace(/\/.*$/, ''))).slice(0, 8 - used.length)
      .map((a) => ({ key: `a:${a}`, server: undefined, label: a, sub: $t('Adresse'), when: '', run: () => setAddress(a) })),
  ];
  return (
    <Dialog
      label={$t('Schnell verbinden')}
      title={$t('Schnell verbinden')}
      subtitle={$t('Ohne den Server zu speichern. Adresse wie im Terminal eingeben; für FTP oder WebDAV mit ftp://, ftps:// oder davs:// davor.')}
      icon={<span className="icon-tile tone-accent"><Zap size={18} strokeWidth={1.75} /></span>}
      width={560}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" onClick={() => quickConnect(address, save, auth as 'auto' | 'key' | 'password')}>{$t('Verbinden')}</Button></>}
    >
      <div className="form-stack">
        <TextField value={address} onChange={setAddress} mono autoFocus prefix={/^[a-z]+:\/\//i.test(address) ? undefined : <span className="muted">sftp://</span>} onEnter={() => quickConnect(address, save, auth as 'auto' | 'key' | 'password')} className="big-field" />
        <div className="row-inline">
          <span className="muted">{$t('Anmeldung')}</span>
          <Select value={auth} onChange={setAuth} label={$t('Anmeldung')} options={[{ value: 'auto', label: $t('Automatisch (Agent, Schlüssel, Passwort)') }, { value: 'key', label: $t('SSH-Schlüssel') }, { value: 'password', label: $t('Passwort') }]} />
        </div>
        <Checkbox checked={save} onChange={setSave} label={$t('Nach dem Verbinden als Server speichern')} />
        {recent.length > 0 && (
          <section className="form-stack-tight" aria-label={$t('Zuletzt verwendet')}>
            <span className="caption-strong">{$t('Zuletzt verwendet')}</span>
            <div className="recent-list">
              {recent.map((r) => (
                <button key={r.key} type="button" className="recent-item" onClick={r.run}>
                  {r.server ? <ServerTile server={r.server} size={20} /> : <span className="recent-dot"><Zap size={12} strokeWidth={1.75} /></span>}
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

/* -------------------------------------------------------------- Host key */

export function Fingerprint({ mode, keyInfo, serverId }: { mode: 'new' | 'changed'; keyInfo: HostKey; serverId: string }) {
  const [details, setDetails] = useState(false);
  const cert = keyInfo.algorithm === 'TLS-Zertifikat';
  if (mode === 'new') {
    return (
      <Dialog
        label={$t('Erste Verbindung')}
        title={$t('Erste Verbindung zu {0}', keyInfo.host)}
        subtitle={cert
          ? $t('Der Server verschlüsselt mit einem eigenen Zertifikat, das keine bekannte Stelle bestätigt hat (bei eigenen Servern üblich). Vergleiche den Fingerabdruck mit dem, den dein Anbieter nennt. Danach merkt sich Bitcrane ihn und warnt, falls er sich ändert.')
          : $t('Bitcrane kennt diesen Server noch nicht. Vergleiche den Fingerabdruck mit dem, den dein Server-Anbieter anzeigt. Danach merkt sich Bitcrane ihn und warnt, falls er sich ändert.')}
        icon={<span className="icon-tile tone-accent"><ShieldCheck size={20} strokeWidth={1.75} /></span>}
        width={600}
        onClose={() => rejectHostKey(serverId)}
        footer={<><span className="flex-1" /><Button onClick={() => rejectHostKey(serverId)}>{$t('Abbrechen')}</Button><Button variant="primary" onClick={() => trustHostKey(serverId)}>{$t('Vertrauen und verbinden')}</Button></>}
      >
        <div className="form-stack">
          <dl className="kv-card mono-values">
            <dt>{cert ? $t('Art') : $t('Verfahren')}</dt><dd>{keyInfo.algorithm}</dd>
            <dt>{$t('Fingerabdruck')}</dt><dd className="mono break">{keyInfo.fingerprint}</dd>
          </dl>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog
      label={$t('Fingerabdruck geändert')}
      title={$t('Fingerabdruck hat sich geändert')}
      subtitle={$t('Der Server meldet sich anders als beim letzten Mal. Das passiert nach einer Neuinstallation, kann aber auch ein Angriff sein. Bitcrane verbindet nicht, bis du es bestätigst.')}
      icon={<span className="icon-tile tone-danger"><ShieldAlert size={20} strokeWidth={1.75} /></span>}
      width={620}
      footer={<><Button variant="ghost" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? $t('Weniger') : $t('Details')}</Button><span className="flex-1" /><Button onClick={() => trustHostKey(serverId)}>{$t('Neuen übernehmen')}</Button><Button variant="primary" onClick={() => rejectHostKey(serverId)}>{$t('Nicht verbinden')}</Button></>}
    >
      <dl className="kv-card">
        <dt>{$t('Server')}</dt><dd>{keyInfo.host}</dd>
        <dt>{$t('Bisher')}</dt><dd className="mono break muted">{keyInfo.previous}</dd>
        <dt>{$t('Jetzt')}</dt><dd className="mono break tone-danger">{keyInfo.fingerprint}</dd>
      </dl>
      {details && (
        <div className="form-stack small details-help">
          <p>{$t('So prüfst du, ob der neue Fingerabdruck echt ist: Melde dich über die Web-Konsole deines Server-Anbieters an (nicht über SSH) und gib dort ein:')}</p>
          <pre className="mono code-box">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</pre>
          <p>{$t('Stimmt die ausgegebene Zeichenfolge mit „Jetzt“ überein, wurde der Server nur neu eingerichtet und du kannst den neuen Fingerabdruck übernehmen. Stimmt sie nicht überein, verbinde dich nicht und sprich mit deinem Anbieter.')}</p>
        </div>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------- Passphrase / password */

export function SecretPrompt({ serverId, kind, wrong }: { serverId: string; kind: 'passphrase' | 'password'; wrong?: boolean }) {
  const srv = serverById(serverId);
  const platform = useStore((s) => s.platform);
  const [value, setValue] = useState('');
  const [save, setSave] = useState(true);
  if (!srv) return null;
  const store = platform === 'mac' ? $t('im Schlüsselbund') : $t('in der Windows-Anmeldeinformationsverwaltung');
  const submit = () => {
    if (value) submitSecret(serverId, value, save, kind);
  };
  return (
    <Dialog
      label={kind === 'passphrase' ? $t('Passphrase') : $t('Passwort')}
      title={kind === 'passphrase' ? $t('Passphrase für den SSH-Schlüssel') : $t('Passwort für {0}@{1}', srv.user, srv.host)}
      subtitle={kind === 'passphrase'
        ? $t('Der Schlüssel {0} ist mit einer Passphrase geschützt.', srv.keyPath)
        : $t('{0} meldet sich mit Passwort an.', srv.name)}
      icon={<span className="icon-tile tone-accent"><KeyRound size={18} strokeWidth={1.75} /></span>}
      width={520}
      onClose={closeDialog}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" onClick={submit} disabled={!value}>{$t('Verbinden')}</Button></>}
    >
      <div className="form-stack">
        {wrong && (
          <div className="notice tone-warn-notice">
            <AlertTriangle size={15} strokeWidth={1.75} className="tone-warn" aria-hidden="true" />
            <span>{kind === 'passphrase' ? $t('Die Passphrase stimmt nicht.') : $t('Der Server hat das Passwort abgelehnt.')} {$t('Bitte noch einmal eingeben.')}</span>
          </div>
        )}
        <TextField type="password" value={value} onChange={setValue} autoFocus onEnter={submit} label={kind === 'passphrase' ? $t('Passphrase') : $t('Passwort')} />
        <Checkbox checked={save} onChange={setSave} label={$t('{0} sichern', store)} />
        <span className="small muted">{$t('Bitcrane speichert')}{' '}{kind === 'passphrase' ? $t('die Passphrase') : $t('das Passwort')} {$t('nie selbst, nur')}{' '}{store}.</span>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------- Questions of the server */

/** Questions of a server during login, e.g. a one-time code (2FA). */
export function AuthPrompt({ id, host, name, instructions, prompts }: { id: string; host: string; name: string; instructions: string; prompts: Array<{ text: string; echo: boolean }> }) {
  const [values, setValues] = useState<string[]>(prompts.map(() => ''));
  const answer = (answers: string[] | null) => {
    closeDialog();
    void invoke('auth_prompt_answer', { id, answers });
  };
  const submit = () => answer(values);
  return (
    <Dialog
      label={$t('Anmeldung')}
      title={name || $t('Anmeldung bei {0}', host)}
      subtitle={instructions || $t('Der Server stellt bei der Anmeldung eine Rückfrage, zum Beispiel nach einem Einmalcode aus deiner Authenticator-App.')}
      icon={<span className="icon-tile tone-accent"><KeyRound size={18} strokeWidth={1.75} /></span>}
      width={520}
      onClose={() => answer(null)}
      footer={<><span className="flex-1" /><Button onClick={() => answer(null)}>{$t('Abbrechen')}</Button><Button variant="primary" onClick={submit}>{$t('Anmelden')}</Button></>}
    >
      <div className="form-stack">
        {prompts.map((p, i) => (
          <label key={i} className="col-text">
            <span className="small">{p.text.trim()}</span>
            <TextField type={p.echo ? 'text' : 'password'} value={values[i]} onChange={(v) => setValues(values.map((x, j) => (j === i ? v : x)))} autoFocus={i === 0} onEnter={submit} label={p.text.trim()} mono={p.echo} />
          </label>
        ))}
        <span className="small muted">{$t('Die Antwort geht direkt an')}{' '}{host}{$t('; Bitcrane speichert sie nicht.')}</span>
      </div>
    </Dialog>
  );
}

/* -------------------------------------------------------------- Conflict */

export function ConflictDialog() {
  // A fresh form per conflict, so an answer never carries over to the next file.
  const id = useStore((s) => s.conflicts[0]?.transferId);
  return <ConflictForm key={id ?? ''} />;
}

function ConflictForm() {
  const conflict = useStore((s) => s.conflicts[0]);
  const platform = useStore((s) => s.platform);
  const servers = useStore((s) => s.servers);
  const [choice, setChoice] = useState<ConflictChoice>('keepServer');
  const [all, setAll] = useState(false);
  if (!conflict) return null;
  const srv = servers.find((x) => x.id === conflict.serverId);
  const down = conflict.direction === 'down';
  // Server to server: "your version" is the copy on the source server.
  const source = conflict.cross ? servers.find((x) => x.id === conflict.sourceServerId) : undefined;
  const here = source ? source.name : platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC');
  const tag = down ? $t('Server') : source ? source.name : platform === 'mac' ? $t('Mac') : 'PC';
  const renamed = conflict.name.replace(/(\.[^.]+)?$/, (ext) => ` (${tag})${ext}`);
  const remoteNewer = conflict.remoteTime - conflict.localTime > 1000;
  const localNewer = conflict.localTime - conflict.remoteTime > 1000;
  const options: Array<{ value: ConflictChoice; title: string; note: string }> = down
    ? [
        { value: 'keepServer', title: $t('Datei auf diesem Rechner behalten'), note: $t('Die Server-Version wird diesmal nicht heruntergeladen.') },
        { value: 'replace', title: $t('Ersetzen'), note: $t('Die Server-Version überschreibt die Datei auf diesem Rechner.') },
        { value: 'keepBoth', title: $t('Beide behalten'), note: $t('Die Server-Version wird als „{0}“ daneben gespeichert.', renamed) },
      ]
    : [
        { value: 'keepServer', title: $t('Server-Datei behalten'), note: $t('Deine Version wird diesmal nicht hochgeladen.') },
        { value: 'replace', title: $t('Ersetzen'), note: remoteNewer ? $t('Deine Version überschreibt die neuere Datei auf dem Server.') : $t('Deine Version überschreibt die Datei auf dem Server.') },
        { value: 'keepBoth', title: $t('Beide behalten'), note: $t('Deine Version wird als „{0}“ daneben hochgeladen.', renamed) },
        { value: 'download', title: $t('Server-Version herunterladen'), note: $t('Holt die Datei vom Server auf diesen Rechner, bevor du weiterarbeitest.') },
      ].filter((o) => !(conflict.cross && o.value === 'download')) as Array<{ value: ConflictChoice; title: string; note: string }>;
  const card = (label: string, size: number, time: number, newer: boolean) => (
    <div className={`compare-card${newer ? ' is-newer' : ''}`}>
      <span className="row-between"><span className="caption-strong">{label}</span>{newer && <span className="badge-warn">{$t('neuer')}</span>}</span>
      <span className="row-inline"><FileGlyph size={22} name={conflict.name} /><span className="col-text"><span className="strong-500">{conflict.name}</span><span className="small muted">{formatSize(size)} · {formatDate(time)}</span></span></span>
    </div>
  );
  return (
    <Dialog
      label={$t('Datei gibt es schon')}
      title={down ? $t('„{0}“ gibt es auf diesem Rechner schon', conflict.name) : $t('„{0}“ gibt es auf dem Server schon', conflict.name)}
      subtitle={down ? $t('Von: {0}, {1}', srv?.name ?? $t('Server'), conflict.remoteFolder) : $t('Ziel: {0}, {1}', srv?.name ?? $t('Server'), conflict.remoteFolder)}
      width={640}
      onClose={() => resolveConflict('keepServer', false)}
      footer={
        <>
          <Checkbox checked={all} onChange={setAll} label={$t('Für alle weiteren Fälle übernehmen{0}', conflict.more ? ` (${conflict.more})` : '')} disabled={!conflict.more} />
          <span className="flex-1" />
          <Button onClick={() => openDialog({ type: 'diff', transferId: conflict.transferId })}>{$t('Unterschiede zeigen')}</Button>
          <Button variant="primary" onClick={() => resolveConflict(choice, all)}>{$t('Weiter')}</Button>
        </>
      }
    >
      <div className="form-stack">
        {conflict.reason !== 'exists' ? (
          <div className="notice tone-warn-notice">
            <AlertTriangle size={15} strokeWidth={1.75} className="tone-warn" aria-hidden="true" />
            <span>{$t('Die Datei auf dem Server ist')}{' '}<strong className="tone-warn">{$t('neuer')}</strong> {$t('als deine. Jemand hat sie dort geändert.')}{conflict.watchName ? $t(' Die Überwachung „{0}“ wartet auf deine Entscheidung.', conflict.watchName) : ''}</span>
          </div>
        ) : (
          <div className="notice">
            <Info size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{$t('Am Ziel liegt schon eine Datei mit diesem Namen. Was soll passieren?')}</span>
          </div>
        )}
        <div className="compare">
          {card(here, conflict.localSize, conflict.localTime, localNewer)}
          {card(conflict.cross ? srv?.name ?? $t('Server') : $t('Server'), conflict.remoteSize, conflict.remoteTime, remoteNewer)}
        </div>
        <div role="radiogroup" aria-label={$t('Was soll passieren?')} className="radio-list">
          {options.map((o) => (
            <label key={o.value} className={`radio-row${choice === o.value ? ' is-on' : ''}`}>
              <input type="radio" name="conflict" checked={choice === o.value} onChange={() => setChoice(o.value)} />
              <span className="radio-dot" aria-hidden="true" />
              <span className="col-text"><span className="strong-500">{o.title}</span><span className="small muted">{o.note}</span></span>
            </label>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

/* ----------------------------------------------------------- Permissions */

export function PermsDialog({ side, path }: { side: PaneSide; path: string }) {
  const tab = activeTab();
  const entry = tab ? statEntry(...paneLoc(side, tab), path) : undefined;
  const [perms, setPerms] = useState(entry?.perms ?? '644');
  const [owner, setOwner] = useState(entry?.owner ?? '');
  const [group, setGroup] = useState(entry?.group ?? '');
  const [recursive, setRecursive] = useState(entry?.kind === 'dir');
  if (!entry || !tab) return null;
  const digits = perms.padEnd(3, '0').slice(0, 3).split('').map((d) => Number(d) || 0);
  const toggle = (r: number, c: number) => {
    const mask = [4, 2, 1][c];
    setPerms(digits.map((v, i) => (i === r ? v ^ mask : v)).join(''));
  };
  const valid = /^[0-7]{3}$/.test(perms);
  const fileVariant = perms.replace(/[1357]/g, (c) => String(Number(c) - 1));
  return (
    <Dialog
      label={$t('Rechte ändern')}
      title={$t('Rechte für „{0}“', entry.name)}
      subtitle={<span className="mono small">{path}</span>}
      icon={entry.kind === 'dir' ? <FolderGlyph size={36} /> : <FileGlyph size={32} />}
      width={540}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!valid} onClick={() => savePerms(side, path, perms, owner, group, recursive && entry.kind === 'dir')}>{$t('Übernehmen')}</Button></>}
    >
      <div className="form-stack">
        <div className="two-fields">
          {LIVE ? (
            <>
              <span>{$t('Besitzer')}</span><span className="mono">{owner || '–'}</span>
              <span>{$t('Gruppe')}</span><span className="mono">{group || '–'}</span>
              <span /><span className="small muted">{$t('Den Besitzer zu ändern braucht Administratorrechte auf dem Server (sudo chown); Bitcrane ändert nur die Rechte.')}</span>
            </>
          ) : (
            <>
              <label htmlFor="p-owner">{$t('Besitzer')}</label><TextField id="p-owner" value={owner} onChange={setOwner} />
              <label htmlFor="p-group">{$t('Gruppe')}</label><TextField id="p-group" value={group} onChange={setGroup} />
            </>
          )}
        </div>
        {paneOnServer(side, tab) && (
          <div className="notice tone-info-notice"><Info size={14} strokeWidth={1.75} aria-hidden="true" />{$t('Besitzer und Gruppe kann nur ändern, wer auf dem Server Administratorrechte hat.')}</div>
        )}
        <table className="perm-table">
          <thead><tr><th scope="col"><span className="vh">{$t('Wer')}</span></th><th scope="col">{$t('Lesen')}</th><th scope="col">{$t('Schreiben')}</th><th scope="col">{$t('Ausführen')}</th></tr></thead>
          <tbody>
            {[$t('Besitzer'), $t('Gruppe'), $t('Andere')].map((w, r) => (
              <tr key={w}>
                <th scope="row">{w}</th>
                {[$t('lesen'), $t('schreiben'), $t('ausführen')].map((x, c) => {
                  const on = (digits[r] & [4, 2, 1][c]) !== 0;
                  return (
                    <td key={x}>
                      <button type="button" role="checkbox" aria-checked={on} aria-label={`${w} ${x}`} className="perm-hit" onClick={() => toggle(r, c)}>
                        <span className={`checkbox-box${on ? ' is-on' : ''}`}>{on && <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.6"><path d="m3.5 8.5 3 3 6-7" /></svg>}</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row-inline">
          <label htmlFor="p-oct" className="muted">{$t('Als Zahl')}</label>
          <TextField id="p-oct" mono value={perms} onChange={(v) => setPerms(v.replace(/[^0-7]/g, '').slice(0, 3))} invalid={!valid} className="oct-field" />
          <span className="mono small muted">{valid ? permsToText(perms) : $t('drei Ziffern 0 bis 7')}</span>
        </div>
        {entry.kind === 'dir' && (
          <Checkbox checked={recursive} onChange={setRecursive} label={$t('Auch auf alle Unterordner und Dateien anwenden')} note={$t('Dateien bekommen dabei {0} statt {1}, damit sie nicht ausführbar werden.', fileVariant, perms)} />
        )}
      </div>
    </Dialog>
  );
}

/* --------------------------------------------------------- Delete confirm */

export function ConfirmDelete({ side, names }: { side: PaneSide; names: string[] }) {
  const tab = activeTab();
  const [ls, sid] = paneLoc(side, tab);
  const remote = ls === 'remote';
  const srv = remote ? serverById(sid) : undefined;
  const what = names.length === 1 ? `„${names[0]}“` : $t('{0} Objekte', names.length);
  return (
    <Dialog
      label={$t('Löschen bestätigen')}
      title={remote ? $t('{0} vom Server löschen?', what) : $t('{0} in den Papierkorb legen?', what)}
      subtitle={remote ? $t('Auf {0} gibt es keinen Papierkorb. Gelöschte Dateien sind dort endgültig weg.', srv?.name ?? $t('dem Server')) : $t('Du kannst sie aus dem Papierkorb wiederherstellen.')}
      icon={<span className="icon-tile tone-danger"><Trash2 size={20} strokeWidth={1.75} /></span>}
      width={480}
      footer={<><span className="flex-1" /><Button autoFocus onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="danger" onClick={() => deleteNames(side, names)}>{remote ? $t('Endgültig löschen') : $t('In den Papierkorb')}</Button></>}
    >
      {names.length > 1 && <ul className="delete-list small">{names.slice(0, 6).map((n) => <li key={n}>{n}</li>)}{names.length > 6 && <li>{$t('… und')}{' '}{names.length - 6} {$t('weitere')}</li>}</ul>}
    </Dialog>
  );
}

/* ---------------------------------------------------------------- About */

export function About() {
  const platform = useStore((s) => s.platform);
  const [version, setVersion] = useState(LIVE ? '' : $t('0.1.0 (Prototyp)'));
  useEffect(() => {
    if (LIVE) invoke<{ version: string }>('app_info').then((i) => setVersion(i.version)).catch(() => undefined);
  }, []);
  return (
    <Dialog label={$t('Über Bitcrane')} width={420} className="about">
      <div className="about-body">
        {platform === 'mac' ? <BMark variant="macApp" size={128} /> : <BMark variant="winApp" size={96} />}
        <span className="display">Bitcrane</span>
        <span className="small muted">{version ? $t('Version {0}', version) : ' '}</span>
        <span>{$t('von')}{' '}<strong>RaccoonWorks</strong></span>
        <p className="muted center">{$t('Dateien per SFTP übertragen und Ordner überwachen. Jede Änderung wird automatisch hochgeladen.')}</p>
        <div className="row-inline">
          <Button onClick={() => openExternal('https://bitcrane.de')}>{$t('Webseite')}</Button>
          <Button onClick={() => openDialog({ type: 'licenses' })}>{$t('Lizenzen')}</Button>
        </div>
        <span className="small muted">{$t('© 2026 RaccoonWorks')}</span>
      </div>
    </Dialog>
  );
}

/* --------------------------------------------------------------- Update */

/** A new version is ready: what changed, then download, install and restart. */
export function UpdateDialog() {
  const update = useStore((s) => s.update);
  const busy = useStore((s) => s.transfers.some((t) => t.state === 'running' || t.state === 'queued'));
  const [current, setCurrent] = useState('');
  useEffect(() => {
    if (LIVE) invoke<{ version: string }>('app_info').then((i) => setCurrent(i.version)).catch(() => undefined);
  }, []);
  if (!update) return null;
  // A quiet background download looks like "waiting" here, not like a running installation.
  const working = (update.status === 'downloading' && !update.background) || update.status === 'installing';
  const ready = update.status === 'ready';
  const pct = update.total ? Math.min(100, Math.round(((update.done ?? 0) / update.total) * 100)) : undefined;
  return (
    <Dialog
      label={$t('Update')}
      title={$t('Bitcrane {0} ist da', update.version ?? '')}
      subtitle={current ? $t('Installiert ist Version {0}.', current) : undefined}
      icon={<span className="icon-tile tone-accent"><Download size={20} strokeWidth={1.75} /></span>}
      width={520}
      onClose={working ? () => undefined : closeDialog}
      footer={
        <>
          <span className="flex-1" />
          {!working && <Button onClick={closeDialog}>{ready ? $t('Beim Beenden') : $t('Später')}</Button>}
          <Button variant="primary" disabled={working || update.status === 'downloading'} onClick={() => void installUpdate()}>
            {update.status === 'error' ? $t('Erneut versuchen') : update.status === 'downloading' && update.background ? $t('Wird geladen …') : working ? $t('Wird installiert …') : ready ? $t('Jetzt neu starten') : $t('Jetzt aktualisieren')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        {update.notes ? <p className="update-notes">{update.notes}</p> : null}
        {ready && <div className="notice"><Info size={15} strokeWidth={1.75} aria-hidden="true" /><span>{$t('Das Update ist schon geladen. Es wird installiert, wenn du Bitcrane beendest, oder jetzt mit einem Neustart.')}</span></div>}
        {busy && !working && <div className="notice"><Info size={15} strokeWidth={1.75} aria-hidden="true" /><span>{$t('Laufende Übertragungen werden unterbrochen und nach dem Neustart fortgesetzt.')}</span></div>}
        {working && (
          <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="progress"><div className="progress-fill" style={{ width: `${pct ?? (update.status === 'installing' ? 100 : 5)}%` }} /></div>
            <span className="small muted">{update.status === 'installing' ? $t('Wird installiert, Bitcrane startet gleich neu …') : update.total ? $t('{0} von {1}', formatSize(update.done ?? 0), formatSize(update.total)) : $t('Wird geladen …')}</span>
          </div>
        )}
        {update.status === 'error' && <div className="notice tone-warn-notice"><AlertTriangle size={15} strokeWidth={1.75} className="tone-warn" aria-hidden="true" /><span>{$t('Das Update konnte nicht installiert werden. Bitcrane läuft in der bisherigen Version weiter.')}</span></div>}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------- Licenses */

type LicenseEntry = { name: string; version: string; license: string; kind: 'npm' | 'rust' };

/** Lists the third-party packages shipped with Bitcrane and their licenses. */
export function Licenses() {
  const [items, setItems] = useState<LicenseEntry[] | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    // Loaded on demand so the list does not weigh down the start.
    import('../../licenses.json').then((m) => setItems(m.default as LicenseEntry[])).catch(() => setItems([]));
  }, []);
  const q = query.trim().toLowerCase();
  const shown = (items ?? []).filter((i) => !q || i.name.toLowerCase().includes(q) || i.license.toLowerCase().includes(q));
  return (
    <Dialog
      label={$t('Lizenzen')}
      title={$t('Lizenzen')}
      subtitle={$t('Bitcrane verwendet freie Software. Die Lizenztexte liegen den jeweiligen Paketen bei.')}
      width={560}
      maxHeight={620}
      className="licenses"
      footer={<><Button onClick={() => openDialog({ type: 'about' })}>{$t('Zurück')}</Button><span className="flex-1" /><span className="small muted">{items ? $t('{0} Pakete', shown.length) : ''}</span><Button variant="primary" onClick={closeDialog}>{$t('Fertig')}</Button></>}
    >
      <TextField value={query} onChange={setQuery} placeholder={$t('Paket oder Lizenz suchen')} label={$t('Paket oder Lizenz suchen')} autoFocus />
      <ul className="license-list">
        {shown.map((i) => (
          <li key={`${i.kind}:${i.name}@${i.version}`}>
            <span className="license-name">{i.name}</span>
            <span className="small muted mono">{i.version}</span>
            <span className="flex-1" />
            <span className="small muted">{i.license || $t('unbekannt')}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/* ------------------------------------------------------------ Shortcuts */

/* ----------------------------------------------------------- Cloud folders */

/**
 * First start (Transmit does the same on the Mac): cloud storage folders found
 * on this computer, ticked, to be added to the places bar.
 */
export function CloudPlacesDialog({ found }: { found: CloudPlace[] }) {
  const [picked, setPicked] = useState<string[]>(found.map((c) => c.path));
  const platform = useStore((s) => s.platform);
  const toggle = (path: string, on: boolean) => setPicked((cur) => (on ? [...cur, path] : cur.filter((p) => p !== path)));
  return (
    <Dialog
      label={$t('Cloud-Ordner gefunden')}
      title={$t('Cloud-Ordner gefunden')}
      subtitle={$t('Bitcrane kann sie in die Ortsleiste übernehmen, dann sind sie mit einem Klick erreichbar.')}
      icon={<span className="icon-tile tone-accent"><Cloud size={20} strokeWidth={1.75} /></span>}
      width={500}
      footer={<>
        <span className="flex-1" />
        <Button onClick={closeDialog}>{$t('Nicht jetzt')}</Button>
        <Button variant="primary" autoFocus disabled={!picked.length} onClick={() => addCloudPlaces(found.filter((c) => picked.includes(c.path)))}>{$t('Zur Ortsleiste hinzufügen')}</Button>
      </>}
    >
      <div className="form-stack">
        {found.map((c) => (
          <Checkbox key={c.path} checked={picked.includes(c.path)} onChange={(v) => toggle(c.path, v)} label={c.name} note={<span className="mono">{c.path}</span>} />
        ))}
        {platform === 'mac' && <p className="small muted">{$t('Beim ersten Öffnen fragt macOS, ob Bitcrane auf den Ordner zugreifen darf.')}</p>}
      </div>
    </Dialog>
  );
}

export function ConfirmDialog({ title, text, confirm, danger, run }: { title: string; text: string; confirm: string; danger?: boolean; run: () => void }) {
  return (
    <Dialog label={title} title={title} subtitle={text} width={480}
      icon={danger ? <span className="icon-tile tone-danger"><Trash2 size={20} strokeWidth={1.75} /></span> : <span className="icon-tile tone-accent"><Info size={20} strokeWidth={1.75} /></span>}
      footer={<><span className="flex-1" /><Button autoFocus={danger} onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant={danger ? 'danger' : 'primary'} autoFocus={!danger} onClick={() => { closeDialog(); run(); }}>{confirm}</Button></>}>
      {null}
    </Dialog>
  );
}

export function Shortcuts() {
  const platform = useStore((s) => s.platform);
  useStore((s) => s.settings.shortcuts);
  const rows: Array<[string, string]> = [
    ...ACTIONS.map((a) => [a.label, keysFor(a.id, platform).map((k) => formatCombo(k, platform)).join('  ') || '–'] as [string, string]),
    ...FIXED.map((f) => [f.label, platform === 'mac' ? f.mac : f.win] as [string, string]),
  ];
  return (
    <Dialog label={$t('Tastenkürzel')} title={$t('Tastenkürzel')} subtitle={platform === 'mac' ? $t('Mac') : $t('Windows')} width={560} maxHeight={680}
      footer={<><Button variant="ghost" onClick={() => openDialog({ type: 'settings', tab: 'keys' })}>{$t('Ändern …')}</Button><span className="flex-1" /><Button variant="primary" onClick={closeDialog}>{$t('Fertig')}</Button></>}>
      <dl className="shortcut-list">
        {rows.map(([what, keys]) => (
          <div key={what} className="shortcut-row"><dt>{what}</dt><dd><kbd>{keys}</kbd></dd></div>
        ))}
      </dl>
      {!LIVE && <p className="small muted">{$t('Im Browser fängt der Browser selbst einige Kürzel ab (zum Beispiel ⌘T, ⌘W, ⇧⌘N). Im echten Programm funktionieren sie.')}</p>}
    </Dialog>
  );
}
