/**
 * Inline panel in the server window: create a new SSH key (ED25519, with an
 * optional passphrase), copy its public key and add it to the server.
 * The passphrase is typed by the user and goes straight into the key file
 * (and, if wanted, into the system keychain); Bitcrane does not keep it.
 */
import { Check, Copy, KeyRound, Upload } from './glyphs';
import { useState } from 'react';
import { toBackendError } from '../backend/api';
import { tauriBackend as backend } from '../backend/tauriBackend';
import type { Server } from '../backend/types';
import { installPublicKey } from '../state/live';
import { LIVE, showToast } from '../state/store';
import { Button, Checkbox, TextField } from './ui';
import { $t } from '../i18n';

export function KeyPanel({ server, onCreated, onClose }: { server: Server; onCreated: (path: string) => void; onClose: () => void }) {
  const base = (server.name || server.host || 'server').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'server';
  const [name, setName] = useState(`~/.ssh/${base}_ed25519`);
  const [comment, setComment] = useState(`bitcrane-${base}`);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [installed, setInstalled] = useState<string | null | undefined>(undefined);
  const mismatch = pass !== pass2;

  const create = async () => {
    if (mismatch) return;
    if (!LIVE) {
      setPublicKey(`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBitcranePrototypBeispielSchluessel ${comment}`);
      onCreated(name);
      return;
    }
    setBusy(true);
    try {
      const pub = await backend.keyGenerate(name, comment, pass || undefined);
      if (pass && save) await backend.secretSet(`passphrase:${name}`, pass).catch(() => showToast($t('Die Passphrase konnte nicht im Schlüsselbund gesichert werden.'), 'error'));
      setPublicKey(pub);
      onCreated(name);
      showToast($t('Neuer Schlüssel erzeugt.'), 'ok');
    } catch (e) {
      showToast(toBackendError(e).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = () => navigator.clipboard?.writeText(publicKey).then(() => showToast($t('Öffentlicher Schlüssel kopiert.'), 'ok')).catch(() => undefined);
  const install = async () => {
    if (!LIVE) { setInstalled(null); return; }
    setInstalled(await installPublicKey(server.id, publicKey));
  };

  return (
    <div className="key-panel">
      <div className="row-between"><span className="strong-500 row-inline"><KeyRound size={14} strokeWidth={1.75} aria-hidden="true" />{$t('Neuen SSH-Schlüssel erzeugen')}</span><Button small variant="ghost" onClick={onClose}>{$t('Schließen')}</Button></div>
      {!publicKey ? (
        <div className="form-grid compact">
          <label htmlFor="k-name">{$t('Datei')}</label><TextField id="k-name" mono value={name} onChange={setName} />
          <label htmlFor="k-comment">{$t('Bezeichnung')}</label><TextField id="k-comment" mono value={comment} onChange={setComment} />
          <label htmlFor="k-pass">{$t('Passphrase')}</label><TextField id="k-pass" type="password" value={pass} onChange={setPass} label={$t('Passphrase (freiwillig)')} />
          <label htmlFor="k-pass2">{$t('Wiederholen')}</label><TextField id="k-pass2" type="password" value={pass2} onChange={setPass2} invalid={mismatch && pass2.length > 0} label={$t('Passphrase wiederholen')} />
          <span />
          <span className="col-text">
            {pass && <Checkbox checked={save} onChange={setSave} label={$t('Passphrase im Schlüsselbund sichern')} />}
            <span className="small muted">{$t('Typ ED25519. Ohne Passphrase reicht der Schlüssel allein zum Anmelden; mit Passphrase ist er sicherer, falls die Datei in falsche Hände gerät.')}</span>
          </span>
          <span /><span><Button variant="primary" disabled={busy || mismatch || !name.trim()} onClick={() => void create()}>{busy ? $t('Erzeuge …') : $t('Schlüssel erzeugen')}</Button></span>
        </div>
      ) : (
        <div className="form-stack">
          <span className="small muted">{$t('Öffentlicher Schlüssel (darf jeder sehen; gehört auf den Server in ~/.ssh/authorized_keys):')}</span>
          <pre className="mono code-box wrap">{publicKey}</pre>
          <span className="row-inline">
            <Button small onClick={copy}><Copy size={12} strokeWidth={1.75} aria-hidden="true" />{$t('Kopieren')}</Button>
            <Button small onClick={() => void install()}><Upload size={12} strokeWidth={1.75} aria-hidden="true" />{$t('Auf dem Server eintragen')}</Button>
            {installed === null && <span className="small tone-ok row-inline"><Check size={12} strokeWidth={2} aria-hidden="true" />{$t('Eingetragen. Anmeldung ab jetzt mit diesem Schlüssel.')}</span>}
          </span>
          {installed && <span className="small tone-danger">{installed}</span>}
        </div>
      )}
    </div>
  );
}
