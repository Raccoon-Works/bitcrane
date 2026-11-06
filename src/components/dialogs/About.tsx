/**
 * About Bitcrane and the list of third-party licenses it links to.
 */
import { useEffect, useState } from 'react';
import { closeDialog, openDialog, openExternal, useStore } from '../../state/store';
import { useAppVersion } from '../../state/updates';
import { BMark } from '../icons';
import { Button, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function About() {
  const platform = useStore((s) => s.platform);
  const version = useAppVersion();
  return (
    <Dialog label={$t('Über Bitcrane')} width={420} className="about">
      <div className="about-body">
        {platform === 'mac' ? <BMark variant="macApp" size={128} /> : <BMark variant="winApp" size={96} />}
        <span className="display">Bitcrane</span>
        <span className="small muted">{version ? $t('Version {0}', version) : ' '}</span>
        <span>
          {$t('von')} <strong>RaccoonWorks</strong>
        </span>
        <p className="muted center">
          {$t('Dateien per SFTP übertragen und Ordner überwachen. Jede Änderung wird automatisch hochgeladen.')}
        </p>
        <div className="row-inline">
          <Button onClick={() => openExternal('https://bitcrane.de')}>{$t('Webseite')}</Button>
          <Button onClick={() => openDialog({ type: 'licenses' })}>{$t('Lizenzen')}</Button>
        </div>
        <span className="small muted">{$t('© 2026 RaccoonWorks')}</span>
      </div>
    </Dialog>
  );
}

type LicenseEntry = { name: string; version: string; license: string; kind: 'npm' | 'rust' | 'other' };

/** Lists the third-party packages shipped with Bitcrane and their licenses. */
export function Licenses() {
  const [items, setItems] = useState<LicenseEntry[] | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    // Loaded on demand so the list does not weigh down the start.
    import('../../licenses.json').then((m) => setItems(m.default as LicenseEntry[])).catch(() => setItems([]));
  }, []);
  const q = query.trim().toLowerCase();
  const shown = (items ?? []).filter(
    (i) => !q || i.name.toLowerCase().includes(q) || i.license.toLowerCase().includes(q),
  );
  return (
    <Dialog
      label={$t('Lizenzen')}
      title={$t('Lizenzen')}
      subtitle={$t('Bitcrane verwendet freie Software. Die Lizenztexte liegen den jeweiligen Paketen bei.')}
      width={560}
      maxHeight={620}
      className="licenses"
      footer={
        <>
          <Button onClick={() => openDialog({ type: 'about' })}>{$t('Zurück')}</Button>
          <span className="flex-1" />
          <span className="small muted">{items ? $t('{0} Pakete', shown.length) : ''}</span>
          <Button variant="primary" onClick={closeDialog}>
            {$t('Fertig')}
          </Button>
        </>
      }
    >
      <TextField
        value={query}
        onChange={setQuery}
        placeholder={$t('Paket oder Lizenz suchen')}
        label={$t('Paket oder Lizenz suchen')}
        autoFocus
      />
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
