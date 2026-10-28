/**
 * In-memory file systems for the browser prototype.
 *
 * There is one local file system (the user's computer) and one remote file
 * system per saved server. All functions are synchronous and operate on a
 * simple tree of nodes. The real app replaces this module with Rust commands
 * that talk to the disk and to the SFTP session.
 */
import type { FileEntry } from './types';

interface FileNode {
  kind: 'file';
  size: number;
  mtime: number;
  perms: string;
  owner: string;
  group: string;
}

interface DirNode {
  kind: 'dir';
  mtime: number;
  perms: string;
  owner: string;
  group: string;
  children: Record<string, Node>;
}

type Node = FileNode | DirNode;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Builds an absolute timestamp from an offset relative to "now". */
const ago = (ms: number) => Date.now() - ms;

/** Returns a timestamp for a fixed calendar day this year (month is 1-based). */
const onDay = (day: number, month: number, hour = 10, minute = 0) => {
  const d = new Date();
  d.setMonth(month - 1, day);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};

function file(size: number, mtime: number, perms = '644', owner = 'ubuntu', group = 'ubuntu'): FileNode {
  return { kind: 'file', size, mtime, perms, owner, group };
}

function dir(children: Record<string, Node>, mtime = ago(2 * DAY), perms = '755', owner = 'ubuntu', group = 'ubuntu'): DirNode {
  return { kind: 'dir', mtime, perms, owner, group, children };
}

/** Local owner names look like a Mac user account. */
const lf = (size: number, mtime: number) => file(size, mtime, '644', 'alex', 'staff');
const ld = (children: Record<string, Node>, mtime?: number) => dir(children, mtime, '755', 'alex', 'staff');

/** Creates the sample project that appears both locally and on the server. */
function taskbotLocal(): DirNode {
  return ld({
    cogs: ld({
      'welcome.py': lf(8 * 1024, ago(3 * MIN)),
      'moderation.py': lf(21 * 1024, ago(2 * DAY)),
      'events.py': lf(12 * 1024, ago(5 * DAY)),
    }, ago(1 * MIN)),
    dashboard: ld({
      static: ld({
        'app.css': lf(48 * 1024, ago(2 * MIN)),
        'logo.png': lf(96 * 1024, ago(2 * MIN)),
        'style.css': lf(18 * 1024, ago(3 * DAY)),
      }, ago(2 * MIN)),
      templates: ld({
        'index.html': lf(9 * 1024, ago(4 * DAY)),
        'login.html': lf(4 * 1024, ago(9 * DAY)),
      }),
      'server.py': lf(16 * 1024, ago(6 * DAY)),
    }, ago(2 * MIN)),
    'bot.py': lf(14 * 1024, ago(9 * MIN)),
    'config.py': lf(3 * 1024, ago(1 * DAY + 4 * HOUR)),
    'requirements.txt': lf(1 * 1024, onDay(12, 10)),
    'README.md': lf(6 * 1024, onDay(8, 10)),
    '.env': lf(1 * 1024, onDay(2, 10)),
  }, ago(1 * MIN));
}

function taskbotRemote(): DirNode {
  return dir({
    cogs: dir({
      'welcome.py': file(8 * 1024, ago(3 * MIN)),
      'moderation.py': file(21 * 1024, ago(2 * DAY)),
      'events.py': file(12 * 1024, ago(5 * DAY)),
    }, ago(1 * MIN)),
    dashboard: dir({
      static: dir({
        'app.css': file(47 * 1024, ago(1 * DAY)),
        'style.css': file(18 * 1024, ago(3 * DAY)),
      }, ago(1 * DAY)),
      templates: dir({
        'index.html': file(9 * 1024, ago(4 * DAY)),
        'login.html': file(4 * 1024, ago(9 * DAY)),
      }),
      'server.py': file(16 * 1024, ago(6 * DAY)),
    }, ago(55 * MIN)),
    logs: dir({
      'bot.log': file(412 * 1024, ago(1 * MIN)),
      'error.log': file(18 * 1024, ago(2 * HOUR)),
    }, ago(1 * MIN)),
    'bot.py': file(14 * 1024, ago(9 * MIN)),
    'config.py': file(3 * 1024, ago(1 * DAY + 4 * HOUR)),
    'data.db': file(Math.round(2.4 * 1024 * 1024), ago(1 * MIN)),
    '.env': file(1 * 1024, onDay(2, 10), '600'),
  }, ago(1 * MIN));
}

