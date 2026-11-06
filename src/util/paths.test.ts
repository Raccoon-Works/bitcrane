import { describe, expect, it } from 'vitest';
import {
  archiveFolder,
  basename,
  crumbs,
  insideArchive,
  isArchiveName,
  join,
  parent,
  relFolder,
  segments,
  winNameFromSafe,
  winSafeRel,
} from './paths';

describe('segments', () => {
  it('drops the home marker and empty parts', () => {
    expect(segments('~/Projekte/a')).toEqual(['Projekte', 'a']);
    expect(segments('/home/deploy/')).toEqual(['home', 'deploy']);
    expect(segments('~')).toEqual([]);
    expect(segments('/')).toEqual([]);
  });
});

describe('join', () => {
  it('adds exactly one separator', () => {
    expect(join('/', 'etc')).toBe('/etc');
    expect(join('~', 'a')).toBe('~/a');
    expect(join('~/a/', 'b')).toBe('~/a/b');
    expect(join('/srv/www', 'index.html')).toBe('/srv/www/index.html');
  });

  it('keeps Windows drive roots', () => {
    expect(join('D:/', 'Daten')).toBe('D:/Daten');
    expect(join('D:/Daten', 'a.txt')).toBe('D:/Daten/a.txt');
  });
});

describe('parent', () => {
  it('keeps roots as they are', () => {
    expect(parent('~')).toBe('~');
    expect(parent('/')).toBe('/');
    expect(parent('D:/')).toBe('D:/');
    expect(parent('D:')).toBe('D:');
  });

  it('goes up one level', () => {
    expect(parent('~/a')).toBe('~');
    expect(parent('~/a/b')).toBe('~/a');
    expect(parent('/etc')).toBe('/');
    expect(parent('/etc/nginx/sites')).toBe('/etc/nginx');
  });

  it('ignores a trailing separator', () => {
    expect(parent('/etc/nginx/')).toBe('/etc');
    expect(parent('~/a/')).toBe('~');
  });

  it('returns the drive root for a folder directly on a drive', () => {
    expect(parent('D:/Daten')).toBe('D:/');
    expect(parent('D:/Daten/x')).toBe('D:/Daten');
  });

  it('treats a bare name as lying in the root', () => {
    expect(parent('name')).toBe('/');
  });
});

describe('basename', () => {
  it('returns the last segment', () => {
    expect(basename('~/Projekte/a')).toBe('a');
    expect(basename('/etc/nginx/')).toBe('nginx');
    expect(basename('D:/Daten/bericht.txt')).toBe('bericht.txt');
  });

  it('returns roots unchanged', () => {
    expect(basename('~')).toBe('~');
    expect(basename('/')).toBe('/');
  });
});

describe('relFolder', () => {
  it('names the root itself for files directly in it', () => {
    expect(relFolder('/srv/www', '/srv/www/a.txt')).toBe('www');
  });

  it('is relative to the root below it', () => {
    expect(relFolder('/srv/www', '/srv/www/css/a.css')).toBe('css');
    expect(relFolder('/srv/www', '/srv/www/css/img/a.png')).toBe('css/img');
  });

  it('keeps the full folder outside the root', () => {
    expect(relFolder('/srv/www', '/srv/wwwold/a.txt')).toBe('/srv/wwwold');
  });
});

describe('crumbs', () => {
  it('starts at the home folder', () => {
    expect(crumbs('~/Projekte/a', 'Home')).toEqual([
      { name: 'Home', path: '~' },
      { name: 'Projekte', path: '~/Projekte' },
      { name: 'a', path: '~/Projekte/a' },
    ]);
  });

  it('shows the POSIX root only when it is the current folder', () => {
    expect(crumbs('/', 'Home')).toEqual([{ name: '/', path: '/' }]);
    expect(crumbs('/etc/nginx', 'Home')).toEqual([
      { name: 'etc', path: '/etc' },
      { name: 'nginx', path: '/etc/nginx' },
    ]);
  });

  it('starts at the drive for Windows paths', () => {
    expect(crumbs('D:/Daten/x', 'Home')).toEqual([
      { name: 'D:', path: 'D:/' },
      { name: 'Daten', path: 'D:/Daten' },
      { name: 'x', path: 'D:/Daten/x' },
    ]);
  });
});

describe('archives', () => {
  it('recognises archive names regardless of case', () => {
    expect(isArchiveName('site.zip')).toBe(true);
    expect(isArchiveName('backup.TGZ')).toBe(true);
    expect(isArchiveName('backup.tar.gz')).toBe(true);
    expect(isArchiveName('notes.gz')).toBe(false);
  });

  it('tells paths inside an archive from the archive itself', () => {
    expect(insideArchive('~/a/site.zip/index.html')).toBe(true);
    expect(insideArchive('~/a/site.zip')).toBe(false);
    expect(insideArchive('C:\\Daten\\backup.tar\\x.txt')).toBe(true);
    expect(archiveFolder('~/a/site.zip')).toBe(true);
    expect(archiveFolder('~/a/site.zip/css')).toBe(true);
    expect(archiveFolder('~/a/site')).toBe(false);
  });
});

describe('Windows-safe names', () => {
  it('encodes characters Windows forbids', () => {
    expect(winSafeRel('a:b.txt')).toBe('a%3Ab.txt');
    expect(winSafeRel('dir/what?.txt')).toBe('dir/what%3F.txt');
    expect(winSafeRel('tab\tname')).toBe('tab%09name');
  });

  it('encodes a trailing dot or space', () => {
    expect(winSafeRel('name.')).toBe('name%2E');
    expect(winSafeRel('name ')).toBe('name%20');
  });

  it('encodes the first letter of reserved names', () => {
    expect(winSafeRel('CON')).toBe('%43ON');
    expect(winSafeRel('con.txt')).toBe('%63on.txt');
    expect(winSafeRel('lpt1')).toBe('%6Cpt1');
    expect(winSafeRel('console.txt')).toBe('console.txt');
  });

  it('leaves other percent signs alone in both directions', () => {
    expect(winSafeRel('100%41')).toBe('100%41');
    expect(winNameFromSafe('100%41')).toBe('100%41');
    expect(winNameFromSafe('%41BC')).toBe('%41BC');
    expect(winNameFromSafe('a%2Eb')).toBe('a%2Eb');
  });

  it('round-trips the names it encodes', () => {
    for (const name of ['a:b', 'q?*<>|"', 'CON', 'con.txt', 'lpt1.log', 'x.', 'a b ', 'back\\slash', 'plain.txt']) {
      expect(winNameFromSafe(winSafeRel(name))).toBe(name);
    }
  });
});
