/**
 * Control bar of the browser prototype (not part of the real app).
 * Switches system look and theme and triggers scenarios that would
 * otherwise need a real server: file changes, conflicts, errors and
 * connection drops.
 */
import { ChevronUp, FlaskConical, Keyboard } from './glyphs';
import { useEffect, useRef, useState } from 'react';
import {
  openDialog, resetPrototype, setPlatform, setState, setTheme, showFirstRun, simulateChangedHostKey, simulateConflict, simulateDisconnect,
  simulateError, simulateLocalChange, useStore,
} from '../state/store';
import { Segmented } from './ui';
import { $t } from '../i18n';

export function PrototypeBar() {
  const platform = useStore((s) => s.platform);
  const theme = useStore((s) => s.theme);
  const palette = useStore((s) => s.palette);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  const run = (fn: () => void) => () => { setOpen(false); fn(); };
  const scenes: Array<{ label: string; note: string; run: () => void } | null> = [
    { label: $t('Datei lokal ändern'), note: $t('Die Überwachung lädt sie nach 2 Sekunden hoch, danach läuft der Befehl.'), run: () => simulateLocalChange() },
    { label: $t('Konflikt auslösen'), note: $t('Die Server-Datei ist neuer als deine.'), run: simulateConflict },
    { label: $t('Upload-Fehler auslösen'), note: $t('Keine Schreibrechte, Aktivität klappt auf.'), run: simulateError },
    { label: $t('Verbindung trennen'), note: $t('Server antwortet nicht mehr, Dateien warten.'), run: () => simulateDisconnect() },
    { label: $t('Fingerabdruck geändert'), note: $t('Warnung vor dem Verbinden.'), run: simulateChangedHostKey },
    null,
    { label: platform === 'mac' ? $t('Fenster der Menüleiste zeigen') : $t('Fenster im Infobereich zeigen'), note: $t('Für den Hintergrundbetrieb.'), run: () => setState({ menuBarWindowOpen: true }) },
    { label: $t('Übertragungen als Fenster'), note: '', run: () => openDialog({ type: 'transfers' }) },
    { label: $t('Einstellungen'), note: '', run: () => openDialog({ type: 'settings', tab: 'watch' }) },
    { label: $t('Werkzeugleiste anpassen'), note: $t('Auch per Rechtsklick auf die Leiste.'), run: () => openDialog({ type: 'toolbar' }) },
    { label: $t('Über Bitcrane'), note: '', run: () => openDialog({ type: 'about' }) },
    null,
    { label: $t('Erster Start ohne Server'), note: $t('Willkommensbildschirm.'), run: showFirstRun },
    { label: $t('Beispieldaten zurücksetzen'), note: '', run: resetPrototype },
  ];

  return (
    <div className="proto-bar" ref={ref}>
      <span className="proto-badge"><FlaskConical size={13} strokeWidth={1.75} aria-hidden="true" />{$t('Prototyp')}</span>
      <span className="proto-note">{$t('Alles simuliert, keine echte Verbindung')}</span>
      <span className="flex-1" />
      <Segmented label={$t('System')} value={platform} onChange={setPlatform} options={[{ value: 'mac', label: $t('Mac') }, { value: 'win', label: $t('Windows') }]} />
      <Segmented label={$t('Erscheinungsbild')} value={theme} onChange={setTheme} options={[{ value: 'dark', label: $t('Dunkel') }, { value: 'light', label: $t('Hell') }]} />
      {theme === 'dark' && <Segmented label={$t('Farben')} value={palette} onChange={(v) => setState({ palette: v })} options={[{ value: 'auto', label: $t('Je System') }, { value: 'explorer', label: 'Explorer' }, { value: 'transmit', label: 'Transmit' }, { value: 'tabby', label: 'Tabby' }, { value: 'old', label: $t('Bisher') }]} />}
      <div className="proto-scenes">
        <button type="button" className="proto-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          {$t('Ausprobieren')}{' '}<ChevronUp size={12} strokeWidth={2} aria-hidden="true" />
        </button>
        {open && (
          <div role="menu" className="proto-menu">
            {scenes.map((s, i) =>
              s ? (
                <button key={s.label} type="button" role="menuitem" className="proto-item" onClick={run(s.run)}>
                  <span>{s.label}</span>
                  {s.note && <span className="proto-item-note">{s.note}</span>}
                </button>
              ) : <div key={`sep${i}`} className="proto-sep" />,
            )}
          </div>
        )}
      </div>
      <button type="button" className="proto-btn" onClick={() => openDialog({ type: 'shortcuts' })}><Keyboard size={13} strokeWidth={1.75} aria-hidden="true" />{$t('Kürzel')}</button>
    </div>
  );
}