function newsbot(local: boolean): DirNode {
  const f = local ? lf : file;
  const d = local ? ld : dir;
  return d({
    'main.py': f(11 * 1024, ago(3 * DAY)),
    'scanner.py': f(27 * 1024, ago(3 * DAY)),
    'requirements.txt': f(1024, ago(20 * DAY)),
  }, ago(3 * DAY));
}

/** Local file system of the user's computer. Home is "~". */
let localRoot: DirNode = createLocal();

function createLocal(): DirNode {
  return ld({
    Projekte: ld({
      taskbot: ld({ live: taskbotLocal() }),
      newsbot: newsbot(true),
      'community-web': ld({
        'index.php': lf(5 * 1024, ago(7 * DAY)),
        'style.css': lf(22 * 1024, ago(7 * DAY)),
      }),
    }),
    Schreibtisch: ld({
      'Notizen.txt': lf(2 * 1024, ago(1 * DAY)),
      'Screenshot.png': lf(820 * 1024, ago(3 * HOUR)),
    }),
    Downloads: ld({
      'export-2026-10.zip': lf(172 * 1024 * 1024, ago(5 * DAY)),
      'putty-0.82.msi': lf(3 * 1024 * 1024, ago(30 * DAY)),
    }),
    Dokumente: ld({}),
  });
}

/** Remote file systems, keyed by server id. */
const remoteRoots: Record<string, DirNode> = {};

function createRemote(serverId: string): DirNode {
  switch (serverId) {
    case 'ob':
      return dir({
        home: dir({
          ubuntu: dir({
            bots: dir({ taskbot: taskbotRemote(), newsbot: newsbot(false) }),
            backups: dir({ 'export-2026-10.zip': file(172 * 1024 * 1024, ago(5 * DAY)) }),
            '.bashrc': file(3 * 1024, ago(90 * DAY)),
          }),
        }),
      });
    case 'cw':
      return dir({
        var: dir({
          www: dir({
            community: dir({
              wcf: dir({ templates: dir({ 'index.php': file(5 * 1024, ago(7 * DAY)) }) }),
              'index.php': file(5 * 1024, ago(7 * DAY), '644', 'www-data', 'www-data'),
              'style.css': file(21 * 1024, ago(9 * DAY), '644', 'www-data', 'www-data'),
            }, ago(7 * DAY), '755', 'www-data', 'www-data'),
          }),
        }),
      });
    case 'nas':
      return dir({ volume1: dir({ backups: dir({ 'export-2026-09.zip': file(160 * 1024 * 1024, ago(35 * DAY)) }) }) });
    default:
      return dir({ home: dir({ test: dir({ 'hallo.txt': file(120, ago(1 * DAY)) }) }) });
  }
}

function rootFor(side: 'local' | 'remote', serverId: string): DirNode {
  if (side === 'local') return localRoot;
  if (!remoteRoots[serverId]) remoteRoots[serverId] = createRemote(serverId);
  return remoteRoots[serverId];
}

/** Splits a path like "~/Projekte/a" or "/home/ubuntu" into segments. */
export function segments(path: string): string[] {
  return path.replace(/^~\/?/, '').split('/').filter(Boolean);
}

/** Joins a parent path and a child name. */
export function join(parent: string, name: string): string {
  if (parent === '/') return '/' + name;
  return parent.replace(/\/$/, '') + '/' + name;
}

/** Returns the parent path, or the same path when already at the root. */
export function parent(path: string): string {
  if (path === '~' || path === '/') return path;
  const i = path.lastIndexOf('/');
  if (i <= 0) return path.startsWith('~') ? '~' : '/';
  return path.slice(0, i);
}

/** Returns the last path segment. */
export function basename(path: string): string {
  const s = segments(path);
  return s.length ? s[s.length - 1] : path;
}

function find(side: 'local' | 'remote', serverId: string, path: string): Node | undefined {
  let node: Node = rootFor(side, serverId);
  for (const seg of segments(path)) {
    if (node.kind !== 'dir') return undefined;
    node = node.children[seg];
    if (!node) return undefined;
  }
  return node;
}

function findDir(side: 'local' | 'remote', serverId: string, path: string): DirNode | undefined {
  const n = find(side, serverId, path);
  return n && n.kind === 'dir' ? n : undefined;
}

