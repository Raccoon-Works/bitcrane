/**
 * The merge behind "Zwischen Rechnern abgleichen" (state/sync.ts), as pure functions.
 *
 * The shared file lies in a cloud folder, so whoever can write there can change it without
 * knowing the sync password, which seals only the passwords. A changed server entry would then
 * lead a password stored on this computer elsewhere (plain HTTP instead of HTTPS, another proxy,
 * a key file on a network share). Changes to how a server is reached are therefore never taken
 * over silently: `heldForReview` sets them apart for the user to confirm.
 */
import type { Server } from '../backend/types';

/** What both sides looked like after the last sync (hashes), see the file comment of sync.ts. */
export interface SyncBase {
  servers: Record<string, string>;
  settings: Record<string, string>;
}

/** JSON with sorted keys, so equal data gives equal text. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The shared part of a server (without local start folder, online state, last use). */
export function sharedServer(x: Server): Server {
  const copy: Server = { ...x, online: false, localStart: '' };
  delete copy.lastUsed;
  delete copy.temporary;
  return copy;
}

export const hashServer = (x: Server) => stable(sharedServer(x));

/** Three-way merge of one value; returns which side wins. */
export function pick(
  ours: string | undefined,
  theirs: string | undefined,
  base: string | undefined,
): 'ours' | 'theirs' {
  if (ours === theirs) return 'ours';
  if (ours === base) return 'theirs';
  return 'ours';
}

/**
 * Three-way merge of the server lists. `theirs` null: no shared file yet, everything here is
 * kept. Returns the merged list (our order first) and the servers taken over from the other
 * computer.
 */
export function mergeServers(
  ours: Server[],
  theirs: Server[] | null,
  base: Record<string, string>,
): { merged: Server[]; taken: Server[] } {
  const theirServers = new Map((theirs ?? []).map((x) => [x.id, x]));
  const ourServers = new Map(ours.map((x) => [x.id, x]));
  const merged: Server[] = [];
  const taken: Server[] = [];
  for (const id of new Set([...ourServers.keys(), ...theirServers.keys()])) {
    const o = ourServers.get(id);
    const t = theirServers.get(id);
    const ho = o && hashServer(o);
    const ht = t && hashServer(t);
    const hb = base[id];
    if (o && t) {
      if (pick(ho, ht, hb) === 'theirs') {
        const next = { ...t, online: o.online, lastUsed: o.lastUsed, localStart: o.localStart };
        merged.push(next);
        taken.push(next);
      } else merged.push(o);
    } else if (o) {
      // Only here: new (keep), or deleted there since the last sync (drop, unless changed here meanwhile).
      if (hb === undefined || ho !== hb || !theirs) merged.push(o);
    } else if (t) {
      // Only there: new there (take), or deleted here since the last sync (stay deleted, unless changed there).
      if (hb === undefined || ht !== hb) {
        // A start folder from the other kind of computer (C:\…) does not fit here.
        const next = {
          ...t,
          online: false,
          localStart:
            t.localStart && !t.localStart.includes('\\') && !/^[A-Za-z]:/.test(t.localStart) ? t.localStart : '~',
        };
        merged.push(next);
        taken.push(next);
      }
    }
  }
  // Keep the order: ours first, then new ones from the other computer.
  const order = new Map(ours.map((x, i) => [x.id, i]));
  merged.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  return { merged, taken };
}

/**
 * How a server is reached and what runs when it is, field by field (field, shown value; switches as
 * "on"/"off", which the dialog translates): address,
 * login, encryption, proxy, key file, jump server, tunnels and commands. Missing switches count as
 * off, so an older entry without a field equals one with the field off.
 */
function profileFields(x: Server) {
  const on = (v: boolean) => (v ? 'on' : 'off');
  return [
    ['protocol', x.protocol ?? 'sftp'],
    ['host', x.host.toLowerCase()],
    ['port', String(x.port)],
    ['user', x.user],
    ['auth', x.auth],
    ['keyPath', x.keyPath],
    [
      'proxy',
      x.proxy ? `${x.proxy.kind}://${x.proxy.user ? `${x.proxy.user}@` : ''}${x.proxy.host}:${x.proxy.port}` : '',
    ],
    ['jump', x.jumpServerId ?? ''],
    ['implicitTls', on(!!x.implicitTls)],
    ['tls13Only', on(!!x.tls13Only)],
    ['davHttps', on(x.davHttps !== false)],
    ['s3Http', on(!!x.s3Http)],
    ['smbEncrypt', on(!!x.smbEncrypt)],
    ['sftpCommand', x.sftpCommand ?? ''],
    ['termStart', x.termStart ?? ''],
    ['forwardAgent', on(!!x.forwardAgent)],
    ['forwards', stable(x.forwards ?? [])],
  ] as const satisfies ReadonlyArray<readonly [string, string]>;
}

export const securityProfile = (x: Server) => stable(profileFields(x));

export type ProfileField = ReturnType<typeof profileFields>[number][0];

/** The fields of `profileFields` that differ (field, before, after). */
export function profileChanges(
  before: Server,
  after: Server,
): Array<{ field: ProfileField; from: string; to: string }> {
  const a = profileFields(before);
  return profileFields(after)
    .map(([field, to], i) => ({ field, from: a[i][1], to }))
    .filter((c) => c.from !== c.to);
}

/** A key file on a network share (\\server\share or //server/share): Windows would send the login hash there. */
export const isNetworkPath = (p: string) => /^(\\\\|\/\/)/.test(p);

/** A server taken over from the other computer that waits for the user's yes, with what it replaces here. */
export interface HeldServer {
  theirs: Server;
  /** Our entry with the same id, or a server here with the same login (a new entry would use its password). */
  ours?: Server;
}

/**
 * Splits the servers `mergeServers` took over: a change to how an existing server is reached, a new
 * server with the login of one here but reached differently, and a key file newly on a network share
 * wait for the user's yes. Our version stays in `merged` meanwhile (a new one stays out).
 */
export function heldForReview(
  ours: Server[],
  merged: Server[],
  taken: Server[],
): { merged: Server[]; taken: Server[]; held: HeldServer[] } {
  const byId = new Map(ours.map((x) => [x.id, x]));
  const login = (x: Server) => `${x.user}@${x.host.toLowerCase()}:${x.port}`;
  const held: HeldServer[] = [];
  const keep = new Map<string, Server | null>();
  for (const t of taken) {
    const o = byId.get(t.id);
    const sameLogin = o ? undefined : ours.find((x) => login(x) === login(t));
    const before = o ?? sameLogin;
    const newShare = isNetworkPath(t.keyPath) && t.keyPath !== before?.keyPath;
    const risky = newShare || (before && securityProfile(before) !== securityProfile(t));
    if (!risky) continue;
    held.push({ theirs: t, ours: before });
    keep.set(t.id, o ?? null);
  }
  if (!held.length) return { merged, taken, held };
  return {
    merged: merged.flatMap((x) => {
      if (!keep.has(x.id)) return [x];
      const o = keep.get(x.id);
      return o ? [o] : [];
    }),
    taken: taken.filter((x) => !keep.has(x.id)),
    held,
  };
}
