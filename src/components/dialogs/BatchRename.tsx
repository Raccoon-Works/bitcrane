/**
 * "Mehrere umbenennen": renames all selected entries with one rule (replace
 * text, regular expression, number, add before/after, upper/lower case). In
 * names, {date} and {time} stand for the file's modification time and
 * {today} for today's date (Transmit "Batch Rename"). A preview shows every
 * new name; clashes are marked and block the renaming.
 */
import { ArrowRight } from '../glyphs';
import { useMemo, useState } from 'react';
import type { PaneSide } from '../../backend/types';
import { activeTab, closeDialog, listEntries, panePath, renameMany, paneLoc } from '../../state/store';
import { Button, Checkbox, Segmented, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

type Mode = 'replace' | 'regex' | 'number' | 'affix' | 'case';

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Fills {date}, {time} (modification time of the file) and {today}. */
function fillDates(text: string, mtime: number): string {
  const m = new Date(mtime);
  return text
    .replace(/\{date\}/g, isoDate(m))
    .replace(/\{time\}/g, `${pad(m.getHours())}-${pad(m.getMinutes())}`)
    .replace(/\{today\}/g, isoDate(new Date()));
}

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
  const [pattern, setPattern] = useState('');
  const [regexRepl, setRegexRepl] = useState('');
  const [ignoreCase, setIgnoreCase] = useState(true);

  const tab = activeTab();
  const listing = useMemo(() => (tab ? listEntries(...paneLoc(side, tab), panePath(side)) ?? [] : []), [tab, side]);
  const others = useMemo(() => new Set(listing.map((e) => e.name).filter((n) => !names.includes(n))), [listing, names]);
  const mtimes = useMemo(() => new Map(listing.map((e) => [e.name, e.mtime])), [listing]);
  // An invalid regular expression is shown as an error instead of renaming anything.
  let regex: RegExp | null = null;
  let regexError = '';
  if (mode === 'regex' && pattern) {
    try { regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g'); } catch { regexError = $t('Kein gültiger regulärer Ausdruck'); }
  }

  const result = names.map((old, i) => {
    const [stem, ext] = splitExt(old);
    let next = old;
    const mtime = mtimes.get(old) ?? Date.now();
    if (mode === 'replace') next = find ? old.split(find).join(fillDates(replace, mtime)) : old;
    if (mode === 'regex') next = regex ? old.replace(regex, fillDates(regexRepl, mtime)) : old;
    if (mode === 'number') next = `${fillDates(base, mtime)}${String((Number(start) || 0) + i).padStart(Math.max(1, Number(digits) || 1), '0')}${ext}`;
    if (mode === 'affix') next = `${fillDates(before, mtime)}${stem}${fillDates(after, mtime)}${ext}`;
    if (mode === 'case') next = caseMode === 'lower' ? old.toLowerCase() : old.toUpperCase();
    return [old, next.trim()] as [string, string];
  });
  const counts = new Map<string, number>();
  result.forEach(([, n]) => counts.set(n, (counts.get(n) ?? 0) + 1));
  const problem = (n: string) => (!n ? $t('leer') : /[/\\]/.test(n) ? $t('Schrägstrich') : (counts.get(n) ?? 0) > 1 ? $t('doppelt') : others.has(n) ? $t('gibt es schon') : '');
  const changes = result.filter(([o, n]) => o !== n);
  const blocked = !!regexError || result.some(([o, n]) => o !== n && problem(n));

  return (
    <Dialog
      label={$t('Mehrere umbenennen')}
      title={$t('{0} Objekte umbenennen', names.length)}
      width={780}
      maxHeight={640}
      footer={<><span className="small muted">{changes.length ? (changes.length === 1 ? $t('1 Name ändert sich') : $t('{0} Namen ändern sich', changes.length)) : $t('Noch keine Änderung')}</span><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!changes.length || blocked} onClick={() => renameMany(side, changes)}>{$t('Umbenennen')}</Button></>}
    >
      <div className="form-stack">
        <Segmented<Mode> label={$t('Art')} value={mode} onChange={setMode} options={[{ value: 'replace', label: $t('Text ersetzen') }, { value: 'regex', label: $t('Muster (Regex)') }, { value: 'number', label: $t('Nummerieren') }, { value: 'affix', label: $t('Vorne/hinten ergänzen') }, { value: 'case', label: $t('Groß/klein') }]} />
        <div className="form-grid">
          {mode === 'replace' && (
            <>
              <label htmlFor="br-find">{$t('Suchen')}</label><TextField id="br-find" value={find} onChange={setFind} autoFocus mono />
              <label htmlFor="br-repl">{$t('Ersetzen durch')}</label><TextField id="br-repl" value={replace} onChange={setReplace} mono />
            </>
          )}
          {mode === 'regex' && (
            <>
              <label htmlFor="br-pattern">{$t('Muster')}</label><TextField id="br-pattern" value={pattern} onChange={setPattern} autoFocus mono invalid={!!regexError} placeholder="^IMG_(\d+)" />
              <label htmlFor="br-regex-repl">{$t('Ersetzen durch')}</label><TextField id="br-regex-repl" value={regexRepl} onChange={setRegexRepl} mono placeholder="Foto-$1" />
              <span />
              <span className="row-inline"><Checkbox checked={ignoreCase} onChange={setIgnoreCase} label={$t('Groß/klein egal')} /></span>
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
        <p className="small muted">{regexError || (mode === 'regex' ? $t('$1, $2 … setzen die Klammern des Musters ein. {date} und {time} stehen für das Änderungsdatum der Datei, {today} für heute.') : mode !== 'case' ? $t('{date} und {time} stehen für das Änderungsdatum der Datei, {today} für heute, z. B. Bericht-{date}.') : '')}</p>
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