function toEntry(name: string, n: Node): FileEntry {
  return {
    name,
    kind: n.kind,
    size: n.kind === 'file' ? n.size : 0,
    mtime: n.mtime,
    perms: n.perms,
    owner: n.owner,
    group: n.group,
  };
}

/** Lists a directory. Folders come first, then files, both alphabetically. */
export function list(side: 'local' | 'remote', serverId: string, path: string): FileEntry[] {
  const d = findDir(side, serverId, path);
  if (!d) return [];
  return Object.entries(d.children)
    .map(([name, n]) => toEntry(name, n))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1));
}

export function stat(side: 'local' | 'remote', serverId: string, path: string): FileEntry | undefined {
  const n = find(side, serverId, path);
  return n ? toEntry(basename(path), n) : undefined;
}

export function isDir(side: 'local' | 'remote', serverId: string, path: string): boolean {
  return !!findDir(side, serverId, path);
}

/** Counts all files below a path (used for folder uploads). */
export function walkFiles(side: 'local' | 'remote', serverId: string, path: string): Array<{ path: string; entry: FileEntry }> {
  const n = find(side, serverId, path);
  if (!n) return [];
  if (n.kind === 'file') return [{ path, entry: toEntry(basename(path), n) }];
  const out: Array<{ path: string; entry: FileEntry }> = [];
  for (const name of Object.keys(n.children)) {
    out.push(...walkFiles(side, serverId, join(path, name)));
  }
  return out;
}

function ensureDir(side: 'local' | 'remote', serverId: string, path: string, owner: string): DirNode {
  let node = rootFor(side, serverId);
  for (const seg of segments(path)) {
    let next = node.children[seg];
    if (!next || next.kind !== 'dir') {
      next = dir({}, Date.now(), '755', owner, owner === 'alex' ? 'staff' : owner);
      node.children[seg] = next;
    }
    node = next;
  }
  return node;
}

/** Writes or replaces a file. Creates missing parent folders. */
export function writeFile(side: 'local' | 'remote', serverId: string, path: string, size: number, mtime = Date.now()) {
  const owner = side === 'local' ? 'alex' : 'ubuntu';
  const d = ensureDir(side, serverId, parent(path), owner);
  const existing = d.children[basename(path)];
  const perms = existing && existing.kind === 'file' ? existing.perms : '644';
  d.children[basename(path)] = { kind: 'file', size, mtime, perms, owner, group: side === 'local' ? 'staff' : owner };
  d.mtime = mtime;
}

export function makeDir(side: 'local' | 'remote', serverId: string, path: string) {
  ensureDir(side, serverId, path, side === 'local' ? 'alex' : 'ubuntu');
}

export function remove(side: 'local' | 'remote', serverId: string, path: string) {
  const d = findDir(side, serverId, parent(path));
  if (d) delete d.children[basename(path)];
}

export function rename(side: 'local' | 'remote', serverId: string, path: string, newName: string): boolean {
  const d = findDir(side, serverId, parent(path));
  if (!d || !d.children[basename(path)] || d.children[newName]) return false;
  d.children[newName] = d.children[basename(path)];
  delete d.children[basename(path)];
  return true;
}

export function chmod(side: 'local' | 'remote', serverId: string, path: string, perms: string, owner?: string, group?: string, recursive = false) {
  const n = find(side, serverId, path);
  if (!n) return;
  const apply = (node: Node) => {
    // Files never get the execute bit when applied recursively from a folder.
    node.perms = node.kind === 'file' && recursive ? perms.replace(/[1357]/g, (c) => String(Number(c) - 1)) : perms;
    if (owner) node.owner = owner;
    if (group) node.group = group;
    if (recursive && node.kind === 'dir') Object.values(node.children).forEach(apply);
  };
  n.perms = perms;
  if (owner) n.owner = owner;
  if (group) n.group = group;
  if (recursive && n.kind === 'dir') Object.values(n.children).forEach(apply);
}

/** Simulates the user saving a file: new size and modification time. */
export function touch(side: 'local' | 'remote', serverId: string, path: string, grow = 0) {
  const n = find(side, serverId, path);
  if (n && n.kind === 'file') {
    n.mtime = Date.now();
    n.size = Math.max(64, n.size + grow);
  }
}

/** Resets all file systems to the initial sample data. */
export function resetAll() {
  localRoot = createLocal();
  for (const k of Object.keys(remoteRoots)) delete remoteRoots[k];
}
