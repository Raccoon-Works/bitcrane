/**
 * Icons drawn for Bitcrane (not from Phosphor): the Bitcrane logo ("B with arrow stem"),
 * the watch symbol and the file/folder glyphs used in file lists.
 *
 * Logo geometry and colours follow PROJEKT-LOGO.md ("VERBINDLICHE LOGO-ANWEISUNG").
 */
import { useId, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { LIVE, useStore } from '../state/store';
import {
  FileAudio, FileC, FileCode, FileCpp, FileCSharp, FileCss, FileCsv, FileDoc, FileHtml, FileImage, FileIni, FileJs, FileJsx, FileLock, FileMd,
  FilePdf, FilePpt, FilePy, FileRs, FileSql, FileTs, FileTsx, FileTxt, FileVideo, FileVue, FileXls, FileZip, type Icon,
} from '@phosphor-icons/react';

type BVariant = 'macApp' | 'winApp' | 'mono' | 'brand';

const BOWL = 'M34 33 H54 A11 11 0 0 1 54 55 H34 M34 55 H56.5 A12 12 0 0 1 56.5 79 H34';
/** Steps of the side edge (relief), towards the lower left as in the logo files. */
const EDGE = Array.from({ length: 14 }, (_, i) => 14 - i).map((k) => [-0.114 * k, 0.371 * k] as const);

/**
 * Bitcrane mark ("relief" logo, Projekt/PROJEKT-LOGO.md and Logos/bitcrane-relief-*):
 * a light blue B whose stem is an upload arrow, with a darker side edge.
 * - macApp: on the near-black app tile (Mac app symbol, welcome).
 * - winApp / brand: free-standing (Windows, title bar, settings).
 * - mono: single colour, e.g. accent blue in small UI places.
 * Below 32 px the edge is left out (flat version), as in the small icon files.
 * On a light background the arrow gets a thin darker rim so it stays visible.
 */
export function BMark({ variant, size, color = 'currentColor' }: { variant: BVariant; size: number; color?: string }) {
  const id = useId().replace(/:/g, '');
  const light = useStore((s) => s.theme === 'light');
  const tile = variant === 'macApp';
  const mono = variant === 'mono';
  const relief = !mono && size >= 32;
  const rim = !mono && !tile && light;
  const vb = tile ? '-7.17 -7.17 114.34 114.34' : '0 0 100 100';
  // The tile version is moved so the mark sits optically in the middle of the tile.
  const tf = tile ? 'translate(48.50 51.00) scale(0.84) translate(-44.5 -48)' : 'translate(50 50) scale(1.12) translate(-44.5 -48)';
  const fill = (k: string) => (mono ? color : `url(#${id}${k})`);
  const shape = (bowl: string, arrow: string, key?: string | number, t?: string, withRim = false) => (
    <g key={key} transform={t}>
      <path d={BOWL} fill="none" stroke={bowl} strokeWidth="10.5" strokeLinejoin="round" strokeLinecap="round" />
      {withRim && (
        <>
          <path d="M34 79 V25" stroke="#4E8FCB" strokeWidth="13.4" strokeLinecap="round" fill="none" />
          <path d="M34 11 L47.5 27 H20.5 Z" fill="#4E8FCB" stroke="#4E8FCB" strokeWidth="5.9" strokeLinejoin="round" />
        </>
      )}
      <path d="M34 79 V25" stroke={arrow} strokeWidth="11" strokeLinecap="round" fill="none" />
      <path d="M34 11 L47.5 27 H20.5 Z" fill={arrow} stroke={arrow} strokeWidth="3.5" strokeLinejoin="round" />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox={vb} role="img" aria-label="Bitcrane">
      <defs>
        <linearGradient id={`${id}b`} gradientUnits="userSpaceOnUse" x1="0" y1="30" x2="0" y2="84"><stop offset="0" stopColor="#6FB8FF" /><stop offset="1" stopColor="#4A9EF2" /></linearGradient>
        <linearGradient id={`${id}a`} gradientUnits="userSpaceOnUse" x1="0" y1="84" x2="0" y2="10"><stop offset="0" stopColor="#9FD6FF" /><stop offset="1" stopColor="#DDF2FF" /></linearGradient>
        <linearGradient id={`${id}sb`} gradientUnits="userSpaceOnUse" x1="0" y1="30" x2="0" y2="88"><stop offset="0" stopColor="#2A6DBA" /><stop offset="1" stopColor="#1F5FA8" /></linearGradient>
        <linearGradient id={`${id}sa`} gradientUnits="userSpaceOnUse" x1="0" y1="10" x2="0" y2="88"><stop offset="0" stopColor="#5E9DD6" /><stop offset="1" stopColor="#4E8FCB" /></linearGradient>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1C1C1E" /><stop offset="1" stopColor="#0D0D0D" /></linearGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FFFFFF" stopOpacity="0.16" /><stop offset="0.35" stopColor="#FFFFFF" stopOpacity="0" /></linearGradient>
      </defs>
      {tile && (
        <>
          <rect x="4" y="4" width="92" height="92" rx="20.6" fill={`url(#${id}t)`} />
          <rect x="4.3" y="4.3" width="91.4" height="91.4" rx="20.3" fill="none" stroke={`url(#${id}r)`} strokeWidth="0.6" />
        </>
      )}
      <g transform={tf}>
        <g transform={relief ? 'translate(0.80 -2.60)' : undefined}>
          {relief && EDGE.map(([x, y], i) => shape(fill('sb'), fill('sa'), i, `translate(${x.toFixed(3)} ${y.toFixed(3)})`))}
          {shape(fill('b'), fill('a'), undefined, undefined, rim)}
        </g>
      </g>
    </svg>
  );
}

export function WatchIcon({ size = 16, waves = 1, strokeWidth = 1.5 }: { size?: number; waves?: 1 | 2; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <path d="M5 5a4.2 4.2 0 0 0 0 6M11 5a4.2 4.2 0 0 1 0 6" />
      {waves === 2 && <path d="M2.8 2.8a7.3 7.3 0 0 0 0 10.4M13.2 2.8a7.3 7.3 0 0 1 0 10.4" />}
    </svg>
  );
}

/** Filled folder glyph in the platform folder colour. */
export function FolderGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="glyph-folder">
      <path d="M1.75 4.5h4.5l1.5 1.5h6.5v7h-12.5z" />
    </svg>
  );
}

