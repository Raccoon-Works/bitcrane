/**
 * Kinds of files by extension: the symbol and colour tone the file lists show
 * for each.
 */
import {
  FileAudio,
  FileC,
  FileCode,
  FileCpp,
  FileCSharp,
  FileCss,
  FileCsv,
  FileDoc,
  FileHtml,
  FileImage,
  FileIni,
  FileJs,
  FileJsx,
  FileLock,
  FileMd,
  FilePdf,
  FilePpt,
  FilePy,
  FileRs,
  FileSql,
  FileTs,
  FileTsx,
  FileTxt,
  FileVideo,
  FileVue,
  FileXls,
  FileZip,
  type Icon,
} from '@phosphor-icons/react';

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
