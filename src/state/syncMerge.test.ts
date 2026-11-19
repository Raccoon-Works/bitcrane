import { describe, expect, it } from 'vitest';
import type { Server } from '../backend/types';
import { hashServer, heldForReview, mergeServers, pick, profileChanges } from './syncMerge';

const srv = (id: string, patch: Partial<Server> = {}): Server => ({
  id,
  name: id,
  mono: 'XX',
  color: 'blue',
  host: `${id}.example`,
  port: 22,
  user: 'anna',
  auth: 'password',
  keyPath: '',
  group: '',
  localStart: '~',
  remoteStart: '/',
  online: false,
  ...patch,
});
const ids = (list: Server[]) => list.map((x) => x.id);
const baseOf = (...list: Server[]) => Object.fromEntries(list.map((x) => [x.id, hashServer(x)]));

describe('pick', () => {
  it('takes theirs only when ours is unchanged since the base', () => {
    expect(pick('a', 'a', 'x')).toBe('ours');
    expect(pick('a', 'b', 'a')).toBe('theirs');
    expect(pick('c', 'b', 'a')).toBe('ours');
  });
});

describe('mergeServers', () => {
  const a = srv('a');
  const b = srv('b');

  it('keeps everything here when there is no shared file yet', () => {
    expect(ids(mergeServers([a, b], null, {}).merged)).toEqual(['a', 'b']);
  });

  it('takes a server changed only on the other computer', () => {
    const changed = { ...a, name: 'Neu' };
    const { merged, taken } = mergeServers([a], [changed], baseOf(a));
    expect(merged[0].name).toBe('Neu');
    expect(ids(taken)).toEqual(['a']);
  });

  it('keeps ours when both sides changed', () => {
    const ours = { ...a, name: 'Hier' };
    const { merged, taken } = mergeServers([ours], [{ ...a, name: 'Dort' }], baseOf(a));
    expect(merged[0].name).toBe('Hier');
    expect(taken).toEqual([]);
  });

  it('carries deletions over, unless the other side changed the server since', () => {
    expect(ids(mergeServers([a, b], [a], baseOf(a, b)).merged)).toEqual(['a']);
    expect(ids(mergeServers([a], [a, b], baseOf(a, b)).merged)).toEqual(['a']);
    expect(ids(mergeServers([a], [a, { ...b, name: 'geändert' }], baseOf(a, b)).merged)).toEqual(['a', 'b']);
  });

  it('adds new servers from the other computer after ours, without a foreign start folder', () => {
    const fromWin = srv('w', { localStart: 'C:\\Users\\anna' });
    const { merged } = mergeServers([a], [a, fromWin], baseOf(a));
    expect(ids(merged)).toEqual(['a', 'w']);
    expect(merged[1].localStart).toBe('~');
  });
});

describe('heldForReview', () => {
  const a = srv('a', { protocol: 'webdav', port: 443, davHttps: true });

  it('holds a change to how an existing server is reached and keeps ours meanwhile', () => {
    const theirs = { ...a, davHttps: false, proxy: { kind: 'http' as const, host: 'evil.example', port: 8080 } };
    const { merged, taken } = mergeServers([a], [theirs], baseOf(a));
    const r = heldForReview([a], merged, taken);
    expect(r.held.map((h) => h.theirs.id)).toEqual(['a']);
    expect(r.merged[0].davHttps).toBe(true);
    expect(r.taken).toEqual([]);
    expect(profileChanges(a, theirs).map((c) => c.field)).toEqual(['proxy', 'davHttps']);
  });

  it('lets other changes through', () => {
    const theirs = { ...a, name: 'Neuer Name', note: 'Notiz' };
    const { merged, taken } = mergeServers([a], [theirs], baseOf(a));
    expect(heldForReview([a], merged, taken).held).toEqual([]);
  });

  it('treats a missing switch like a switched-off one', () => {
    const plain = srv('p');
    const explicit = { ...plain, implicitTls: false, forwardAgent: false, name: 'umbenannt' };
    const { merged, taken } = mergeServers([plain], [explicit], baseOf(plain));
    expect(heldForReview([plain], merged, taken).held).toEqual([]);
  });

  it('holds a new server with the login of one here that is reached differently', () => {
    const twin = srv('t', { host: 'A.example', protocol: 'webdav', port: 443, davHttps: false });
    const { merged, taken } = mergeServers([a], [a, twin], baseOf(a));
    const r = heldForReview([a], merged, taken);
    expect(r.held).toEqual([{ theirs: twin, ours: a }]);
    expect(ids(r.merged)).toEqual(['a']);
  });

  it('holds a key file that newly lies on a network share', () => {
    const k = srv('k', { auth: 'key', keyPath: '~/.ssh/id_ed25519' });
    for (const share of ['\\\\nas\\keys\\id', '//nas/keys/id']) {
      const theirs = { ...k, keyPath: share };
      const { merged, taken } = mergeServers([k], [theirs], baseOf(k));
      expect(heldForReview([k], merged, taken).held.length).toBe(1);
    }
    const fresh = srv('n', { auth: 'key', keyPath: '\\\\nas\\keys\\id' });
    const { merged, taken } = mergeServers([], [fresh], {});
    expect(heldForReview([], merged, taken).held.length).toBe(1);
  });
});
