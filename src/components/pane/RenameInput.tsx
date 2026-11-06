/**
 * Inline rename of a row or tile: selects the name without its extension and
 * commits on Enter or when the field loses the focus.
 */
import { useEffect, useRef, useState } from 'react';
import type { PaneSide } from '../../backend/types';
import { commitRename, setState } from '../../state/store';
import { $t } from '../../i18n';

export function RenameInput({ side, name: full }: { side: PaneSide; name: string }) {
  // Rows inside opened folders carry a relative path; only the last part is edited.
  const name = full.slice(full.lastIndexOf('/') + 1);
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  // Set once Enter or Escape handled the name, so the blur that follows does not commit it again.
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    done.current = false;
    // Select the name without the extension, like Finder and Explorer.
    const dot = name.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [name]);
  return (
    <input
      ref={ref}
      className="rename-input"
      value={value}
      aria-label={$t('Neuer Name')}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        // The keyboard goes back to the list, so Enter right after opens the folder (Finder, Explorer).
        done.current = true;
        (e.currentTarget.closest('.list') as HTMLElement | null)?.focus();
        if (e.key === 'Enter') commitRename(side, full, value);
        else setState({ renaming: null });
      }}
      onBlur={() => {
        if (!done.current) commitRename(side, full, value);
      }}
    />
  );
}
