/**
 * "Ordner abgleichen": compares the folders of the two halves of the tab (with
 * subfolders) and lists what would happen before anything happens. Every line
 * can be ticked off; deleting is off unless chosen.
 *
 * Works for every pair of halves: this computer ↔ server, server ↔ server and
 * two folders of this computer. Filters: names and patterns (the watch's or
 * the general ones plus the server's rule) and "only files changed in the last
 * X days". A server clock that is off is corrected before comparing times.
 */
import { ArrowLeft, ArrowRight, Loader2, Star, Trash2 } from '../glyphs';
import { useEffect, useMemo, useState } from 'react';
import { toBackendError } from '../../backend/api';
import { clockOffset, connectServer, isConnected } from '../../state/live';
import { baseKey, contentDiffers, learnBase, planLines, sameSizePairs, walkPlace as walk, type Base, type Direction, type Line, type Place, type Side } from '../../state/syncPlan';
import {
  activeTab, closeDialog, getState, LIVE, paneLoc, ruleFor, runSync, serverById, showToast, uid, updateSettings, useStore, watchForLocal, type SyncAction, type SyncFavorite, type SyncSchedule,
} from '../../state/store';
import { formatDate, formatSize } from '../../util/format';
import { Button, Checkbox, Segmented, Select, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function CompareDialog({ favoriteId }: { favoriteId?: string }) {
  // The right half must show files (a server or this computer), not the server list.
  const ready = useStore((s) => { const t = s.tabs.find((x) => x.id === s.activeTabId); return !!t && (!!t.serverId || !!t.rightLocal); });
  if (!ready) {
    return (
      <Dialog label={$t('Ordner abgleichen')} title={$t('Ordner abgleichen')} subtitle={$t('Öffne rechts zuerst einen Server oder einen Ordner dieses Computers; abgeglichen werden die Ordner der beiden Hälften.')} width={480}
        footer={<><span className="flex-1" /><Button variant="primary" onClick={closeDialog}>{$t('OK')}</Button></>}>
        {null}
      </Dialog>
    );
  }
  return <CompareBody favoriteId={favoriteId} />;
}

function CompareBody({ favoriteId }: { favoriteId?: string }) {
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const platform = useStore((s) => s.platform);
  const defaults = useStore((s) => s.settings.defaultExcludes);
  const favorites = useStore((s) => s.settings.syncFavorites);
  const fav = favorites.find((f) => f.id === favoriteId);
  const [direction, setDirection] = useState<Direction>(fav?.direction ?? 'up');
  const [bySize, setBySize] = useState(fav?.bySize ?? false);
  const [byContent, setByContent] = useState(fav?.byContent ?? false);
  const [deletes, setDeletes] = useState(fav?.deletes ?? false);
  const [days, setDays] = useState<number>(fav?.days ?? 0);
  // Schedule of a saved comparison: 'off' or when it runs by itself.
  const [schedMode, setSchedMode] = useState<'off' | SyncSchedule['mode']>(fav?.schedule?.mode ?? 'off');
  const [schedTime, setSchedTime] = useState(fav?.schedule?.time ?? '03:00');
  const [schedDelete, setSchedDelete] = useState(!!fav?.schedule?.allowDelete);
  const [differs, setDiffers] = useState<Map<string, boolean> | null>(null);
  const [checking, setChecking] = useState(false);
  const [favName, setFavName] = useState<string | null>(null);
  const [data, setData] = useState<{ local: Map<string, Side>; remote: Map<string, Side>; base: Base } | null>(null);
  // Conflicts (changed on both sides): which side the user keeps; none chosen = left alone.
  const [keep, setKeep] = useState<Map<string, 'upload' | 'download'>>(new Map());
  const [error, setError] = useState('');
  const [unticked, setUnticked] = useState<Set<string>>(new Set());

  // The two halves as places.
  const thisComputer = platform === 'mac' ? $t('Dieser Mac') : $t('Dieser PC');
  const placeOfSide = (side: 'local' | 'remote'): Place => {
    const [ls, sid] = paneLoc(side, tab);
    const serverId = ls === 'remote' ? sid : '';
    return { serverId, dir: tab ? (side === 'local' ? tab.localPath : tab.remotePath) : '', name: serverId ? serverById(serverId)?.name ?? $t('Server') : thisComputer };
  };
  const left = placeOfSide('local');
  const right = placeOfSide('remote');
  // The usual case (this computer left, a server right) keeps the words "hochladen" and "herunterladen".
  const classic = !left.serverId && !!right.serverId;

  // Left out: the watch's patterns (or the general ones) plus those of the servers' rules.
  const watch = tab && !left.serverId ? watchForLocal(tab.localPath) : undefined;
  const excludes = useMemo(() => {
    const own = watch?.excludes ?? defaults;
    const rules = [left.serverId, right.serverId].filter(Boolean).flatMap((sid) => ruleFor(sid)?.excludes ?? []);
    return [...new Set([...own, ...rules])];
  }, [watch, defaults, left.serverId, right.serverId]);

  // A server whose clock is off by more than a few seconds is mentioned (and corrected).
  const offsets = [left, right].filter((p) => p.serverId && LIVE && Math.abs(clockOffset(p.serverId)) > 2000)
    .map((p) => $t('Die Uhr von „{0}“ geht {1} Sek. {2}; das wird beim Vergleich ausgeglichen.', p.name, Math.round(Math.abs(clockOffset(p.serverId)) / 1000), clockOffset(p.serverId) > 0 ? $t('vor') : $t('nach')));

  useEffect(() => {
    const t = activeTab();
    if (!t) return;
    // Opened from a favorite the connections may still be starting.
    const ready = Promise.all([left.serverId, right.serverId].filter(Boolean).map((sid) => (LIVE && !isConnected(sid) ? connectServer(sid) : Promise.resolve(true))));
    ready
      .then(() => Promise.all([walk(left), walk(right)]))
      // The agreed state from the last time (for "Beide Richtungen"); what is equal now is remembered.
      .then(([local, remote]) => setData({ local, remote, base: learnBase(baseKey(left, right), local, remote) }))
      .catch((e) => setError(toBackendError(e).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Inhalt prüfen": checksums for files of the same size on both sides.
  useEffect(() => {
    if (!byContent || !data || !tab) { setDiffers(null); return; }
    const pairs = sameSizePairs(data.local, data.remote, excludes);
    setChecking(true);
    let cancelled = false;
    contentDiffers(left, right, pairs).then((m) => { if (!cancelled) setDiffers(m); }, (e) => { if (!cancelled) setError(toBackendError(e).message); }).finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byContent, data]);

  const lines: Line[] = useMemo(
    () => (data ? planLines(data.local, data.remote, { direction, bySize, deletes, days, excludes, differs, base: data.base }) : []),
    [data, direction, bySize, deletes, excludes, differs, days],
  );

  const todo = lines.filter((l) => l.action !== 'none');
  // A conflict takes part once a side is chosen; it then counts as that copy.
  const effective = (l: Line): Line['action'] => (l.action === 'conflict' ? keep.get(l.rel) ?? 'conflict' : l.action);
  const chosen = todo.filter((l) => !unticked.has(l.rel) && effective(l) !== 'conflict').map((l) => ({ ...l, action: effective(l) }));
  const conflicts = todo.filter((l) => l.action === 'conflict' && !keep.has(l.rel)).length;
  const same = lines.length - todo.length;
  const count = (k: Line['action']) => chosen.filter((l) => l.action === k).length;
  const toggle = (rel: string) => setUnticked((u) => {
    const n = new Set(u);
    if (n.has(rel)) n.delete(rel); else n.add(rel);
    return n;
  });
  const run = () => runSync(chosen.map((l) => ({
    kind: l.action as SyncAction['kind'], rel: l.rel, size: (l.action === 'download' ? l.remote : l.local)?.size ?? 0,
  })));

  const saveFavorite = () => {
    if (!tab || !favName?.trim()) return;
    const f: SyncFavorite = {
      id: fav?.id ?? uid('sync'), name: favName.trim(), serverId: right.serverId || left.serverId, local: tab.localPath, remote: tab.remotePath,
      direction, bySize, byContent, deletes, days: days || undefined,
      schedule: schedMode === 'off' ? undefined : { mode: schedMode, time: schedMode === 'daily' ? schedTime : undefined, allowDelete: deletes && schedDelete ? true : undefined },
      lastRun: fav?.lastRun, lastResult: fav?.lastResult,
      ...(left.serverId ? { leftServerId: left.serverId } : {}), ...(!right.serverId ? { rightLocal: true } : {}),
    };
    const list = getState().settings.syncFavorites;
    updateSettings({ syncFavorites: fav ? list.map((x) => (x.id === fav.id ? f : x)) : [...list, f] });
    setFavName(null);
    showToast($t('Abgleich „{0}“ gesichert. Er steht in der Serverliste unter „Abgleiche“.', f.name), 'ok');
  };

  const toRight = classic ? $t('hochladen') : $t('nach rechts');
  const toLeft = classic ? $t('herunterladen') : $t('nach links');
  const summary = [
    count('upload') && `${count('upload')} ${toRight}`,
    count('download') && `${count('download')} ${toLeft}`,
    count('deleteRemote') && $t('{0} in „{1}“ löschen', count('deleteRemote'), right.name),
    count('deleteLocal') && $t('{0} in „{1}“ löschen', count('deleteLocal'), left.name),
    conflicts && (conflicts === 1 ? $t('1 Konflikt offen') : $t('{0} Konflikte offen', conflicts)),
  ].filter(Boolean).join(', ');

  return (
    <Dialog
      label={$t('Ordner abgleichen')}
      title={fav ? $t('Abgleich „{0}“', fav.name) : $t('Ordner abgleichen')}
      subtitle={tab ? `${left.name}: ${left.dir}  ↔  ${right.name}: ${right.dir}` : undefined}
      width={920}
      maxHeight={740}
      footer={favName !== null ? (
        <><span className="small muted">{$t('Name')}</span><TextField label={$t('Name des Abgleichs')} value={favName} onChange={setFavName} autoFocus onEnter={saveFavorite} className="flex-1" /><Button onClick={() => setFavName(null)}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!favName.trim()} onClick={saveFavorite}>{$t('Sichern')}</Button></>
      ) : (
        <><Button variant="ghost" onClick={() => setFavName(fav?.name ?? (tab ? `${tab.localPath.split('/').pop()} ↔ ${tab.remotePath.split('/').pop() || '/'}` : ''))}><Star size={13} strokeWidth={1.75} aria-hidden="true" />{fav ? $t('Favorit ändern') : $t('Als Favorit sichern')}</Button><span className="small muted">{data ? (checking ? $t('Prüfsummen werden berechnet …') : summary || $t('Nichts zu tun.')) : ''}</span><span className="flex-1" /><Button onClick={closeDialog}>{$t('Abbrechen')}</Button><Button variant="primary" disabled={!chosen.length || checking} onClick={run}>{$t('Abgleichen')}</Button></>
      )}
    >
      <div className="form-stack">
        <div className="row-between wrap-row">
          <Segmented<Direction> label={$t('Richtung')} value={direction} onChange={setDirection} options={[
            { value: 'up', label: classic ? $t('Hochladen') : $t('Nach rechts') },
            { value: 'down', label: classic ? $t('Herunterladen') : $t('Nach links') },
            { value: 'both', label: $t('Beide Richtungen') },
          ]} />
          <Select label={$t('Zeitraum')} value={String(days)} onChange={(v) => setDays(Number(v))} options={[
            { value: '0', label: $t('Alle Dateien') }, { value: '1', label: $t('Geändert seit gestern') }, { value: '7', label: $t('Letzte 7 Tage') }, { value: '30', label: $t('Letzte 30 Tage') }, { value: '90', label: $t('Letzte 90 Tage') },
          ]} />
        </div>
        <span className="row-inline wrap-row">
          <Checkbox checked={bySize} onChange={setBySize} label={$t('Nur nach Größe vergleichen')} />
          <Checkbox checked={byContent} onChange={setByContent} label={$t('Inhalt prüfen (Prüfsumme)')} />
          {direction !== 'both' && <Checkbox danger checked={deletes} onChange={setDeletes} label={$t('Was nur in „{0}“ liegt, löschen', direction === 'up' ? right.name : left.name)} />}
          {direction === 'both' && <Checkbox danger checked={deletes} onChange={setDeletes} label={$t('Gelöschtes auch auf der anderen Seite löschen')} />}
        </span>
        {direction === 'both' && (
          <span className="small muted">{data?.base.size
            ? $t('Bitcrane kennt den Stand vom letzten Abgleich: Kopiert wird jeweils die geänderte Seite. Wurde eine Datei auf beiden Seiten geändert, entscheidest du.')
            : $t('Erster Abgleich dieser beiden Ordner: Bei Unterschieden gewinnt die neuere Datei. Ab dem nächsten Mal erkennt Bitcrane auch Löschungen und Konflikte.')}</span>
        )}
        <span className="small muted">{$t('Ausgelassen wird:')}{' '}{excludes.join(', ') || $t('nichts')}{watch ? $t(' (wie bei der Überwachung „{0}“)', watch.name) : ''}. {same > 0 && $t('{0} {1} schon gleich.', same, same === 1 ? $t('Datei ist') : $t('Dateien sind'))}</span>
        {offsets.map((o) => <span key={o} className="small tone-accent">{o}</span>)}
        {/* Schedule: saved with "Als Favorit sichern" / "Favorit ändern". */}
        <div className="schedule-row">
          <span className="caption-strong">{$t('Automatisch')}</span>
          <Select label={$t('Automatisch abgleichen')} value={schedMode} onChange={(v) => setSchedMode(v as typeof schedMode)} options={[
            { value: 'off', label: $t('Nur von Hand') }, { value: 'daily', label: $t('Täglich um …') }, { value: 'hourly', label: $t('Stündlich') }, { value: 'startup', label: $t('Beim Start von Bitcrane') },
          ]} />
          {schedMode === 'daily' && <input type="time" className="field time-field" value={schedTime} aria-label={$t('Uhrzeit')} onChange={(e) => setSchedTime(e.target.value || '03:00')} />}
          {schedMode !== 'off' && deletes && <Checkbox danger checked={schedDelete} onChange={setSchedDelete} label={$t('Auch dabei löschen')} />}
          <span className="small muted flex-1">{schedMode === 'off' ? '' : deletes && !schedDelete
            ? $t('Läuft, solange Bitcrane läuft (auch nur im Infobereich). Gelöscht wird dabei nichts, nur gemeldet.')
            : $t('Läuft, solange Bitcrane läuft (auch nur im Infobereich). Wird mit „{0}“ gespeichert.', fav ? $t('Favorit ändern') : $t('Als Favorit sichern'))}</span>
        </div>
        {fav?.lastRun && <span className="small muted">{$t('Zuletzt automatisch: {0} – {1}', formatDate(fav.lastRun), fav.lastResult ?? '')}</span>}
        {!data && !error && <span className="row-inline muted"><Loader2 size={14} className="spin" aria-hidden="true" />{$t('Ordner werden gelesen …')}</span>}
        {error && <p className="tone-danger">{error}</p>}
        {data && !todo.length && <p className="muted">{days ? $t('In diesem Zeitraum sind beide Ordner auf dem gleichen Stand.') : $t('Beide Ordner sind auf dem gleichen Stand.')}</p>}
        {todo.length > 0 && (
          <div className={`sync-list${todo.some((l) => l.action === 'conflict') ? ' has-conflicts' : ''}`} role="table" aria-label={$t('Was passiert')}>
            <div className="sync-row sync-head" role="row">
              <span role="columnheader"><Checkbox checked={chosen.length === todo.length} onChange={(v) => setUnticked(v ? new Set() : new Set(todo.map((l) => l.rel)))} label="" /></span>
              <span role="columnheader">{$t('Datei')}</span><span role="columnheader" className="ellipsis">{left.name}</span><span role="columnheader" /><span role="columnheader" className="ellipsis">{right.name}</span>
            </div>
            {todo.map((l) => (
              <div key={l.rel} role="row" className={`sync-row${unticked.has(l.rel) ? ' is-off' : ''}`}>
                <span role="cell"><Checkbox checked={!unticked.has(l.rel)} onChange={() => toggle(l.rel)} label="" /></span>
                <span role="cell" className="mono ellipsis" title={l.rel}>{l.rel}</span>
                <span role="cell" className="small muted">{l.local ? `${formatSize(l.local.size)} · ${formatDate(l.local.mtime)}` : '–'}</span>
                {l.action === 'conflict' ? (
                  <span role="cell" className="sync-action sync-conflict">
                    <Select label={$t('Konflikt: welche Fassung behalten?')} value={keep.get(l.rel) ?? ''} onChange={(v) => setKeep((m) => { const n = new Map(m); if (v) n.set(l.rel, v as 'upload' | 'download'); else n.delete(l.rel); return n; })} options={[
                      { value: '', label: $t('Konflikt') }, { value: 'upload', label: $t('Linke behalten') }, { value: 'download', label: $t('Rechte behalten') },
                    ]} />
                  </span>
                ) : (
                <span role="cell" className={`sync-action ${l.action.startsWith('delete') ? 'tone-danger' : 'tone-accent'}`} title={l.action}>
                  {l.action === 'upload' && <ArrowRight size={14} strokeWidth={2} aria-label={toRight} />}
                  {l.action === 'download' && <ArrowLeft size={14} strokeWidth={2} aria-label={toLeft} />}
                  {l.action.startsWith('delete') && <Trash2 size={14} strokeWidth={1.75} aria-label={$t('löschen')} />}
                </span>
                )}
                <span role="cell" className="small muted">{l.remote ? `${formatSize(l.remote.size)} · ${formatDate(l.remote.mtime)}` : '–'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
