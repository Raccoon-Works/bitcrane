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
export function basename(path: string): string {
  const s = segments(path);
  return s.length ? s[s.length - 1] : path;
}

/**
 * Breadcrumb parts of a path, e.g. "~/Projekte/a" -> [home, Projekte, a].
 * Handles the home folder ("~"), POSIX roots ("/") and Windows drives ("D:/").
 */
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
