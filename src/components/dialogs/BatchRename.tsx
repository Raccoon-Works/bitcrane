/**
 * "Mehrere umbenennen": renames all selected entries with one rule (replace
 * text, number, add before/after, upper/lower case). A preview shows every
 * new name; clashes are marked and block the renaming.
 */
import { ArrowRight } from '../glyphs';
import { useMemo, useState } from 'react';
import type { PaneSide } from '../../backend/types';
import { activeTab, closeDialog, listEntries, panePath, renameMany, paneLoc } from '../../state/store';
import { Button, Segmented, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

type Mode = 'replace' | 'number' | 'affix' | 'case';

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

export function BatchRename({ side, names }: { side: PaneSide; names: string[] }) {
  const [mode, setMode] = useState<Mode>('replace');
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [base, setBase] = useState($t('Datei '));
  const [start, setStart] = useState('1');
  const [digits, setDigits] = useState('2');
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [caseMode, setCaseMode] = useState<'lower' | 'upper'>('lower');

  const tab = activeTab();
  const others = useMemo(
    () => new Set((tab ? listEntries(...paneLoc(side, tab), panePath(side)) ?? [] : []).map((e) => e.name).filter((n) => !names.includes(n))),
    [tab, side, names],
  );

  const result = names.map((old, i) => {
    const [stem, ext] = splitExt(old);
    let next = old;
    if (mode === 'replace') next = find ? old.split(find).join(replace) : old;
    if (mode === 'number') next = `${base}${String((Number(start) || 0) + i).padStart(Math.max(1, Number(digits) || 1), '0')}${ext}`;
    if (mode === 'affix') next = `${before}${stem}${after}${ext}`;
    if (mode === 'case') next = caseMode === 'lower' ? old.toLowerCase() : old.toUpperCase();
    return [old, next.trim()] as [string, string];
  });
  const counts = new Map<string, number>();
  result.forEach(([, n]) => counts.set(n, (counts.get(n) ?? 0) + 1));
  const problem = (n: string) => (!n ? $t('leer') : /[/\\]/.test(n) ? $t('Schrägstrich') : (counts.get(n) ?? 0) > 1 ? $t('doppelt') : others.has(n) ? $t('gibt es schon') : '');
  const changes = result.filter(([o, n]) => o !== n);
  const blocked = result.some(([o, n]) => o !== n && problem(n));

  return (
    <Dialog
      label={$t('Mehrere umbenennen')}
      title={$t('{0} Objekte umbenennen', names.length)}
      width={680}
      maxHeight={640}
      footer={<><span className="small muted">{changes.length ? (changes.length === 1 ? $t('1 Name ändert sich') : $t('{0} Namen ändern sich', changes.length)) : $t('Noch keine Änderung')}</span><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!changes.length || blocked} onClick={() => renameMany(side, changes)}>{$t('Umbenennen')}</Button></>}
    >
      <div className="form-stack">
        <Segmented<Mode> label={$t('Art')} value={mode} onChange={setMode} options={[{ value: 'replace', label: $t('Text ersetzen') }, { value: 'number', label: $t('Nummerieren') }, { value: 'affix', label: $t('Vorne/hinten ergänzen') }, { value: 'case', label: $t('Groß/klein') }]} />
        <div className="form-grid">
          {mode === 'replace' && (
            <>
              <label htmlFor="br-find">{$t('Suchen')}</label><TextField id="br-find" value={find} onChange={setFind} autoFocus mono />
              <label htmlFor="br-repl">{$t('Ersetzen durch')}</label><TextField id="br-repl" value={replace} onChange={setReplace} mono />
            </>
          )}
          {mode === 'number' && (
            <>
              <label htmlFor="br-base">{$t('Name')}</label><TextField id="br-base" value={base} onChange={setBase} autoFocus mono />
              <label htmlFor="br-start">{$t('Beginnen bei')}</label><TextField id="br-start" value={start} onChange={(v) => setStart(v.replace(/\D/g, ''))} className="port-field" />
              <label htmlFor="br-digits">{$t('Stellen')}</label><TextField id="br-digits" value={digits} onChange={(v) => setDigits(v.replace(/\D/g, '').slice(0, 1))} className="port-field" />
            </>
          )}
          {mode === 'affix' && (
            <>
              <label htmlFor="br-before">{$t('Vorne')}</label><TextField id="br-before" value={before} onChange={setBefore} autoFocus mono />
              <label htmlFor="br-after">{$t('Hinten (vor der Endung)')}</label><TextField id="br-after" value={after} onChange={setAfter} mono />
            </>
          )}
          {mode === 'case' && (
            <>
              <span>{$t('Schreibweise')}</span>
              <Segmented<'lower' | 'upper'> label={$t('Schreibweise')} value={caseMode} onChange={setCaseMode} options={[{ value: 'lower', label: $t('klein') }, { value: 'upper', label: 'GROSS' }]} />
            </>
          )}
        </div>
        <div className="rename-preview" role="table" aria-label={$t('Vorschau')}>
          {result.map(([o, n]) => {
            const p = o !== n ? problem(n) : '';
            return (
              <div key={o} role="row" className={`rename-row${p ? ' is-bad' : ''}${o === n ? ' is-same' : ''}`}>
                <span className="mono ellipsis" role="cell">{o}</span>
                <ArrowRight size={12} strokeWidth={2} aria-hidden="true" className="muted" />
                <span className="mono ellipsis" role="cell">{n}</span>
                <span className="small tone-danger" role="cell">{p}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
