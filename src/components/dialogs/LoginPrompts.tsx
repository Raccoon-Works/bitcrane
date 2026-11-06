/**
 * Questions while logging in: the passphrase of a key or a password, and the
 * keyboard-interactive questions of a server (for example a one-time code).
 */
import { useState } from 'react';
import { tauriBackend as backend } from '../../backend/tauriBackend';
import { cancelSecret, closeDialog, serverById, submitSecret, useStore } from '../../state/store';
import { AlertTriangle, KeyRound } from '../glyphs';
import { Button, Checkbox, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function SecretPrompt({
  serverId,
  kind,
  wrong,
}: {
  serverId: string;
  kind: 'passphrase' | 'password';
  wrong?: boolean;
}) {
  const srv = useStore((s) => serverById(serverId, s));
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
      title={
        kind === 'passphrase'
          ? $t('Passphrase für den SSH-Schlüssel')
          : srv.protocol === 'vault'
            ? $t('Tresor „{0}“ entsperren', srv.name)
            : $t('Passwort für {0}@{1}', srv.user, srv.host)
      }
      subtitle={
        kind === 'passphrase'
          ? $t('Der Schlüssel {0} ist mit einer Passphrase geschützt.', srv.keyPath)
          : srv.protocol === 'vault'
            ? $t('Cryptomator-Tresor in {0}', srv.host)
            : $t('{0} meldet sich mit Passwort an.', srv.name)
      }
      icon={
        <span className="icon-tile tone-accent">
          <KeyRound size={18} strokeWidth={1.75} />
        </span>
      }
      width={520}
      onClose={() => cancelSecret(serverId)}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={() => cancelSecret(serverId)}>{$t('Abbrechen')}</Button>
          <Button variant="primary" onClick={submit} disabled={!value}>
            {srv.protocol === 'vault' ? $t('Entsperren') : $t('Verbinden')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        {wrong && (
          <div className="notice tone-warn-notice">
            <AlertTriangle size={15} strokeWidth={1.75} className="tone-warn" aria-hidden="true" />
            <span>
              {kind === 'passphrase'
                ? $t('Die Passphrase stimmt nicht.')
                : srv.protocol === 'vault'
                  ? $t('Das Tresor-Passwort stimmt nicht.')
                  : $t('Der Server hat das Passwort abgelehnt.')}{' '}
              {$t('Bitte noch einmal eingeben.')}
            </span>
          </div>
        )}
        <TextField
          type="password"
          value={value}
          onChange={setValue}
          autoFocus
          onEnter={submit}
          label={kind === 'passphrase' ? $t('Passphrase') : $t('Passwort')}
        />
        <Checkbox checked={save} onChange={setSave} label={$t('{0} sichern', store)} />
        <span className="small muted">
          {$t('Bitcrane speichert')} {kind === 'passphrase' ? $t('die Passphrase') : $t('das Passwort')}{' '}
          {$t('nie selbst, nur')} {store}.
        </span>
      </div>
    </Dialog>
  );
}

/** Questions of a server during login, e.g. a one-time code (2FA). */
export function AuthPrompt({
  id,
  host,
  name,
  instructions,
  prompts,
}: {
  id: string;
  host: string;
  name: string;
  instructions: string;
  prompts: Array<{ text: string; echo: boolean }>;
}) {
  const [values, setValues] = useState<string[]>(prompts.map(() => ''));
  const answer = (answers: string[] | null) => {
    closeDialog();
    void backend.authPromptAnswer(id, answers);
  };
  const submit = () => answer(values);
  return (
    <Dialog
      label={$t('Anmeldung')}
      title={name || $t('Anmeldung bei {0}', host)}
      subtitle={
        instructions ||
        $t(
          'Der Server stellt bei der Anmeldung eine Rückfrage, zum Beispiel nach einem Einmalcode aus deiner Authenticator-App.',
        )
      }
      icon={
        <span className="icon-tile tone-accent">
          <KeyRound size={18} strokeWidth={1.75} />
        </span>
      }
      width={520}
      onClose={() => answer(null)}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={() => answer(null)}>{$t('Abbrechen')}</Button>
          <Button variant="primary" onClick={submit}>
            {$t('Anmelden')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        {prompts.map((p, i) => (
          <label key={i} className="col-text">
            <span className="small">{p.text.trim()}</span>
            <TextField
              type={p.echo ? 'text' : 'password'}
              value={values[i]}
              onChange={(v) => setValues(values.map((x, j) => (j === i ? v : x)))}
              autoFocus={i === 0}
              onEnter={submit}
              label={p.text.trim()}
              mono={p.echo}
            />
          </label>
        ))}
        <span className="small muted">
          {$t('Die Antwort geht direkt an')} {host}
          {$t('; Bitcrane speichert sie nicht.')}
        </span>
      </div>
    </Dialog>
  );
}
