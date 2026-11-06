/**
 * One way to report errors (Apple HIG and Windows guidelines: say what
 * happened, then what the user can do). Every error toast has the same shape:
 *
 *   What happened.            (one sentence, ends with a full stop)
 *   What you can do.          (smaller second line, from the error kind)
 *
 * Technical details (the server's own wording, OS error codes) never go into
 * the toast; they are written to the protocol, and the hint points there.
 */
import { toBackendError, type BackendError } from '../backend/api';
import { $t } from '../i18n';
import { addLog } from './log';
import { showToast } from './store';

export interface ErrorText {
  /** What happened. */
  text: string;
  /** What the user can do (may be empty). */
  hint: string;
}

/** Ends a sentence with a full stop unless it already ends with punctuation. */
function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return /[.!?…:)]$|[.!?]["“”»«]$/.test(t) ? t : `${t}.`;
}

/**
 * Turns any error into the two lines shown to the user.
 * `connecting`: the error came from opening a connection, where retrying on
 * its own does not happen and the settings are the likely cause.
 */
export function explainError(e: unknown, opts: { connecting?: boolean; logged?: boolean } = {}): ErrorText {
  const err: BackendError =
    e && typeof e === 'object' && 'kind' in e && 'message' in e ? (e as BackendError) : toBackendError(e);
  const text = sentence(err.message);
  let hint = '';
  switch (err.kind) {
    case 'authFailed':
      hint = $t('Benutzer, Passwort oder Schlüssel in den Servereinstellungen prüfen.');
      break;
    case 'unreachable':
      hint = $t('Adresse und Port prüfen und ob der Server läuft.');
      break;
    case 'connectionLost':
    case 'notConnected':
      hint = opts.connecting
        ? $t('Adresse, Port und Protokoll in den Servereinstellungen prüfen.')
        : $t('Bitcrane verbindet sich neu, sobald der Server wieder erreichbar ist.');
      break;
    case 'permissionDenied':
      hint = $t('Rechte mit „Informationen und Rechte“ prüfen.');
      break;
    case 'notFound':
      // No shortcut here: keys.ts depends on the store, which imports this module.
      hint = $t('Vielleicht wurde es gerade verschoben oder gelöscht. Mit „Aktualisieren“ neu laden.');
      break;
    case 'alreadyExists':
      hint = $t('Einen anderen Namen wählen oder das Vorhandene zuerst entfernen.');
      break;
    default:
      break;
  }
  // Without a specific hint, the details in the protocol are the next step.
  if (!hint && err.detail && opts.logged) hint = $t('Einzelheiten im Protokoll.');
  return { text, hint };
}

/**
 * Shows an error toast in the common shape. With `prefix` (a server, a watch)
 * the first line names what it concerns. Details go to the protocol.
 * Cancelled operations show nothing.
 */
export function showError(
  e: unknown,
  opts: { prefix?: string; serverId?: string; connecting?: boolean; log?: boolean | 'done' } = {},
) {
  const err: BackendError =
    e && typeof e === 'object' && 'kind' in e && 'message' in e ? (e as BackendError) : toBackendError(e);
  if (err.kind === 'cancelled') return;
  // 'done': the caller already wrote the error to the protocol.
  const logged = opts.log !== false && !!err.detail;
  if (logged && opts.log !== 'done') addLog('error', sentence(err.message), opts.serverId, err.detail);
  const { text, hint } = explainError(err, { connecting: opts.connecting, logged });
  showToast(opts.prefix ? `${opts.prefix}: ${text}` : text, 'error', hint);
}
