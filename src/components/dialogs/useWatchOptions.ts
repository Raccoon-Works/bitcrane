/**
 * The options of a watch form (watch dialog and template editor), with a setter for a single option.
 */
import { useState } from 'react';
import type { WatchOptions } from '../../backend/types';

/** Sets one option of the form. */
export type SetOption = <K extends keyof WatchOptions>(k: K, v: WatchOptions[K]) => void;

/** `initial` may be a function, so defaults are read only when the form opens. */
export function useWatchOptions(initial: WatchOptions | (() => WatchOptions)) {
  const [opts, setOpts] = useState<WatchOptions>(initial);
  const set: SetOption = (k, v) => setOpts((o) => ({ ...o, [k]: v }));
  return { opts, set, setOpts };
}
