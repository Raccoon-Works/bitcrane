import { $t, LANG, LOCALE } from '../i18n';
/**
 * Formatting helpers for sizes, dates and file types (German or English).
 */

/** Formats a byte count like Finder does: "14 KB", "2,4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return $t('{0} Byte', bytes);
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v < 10 && i > 0 ? 1 : 0;
  return `${v.toLocaleString(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${units[i]}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "Heute, 17:04", "Gestern, 21:10" or "12.10.2026". */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (ms >= startToday) return $t('Heute, {0}', time);
  if (ms >= startToday - 86400000) return $t('Gestern, {0}', time);
  if (LANG === 'en') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (LANG === 'de') return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  return d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** "vor 12 Sek.", "vor 3 Min.", "vor 2 Std." or the date. */
export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return $t('gerade eben');
  if (s < 60) return $t('vor {0} Sek.', s);
  const m = Math.round(s / 60);
  if (m < 60) return $t('vor {0} Min.', m);
  const h = Math.round(m / 60);
  if (h < 24) return $t('vor {0} Std.', h);
  return formatDate(ms);
}

/** Clock time "19:29". */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "1,2 MB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatSize(Math.max(1, Math.round(bytesPerSecond)))}/s`;
}

/** Describes a file by its extension, like Finder's "Art" column. */
export function describeFile(name: string, kind: 'dir' | 'file'): string {
  if (kind === 'dir') return $t('Ordner');
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const map: Record<string, string> = {
    py: $t('Python-Skript'), js: 'JavaScript', ts: 'TypeScript', css: $t('Stylesheet'), html: $t('HTML-Seite'), php: $t('PHP-Skript'),
    md: $t('Markdown-Text'), txt: $t('Textdatei'), json: $t('JSON-Daten'), png: $t('PNG-Bild'), jpg: $t('JPEG-Bild'), db: $t('Datenbank'),
    log: $t('Protokoll'), zip: $t('ZIP-Archiv'), msi: $t('Windows-Installer'), env: $t('Umgebungsvariablen'),
  };
  if (name.startsWith('.') && !name.slice(1).includes('.')) return name === '.env' ? $t('Umgebungsvariablen') : $t('Versteckte Datei');
  return map[ext] ?? (ext ? $t('{0}-Datei', ext.toUpperCase()) : $t('Datei'));
}

/** Short extension label for the preview tile, e.g. ".py". */
export function extLabel(name: string): string {
  if (name.startsWith('.') && !name.slice(1).includes('.')) return name;
  return name.includes('.') ? name.slice(name.lastIndexOf('.')) : $t('Datei');
}

/** Converts "644" into "rw-r--r--" (with a leading type char omitted). */
export function permsToText(perms: string): string {
  const map = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
  return perms.split('').map((c) => map[Number(c)] ?? '---').join('');
}

/** Matches a file name against a simple pattern list (".git", "*.log"). */
export function matchesExclude(name: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p.startsWith('*.')) return name.toLowerCase().endsWith(p.slice(1).toLowerCase());
    return name === p;
  });
}

/** Remaining time as "45 Sek.", "3 Min." or "1 Std. 20 Min.". */
export function formatDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return $t('{0} Sek.', s);
  const m = Math.round(s / 60);
  if (m < 60) return $t('{0} Min.', m);
  return $t('{0} Std. {1} Min.', Math.floor(m / 60), m % 60);
}
