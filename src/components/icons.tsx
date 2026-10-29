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

const bColors: Record<Exclude<BVariant, 'mono'>, { arrowA: string; arrowB: string; bowlA: string; bowlB: string }> = {
  macApp: { arrowA: '#2A6DE0', arrowB: '#9AD8FF', bowlA: '#FFFFFF', bowlB: '#DCE6F5' },
  winApp: { arrowA: '#4C9BFF', arrowB: '#9FDCFF', bowlA: '#2A6DE0', bowlB: '#1B4FB8' },
  // Interim free-standing mark in light blue with a slight edge (variant "D"), until the reworked logo arrives.
  brand: { arrowA: '#9FD6FF', arrowB: '#DDF2FF', bowlA: '#6FB8FF', bowlB: '#4A9EF2' },
};

/**
 * Bitcrane mark.
 * - macApp: B on a dark graphite tile (Mac app icon, welcome, about).
 * - winApp: B without background (Windows icon, title bar).
 * - mono: single colour, e.g. accent blue in small UI places.
 */
export function BMark({ variant, size, color = 'currentColor' }: { variant: BVariant; size: number; color?: string }) {
  const id = useId().replace(/:/g, '');
  const tile = variant === 'macApp';
  const c = variant === 'mono' ? { arrowA: color, arrowB: color, bowlA: color, bowlB: color } : bColors[variant];
  const vb = tile ? '-7.17 -7.17 114.34 114.34' : '0 0 100 100';
  const tf = tile
    ? 'translate(1.5 3) translate(50 50) scale(0.94) translate(-50 -50)'
    : 'translate(1.5 3) translate(50 50) scale(1.14) translate(-50 -50)';
  return (
    <svg width={size} height={size} viewBox={vb} role="img" aria-label="Bitcrane">
      <defs>
        <linearGradient id={`${id}t`} x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stopColor="#30343D" /><stop offset="1" stopColor="#0D0E12" /></linearGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FFFFFF" stopOpacity="0.22" /><stop offset="0.35" stopColor="#FFFFFF" stopOpacity="0" /></linearGradient>
        <linearGradient id={`${id}a`} gradientUnits="userSpaceOnUse" x1="0" y1="84" x2="0" y2="10"><stop offset="0" stopColor={c.arrowA} /><stop offset="1" stopColor={c.arrowB} /></linearGradient>
        <linearGradient id={`${id}b`} gradientUnits="userSpaceOnUse" x1="0" y1="30" x2="0" y2="84"><stop offset="0" stopColor={c.bowlA} /><stop offset="1" stopColor={c.bowlB} /></linearGradient>
      </defs>
      {tile && (
        <>
          <rect x="4" y="4" width="92" height="92" rx="22" fill={`url(#${id}t)`} />
          <rect x="4.5" y="4.5" width="91" height="91" rx="21.5" fill="none" stroke={`url(#${id}r)`} strokeWidth="1" />
        </>
      )}
      <g transform={tf}>
        {variant === 'brand' && [5, 4, 3, 2, 1].map((i) => (
          <g key={i} transform={`translate(${i * 0.7} ${i * 0.9})`}>
            <path d="M34 33 H54 A11 11 0 0 1 54 55 H34 M34 55 H56.5 A12 12 0 0 1 56.5 79 H34" fill="none" stroke="#1F5FA8" strokeWidth="10.5" strokeLinejoin="round" strokeLinecap="round" />
            <path d="M34 79 V25" stroke="#4E8FCB" strokeWidth="11" strokeLinecap="round" fill="none" />
            <path d="M34 11 L47.5 27 H20.5 Z" fill="#4E8FCB" stroke="#4E8FCB" strokeWidth="3.5" strokeLinejoin="round" />
          </g>
        ))}
        <path d="M34 33 H54 A11 11 0 0 1 54 55 H34 M34 55 H56.5 A12 12 0 0 1 56.5 79 H34" fill="none" stroke={`url(#${id}b)`} strokeWidth="10.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d="M34 79 V25" stroke={`url(#${id}a)`} strokeWidth="11" strokeLinecap="round" fill="none" />
        <path d="M34 11 L47.5 27 H20.5 Z" fill={`url(#${id}a)`} stroke={`url(#${id}a)`} strokeWidth="3.5" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/** Watch symbol: a dot with radio waves (from the mockups). */
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
