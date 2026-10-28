/**
 * Tile picture of a file in the icons view: a preview picture for local
 * images (served by the app's "thumb" URI scheme, see local::thumb in Rust),
 * otherwise the type symbol. Images on a server keep their symbol; loading
 * them would mean downloading every file.
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { useState } from 'react';
import type { PaneSide } from '../backend/types';
import { LIVE } from '../state/store';
import { FileGlyph } from './icons';

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i;

export function Thumb({ side, path, name, size }: { side: PaneSide; path: string; name: string; size: number }) {
  const [failed, setFailed] = useState(false);
  if (!LIVE || side !== 'local' || failed || !IMAGE.test(name)) return <FileGlyph size={size} name={name} />;
  return (
    <img
      className="tile-thumb"
      src={convertFileSrc(path, 'thumb')}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
