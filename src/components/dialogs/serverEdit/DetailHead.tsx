/**
 * Top of the server editor's detail side: the server's picture (a click
 * chooses an own one), its name and its colour.
 */
import type { Server, ServerColor } from '../../../backend/types';
import { showToast } from '../../../state/store';
import { ServerTile } from '../../ServerTile';
import { swatch } from '../../serverColors';
import { TextField } from '../../ui';
import { $t } from '../../../i18n';
import type { SetField } from './model';

const colors: ServerColor[] = ['gray', 'blue', 'purple', 'green', 'yellow', 'orange', 'red'];

/** Names of the server colours for screen readers and tooltips. */
const COLOR_NAMES: Record<ServerColor, string> = {
  gray: $t('Keine Farbe'),
  blue: $t('Blau'),
  purple: $t('Lila'),
  green: $t('Grün'),
  yellow: $t('Gelb'),
  orange: $t('Orange'),
  red: $t('Rot'),
};

/** Reads an image file and shrinks it to a 64 px square PNG (centred, transparent edges). */
function pictureFromFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = 64;
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas'));
        return;
      }
      const scale = Math.min(side / img.width, side / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (side - w) / 2, (side - h) / 2, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image'));
    };
    img.src = url;
  });
}

export function DetailHead({ draft, set }: { draft: Server; set: SetField }) {
  return (
    <div className="detail-head">
      {/* Own picture (Transmit): click the symbol to choose one; it is shrunk to 64 px and kept in the settings. */}
      <label className="server-picture" title={$t('Eigenes Bild wählen')}>
        <ServerTile
          mono={draft.mono || (draft.name || draft.host || '?').slice(0, 2).toUpperCase()}
          color={draft.color}
          image={draft.image}
          protocol={draft.protocol}
          size={48}
        />
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          className="vh"
          aria-label={$t('Eigenes Bild wählen')}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f)
              void pictureFromFile(f)
                .then((url) => set('image', url))
                .catch(() => showToast($t('Das Bild ließ sich nicht lesen.'), 'error'));
          }}
        />
      </label>
      <div className="detail-head-fields">
        <TextField
          value={draft.name}
          onChange={(v) => set('name', v)}
          placeholder={$t('Name, z. B. Webshop · Live')}
          className="name-field"
        />
        <div className="swatches" role="radiogroup" aria-label={$t('Farbe')}>
          <span
            className="small muted"
            title={$t('Die Farbe erscheint im Tab und über der Serverhälfte, z. B. Rot für den Produktivserver.')}
          >
            {$t('Farbe')}
          </span>
          {colors.map((c) => (
            // "gray" means no colour: shown as an empty ring and listed first.
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={draft.color === c}
              aria-label={COLOR_NAMES[c]}
              title={COLOR_NAMES[c]}
              className={`swatch${c === 'gray' ? ' is-none' : ''}${draft.color === c ? ' is-on' : ''}`}
              style={c === 'gray' ? undefined : { background: swatch[c] }}
              onClick={() => set('color', c)}
            />
          ))}
          {draft.image ? (
            <button type="button" className="link small" onClick={() => set('image', undefined)}>
              {$t('Bild entfernen')}
            </button>
          ) : (
            <span className="small muted">{$t('Klick aufs Symbol: eigenes Bild')}</span>
          )}
        </div>
      </div>
    </div>
  );
}
