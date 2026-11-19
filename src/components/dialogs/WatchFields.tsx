/**
 * The parts of the watch dialog that a watch template carries as well: behaviour, what is not
 * uploaded and the further options. Shared by the watch dialog (WatchSetup) and the template
 * editor (WatchTemplateEdit), so both show the same options with the same texts.
 */
import { useState, type ReactNode } from 'react';
import type { SetOption } from './useWatchOptions';
import type { WatchOptions } from '../../backend/types';
import { defaultWatchOptions } from '../../state/store';
import { ChevronRight } from '../glyphs';
import { Checkbox, Switch, TextField } from '../ui';
import { Chips } from './settings/parts';
import { $t } from '../../i18n';

export function WatchBehaviour({ opts, set }: { opts: WatchOptions; set: SetOption }) {
  return (
    <section aria-label={$t('Verhalten')} className="form-section">
      <span className="caption-strong">{$t('Verhalten')}</span>
      <div className="section-card list-card">
        <Checkbox
          checked={opts.includeSubfolders}
          onChange={(v) => set('includeSubfolders', v)}
          label={$t('Unterordner einbeziehen')}
          note={$t('Auch Änderungen in allen Unterordnern hochladen.')}
        />
        <Checkbox
          checked={opts.syncOnStart}
          onChange={(v) => set('syncOnStart', v)}
          label={$t('Beim Start abgleichen')}
          note={$t('Einmal alles hochladen, was lokal neuer ist.')}
        />
        <Checkbox
          checked={opts.warnIfServerNewer}
          onChange={(v) => set('warnIfServerNewer', v)}
          label={$t('Warnen, wenn die Server-Datei neuer ist')}
          note={$t('Nachfragen statt still überschreiben.')}
        />
        <Checkbox
          checked={opts.runInBackground}
          onChange={(v) => set('runInBackground', v)}
          label={$t('Im Hintergrund weiterlaufen')}
          note={$t('Auch bei geschlossenem Fenster.')}
        />
        <Checkbox
          checked={opts.startWithApp !== false}
          onChange={(v) => set('startWithApp', v)}
          label={$t('Beim Start von Bitcrane automatisch starten')}
          note={$t(
            'Verbindet sich selbst und überwacht sofort, z. B. nach dem Hochfahren. Aus: bleibt pausiert, bis du sie startest.',
          )}
        />
      </div>
    </section>
  );
}

/** "Nicht hochladen": the patterns as chips; `choose` is the template menu in the section head. */
export function WatchExcludes({
  excludes,
  onChange,
  choose,
}: {
  excludes: string[];
  onChange: (v: string[]) => void;
  choose?: ReactNode;
}) {
  return (
    <section aria-label={$t('Nicht hochladen')} className="form-section">
      <div className="form-section-head">
        <span className="caption-strong">{$t('Nicht hochladen')}</span>
        {choose}
      </div>
      <Chips values={excludes} onChange={onChange} placeholder="*.bak" className="section-card" />
    </section>
  );
}

/**
 * The post-upload command. `action` and `result` are the watch dialog's test on the chosen server;
 * a template has no server, so it shows the command alone.
 */
export function WatchCommand({
  opts,
  set,
  action,
  result,
}: {
  opts: WatchOptions;
  set: SetOption;
  action?: ReactNode;
  result?: ReactNode;
}) {
  return (
    <div className="sub-card">
      <div className="row-between">
        <label htmlFor="w-cmd" className="strong-500">
          {$t('Nach dem Hochladen einen Befehl auf dem Server ausführen')}
        </label>
        <Switch
          checked={opts.commandEnabled}
          onChange={(v) => set('commandEnabled', v)}
          label={$t('Befehl nach dem Hochladen ausführen')}
        />
      </div>
      <div className="field-row">
        <TextField
          id="w-cmd"
          mono
          className="flex-1 is-terminal"
          prefix={<span className="tone-ok">$</span>}
          value={opts.command}
          onChange={(v) => set('command', v)}
          placeholder={$t('pm2 restart meinbot')}
        />
        {action}
      </div>
      {result}
      <span className="small muted">
        {$t(
          'Läuft einmal, nachdem ein Schub Änderungen fertig hochgeladen ist, und nur, wenn dabei kein Fehler auftrat. Die Ausgabe steht in der Aktivität.',
        )}
      </span>
    </div>
  );
}

