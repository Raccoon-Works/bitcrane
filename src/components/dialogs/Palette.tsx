/**
 * Command palette (⇧⌘P): every action, server, bookmark, saved comparison
 * and watch in one searchable list. Words may come in any order.
 */
import { checkForUpdates } from '../../state/updates';
import { CornerDownLeft, Search } from '../glyphs';
import { useMemo, useRef, useState } from 'react';
import { ACTIONS, formatCombo, keysFor } from '../../state/keys';
import {
  activeTab, closeDialog, getState, placesFor, paneShowsServers, navigate, openDialog, openServer, openSyncFavorite, openWatchFolders, pauseAllTransfers, useStore,
} from '../../state/store';
import { Dialog } from './Dialog';
import { $t, tr } from '../../i18n';

interface Entry { id: string; group: string; label: string; hint?: string; keys?: string; run: () => void }

export function Palette() {
  const platform = useStore((s) => s.platform);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const s = getState();
    const t = activeTab(s);
    const out: Entry[] = [];
    for (const x of s.servers) out.push({ id: `srv:${x.id}`, group: 'Server', label: $t('{0} öffnen', x.name), hint: `${x.user}@${x.host}`, run: () => openServer(x.id) });
    for (const side of ['local', 'remote'] as const) {
      if (!t || paneShowsServers(side, t)) continue;
      for (const p of placesFor(side, s, t)) out.push({ id: `pl:${side}:${p.path}`, group: $t('Orte'), label: tr(p.name), hint: p.path, run: () => navigate(side, p.path) });
    }
    for (const f of s.settings.syncFavorites) out.push({ id: `sync:${f.id}`, group: 'Abgleiche', label: $t('Abgleich „{0}“', f.name), hint: f.remote, run: () => openSyncFavorite(f.id) });
    for (const w of s.watches) out.push({ id: `w:${w.id}`, group: 'Überwachungen', label: $t('Überwachung „{0}“ zeigen', w.name), hint: w.localPath, run: () => openWatchFolders(w.id) });
    for (const a of ACTIONS) {
      if (a.id === 'palette') continue;
      const k = keysFor(a.id, platform)[0];
      out.push({ id: `a:${a.id}`, group: a.group, label: a.label, keys: k ? formatCombo(k, platform) : undefined, run: a.run });
    }
    const more: Array<[string, () => void]> = [
      [$t('Server hinzufügen …'), () => openDialog({ type: 'serverEdit' })],
      [$t('Server importieren …'), () => openDialog({ type: 'import' })],
      [$t('Ordner abgleichen …'), () => openDialog({ type: 'compare' })],
      [$t('Bearbeitete Dateien …'), () => openDialog({ type: 'edits' })],
      [$t('Protokoll'), () => openDialog({ type: 'log' })],
      [$t('Alle Übertragungen pausieren'), pauseAllTransfers],
      [$t('Werkzeugleiste anpassen …'), () => openDialog({ type: 'toolbar' })],
      [$t('Über Bitcrane'), () => openDialog({ type: 'about' })],
      [$t('Nach Updates suchen …'), () => void checkForUpdates(true)],
    ];
    for (const [label, run] of more) out.push({ id: `m:${label}`, group: 'Weitere', label, run });
    return out;
  }, [platform]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = entries.filter((e) => words.every((w) => `${e.label} ${e.hint ?? ''} ${e.group}`.toLowerCase().includes(w))).slice(0, 60);
  const pick = (e: Entry | undefined) => {
    if (!e) return;
    closeDialog();
    // Let the palette close first; some actions open another dialog.
    window.setTimeout(e.run, 0);
  };
  const move = (d: number) => {
    const next = Math.max(0, Math.min(shown.length - 1, cursor + d));
    setCursor(next);
    listRef.current?.querySelector<HTMLElement>(`[data-i="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <Dialog label={$t('Befehle')} width={600} maxHeight={520} className="palette">
      <div className="palette-field">
        <Search size={16} strokeWidth={1.5} aria-hidden="true" />
        <input
          autoFocus
          value={query}
          placeholder={$t('Befehl, Server oder Ort suchen')}
          aria-label={$t('Befehl suchen')}
          aria-controls="palette-list"
          aria-activedescendant={shown[cursor] ? `pal-${cursor}` : undefined}
          spellCheck={false}
          onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            if (e.key === 'Enter') { e.preventDefault(); pick(shown[cursor]); }
          }}
        />
      </div>
      <div id="palette-list" ref={listRef} className="palette-list" role="listbox" aria-label={$t('Treffer')}>
        {shown.map((e, i) => (
          <div key={e.id} id={`pal-${i}`} data-i={i} role="option" aria-selected={i === cursor} className={`palette-item${i === cursor ? ' is-sel' : ''}`}
            onMouseMove={() => setCursor(i)} onClick={() => pick(e)}>
            <span className="flex-1 min-w-0 col-text">
              <span className="ellipsis">{e.label}</span>
              {e.hint && <span className="small muted mono ellipsis">{e.hint}</span>}
            </span>
            <span className="small muted">{e.group}</span>
            {e.keys && <kbd>{e.keys}</kbd>}
            {i === cursor && <CornerDownLeft size={13} strokeWidth={1.75} className="muted" aria-hidden="true" />}
          </div>
        ))}
        {!shown.length && <p className="muted palette-empty">{$t('Nichts gefunden.')}</p>}
      </div>
    </Dialog>
  );
}
