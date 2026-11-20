import { describe, expect, it } from 'vitest';
import { isOwnDownload, noteDownloaded } from './ownDownloads';

describe('own downloads', () => {
  it('recognises a downloaded file once, while it is unchanged', () => {
    noteDownloaded('~/site/a.txt', { size: 5, mtime: 1000 });
    expect(isOwnDownload('~/site/a.txt', { size: 5, mtime: 1000 })).toBe(true);
    // The note is used up: a later change of the same file is the user's.
    expect(isOwnDownload('~/site/a.txt', { size: 5, mtime: 1000 })).toBe(false);
  });

  it('lets a file changed after the download through', () => {
    noteDownloaded('~/site/b.txt', { size: 5, mtime: 1000 });
    expect(isOwnDownload('~/site/b.txt', { size: 6, mtime: 2000 })).toBe(false);
  });

  it('knows nothing of files it did not download', () => {
    expect(isOwnDownload('~/site/c.txt', { size: 5, mtime: 1000 })).toBe(false);
  });
});
