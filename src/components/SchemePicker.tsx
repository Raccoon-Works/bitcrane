/**
 * Colour schemes of the terminal as small previews (like Tabby): each card
 * shows a prompt, a listing and the 16 colours in the scheme's own colours.
 */
import { useState } from 'react';
import type { ITheme } from '@xterm/xterm';
import { $t } from '../i18n';
import { SCHEMES } from '../state/terminal';
import { getState, useStore } from '../state/store';

function Preview({ theme }: { theme: ITheme }) {
  const c = (k: keyof ITheme, fallback = theme.foreground) => (theme[k] as string | undefined) ?? fallback;
  return (
    <span className="scheme-preview mono" style={{ background: theme.background, color: theme.foreground }} aria-hidden="true">
      <span><span style={{ color: c('green') }}>ubuntu@bot</span>:<span style={{ color: c('blue') }}>~</span>$ ls</span>
      <span><span style={{ color: c('blue') }}>logs</span> <span style={{ color: c('green') }}>start.sh</span> <span style={{ color: c('red') }}>dump.zip</span></span>
      <span><span style={{ color: c('yellow') }}>warn</span> <span style={{ color: c('magenta') }}>pm2</span> <span style={{ color: c('cyan') }}>online</span><span className="scheme-cursor" style={{ background: c('cursor') }} /></span>
    </span>
  );
}

export function SchemePicker({ value, onChange, allowAuto = true }: { value: string; onChange: (id: string) => void; allowAuto?: boolean }) {
  useStore((s) => s.theme);
  const autoId = getState().theme === 'light' ? 'bitcrane-light' : 'bitcrane-dark';
  const auto = SCHEMES.find((x) => x.id === autoId) ?? SCHEMES[0];
  const cards = [...(allowAuto ? [{ id: 'auto', name: $t('Automatisch'), theme: auto.theme, note: $t('folgt hell/dunkel') }] : []), ...SCHEMES.map((x) => ({ ...x, name: $t(x.name), note: '' }))];
  // Collapsed: the first row or two and the chosen one; everything on request (no scroll inside the page).
  const [all, setAll] = useState(false);
  const FEW = 8;
  const shown = all ? cards : cards.filter((x, i) => i < FEW || x.id === value);
  return (
    <>
    <div className="scheme-grid" role="radiogroup" aria-label={$t('Farbschema')}>
      {shown.map((x) => (
        <button key={x.id} type="button" role="radio" aria-checked={value === x.id} className={`scheme-card${value === x.id ? ' is-sel' : ''}`} onClick={() => onChange(x.id)}>
          <Preview theme={x.theme} />
          <span className="scheme-name ellipsis">{x.name}{x.note && <span className="small muted"> · {x.note}</span>}</span>
        </button>
      ))}
    </div>
    {cards.length > FEW && (
      <button type="button" className="scheme-more" onClick={() => setAll(!all)}>
        {all ? $t('Weniger zeigen') : $t('Alle {0} Farbschemata zeigen', String(cards.length))}
      </button>
    )}
    </>
  );
}