/** Document glyph. */
/** Symbol and colour per kind of file (by extension), shown in the file lists. */
type TypeIcon = { Icon: Icon; tone: string };
const TYPE_ICONS: Array<[RegExp, TypeIcon]> = [
  [/^(png|jpe?g|gif|webp|bmp|heic|heif|tiff?|avif|ico|svg|raw|cr2|nef|psd)$/, { Icon: FileImage, tone: 'image' }],
  [/^pdf$/, { Icon: FilePdf, tone: 'pdf' }],
  [/^(docx?|odt|rtf|pages)$/, { Icon: FileDoc, tone: 'doc' }],
  [/^(xlsx?|ods|numbers)$/, { Icon: FileXls, tone: 'sheet' }],
  [/^(csv|tsv)$/, { Icon: FileCsv, tone: 'sheet' }],
  [/^(pptx?|odp|key)$/, { Icon: FilePpt, tone: 'slides' }],
  [/^(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|dmg|iso)$/, { Icon: FileZip, tone: 'archive' }],
  [/^(mp3|wav|flac|m4a|aac|ogg|opus|wma)$/, { Icon: FileAudio, tone: 'audio' }],
  [/^(mp4|mov|mkv|avi|webm|wmv|m4v|mpe?g)$/, { Icon: FileVideo, tone: 'video' }],
  [/^py$/, { Icon: FilePy, tone: 'code' }],
  [/^(js|mjs|cjs)$/, { Icon: FileJs, tone: 'code' }],
  [/^ts$/, { Icon: FileTs, tone: 'code' }],
  [/^tsx$/, { Icon: FileTsx, tone: 'code' }],
  [/^jsx$/, { Icon: FileJsx, tone: 'code' }],
  [/^html?$/, { Icon: FileHtml, tone: 'code' }],
  [/^(css|scss|sass|less)$/, { Icon: FileCss, tone: 'code' }],
  [/^sql$/, { Icon: FileSql, tone: 'code' }],
  [/^rs$/, { Icon: FileRs, tone: 'code' }],
  [/^(c|h)$/, { Icon: FileC, tone: 'code' }],
  [/^(cpp|cc|hpp)$/, { Icon: FileCpp, tone: 'code' }],
  [/^cs$/, { Icon: FileCSharp, tone: 'code' }],
  [/^vue$/, { Icon: FileVue, tone: 'code' }],
  [/^(json|ya?ml|toml|xml|php|sh|bat|ps1|rb|go|java|kt|swift|lua|pl)$/, { Icon: FileCode, tone: 'code' }],
  [/^(md|markdown)$/, { Icon: FileMd, tone: 'text' }],
  [/^(txt|log|nfo)$/, { Icon: FileTxt, tone: 'text' }],
  [/^(ini|conf|cfg|env|properties)$/, { Icon: FileIni, tone: 'text' }],
  [/^(lock|pem|key|crt|pub)$/, { Icon: FileLock, tone: 'text' }],
];

/** Type symbol for a file name, or undefined for an unknown kind (plain sheet). */
export function typeIconFor(name: string): TypeIcon | undefined {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
  // ".env", ".htaccess": treat the name after the dot as the kind.
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return TYPE_ICONS.find(([re]) => re.test(ext))?.[1];
}

/**
 * File symbol. With a name it shows the kind of file (image, PDF, code …)
 * in its own colour, like the Explorer and Finder do; unknown kinds keep the
 * plain sheet.
 */
export function FileGlyph({ size = 16, name }: { size?: number; name?: string }) {
  // Setting "Dateisymbole des Systems": the Explorer/Finder symbol for the extension (app only).
  const systemIcons = useStore((s) => !!s.settings.systemIcons) && LIVE;
  const [failed, setFailed] = useState(false);
  const base = name ? name.slice(name.lastIndexOf('/') + 1) : '';
  const ext = base.lastIndexOf('.') > 0 ? base.slice(base.lastIndexOf('.') + 1) : '';
  if (systemIcons && ext && !failed) {
    return <img className="glyph-system" src={convertFileSrc(ext.toLowerCase(), 'fileicon')} width={size} height={size} alt="" aria-hidden="true" draggable={false} onError={() => setFailed(true)} />;
  }
  const t = name ? typeIconFor(name) : undefined;
  if (t) return <t.Icon size={size} weight="duotone" className={`glyph-type tone-file-${t.tone}`} aria-hidden="true" />;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="glyph-file">
      <path d="M3.5 1.5h6l3 3v10h-9z" />
    </svg>
  );
}
