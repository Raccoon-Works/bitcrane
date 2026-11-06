/**
 * The path bar as a text field (⌘L or a click into its free space).
 */
import { useEffect, useRef, useState } from 'react';
import type { PaneSide } from '../../backend/types';
import { setState, submitPath } from '../../state/store';
import { $t } from '../../i18n';

/** Enter goes to the typed path, Escape keeps the folder. */
export function PathInput({ side, path, onServer }: { side: PaneSide; path: string; onServer: boolean }) {
  const [value, setValue] = useState(path);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const back = () => document.querySelector<HTMLElement>(`.pane[data-side="${side}"] [role="listbox"]`)?.focus();
  return (
    <input
      ref={ref}
      className="path-input mono"
      value={value}
      spellCheck={false}
      aria-label={onServer ? $t('Pfad auf dem Server') : $t('Pfad auf diesem Computer')}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          submitPath(side, value);
          back();
        }
        if (e.key === 'Escape') {
          setState({ pathEdit: null });
          back();
        }
      }}
      onBlur={() => setState({ pathEdit: null })}
    />
  );
}
