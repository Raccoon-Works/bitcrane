/**
 * Server management: list of saved servers on the left, the selected
 * server's settings on the right. Opens for a new server when no id is given.
 */
import { SCHEMES } from '../../state/terminal';
import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Check, ChevronRight, FolderPlus, KeyRound, Plus, Search, Trash2 } from '../glyphs';
import { useEffect, useMemo, useState } from 'react';
import type { KeyInfo } from '../../backend/api';
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { isCloudProtocol, type AuthMethod, type Protocol, type Server, type ServerColor } from '../../backend/types';
import { davUrl, hasStoredSecret, proxyAccount, testServer } from '../../state/live';
import { askRemoveServer, closeDialog, getState, LIVE, monoFor, newServerTemplate, openDialog, openExternal, saveServer, showToast, updateSettings, useStore } from '../../state/store';
import { CLOUD_NAMES, GDRIVE_GUIDE_URL, googleKey, saveGoogleKey, showCloudNotSetUp } from '../../state/cloud';
import { KeyPanel } from '../KeyPanel';
import { ServerTile, swatch } from '../ServerTile';
import { Button, Segmented, Select, Switch, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';
import { ForwardEditor } from './ForwardEditor';

/** Stable empty list for the store selector (a new [] would redraw endlessly). */
const NO_RULES: import('../../state/store').TransferRule[] = [];

/** Reads an image file and shrinks it to a 64 px square PNG (centred, transparent edges). */
function pictureFromFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = 64;
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('canvas')); return; }
      const scale = Math.min(side / img.width, side / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (side - w) / 2, (side - h) / 2, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}

const colors: ServerColor[] = ['gray', 'blue', 'purple', 'green', 'yellow', 'orange', 'red'];

/** Time zones for FTP servers that list local times (UTC-12 to UTC+14). */
const TIMEZONES = Array.from({ length: 27 }, (_, i) => i - 12).map((h) => ({ value: String(h * 60), label: h === 0 ? $t('UTC (Standard)') : `UTC${h > 0 ? '+' : '−'}${Math.abs(h)}${h === 1 ? $t(' (Winterzeit Deutschland)') : h === 2 ? $t(' (Sommerzeit Deutschland)') : ''}` }));

/** Fixed fields of a cloud service entry (no address, port or password of its own). */
function cloudDefaults(service: Protocol): Partial<Server> {
  return { protocol: service, host: service === 'gdrive' ? 'drive.google.com' : service === 'onedrive' ? 'onedrive.live.com' : 'dropbox.com', port: 443, auth: 'agent', remoteStart: '' };
}

