/**
 * Tile picture of a file in the icons view: a preview picture for images,
 * otherwise the type symbol. Local images are served by the app's "thumb"
 * URI scheme; images on a server by "rthumb", only when the user turned that
 * on, because each picture means reading the file from the server (see
 * thumbs.rs in the Rust core).
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { useState } from 'react';
import type { PaneSide } from '../backend/types';
import { LIVE, useStore } from '../state/store';
import { FileGlyph } from './icons';

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i;
/** Same limit as REMOTE_MAX_BYTES in thumbs.rs; larger files are not even asked for. */
const REMOTE_MAX_BYTES = 10 * 1024 * 1024;

type Props = {
  side: PaneSide;
  serverId: string;
  path: string;
  name: string;
  /** File size and modification time; a changed image gets a new picture. */
  bytes: number;
  mtime: number;
  size: number;
};

export function Thumb({ side, serverId, path, name, bytes, mtime, size }: Props) {
  const [failed, setFailed] = useState(false);
  const remoteThumbs = useStore((s) => !!s.settings.remoteThumbs);
  const src = !LIVE || failed || !IMAGE.test(name) ? null
    : side === 'local' ? convertFileSrc(path, 'thumb')
      : remoteThumbs && bytes <= REMOTE_MAX_BYTES ? `${convertFileSrc(`${serverId}/${path}`, 'rthumb')}?m=${mtime}`
        : null;
  if (!src) return <FileGlyph size={size} name={name} />;
  return (
    <img
      className="tile-thumb"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
