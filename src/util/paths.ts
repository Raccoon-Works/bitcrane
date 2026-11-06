/**
 * Path helpers shared by the UI and the mock backend.
 *
 * UI paths always use "/" separators. Local paths below the home folder
 * start with "~"; remote paths are POSIX paths.
 */

/** Splits "~/Projekte/a" or "/home/ubuntu" into segments. */
export function segments(path: string): string[] {
  return path.replace(/^~\/?/, '').split('/').filter(Boolean);
}

/** Joins a parent path and a child name. */
export function join(parent: string, name: string): string {
  if (parent === '/' || parent.endsWith('/')) return parent + name;
  return parent.replace(/\/$/, '') + '/' + name;
}

/** Parent path; the root stays the root. */
export function parent(path: string): string {
  if (path === '~' || path === '/' || /^[A-Za-z]:\/?$/.test(path)) return path;
  const trimmed = path.replace(/\/$/, '');
  const i = trimmed.lastIndexOf('/');
  if (i < 0) return trimmed.startsWith('~') ? '~' : '/';
  if (i === 0) return '/';
  const p = trimmed.slice(0, i);
  // "D:" alone is the drive root "D:/".
  return /^[A-Za-z]:$/.test(p) ? p + '/' : p;
}

/** Last path segment. */
/** True when a local path lies inside a zip or tar archive opened like a folder (archive_vfs.rs). */
export function insideArchive(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(0, -1).some(isArchiveName);
}

/** True when a folder shown in a half is an archive or lies inside one (read-only). */
export function archiveFolder(path: string): boolean {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).some(isArchiveName);
}

/** True for file names Bitcrane opens like a folder. */
export function isArchiveName(name: string): boolean {
  return /\.(zip|tar|tgz|tar\.gz)$/i.test(name);
}

export function basename(path: string): string {
  const s = segments(path);
  return s.length ? s[s.length - 1] : path;
}

/**
 * Breadcrumb parts of a path, e.g. "~/Projekte/a" -> [home, Projekte, a].
 * Handles the home folder ("~"), POSIX roots ("/") and Windows drives ("D:/").
 */
/** Folder of `path` as shown in a transfer list: relative to `root`, or the root's own name. */
export function relFolder(root: string, path: string): string {
  const p = parent(path);
  if (p === root) return basename(root);
  return p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
}

export function crumbs(path: string, homeName: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  let acc: string;
  let rest: string;
  if (path === '~' || path.startsWith('~/')) {
    acc = '~';
    rest = path.slice(1);
    out.push({ name: homeName, path: '~' });
  } else if (/^[A-Za-z]:/.test(path)) {
    acc = path.slice(0, 2) + '/';
    rest = path.slice(2);
    out.push({ name: path.slice(0, 2), path: acc });
  } else {
    acc = '/';
    rest = path;
    // The root only gets its own crumb when it is the current folder.
    if (!path.split('/').some(Boolean)) out.push({ name: '/', path: '/' });
  }
  for (const seg of rest.split('/').filter(Boolean)) {
    acc = join(acc, seg);
    out.push({ name: seg, path: acc });
  }
  return out;
}

/* ------------------------------------------------------------------ Windows names */

/** Characters Windows does not allow in file names (besides control characters). */
const WIN_BAD = new Set(['<', '>', ':', '"', '|', '?', '*', '\\']);
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i;
const pct = (c: string) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');

/**
 * One name from a server made storable on Windows (WinSCP does the same):
 * forbidden characters become %XX ("a:b.txt" → "a%3Ab.txt"), as do a dot or
 * space at the end and the first letter of reserved names ("CON" → "%43ON").
 * `winNameFromSafe` turns it back on upload.
 */
export function winSafeName(name: string): string {
  let out = [...name].map((c) => (WIN_BAD.has(c) || c.charCodeAt(0) < 32 ? pct(c) : c)).join('');
  if (/[. ]$/.test(out)) out = out.slice(0, -1) + pct(out.slice(-1));
  if (WIN_RESERVED.test(out)) out = pct(out[0]) + out.slice(1);
  return out;
}

/** A relative path ("a/b:c") with every part made storable on Windows. */
export function winSafeRel(rel: string): string {
  return rel.split('/').map(winSafeName).join('/');
}

/** Reverses `winSafeName` for exactly what it encodes; any other "%" stays as it is. */
export function winNameFromSafe(name: string): string {
  let out = name.replace(/%([0-9A-F]{2})/g, (m, hex: string) => {
    const c = String.fromCharCode(parseInt(hex, 16));
    return WIN_BAD.has(c) || c.charCodeAt(0) < 32 ? c : m;
  });
  out = out.replace(/%(2E|20)$/, (_m, hex: string) => (hex === '2E' ? '.' : ' '));
  const lead = /^%([0-9A-F]{2})/.exec(out);
  if (lead) {
    const restored = String.fromCharCode(parseInt(lead[1], 16)) + out.slice(3);
    if (WIN_RESERVED.test(restored)) out = restored;
  }
  return out;
}
