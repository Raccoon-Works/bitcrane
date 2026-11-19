/**
 * What an empty server list shows: first steps (new server, quick connect, servers from other
 * programs).
 */
import { Plus, SquareTerminal, Zap } from './glyphs';
import { useEffect, useState } from 'react';
import { tauriBackend as backend } from '../backend/tauriBackend';
import { importSshConfig, LIVE, openDialog } from '../state/store';
import { BMark } from './icons';
import { Button, WithWordmark } from './ui';
import { $t } from '../i18n';

/** No servers yet: the first steps (the old welcome screen, now inside the half). */
export function Welcome({ onQuick }: { onQuick: () => void }) {
  const [found, setFound] = useState(LIVE ? 0 : 3);
  useEffect(() => {
    if (LIVE) void backend.importFind().then((r) => setFound(r.servers.length));
  }, []);
  return (
    <div className="server-welcome">
      <BMark variant="brand" size={72} />
      <h2 className="headline">
        <WithWordmark text={$t('Willkommen bei {0}', '\u0000')} />
      </h2>
      <p className="muted center">
        {$t('Verbinde dich mit einem Server. Danach kannst du einen Ordner überwachen lassen.')}
      </p>
      <div className="server-welcome-actions">
        <Button variant="primary" onClick={() => openDialog({ type: 'serverEdit' })}>
          <Plus size={14} strokeWidth={2} aria-hidden="true" />
          {$t('Server hinzufügen')}
        </Button>
        <Button onClick={onQuick}>
          <Zap size={14} strokeWidth={1.75} aria-hidden="true" />
          {$t('Schnell verbinden')}
        </Button>
        {/* The number of servers found elsewhere is a small badge, so the label stays short. */}
        <Button
          onClick={importSshConfig}
          title={
            found > 0
              ? found === 1
                ? $t('1 Server aus anderen Programmen übernehmen')
                : $t('{0} Server aus anderen Programmen übernehmen', found)
              : undefined
          }
        >
          <SquareTerminal size={14} strokeWidth={1.75} aria-hidden="true" />
          {$t('Aus anderen Programmen')}
          {found > 0 && (
            <span
              className="count-badge"
              aria-label={found === 1 ? $t('1 Server gefunden') : $t('{0} Server gefunden', found)}
            >
              {found}
            </span>
          )}
        </Button>
      </div>
    </div>
  );
}
