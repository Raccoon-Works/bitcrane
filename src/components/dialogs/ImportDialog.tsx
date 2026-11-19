/**
 * "Server importieren": shows the servers saved in FileZilla, WinSCP, Cyberduck, PuTTY and the
 * SSH configuration, plus those of an exported file (e.g. from Transmit); ticked ones are added to Bitcrane. Passwords are never
 * taken over (they are asked for on the first connection).
 */
import { showError } from '../../state/errors';
import { Loader2 } from '../glyphs';
import { useEffect, useState } from 'react';
import type { ImportedServer } from '../../backend/api';
import {
  closeDialog,
  findImportable,
  getState,
  importServers,
  readImportFile,
  serverKey,
  useStore,
} from '../../state/store';
import { Button, Checkbox } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

const protoLabel = (s: ImportedServer) =>
  s.protocol === 'ftps' ? (s.implicitTls ? $t('FTPS (implizit)') : 'FTPS') : s.protocol.toUpperCase();

/** Index of the first entry with the same server (protocol, user, host, port). */
const firstIndex = (list: ImportedServer[], s: ImportedServer) => list.findIndex((x) => serverKey(x) === serverKey(s));

export function ImportDialog() {
  const [found, setFound] = useState<{ servers: ImportedServer[]; sources: string[] } | null>(null);
  // The saved servers when the dialog opened: what is new is ticked and marked against these.
  const [existing] = useState(
    () =>
      new Set(
        getState()
          .servers.filter((x) => !x.temporary)
          .map(serverKey),
      ),
  );
  const [picked, setPicked] = useState<Set<number>>(new Set());
  // Offered by Bitcrane itself on the first start (not opened from the menu).
  const firstStart = useStore((s) => s.dialog?.type === 'import' && !!s.dialog.firstStart);

  useEffect(() => {
    void findImportable().then(setFound);
  }, []);
  useEffect(() => {
    // Preselect each new server once; the same server from a second program stays unticked.
    if (found)
      setPicked(
        new Set(
          found.servers
            .map((s, i) => [s, i] as const)
            .filter(([s, i]) => !existing.has(serverKey(s)) && firstIndex(found.servers, s) === i)
            .map(([, i]) => i),
        ),
      );
  }, [found, existing]);

  const [fileNote, setFileNote] = useState('');
  const fromFile = async () => {
    try {
      const list = await readImportFile();
      if (!list) return;
      if (!list.length) {
        setFileNote(
          $t(
            'In dieser Datei wurden keine Server erkannt. Unterstützt: Transmit-Export (unverschlüsselt), FileZilla, WinSCP.ini und Cyberduck-Lesezeichen.',
          ),
        );
        return;
      }
      setFileNote('');
      setFound((f) => ({
        servers: [
          ...(f?.servers ?? []),
          ...list.filter(
            (s) => !(f?.servers ?? []).some((x) => x.source === s.source && serverKey(x) === serverKey(s)),
          ),
        ],
        sources: f?.sources ?? [],
      }));
    } catch (e) {
      showError(e);
    }
  };

  const sources = found ? [...new Set(found.servers.map((s) => s.source))] : [];
  const toggle = (i: number) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  return (
    <Dialog
      label={$t('Server importieren')}
      title={$t('Server importieren')}
      subtitle={
        firstStart
          ? $t(
              'Auf diesem Computer sind Server aus anderen Programmen gespeichert. Die ausgewählten kommen in die Serverliste; Passwörter werden nicht übernommen, Bitcrane fragt beim ersten Verbinden danach.',
            )
          : $t(
              'Aus FileZilla, WinSCP, Cyberduck, PuTTY und der SSH-Konfiguration. Passwörter werden nicht übernommen; Bitcrane fragt beim ersten Verbinden danach.',
            )
      }
      width={760}
      maxHeight={680}
      footer={
        <>
          <Button onClick={() => void fromFile()}>{$t('Aus Datei …')}</Button>
          <span className="small muted">{picked.size ? $t('{0} ausgewählt', picked.size) : ''}</span>
          <span className="flex-1" />
          <Button onClick={closeDialog}>{firstStart ? $t('Nicht übernehmen') : $t('Abbrechen')}</Button>
          <Button
            variant="primary"
            disabled={!picked.size}
            onClick={() => found && importServers(found.servers.filter((_, i) => picked.has(i)))}
          >
            {$t('Übernehmen#importieren')}
          </Button>
        </>
      }
    >
      {!found && (
        <span className="row-inline muted">
          <Loader2 size={14} className="spin" aria-hidden="true" />
          {$t('Wird gesucht …')}
        </span>
      )}
      {fileNote && <p className="muted">{fileNote}</p>}
      {firstStart && (
        <p className="small muted">{$t('Das geht später jederzeit unter Server > Server importieren …')}</p>
      )}
      {found && !found.servers.length && (
        <p className="muted">
          {$t(
            'Keine gespeicherten Server gefunden. Gesucht wurde in: FileZilla (sitemanager.xml), WinSCP (Registry bzw. WinSCP.ini), Cyberduck und Mountain Duck (Lesezeichen), PuTTY (Registry) und ~/.ssh/config.',
          )}
        </p>
      )}
      {found && found.servers.length > 0 && (
        <div className="form-stack">
          {sources.map((src) => (
            <section key={src} className="import-group" aria-label={src}>
              <span className="caption-strong">{src}</span>
              <div className="import-list">
                {found.servers.map((s, i) =>
                  s.source !== src ? null : (
                    <label key={i} className={`import-row${existing.has(serverKey(s)) ? ' is-known' : ''}`}>
                      <Checkbox checked={picked.has(i)} onChange={() => toggle(i)} label="" />
                      <span className="col-text min-w-0">
                        <span className="strong-500 ellipsis">
                          {s.group ? `${s.group} / ` : ''}
                          {s.name}
                        </span>
                        <span className="small muted mono ellipsis">
                          {s.user ? `${s.user}@` : ''}
                          {s.host}:{s.port}
                          {s.remoteDir ? ` · ${s.remoteDir}` : ''}
                        </span>
                      </span>
                      <span className="small muted">{protoLabel(s)}</span>
                      <span className="small muted">
                        {s.auth === 'key'
                          ? $t('Schlüssel')
                          : s.auth === 'agent'
                            ? $t('Agent')
                            : s.auth === 'auto'
                              ? $t('Automatisch')
                              : $t('Passwort')}
                      </span>
                      {existing.has(serverKey(s)) ? (
                        <span className="tag">{$t('schon vorhanden')}</span>
                      ) : (
                        firstIndex(found.servers, s) !== i && <span className="tag">{$t('doppelt')}</span>
                      )}
                    </label>
                  ),
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
