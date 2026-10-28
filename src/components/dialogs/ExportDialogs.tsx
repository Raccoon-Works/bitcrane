/**
 * Export with optional password: an encrypted file may also carry the
 * passwords and passphrases stored in the keychain, so moving to another
 * computer needs no retyping. Import asks for the password of such a file.
 */
import { Lock } from '../glyphs';
import { useState } from 'react';
import { closeDialog, importSealed, useStore, writeExport } from '../../state/store';
import type { Sealed } from '../../util/crypto';
import { Button, Checkbox, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function ExportDialog() {
  const platform = useStore((s) => s.platform);
  const serverCount = useStore((s) => s.servers.filter((x) => !x.temporary).length);
  const watchCount = useStore((s) => s.watches.length);
  const [encrypt, setEncrypt] = useState(false);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [withSecrets, setWithSecrets] = useState(true);
  const [busy, setBusy] = useState(false);
  const store = platform === 'mac' ? $t('Schlüsselbund') : $t('Anmeldeinformationsverwaltung');
  const tooShort = encrypt && password.length > 0 && password.length < 8;
  const mismatch = encrypt && repeat.length > 0 && password !== repeat;
  const ready = !encrypt || (password.length >= 8 && password === repeat);
  const go = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const ok = await writeExport(encrypt ? password : '', encrypt && withSecrets);
    setBusy(false);
    if (ok) closeDialog();
  };
  return (
    <Dialog label={$t('Exportieren')} title={$t('Server und Überwachungen exportieren')} subtitle={$t('{0} Server, {1} Überwachungen und die Einstellungen in eine Datei, zum Beispiel für einen anderen Computer.', serverCount, watchCount)} width={560}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!ready || busy} onClick={() => void go()}>{busy ? $t('Exportiere …') : $t('Exportieren …')}</Button></>}>
      <div className="form-stack">
        <Checkbox checked={encrypt} onChange={setEncrypt} label={$t('Mit Passwort verschlüsseln')} note={$t('Ohne das Passwort lässt sich die Datei nicht lesen.')} />
        {encrypt && (
          <div className="form-grid">
            <label htmlFor="ex-pw">{$t('Passwort')}</label>
            <TextField id="ex-pw" type="password" value={password} onChange={setPassword} invalid={tooShort} autoFocus />
            <label htmlFor="ex-pw2">{$t('Wiederholen')}</label>
            <TextField id="ex-pw2" type="password" value={repeat} onChange={setRepeat} invalid={mismatch} onEnter={() => void go()} />
            <span />
            <span className={`small ${tooShort || mismatch ? 'tone-danger' : 'muted'}`}>{tooShort ? $t('Mindestens 8 Zeichen.') : mismatch ? $t('Die beiden Eingaben sind verschieden.') : $t('Bitcrane merkt sich dieses Passwort nicht.')}</span>
            <span />
            <Checkbox checked={withSecrets} onChange={setWithSecrets} label={$t('Gespeicherte Passwörter mitnehmen')} note={$t('Passwörter und Passphrasen aus dem {0}. Beim Import landen sie dort wieder.', store)} />
          </div>
        )}
        {!encrypt && <p className="small muted row-inline"><Lock size={12} strokeWidth={1.75} aria-hidden="true" />{$t('Ohne Verschlüsselung enthält die Datei keine Passwörter.')}</p>}
      </div>
    </Dialog>
  );
}

export function ImportPasswordDialog({ sealed }: { sealed: Sealed }) {
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!password || busy) return;
    setBusy(true);
    const ok = await importSealed(sealed, password);
    setBusy(false);
    if (!ok) setWrong(true);
  };
  return (
    <Dialog label={$t('Verschlüsselte Exportdatei')} title={$t('Verschlüsselte Exportdatei')} subtitle={$t('Bitte das Passwort eingeben, mit dem die Datei exportiert wurde.')} width={480}
      icon={<span className="icon-tile tone-accent"><Lock size={18} strokeWidth={1.75} /></span>}
      footer={<><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!password || busy} onClick={() => void go()}>{busy ? $t('Entschlüssele …') : $t('Importieren')}</Button></>}>
      <div className="form-stack">
        <TextField type="password" label={$t('Passwort')} value={password} onChange={(v) => { setPassword(v); setWrong(false); }} invalid={wrong} autoFocus onEnter={() => void go()} />
        {wrong && <span className="small tone-danger">{$t('Das Passwort passt nicht zu dieser Datei.')}</span>}
      </div>
    </Dialog>
  );
}
