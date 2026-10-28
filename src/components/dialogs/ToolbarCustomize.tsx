/**
 * "Werkzeugleiste anpassen": the current toolbar on top, further symbols
 * below. Symbols move by drag & drop or by a simple click (click adds or
 * removes, which also works with the keyboard).
 */
import { Search } from '../glyphs';
import { useState } from 'react';
import { allTools, closeDialog, defaultToolbar, setState, setToolbar, useStore, type ToolId } from '../../state/store';
import { WatchIcon } from '../icons';
import { useToolDefs } from '../Toolbar';
import { Button, Select } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function ToolbarCustomize() {
  const toolbar = useStore((s) => s.toolbar);
  const labels = useStore((s) => s.toolbarLabels);
  const defs = useToolDefs();
  const [drag, setDrag] = useState<{ id: ToolId; from: 'bar' | 'pool' } | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const add = (id: ToolId, at?: number) => {
    const without = toolbar.filter((x) => x !== id);
    const pos = at === undefined ? without.length : Math.min(at, without.length);
    setToolbar([...without.slice(0, pos), id, ...without.slice(pos)]);
  };
  const remove = (id: ToolId) => setToolbar(toolbar.filter((x) => x !== id));

  return (
    <Dialog
      label={$t('Werkzeugleiste anpassen')}
      title={$t('Werkzeugleiste anpassen')}
      subtitle={$t('Ziehe Symbole in die Leiste oder aus ihr heraus, oder klicke sie an. Die Standardleiste reicht für die tägliche Arbeit, alles Weitere kannst du dazunehmen.')}
      width={820}
      footer={
        <>
          <span className="muted">{$t('Anzeigen als')}</span>
          <Select value={labels} onChange={(v) => setState({ toolbarLabels: v })} label={$t('Anzeigen als')} options={[{ value: 'icons', label: $t('Nur Symbole') }, { value: 'iconsText', label: $t('Symbole und Text') }]} />
          <span className="flex-1" />
          <Button onClick={() => setToolbar([...defaultToolbar])}>{$t('Standard wiederherstellen')}</Button>
          <Button variant="primary" onClick={closeDialog}>{$t('Fertig')}</Button>
        </>
      }
    >
      <div className="form-stack">
        <span className="caption-strong">{$t('Deine Leiste')}</span>
        <div
          className={`tb-preview${drag?.from === 'pool' ? ' is-target' : ''}`}
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={() => { if (drag) add(drag.id, over ?? undefined); setDrag(null); setOver(null); }}
        >
          {toolbar.map((id, i) => (
            <button
              key={id}
              type="button"
              draggable
              className={`tb-item${over === i && drag ? ' is-over' : ''}`}
              title={$t('{0} entfernen', defs[id].label)}
              aria-label={$t('{0} aus der Leiste entfernen', defs[id].label)}
              onDragStart={() => setDrag({ id, from: 'bar' })}
              onDragOver={(e) => { e.preventDefault(); setOver(i); }}
              onDragEnd={() => { setDrag(null); setOver(null); }}
              onClick={() => remove(id)}
            >
              {defs[id].icon}
            </button>
          ))}
          <span className="flex-1" />
          <span className="tb-fixed"><WatchIcon size={13} /> {$t('Überwachungen')}</span>
          <span className="tb-fixed"><Search size={13} strokeWidth={1.5} /> {$t('Suchen')}</span>
        </div>
        <div className="row-between">
          <span className="caption-strong">{$t('Weitere Symbole')}</span>
          <span className="small muted">{$t('Bereits in der Leiste: abgeblendet')}</span>
        </div>
        <div
          className={`tb-pool${drag?.from === 'bar' ? ' is-target' : ''}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => { if (drag?.from === 'bar') remove(drag.id); setDrag(null); setOver(null); }}
        >
          {allTools.map((t) => {
            const inBar = toolbar.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                draggable={!inBar}
                className={`tb-pool-item${inBar ? ' is-used' : ''}`}
                aria-label={inBar ? $t('{0} ist in der Leiste', t.label) : $t('{0} zur Leiste hinzufügen', t.label)}
                onDragStart={() => setDrag({ id: t.id, from: 'pool' })}
                onDragEnd={() => { setDrag(null); setOver(null); }}
                onClick={() => (inBar ? remove(t.id) : add(t.id))}
              >
                <span className="tb-pool-icon">{defs[t.id].icon}</span>
                <span className="small">{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
