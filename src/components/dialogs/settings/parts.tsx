/**
 * Building blocks shared by the settings areas: the area title, a labelled
 * row, a titled group of rows and an editable list of name patterns.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { Plus, X } from '../../glyphs';
import { $t } from '../../../i18n';

/** Title of the settings area shown; a group with the same name needs no caption of its own. */
const SectionTitle = createContext('');

/** Marks the rows inside as belonging to the settings area with this title. */
export function AreaTitle({ title, children }: { title: string; children: ReactNode }) {
  return <SectionTitle.Provider value={title}>{children}</SectionTitle.Provider>;
}

export function Row({
  label,
  note,
  children,
  column,
}: {
  label: string;
  note?: ReactNode;
  children?: ReactNode;
  column?: boolean;
}) {
  return (
    <div className={`set-row${column ? ' is-column' : ''}`}>
      <div className="col-text flex-1">
        <span>{label}</span>
        {note && <span className="small muted">{note}</span>}
      </div>
      {children}
    </div>
  );
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  const section = useContext(SectionTitle);
  return (
    <section className="set-group" aria-label={title}>
      {title !== section && <span className="caption-strong">{title}</span>}
      <div className="set-card">{children}</div>
    </section>
  );
}

/** Editable list of patterns as chips. */
export function Chips({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const add = () => {
    if (draft?.trim() && !values.includes(draft.trim())) onChange([...values, draft.trim()]);
  };
  return (
    <div className="chips">
      {values.map((x) => (
        <span key={x} className="chip mono">
          {x}
          <button
            type="button"
            aria-label={$t('Muster {0} entfernen', x)}
            onClick={() => onChange(values.filter((y) => y !== x))}
          >
            <X size={10} strokeWidth={2.4} />
          </button>
        </span>
      ))}
      {draft !== null ? (
        <input
          className="chip-input mono"
          autoFocus
          value={draft}
          aria-label={$t('Neues Muster')}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              add();
              setDraft('');
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(null);
            }
          }}
          onBlur={() => {
            add();
            setDraft(null);
          }}
        />
      ) : (
        <button type="button" className="chip-add" aria-label={$t('Muster hinzufügen')} onClick={() => setDraft('')}>
          <Plus size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
