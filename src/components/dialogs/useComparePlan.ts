/**
 * The comparison window's plan: reads both folders once, checks contents when
 * asked, and works out per file what would happen with the chosen options.
 */
import { useEffect, useMemo, useState } from 'react';
import { toBackendError } from '../../backend/api';
import {
  baseKey,
  contentDiffers,
  learnBase,
  planLines,
  readPlaces,
  sameSizePairs,
  type Base,
  type Direction,
  type Line,
  type Place,
  type Side,
} from '../../state/syncPlan';

export interface PlanChoices {
  direction: Direction;
  bySize: boolean;
  byContent: boolean;
  deletes: boolean;
  days: number;
  excludes: string[];
}

export function useComparePlan(left: Place, right: Place, choices: PlanChoices) {
  const { direction, bySize, byContent, deletes, days, excludes } = choices;
  const [data, setData] = useState<{ local: Map<string, Side>; remote: Map<string, Side>; base: Base } | null>(null);
  const [differs, setDiffers] = useState<Map<string, boolean> | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    readPlaces(left, right)
      // The agreed state from the last time (for "Beide Richtungen"); what is equal now is remembered.
      .then(([local, remote]) => setData({ local, remote, base: learnBase(baseKey(left, right), local, remote) }))
      .catch((e) => setError(toBackendError(e).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- both folders are read once, when the window opens
  }, []);

  // "Inhalt prüfen": checksums for files of the same size on both sides.
  useEffect(() => {
    if (!byContent || !data) {
      setDiffers(null);
      return;
    }
    setChecking(true);
    let cancelled = false;
    contentDiffers(left, right, sameSizePairs(data.local, data.remote, excludes))
      .then(
        (m) => {
          if (!cancelled) setDiffers(m);
        },
        (e) => {
          if (!cancelled) setError(toBackendError(e).message);
        },
      )
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [byContent, data, excludes, left, right]);

  const lines: Line[] = useMemo(
    () =>
      data
        ? planLines(data.local, data.remote, { direction, bySize, deletes, days, excludes, differs, base: data.base })
        : [],
    [data, direction, bySize, deletes, excludes, differs, days],
  );
  return { loaded: !!data, knowsBase: !!data?.base.size, lines, checking, error };
}
