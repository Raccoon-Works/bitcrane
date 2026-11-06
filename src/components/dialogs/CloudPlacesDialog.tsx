/**
 * Cloud storage folders found on this computer at the first start, offered
 * for the places bar.
 */
import { useState } from 'react';
import type { CloudPlace } from '../../backend/types';
import { addCloudPlaces, closeDialog, useStore } from '../../state/store';
import { Cloud } from '../glyphs';
import { Button, Checkbox } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

/**
 * First start (Transmit does the same on the Mac): cloud storage folders found
 * on this computer, ticked, to be added to the places bar.
 */
export function CloudPlacesDialog({ found }: { found: CloudPlace[] }) {
  const [picked, setPicked] = useState<string[]>(found.map((c) => c.path));
  const platform = useStore((s) => s.platform);
  const toggle = (path: string, on: boolean) =>
    setPicked((cur) => (on ? [...cur, path] : cur.filter((p) => p !== path)));
  return (
    <Dialog
      label={$t('Cloud-Ordner gefunden')}
      title={$t('Cloud-Ordner gefunden')}
      subtitle={$t('Bitcrane kann sie in die Ortsleiste übernehmen, dann sind sie mit einem Klick erreichbar.')}
      icon={
        <span className="icon-tile tone-accent">
          <Cloud size={20} strokeWidth={1.75} />
        </span>
      }
      width={500}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={closeDialog}>{$t('Nicht jetzt')}</Button>
          <Button
            variant="primary"
            autoFocus
            disabled={!picked.length}
            onClick={() => addCloudPlaces(found.filter((c) => picked.includes(c.path)))}
          >
            {$t('Zur Ortsleiste hinzufügen')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        {found.map((c) => (
          <Checkbox
            key={c.path}
            checked={picked.includes(c.path)}
            onChange={(v) => toggle(c.path, v)}
            label={c.name}
            note={<span className="mono">{c.path}</span>}
          />
        ))}
        {platform === 'mac' && (
          <p className="small muted">
            {$t('Beim ersten Öffnen fragt macOS, ob Bitcrane auf den Ordner zugreifen darf.')}
          </p>
        )}
      </div>
    </Dialog>
  );
}
