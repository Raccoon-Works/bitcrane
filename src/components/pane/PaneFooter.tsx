/**
 * Footer of a half: how many entries (hidden, selected, different from the
 * other half, free space) and the buttons that act on the selection.
 */
import type { FileEntry, PaneSide, Tab } from '../../backend/types';
import {
  download,
  hiddenCount,
  isOffline,
  moveToOtherHalf,
  upload,
  useStore,
  type paneStatus,
} from '../../state/store';
import { selectDifferences, toggleCompareDirs, type CompareMark } from '../../state/tools';
import { ArrowLeft, ArrowRight, Download } from '../glyphs';
import { Button } from '../ui';
import { $t } from '../../i18n';
import { formatFree } from './useFreeSpace';

export function PaneFooter({
  side,
  tab,
  status,
  entries,
  search,
  selectedCount,
  marks,
  otherNames,
  freeSpace,
  bothLocal,
  offline,
}: {
  side: PaneSide;
  tab: Tab;
  status: ReturnType<typeof paneStatus>;
  entries: FileEntry[];
  search: string;
  selectedCount: number;
  marks: Map<string, CompareMark> | null;
  otherNames: Set<string> | null;
  freeSpace: number | null;
  bothLocal: boolean;
  offline: boolean;
}) {
  const serverOffline = useStore((s) => isOffline(tab.serverId, s));
  const hidden = search ? 0 : hiddenCount(side);
  const footText = (() => {
    if (status.notConnected) return '';
    if (status.loading && !entries.length) return $t('Wird gelesen …');
    const n = entries.length;
    // Hidden entries are counted, so nobody wonders where a file went (WinSCP: "2 versteckt").
    // Free space of the disk shown (this computer only), as in the Finder's status bar.
    const freeText = freeSpace !== null ? `, ${$t('{0} frei', formatFree(freeSpace))}` : '';
    const base = `${n} ${n === 1 ? $t('Objekt') : $t('Objekte')}${hidden ? `, ${$t('{0} versteckt', hidden)}` : ''}`;
    if (selectedCount) return $t('{0}, {1} ausgewählt', base, selectedCount) + freeText;
    if (marks)
      return marks.size ? $t('{0}, {1} anders als drüben', base, marks.size) : $t('{0}, gleich wie drüben', base);
    if (side === 'remote' && otherNames) {
      const only = entries.filter((e) => !otherNames.has(e.name)).length;
      if (only) return $t('{0}, {1} nur auf dem Server', base, only);
    }
    return base + freeText;
  })();

  return (
    <div className="pane-foot">
      <span className="flex-1">{footText}</span>
      {marks && marks.size > 0 && (
        <Button
          small
          variant="ghost"
          onClick={() => selectDifferences(side)}
          title={$t('Alles auswählen, was drüben fehlt oder hier neuer ist')}
        >
          {$t('Unterschiede auswählen')}
        </Button>
      )}
      {marks && side === 'remote' && (
        <Button small variant="ghost" onClick={toggleCompareDirs}>
          {$t('Vergleich beenden')}
        </Button>
      )}
      {/* Two local halves (Total Commander): copy or move into the other half's folder. */}
      {bothLocal && selectedCount > 0 && (
        <>
          <Button onClick={() => moveToOtherHalf(side)} title={$t('In den Ordner der anderen Hälfte verschieben')}>
            {$t('Verschieben')}
          </Button>
          <Button
            variant="primary"
            onClick={() => (side === 'local' ? upload() : download())}
            title={$t('In den Ordner der anderen Hälfte kopieren')}
          >
            {side === 'local' ? (
              <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
            ) : (
              <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
            )}
            {$t('Kopieren')}
          </Button>
        </>
      )}
      {!bothLocal && side === 'local' && selectedCount > 0 && !!tab.serverId && (
        <Button variant="primary" onClick={() => upload()} disabled={serverOffline || offline}>
          <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          {tab.leftServerId ? $t('Übertragen') : $t('Hochladen')}
        </Button>
      )}
      {!bothLocal && side === 'remote' && selectedCount > 0 && !offline && (
        <Button variant="primary" onClick={() => download()}>
          {tab.leftServerId ? (
            <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Download size={14} strokeWidth={2} aria-hidden="true" />
          )}
          {tab.leftServerId ? $t('Übertragen') : $t('Herunterladen')}
        </Button>
      )}
    </div>
  );
}