/**
 * "Weitere Optionen", folded by default. `subfolders` is the chooser of a watch's subfolders; without
 * it (a template has no folder) the option to watch only selected subfolders is not offered.
 */
export function WatchMoreOptions({
  opts,
  set,
  subfolders,
  command,
}: {
  opts: WatchOptions;
  set: SetOption;
  subfolders?: ReactNode;
  command: ReactNode;
}) {
  const [more, setMore] = useState(false);
  const changedCount =
    (
      [
        'continueOnError',
        'onlyExisting',
        'onlySelectedSubfolders',
        'setPermissions',
        'mirrorDeletes',
        'keepOldVersion',
        'commandEnabled',
      ] as const
    ).filter((k) => opts[k] !== defaultWatchOptions[k]).length + (opts.delay !== defaultWatchOptions.delay ? 1 : 0);
  return (
    <section aria-label={$t('Weitere Optionen')} className="section-card disclosure">
      <button type="button" className="disclosure-head" aria-expanded={more} onClick={() => setMore(!more)}>
        <ChevronRight size={13} strokeWidth={2} className={`chev${more ? ' is-open' : ''}`} aria-hidden="true" />
        <span className="strong">{$t('Weitere Optionen')}</span>
        <span className="small muted ellipsis">
          {$t('Fehler, Löschen, Rechte, Befehl, Wartezeit')}
          {changedCount ? $t(' · {0} geändert', changedCount) : ''}
        </span>
      </button>
      {more && (
        <div className="disclosure-body">
          <div className="option-grid">
            <Checkbox
              checked={opts.continueOnError}
              onChange={(v) => set('continueOnError', v)}
              label={$t('Bei Fehlern weitermachen')}
              note={$t('Ein Fehler hält die Überwachung nicht an; er erscheint in der Aktivität.')}
            />
            <Checkbox
              checked={opts.onlyExisting}
              onChange={(v) => set('onlyExisting', v)}
              label={$t('Nur vorhandene Dateien aktualisieren')}
              note={$t('Neue Dateien bleiben lokal, nur bestehende werden ersetzt.')}
            />
            {subfolders && (
              <Checkbox
                checked={opts.onlySelectedSubfolders}
                onChange={(v) => set('onlySelectedSubfolders', v)}
                label={$t('Nur ausgewählte Unterordner')}
                note={$t('Statt des ganzen Ordners nur bestimmte Unterordner überwachen.')}
              />
            )}
            {subfolders && opts.onlySelectedSubfolders && subfolders}
            <Checkbox
              checked={opts.setPermissions}
              onChange={(v) => set('setPermissions', v)}
              label={$t('Rechte nach dem Hochladen setzen')}
              note={$t('Zum Beispiel rw-r--r-- für Dateien und rwxr-xr-x für Ordner.')}
            />
            <Checkbox
              danger
              checked={opts.mirrorDeletes}
              onChange={(v) => set('mirrorDeletes', v)}
              label={$t('Lokal Gelöschtes auch auf dem Server löschen')}
              note={$t(
                'Bitcrane fragt jedes Mal nach, bevor es auf dem Server löscht; dort lässt sich das nicht rückgängig machen. Standardmäßig aus.',
              )}
            />
            <Checkbox
              checked={opts.keepOldVersion}
              onChange={(v) => set('keepOldVersion', v)}
              label={$t('Ältere Version auf dem Server behalten')}
              note={$t(
                'Vor dem Überschreiben kommt die alte Datei in den versteckten Ordner .bitcrane-versions daneben; die letzten 5 Versionen bleiben.',
              )}
            />
          </div>

          {command}

          <div className="sub-card row-card">
            <div className="col-text">
              <span className="strong-500">{$t('Kurz warten, bevor hochgeladen wird')}</span>
              <span className="small muted">
                {$t('Sammelt Änderungen, damit keine halb gespeicherten Dateien hochgehen.')}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={opts.delay}
              aria-label={$t('Wartezeit in Sekunden')}
              className="slider"
              onChange={(e) => set('delay', Number(e.target.value))}
            />
            <span className="num slider-value">
              {opts.delay} {$t('Sek.')}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