export function ServerEdit({ serverId, cloud: presetCloud, terminal }: { serverId?: string; cloud?: Protocol; terminal?: boolean }) {
  const servers = useStore((s) => s.servers).filter((x) => !x.temporary);
  const rules = useStore((s) => s.settings.rules) ?? NO_RULES;
  const platform = useStore((s) => s.platform);
  const [currentId, setCurrentId] = useState<string | undefined>(serverId);
  const [draft, setDraft] = useState<Server>(() => servers.find((x) => x.id === serverId) ?? (presetCloud ? { ...newServerTemplate(), ...cloudDefaults(presetCloud) } : { ...newServerTemplate(), ...(terminal ? { openAs: 'terminal' as const } : {}) }));
  // The user's own Google app key (Google Drive only): the id from the settings, the secret only typed here.
  const [googleId, setGoogleId] = useState(() => getState().settings.googleClientId ?? '');
  const [googleSecret, setGoogleSecret] = useState('');
  const [googleStored, setGoogleStored] = useState(false);
  useEffect(() => { void googleKey().then((k) => setGoogleStored(!!k?.clientSecret)); }, []);
  const [query, setQuery] = useState('');
  const [test, setTest] = useState<'idle' | 'running' | 'ok' | 'fail'>('idle');
  const [testText, setTestText] = useState('');
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const [keyPanel, setKeyPanel] = useState(false);
  const [secretStored, setSecretStored] = useState(false);
  const [more, setMore] = useState(() => !!(draft.proxy || draft.webUrl || draft.note));
  const [proxyPassword, setProxyPassword] = useState('');
  const [proxyStored, setProxyStored] = useState(false);
  const defaults = useStore((s) => s.settings.serverDefaults);
  useEffect(() => {
    const p = draft.proxy;
    if (!LIVE || !p?.user || !p.host) { setProxyStored(false); return; }
    backend.secretGet(proxyAccount(p)).then((v) => setProxyStored(v !== null)).catch(() => setProxyStored(false));
  }, [draft.proxy]);
  const store = platform === 'mac' ? $t('im Schlüsselbund') : $t('in der Anmeldeinformationsverwaltung');

  // Key type and whether its passphrase is in the keychain (desktop app only).
  useEffect(() => {
    if (!LIVE || (draft.auth !== 'key' && draft.auth !== 'auto')) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      backend.keyInfo(draft.keyPath).then((k) => { if (!cancelled) setKeyInfo(k); }).catch(() => undefined);
      hasStoredSecret(draft).then((v) => { if (!cancelled) setSecretStored(v); }).catch(() => undefined);
    }, 250);
    return () => { cancelled = true; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.keyPath, draft.auth]);

  const chooseKey = async () => {
    const picked = await openFileDialog({ multiple: false, directory: false, title: $t('SSH-Schlüssel wählen') }).catch(() => null);
    if (typeof picked === 'string') set('keyPath', await invoke<string>('path_to_ui', { path: picked }));
  };
  const isNew = !servers.some((x) => x.id === draft.id);
  /** Signs in to the chosen cloud service (Google Drive: keeps the entered app key first). */
  const signIn = async () => {
    const service = draft.protocol;
    if (!service) return;
    if (service === 'gdrive') await saveGoogleKey(googleId, googleSecret);
    if ((service === 'dropbox' || service === 'onedrive') && LIVE && !getState().cloudAvailable[service]) { showCloudNotSetUp(service); return; }
    openDialog({ type: 'cloudSignIn', service });
  };
  const cloud = isCloudProtocol(draft.protocol);
  const family: 'sftp' | 'ftp' | 'webdav' | 'smb' | 'cloud' = cloud ? 'cloud' : draft.protocol === 'ftp' || draft.protocol === 'ftps' ? 'ftp' : draft.protocol === 'webdav' ? 'webdav' : draft.protocol === 'smb' ? 'smb' : 'sftp';
  /** Default ports per protocol; a port the user chose stays. */
  const STANDARD_PORTS = [22, 21, 990, 443, 80, 445];
  const setFamily = (f: 'sftp' | 'ftp' | 'webdav' | 'smb' | 'cloud') => {
    setTest('idle');
    setDraft((d) => {
      // Cloud services (Transmit lists them with the protocols): signed in through the browser, no address or password.
      if (f === 'cloud') return { ...d, ...cloudDefaults('dropbox') };
      const port = (p: number) => (STANDARD_PORTS.includes(d.port) ? p : d.port);
      if (f === 'sftp') return { ...d, protocol: 'sftp', host: isCloudProtocol(d.protocol) ? '' : d.host, port: isCloudProtocol(d.protocol) ? 22 : port(22), auth: d.protocol && d.protocol !== 'sftp' ? 'auto' : d.auth };
      if (f === 'ftp') return { ...d, protocol: 'ftps', implicitTls: false, port: port(21), auth: 'password' };
      if (f === 'smb') return { ...d, protocol: 'smb', port: port(445), auth: 'password', proxy: undefined };
      return { ...d, protocol: 'webdav', davHttps: d.davHttps ?? true, port: port(d.davHttps === false ? 80 : 443), auth: 'password' };
    });
  };
  const setFtpTls = (v: 'explicit' | 'implicit' | 'none') => {
    setTest('idle');
    setDraft((d) => ({
      ...d,
      protocol: v === 'none' ? 'ftp' : 'ftps',
      implicitTls: v === 'implicit',
      port: v === 'implicit' ? (d.port === 21 ? 990 : d.port) : d.port === 990 ? 21 : d.port,
    }));
  };

  const pick = (id: string) => {
    const srv = servers.find((x) => x.id === id);
    if (!srv) return;
    setCurrentId(id);
    setDraft(srv);
    setTest('idle');
  };
  const set = <K extends keyof Server>(k: K, v: Server[K]) => { setDraft((d) => ({ ...d, [k]: v })); setTest('idle'); };

  const groups = useMemo(() => {
    const q = query.toLowerCase();
    const list = servers.filter((x) => !q || x.name.toLowerCase().includes(q) || x.host.toLowerCase().includes(q));
    const map = new Map<string, Server[]>();
    for (const x of list) map.set(x.group || $t('Ohne Gruppe'), [...(map.get(x.group || $t('Ohne Gruppe')) ?? []), x]);
    return [...map.entries()];
  }, [servers, query]);

  const valid = draft.host.trim() && draft.user.trim();
  const finish = (connect: boolean) => {
    if (!valid) {
      showToast($t('Bitte Server und Benutzer eintragen.'), 'error');
      return;
    }
    const name = draft.name.trim() || draft.host.trim();
    const mono = draft.mono || monoFor(name);
    // In the app an empty start folder means the user's home folder on the server.
    // The proxy password goes to the keychain only.
    if (LIVE && draft.proxy?.user && proxyPassword) void backend.secretSet(proxyAccount(draft.proxy), proxyPassword).catch(() => showToast($t('Proxy-Passwort konnte nicht gespeichert werden.'), 'error'));
    saveServer({ ...draft, name, mono, proxy: draft.proxy?.host ? draft.proxy : undefined, remoteStart: draft.remoteStart || (LIVE ? '' : `/home/${draft.user}`) }, connect);
  };

  const runTest = () => {
    if (!valid) { showToast($t('Bitte Server und Benutzer eintragen.'), 'error'); return; }
    setTest('running');
    if (LIVE) {
      void testServer({ ...draft, host: draft.host.trim(), user: draft.user.trim() }).then((r) => {
        setTest(r.ok ? 'ok' : 'fail');
        setTestText(r.text);
      });
      return;
    }
    window.setTimeout(() => {
      const ok = !draft.host.includes('fehler');
      setTest(ok ? 'ok' : 'fail');
      setTestText(ok ? $t('Erreichbar, Anmeldung erfolgreich') : $t('Server nicht erreichbar. Adresse und Port prüfen.'));
    }, 900);
  };

  const footer = (
    <>
      {cloud
        ? (!isNew && <Button onClick={() => draft.protocol && openDialog({ type: 'cloudSignIn', service: draft.protocol, serverId: draft.id })}>{$t('Neu anmelden …')}</Button>)
        : <Button onClick={runTest} disabled={test === 'running'}>{test === 'running' ? $t('Teste …') : $t('Verbindung testen')}</Button>}
      {test === 'ok' && <span className="small tone-ok row-inline test-result"><Check size={13} strokeWidth={2.2} aria-hidden="true" />{testText}</span>}
      {test === 'fail' && <span className="small tone-danger test-result">{testText}</span>}
      <span className="flex-1" />
      {!isNew && <Button variant="ghost" className="tone-danger-text" onClick={() => askRemoveServer(draft.id)}><Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />{$t('Entfernen')}</Button>}
      <Button onClick={closeDialog}>{$t('Abbrechen')}</Button>
      {cloud && isNew
        // A new cloud service is created by signing in (the browser gives Bitcrane the account).
        ? <Button variant="primary" disabled={draft.protocol === 'gdrive' && (!googleId.trim() || (!googleSecret.trim() && !googleStored))} onClick={() => void signIn()}>{$t('Bei {0} anmelden …', CLOUD_NAMES[draft.protocol ?? ''] ?? '')}</Button>
        : <>
          <Button onClick={() => finish(false)}>{$t('Sichern')}</Button>
          <Button variant="primary" onClick={() => finish(true)}>{$t('Verbinden')}</Button>
        </>}
    </>
  );

  return (
    <Dialog label={$t('Server verwalten')} windowLike windowTitle={$t('Server')} width={1000} maxHeight={680} footer={footer} className="server-dialog">
      <div className="split">
        <div className="split-list">
          <label className="search small-search">
            <Search size={13} strokeWidth={1.5} aria-hidden="true" />
            <span className="vh">{$t('Server suchen')}</span>
            <input type="search" placeholder={$t('Server suchen')} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="split-scroll" role="listbox" aria-label={$t('Gespeicherte Server')}>
            {groups.map(([g, list]) => (
              <div key={g} className="split-group">
                <span className="side-title">{g}</span>
                {list.map((x) => (
                  <button key={x.id} type="button" role="option" aria-selected={x.id === currentId} className={`split-item${x.id === currentId ? ' is-sel' : ''}`} onClick={() => pick(x.id)}>
                    <ServerTile server={x} size={24} />
                    <span className="split-text"><span className="strong-500 ellipsis">{x.name}</span><span className="small sub ellipsis">{x.user}@{x.host}</span></span>
                    {x.online && <span className="dot is-ok" />}
                  </button>
                ))}
              </div>
            ))}
            {isNew && (
              <div className="split-group">
                <span className="side-title">{$t('Neu')}</span>
                <div className="split-item is-sel"><ServerTile mono={draft.mono || '?'} color={draft.color} image={draft.image} protocol={draft.protocol} size={24} /><span className="split-text"><span className="strong-500">{draft.name || $t('Neuer Server')}</span><span className="small sub">{draft.host || $t('noch nicht gespeichert')}</span></span></div>
              </div>
            )}
          </div>
          <div className="split-foot">
            <button type="button" className="icon-btn" aria-label={$t('Neuer Server')} onClick={() => { setCurrentId(undefined); setDraft(newServerTemplate()); setTest('idle'); }}><Plus size={15} strokeWidth={1.75} /></button>
            <button type="button" className="icon-btn" aria-label={$t('Neue Gruppe')} title={$t('Gruppe: im Feld „Gruppe“ einen Namen eintragen')} onClick={() => document.getElementById('s-group')?.focus()}><FolderPlus size={15} strokeWidth={1.75} /></button>
            <span className="flex-1" />
            <Button variant="ghost" small onClick={() => openDialog({ type: 'import' })}>{$t('Importieren …')}</Button>
          </div>
        </div>

        <div className="split-detail">
          <div className="detail-head">
            {/* Own picture (Transmit): click the symbol to choose one; it is shrunk to 64 px and kept in the settings. */}
            <label className="server-picture" title={$t('Eigenes Bild wählen')}>
              <ServerTile mono={draft.mono || (draft.name || draft.host || '?').slice(0, 2).toUpperCase()} color={draft.color} image={draft.image} protocol={draft.protocol} size={48} />
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" className="vh" aria-label={$t('Eigenes Bild wählen')}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pictureFromFile(f).then((url) => set('image', url)).catch(() => showToast($t('Das Bild ließ sich nicht lesen.'), 'error')); }} />
            </label>
            <div className="detail-head-fields">
              <TextField value={draft.name} onChange={(v) => set('name', v)} placeholder={$t('Name, z. B. Cloud · Bots')} className="name-field" />
              <div className="swatches" role="radiogroup" aria-label={$t('Farbe')}>
                <span className="small muted">{$t('Farbe')}</span>
                {colors.map((c) => (
                  // "gray" means no colour: shown as an empty ring and listed first.
                  <button key={c} type="button" role="radio" aria-checked={draft.color === c} aria-label={c === 'gray' ? $t('Keine Farbe') : c} title={c === 'gray' ? $t('Keine Farbe') : undefined}
                    className={`swatch${c === 'gray' ? ' is-none' : ''}${draft.color === c ? ' is-on' : ''}`} style={c === 'gray' ? undefined : { background: swatch[c] }} onClick={() => set('color', c)} />
                ))}
                {draft.image
                  ? <button type="button" className="link small" onClick={() => set('image', undefined)}>{$t('Bild entfernen')}</button>
                  : <span className="small muted">{$t('Klick aufs Symbol: eigenes Bild')}</span>}
              </div>
            </div>
          </div>

          <div className="form-grid">
            {cloud ? (
              <>
                <span>{$t('Protokoll#protocol')}</span>
                <div className="row-inline">
                  <Segmented<'sftp' | 'ftp' | 'webdav' | 'smb' | 'cloud'> label={$t('Protokoll#protocol')} value={family} onChange={setFamily} options={isNew ? [{ value: 'sftp', label: 'SFTP / SSH' }, { value: 'ftp', label: 'FTP' }, { value: 'webdav', label: 'WebDAV' }, { value: 'smb', label: 'SMB' }, { value: 'cloud', label: $t('Cloud-Dienst') }] : [{ value: 'cloud', label: $t('Cloud-Dienst') }]} />
                </div>
                <span>{$t('Dienst')}</span>
                <div className="col-text">
                  <Select<'dropbox' | 'gdrive' | 'onedrive'> label={$t('Dienst')} value={draft.protocol === 'gdrive' || draft.protocol === 'onedrive' ? draft.protocol : 'dropbox'} onChange={(v) => isNew && setDraft((d) => ({ ...d, ...cloudDefaults(v) }))} options={isNew ? [{ value: 'dropbox', label: 'Dropbox' }, { value: 'gdrive', label: 'Google Drive' }, { value: 'onedrive', label: 'OneDrive' }] : [{ value: draft.protocol === 'gdrive' || draft.protocol === 'onedrive' ? draft.protocol : 'dropbox', label: CLOUD_NAMES[draft.protocol ?? ''] ?? '' }]} />
                </div>
                {draft.protocol === 'gdrive' && (
                  <>
                    <span>{$t('Client-ID')}</span>
                    <div className="col-text">
                      <TextField mono value={googleId} onChange={setGoogleId} placeholder="123456789-abc….apps.googleusercontent.com" label={$t('Client-ID')} />
                    </div>
                    <span>{$t('Client-Schlüssel')}</span>
                    <div className="col-text">
                      <TextField mono type="password" value={googleSecret} onChange={setGoogleSecret} placeholder={googleStored ? $t('gespeichert {0}', store) : 'GOCSPX-…'} label={$t('Client-Schlüssel')} />
                      <span className="small muted">{$t('Google Drive braucht einen eigenen, kostenlosen App-Schlüssel aus deinem Google-Konto. Einmal einrichten, etwa 10 Minuten.')}{' '}
                        <button type="button" className="link small" onClick={() => openExternal(GDRIVE_GUIDE_URL)}>{$t('Zur Anleitung')}</button></span>
                    </div>
                  </>
                )}
                <span>{$t('Konto')}</span>
                <span className="small muted">{draft.user || '–'}</span>
                <span>{$t('Anmeldung')}</span>
                <span className="small muted">{$t('Über den Browser; gespeichert {0}. „Neu anmelden …“ unten, falls der Zugriff entzogen wurde.', platform === 'mac' ? $t('im Schlüsselbund') : $t('in der Windows-Anmeldeinformationsverwaltung'))}</span>
              </>
            ) : (
            <>
            <span>{$t('Protokoll#protocol')}</span>
            <div className="row-inline">
              <Segmented<'sftp' | 'ftp' | 'webdav' | 'smb' | 'cloud'> label={$t('Protokoll#protocol')} value={family} onChange={setFamily} options={[{ value: 'sftp', label: 'SFTP / SSH' }, { value: 'ftp', label: 'FTP' }, { value: 'webdav', label: 'WebDAV' }, { value: 'smb', label: 'SMB' }, ...(isNew ? [{ value: 'cloud' as const, label: $t('Cloud-Dienst') }] : [])]} />
            </div>

            {family === 'ftp' && (
              <>
                <label htmlFor="s-tls">{$t('Verschlüsselung')}</label>
                <div className="col-text">
                  <Select<'explicit' | 'implicit' | 'none'> id="s-tls" label={$t('Verschlüsselung')} value={draft.protocol === 'ftp' ? 'none' : draft.implicitTls ? 'implicit' : 'explicit'} onChange={setFtpTls}
                    options={[{ value: 'explicit', label: $t('FTPS: TLS anfordern (empfohlen)') }, { value: 'implicit', label: $t('FTPS: implizites TLS (eigener Port, meist 990)') }, { value: 'none', label: $t('Keine (unverschlüsselt)') }]} />
                  {draft.protocol === 'ftp' && <span className="small tone-warn">{$t('Ohne Verschlüsselung gehen Passwort und Dateien lesbar durchs Netz. Nur nutzen, wenn der Server nichts anderes kann.')}</span>}
                </div>
              </>
            )}

            <label htmlFor="s-host">{$t('Server')}</label>
            <div className="field-row">
              <TextField id="s-host" value={draft.host} onChange={(v) => set('host', v)} placeholder={family === 'smb' ? $t('nas.local oder 192.168.1.20') : $t('server.example oder 203.0.113.10')} className="flex-1" invalid={!draft.host && test === 'fail'} />
              <TextField value={String(draft.port)} onChange={(v) => set('port', Number(v.replace(/\D/g, '')) || 22)} className="port-field" />
            </div>

            {family === 'webdav' && (
              <>
                <label htmlFor="s-davpath">{$t('Pfad')}</label>
                <div className="col-text">
                  <div className="field-row">
                    <Select<'https' | 'http'> label={$t('https oder http')} value={draft.davHttps === false ? 'http' : 'https'} onChange={(v) => setDraft((d) => ({ ...d, davHttps: v === 'https', port: d.port === (v === 'https' ? 80 : 443) ? (v === 'https' ? 443 : 80) : d.port }))}
                      options={[{ value: 'https', label: 'https' }, { value: 'http', label: $t('http (unverschlüsselt)') }]} />
                    <TextField id="s-davpath" mono value={draft.davPath ?? ''} onChange={(v) => set('davPath', v.trim() || undefined)} placeholder="/remote.php/dav/files/name" className="flex-1" />
                  </div>
                  <span className="small muted mono ellipsis">{draft.host ? davUrl(draft) : $t('Adresse erscheint, sobald der Server eingetragen ist.')}</span>
                </div>
              </>
            )}

            {family === 'smb' && (
              <>
                <label htmlFor="s-share">{$t('Freigabe')}</label>
                <div className="col-text">
                  <TextField id="s-share" value={draft.smbShare ?? ''} onChange={(v) => set('smbShare', v.trim().replace(/^[\\/]+|[\\/]+$/g, '') || undefined)} placeholder={$t('z. B. daten')} />
                  <span className="small muted">{$t('Leer lassen, um mit der Liste aller Freigaben zu beginnen.')}</span>
                </div>
              </>
            )}

            <label htmlFor="s-user">{$t('Benutzer')}</label>
            <TextField id="s-user" value={draft.user} onChange={(v) => set('user', v)} placeholder={family === 'ftp' ? $t('leer lassen für anonym') : family === 'smb' ? $t('leer lassen für Gast') : 'ubuntu'} />

            {family !== 'sftp' && (
              <>
                <span>{$t('Anmeldung')}</span>
                <span className="small muted">{family === 'ftp' && !draft.user ? $t('Ohne Benutzer meldet sich Bitcrane anonym an.') : family === 'smb' && !draft.user ? $t('Ohne Benutzer meldet sich Bitcrane als Gast an. Für Domänenkonten DOMÄNE\\name eintragen.') : $t('Mit Passwort. Bitcrane fragt beim ersten Verbinden und speichert es {0}.', platform === 'mac' ? $t('im Schlüsselbund') : $t('in der Windows-Anmeldeinformationsverwaltung'))}</span>
              </>
            )}
            {family === 'sftp' && <span>{$t('Anmeldung')}</span>}
            {family === 'sftp' && <div className="row-inline">
              <Segmented<AuthMethod> label={$t('Anmeldung')} value={draft.auth} onChange={(v) => set('auth', v)} options={[{ value: 'auto', label: $t('Automatisch') }, { value: 'key', label: $t('SSH-Schlüssel') }, { value: 'agent', label: 'SSH-Agent' }, { value: 'password', label: $t('Passwort') }]} />
            </div>}

            {family === 'sftp' && draft.auth === 'auto' && (
              <>
                <span>{$t('Reihenfolge')}</span>
                <span className="small muted">{$t('Erst der SSH-Agent, dann der Schlüssel unten und die üblichen Schlüssel aus ~/.ssh, zuletzt das Passwort. Fragt der Server nach einem Einmalcode, fragt Bitcrane dich.')}</span>
              </>
            )}
            {family === 'sftp' && (draft.auth === 'key' || draft.auth === 'auto') && (
              <>
                <label htmlFor="s-key">{$t('Schlüssel')}</label>
                <div className="col-text">
                  <div className="field-row">
                    <TextField id="s-key" mono value={draft.keyPath} onChange={(v) => set('keyPath', v)} className="flex-1" />
                    <Button onClick={() => (LIVE ? void chooseKey() : undefined)}>{$t('Auswählen …')}</Button>
                    <Button onClick={() => setKeyPanel(!keyPanel)} aria-expanded={keyPanel}>{$t('Neu …')}</Button>
                  </div>
                  {keyPanel && <KeyPanel server={draft} onCreated={(p) => set('keyPath', p)} onClose={() => setKeyPanel(false)} />}
                  {!LIVE && <span className="small tone-ok row-inline"><Check size={12} strokeWidth={2.2} aria-hidden="true" />{$t('ED25519 · Passphrase {0} gespeichert', store)}</span>}
                  {LIVE && keyInfo && !keyInfo.exists && <span className="small tone-danger row-inline"><AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />{$t('Datei nicht gefunden')}</span>}
                  {LIVE && keyInfo?.invalid && <span className="small tone-danger row-inline"><AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />{$t('Das ist kein privater SSH-Schlüssel')}</span>}
                  {LIVE && keyInfo?.exists && !keyInfo.invalid && (
                    <span className="small muted row-inline"><KeyRound size={12} strokeWidth={1.75} aria-hidden="true" />
                      {[keyInfo.algorithm, keyInfo.encrypted ? (secretStored ? $t('Passphrase {0} gespeichert', store) : $t('mit Passphrase, wird beim Verbinden abgefragt')) : $t('ohne Passphrase')].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
              </>
            )}
            {family === 'sftp' && draft.auth === 'password' && (
              <>
                <span>{$t('Passwort')}</span>
                <span className="small muted">{$t('Wird beim ersten Verbinden abgefragt und')}{' '}{platform === 'mac' ? $t('im Schlüsselbund') : $t('in der Windows-Anmeldeinformationsverwaltung')} {$t('gespeichert, nie in Bitcrane selbst.')}</span>
              </>
            )}
            {family === 'sftp' && draft.auth === 'agent' && (
              <>
                <span>{$t('Agent')}</span>
                <span className="small muted">{$t('Nutzt die Schlüssel, die im SSH-Agent geladen sind (z. B. aus 1Password, Bitwarden oder ssh-agent).')}</span>
              </>
            )}

            </>
            )}

            <span>{$t('Startordner')}</span>
            <div className="sub-grid">
              <span className="small muted">{$t('Lokal')}</span>
              <TextField mono value={draft.localStart} onChange={(v) => set('localStart', v)} />
              <span className="small muted">{$t('Server')}</span>
              <TextField mono value={draft.remoteStart} onChange={(v) => set('remoteStart', v)} placeholder={cloud ? '/' : `/home/${draft.user || 'benutzer'}`} />
            </div>

            {family === 'sftp' && <label htmlFor="s-jump">{$t('Sprungserver')}</label>}
            {family === 'sftp' && <div className="col-text">
              <Select id="s-jump" label={$t('Sprungserver')} value={draft.jumpServerId ?? ''} onChange={(v) => set('jumpServerId', v || undefined)}
                options={[{ value: '', label: $t('Keiner, direkt verbinden') }, ...servers.filter((x) => x.id !== draft.id).map((x) => ({ value: x.id, label: $t('Über {0}', x.name) }))]} />
              <span className="small muted">{$t('Für Server, die nur über einen anderen Server erreichbar sind (wie ProxyJump in der SSH-Konfiguration).')}</span>
            </div>}

            {family === 'sftp' && <span>{$t('Beim Öffnen')}</span>}
            {family === 'sftp' && <div className="col-text">
              <div className="row-inline">
                <Segmented<'files' | 'terminal'> label={$t('Beim Öffnen')} value={draft.openAs ?? 'files'} onChange={(v) => set('openAs', v === 'terminal' ? 'terminal' : undefined)}
                  options={[{ value: 'files', label: $t('Dateien') }, { value: 'terminal', label: $t('Nur Terminal') }]} />
              </div>
              <span className="small muted">{draft.openAs === 'terminal'
                ? $t('Ein Doppelklick öffnet eine SSH-Konsole im eigenen Tab. Die Dateien erreichst du per Rechtsklick › Dateien öffnen.')
                : $t('Derselbe Server kann beides: Dateien hier, SSH-Terminal über den Terminal-Knopf oder per Rechtsklick.')}</span>
            </div>}

            <label htmlFor="s-group">{$t('Gruppe')}</label>
            <TextField id="s-group" value={draft.group} onChange={(v) => set('group', v)} placeholder={$t('z. B. Bots')} className="group-field" />

            {/* Transfer rule for this server's manual transfers and watches (settings > Regeln). */}
            <label htmlFor="s-rule">{$t('Regel')}</label>
            <div className="col-text">
              <Select id="s-rule" label={$t('Regel')} value={draft.ruleId ?? ''} onChange={(v) => set('ruleId', v || undefined)}
                options={[{ value: '', label: $t('Keine, allgemeine Einstellungen') }, ...rules.map((r) => ({ value: r.id, label: r.name || $t('Ohne Namen') }))]} />
              <span className="small muted">{$t('Regeln legst du unter Einstellungen › Regeln an.')}</span>
            </div>
          </div>

          <section aria-label={$t('Weitere Einstellungen')} className="section-card disclosure server-more">
            <button type="button" className="disclosure-head" aria-expanded={more} onClick={() => setMore(!more)}>
              <ChevronRight size={13} strokeWidth={2} className={`chev${more ? ' is-open' : ''}`} aria-hidden="true" />
              <span className="strong">{$t('Weitere Einstellungen')}</span>
              <span className="small muted ellipsis">{[draft.proxy?.host && $t('Proxy'), draft.forwards?.length && (draft.forwards.length === 1 ? $t('1 Tunnel') : $t('{0} Tunnel', draft.forwards.length)), draft.webUrl && $t('Web-Adresse'), draft.note && $t('Notiz')].filter(Boolean).join(', ') || (family === 'ftp' ? $t('Proxy, TLS-Version, Dateinamen, Zeitzone, Übertragungsart, Notiz') : family === 'sftp' ? $t('Proxy, Terminal, Tunnel, Web-Adresse, Notiz') : $t('Proxy, Web-Adresse, Notiz'))}</span>
            </button>
            {more && (
              <div className="disclosure-body form-grid">
                {family !== 'smb' && <label htmlFor="s-proxy">{$t('Proxy')}</label>}
                {family !== 'smb' && <div className="col-text">
                  <div className="field-row">
                    <Select id="s-proxy" label={$t('Proxy')} value={draft.proxy?.kind ?? 'none'} onChange={(v) => set('proxy', v === 'none' ? undefined : { host: '', port: v === 'http' ? 8080 : 1080, ...draft.proxy, kind: v as 'socks5' | 'http' })}
                      options={[{ value: 'none', label: $t('Kein Proxy') }, { value: 'socks5', label: 'SOCKS5' }, { value: 'http', label: 'HTTP (CONNECT)' }]} />
                    {draft.proxy && (
                      <>
                        <TextField label={$t('Proxy-Adresse')} value={draft.proxy.host} onChange={(v) => set('proxy', { ...draft.proxy!, host: v.trim() })} placeholder="proxy.example" className="flex-1" />
                        <TextField label={$t('Proxy-Port')} value={String(draft.proxy.port)} onChange={(v) => set('proxy', { ...draft.proxy!, port: Number(v.replace(/\D/g, '')) || 1080 })} className="port-field" />
                      </>
                    )}
                  </div>
                  {draft.proxy && (
                    <div className="field-row">
                      <TextField label={$t('Proxy-Benutzer')} value={draft.proxy.user ?? ''} onChange={(v) => set('proxy', { ...draft.proxy!, user: v.trim() || undefined })} placeholder={$t('Benutzer (falls nötig)')} className="flex-1" />
                      {draft.proxy.user && <TextField type="password" label={$t('Proxy-Passwort')} value={proxyPassword} onChange={setProxyPassword} placeholder={proxyStored ? $t('{0} gespeichert', store) : $t('Passwort')} className="flex-1" />}
                    </div>
                  )}
                  {draft.jumpServerId && draft.proxy && <span className="small muted">{$t('Mit Sprungserver gilt dessen Proxy-Einstellung.')}</span>}
                </div>}

                {family === 'sftp' && (
                  <>
                    <label htmlFor="s-scp">{$t('Dateiübertragung')}</label>
                    <div className="col-text">
                      <Select<'sftp' | 'scp'> id="s-scp" label={$t('Dateiübertragung')} value={draft.scp ? 'scp' : 'sftp'} onChange={(v) => set('scp', v === 'scp' || undefined)}
                        options={[{ value: 'sftp', label: $t('SFTP (Standard)') }, { value: 'scp', label: $t('SCP über Shell-Befehle') }]} />
                      <span className="small muted">{$t('Hat der Server kein SFTP, nimmt Bitcrane von selbst SCP. Nur für Router, NAS und sehr alte Server nötig.')}</span>
                    </div>
                  </>
                )}
                {family === 'sftp' && (
                  <>
                    <label htmlFor="s-termscheme">{$t('Terminal')}</label>
                    <div className="col-text">
                      <div className="field-row">
                        <Select id="s-termscheme" label={$t('Farbschema des Terminals')} value={draft.termScheme ?? ''} onChange={(v) => set('termScheme', v || undefined)}
                          options={[{ value: '', label: $t('Farbschema wie eingestellt') }, ...SCHEMES.map((x) => ({ value: x.id, label: $t(x.name) }))]} />
                        <TextField label={$t('Befehl beim Start')} value={draft.termStart ?? ''} onChange={(v) => set('termStart', v || undefined)} placeholder={$t('Befehl beim Start, z. B. tmux attach')} mono className="flex-1" />
                      </div>
                      <span className="small muted">{$t('Für das eingebaute Terminal. Ein eigenes Farbschema (z. B. rot) zeigt sofort, auf welchem Server du tippst.')}</span>
                    </div>
                  </>
                )}
                {family === 'sftp' && (
                  <>
                    <label>{$t('Tunnel')}</label>
                    <ForwardEditor serverId={draft.id} value={draft.forwards ?? []} onChange={(v) => set('forwards', v.length ? v : undefined)} />
                  </>
                )}
                {family === 'smb' && (
                  <>
                    <label htmlFor="s-smbenc">{$t('Verschlüsselung')}</label>
                    <div className="col-text">
                      <Select<'auto' | 'required'> id="s-smbenc" label={$t('Verschlüsselung')} value={draft.smbEncrypt ? 'required' : 'auto'} onChange={(v) => set('smbEncrypt', v === 'required' || undefined)}
                        options={[{ value: 'auto', label: $t('Wie der Server es verlangt (Standard)') }, { value: 'required', label: $t('Immer verschlüsseln (SMB 3)') }]} />
                      <span className="small muted">{$t('Älteren NAS-Geräten fehlt SMB 3; dann kommt keine Verbindung zustande.')}</span>
                    </div>
                  </>
                )}

                {(draft.protocol === 'ftps' || (draft.protocol === 'webdav' && draft.davHttps !== false)) && (
                  <>
                    <label htmlFor="s-tlsver">TLS-Version</label>
                    <Select<'any' | '13'> id="s-tlsver" label="TLS-Version" value={draft.tls13Only ? '13' : 'any'} onChange={(v) => set('tls13Only', v === '13' || undefined)} options={[{ value: 'any', label: $t('TLS 1.2 und 1.3') }, { value: '13', label: $t('Nur TLS 1.3') }]} />
                  </>
                )}
                {family === 'ftp' && (
                  <>
                    <label htmlFor="s-enc">{$t('Dateinamen')}</label>
                    <div className="col-text">
                      <Select<'utf8' | 'latin1'> id="s-enc" label={$t('Zeichensatz der Dateinamen')} value={draft.ftpEncoding ?? 'utf8'} onChange={(v) => set('ftpEncoding', v === 'utf8' ? undefined : v)} options={[{ value: 'utf8', label: $t('UTF-8 (Standard)') }, { value: 'latin1', label: $t('Latin-1 / Windows (ältere Server)') }]} />
                      <span className="small muted">{$t('Wenn Umlaute in Dateinamen falsch aussehen, Latin-1 wählen.')}</span>
                    </div>
                    <label htmlFor="s-tz">{$t('Zeitzone des Servers')}</label>
                    <div className="col-text">
                      <Select id="s-tz" label={$t('Zeitzone des Servers')} value={String(draft.ftpTimezone ?? 0)} onChange={(v) => set('ftpTimezone', Number(v) || undefined)} options={TIMEZONES} />
                      <span className="small muted">{$t('Nur für Server ohne genaue Zeitangaben (kein MLSD): ihre Uhrzeiten sind Ortszeit.')}</span>
                    </div>
                    <label htmlFor="s-mode">{$t('Übertragungsart')}</label>
                    <div className="col-text">
                      <Select<'binary' | 'ascii' | 'auto'> id="s-mode" label={$t('Übertragungsart')} value={draft.ftpMode ?? 'binary'} onChange={(v) => set('ftpMode', v === 'binary' ? undefined : v)} options={[{ value: 'binary', label: $t('Binär (Standard, Dateien bleiben unverändert)') }, { value: 'auto', label: $t('Automatisch (Textdateien als Text)') }, { value: 'ascii', label: $t('Text (Zeilenenden anpassen)') }]} />
                      <span className="small muted">{$t('Text passt Zeilenenden zwischen Windows und Linux an. Abgebrochene Textübertragungen beginnen neu.')}</span>
                    </div>
                  </>
                )}

                {family !== 'cloud' && (
                  <>
                    <span>{platform === 'win' ? $t('Im Explorer zeigen') : $t('Im Finder zeigen')}</span>
                    <div className="col-text">
                      {platform === 'win' ? (
                        <>
                          <Switch checked={!!draft.mountExplorer} onChange={(v) => set('mountExplorer', v || undefined)} label={$t('Im Explorer als Ordner zeigen')} />
                          <span className="small muted">{$t('Wie OneDrive: Der Server erscheint links im Explorer, Dateien werden erst beim Öffnen geladen, Änderungen gehen von selbst zurück auf den Server. Braucht ein gespeichertes Passwort.')}</span>
                        </>
                      ) : (
                        <span className="small muted">{$t('Server als Ordner im Finder kommen mit einer von Apple signierten Version von Bitcrane. Unter Windows gibt es das schon.')}</span>
                      )}
                    </div>
                  </>
                )}

                <label htmlFor="s-web">{$t('Web-Adresse')}</label>
                <div className="col-text">
                  <div className="field-row">
                    <TextField id="s-web" value={draft.webUrl ?? ''} onChange={(v) => set('webUrl', v.trim() || undefined)} placeholder="https://example.com" className="flex-1" />
                    <TextField label={$t('Passender Ordner auf dem Server')} mono value={draft.webRoot ?? ''} onChange={(v) => set('webRoot', v.trim() || undefined)} placeholder="/var/www/html" className="flex-1" />
                  </div>
                  <span className="small muted">{$t('Damit gibt es bei Dateien „Web-Adresse kopieren“ und „Im Browser öffnen“.')}</span>
                </div>

                <label htmlFor="s-note">{$t('Notiz')}</label>
                <textarea id="s-note" className="note-field" rows={3} value={draft.note ?? ''} onChange={(e) => set('note', e.target.value || undefined)} placeholder={$t('Was läuft hier? Wen fragen?')} />

                <span>{$t('Vorlage')}</span>
                <div className="row-inline">
                  <Button small onClick={() => { updateSettings({ serverDefaults: { port: draft.port, user: draft.user, auth: draft.auth, keyPath: draft.keyPath, localStart: draft.localStart, group: draft.group, color: draft.color, jumpServerId: draft.jumpServerId, proxy: draft.proxy } }); showToast($t('Neue Server beginnen jetzt mit diesen Einstellungen.'), 'ok'); }}>{$t('Als Vorlage für neue Server')}</Button>
                  {Object.keys(defaults).length > 0 && <Button small variant="ghost" onClick={() => { updateSettings({ serverDefaults: {} }); showToast($t('Vorlage entfernt.')); }}>{$t('Vorlage entfernen')}</Button>}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </Dialog>
  );
}
