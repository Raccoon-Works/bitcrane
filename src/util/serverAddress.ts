/**
 * Server addresses: how they are shown in the list, in tabs and in dialogs, and
 * how an address typed into "Schnell verbinden" is read.
 */
import { isCloudProtocol, type Protocol, type Server } from '../backend/types';

/** Address shown next to a server name ("user@host" plus a port other than the default). */
export function addressOf(x: Server): string {
  // Cloud services: the signed-in account.
  if (isCloudProtocol(x.protocol)) return x.user || x.host;
  // S3: bucket and service; the access key is no user name worth showing.
  if (x.protocol === 's3') return `${x.s3Bucket ? `${x.s3Bucket} · ` : ''}${x.host}`;
  const defaults: Record<string, number> = {
    sftp: 22,
    ftp: 21,
    ftps: x.implicitTls ? 990 : 21,
    webdav: x.davHttps === false ? 80 : 443,
  };
  const port = x.port !== defaults[x.protocol ?? 'sftp'] ? `:${x.port}` : '';
  return `${x.user ? `${x.user}@` : ''}${x.host}${port}`;
}

/** Short address for the list: the host (and a port other than the default); the user is in the tooltip. */
export function hostOf(x: Server): string {
  if (isCloudProtocol(x.protocol) || x.protocol === 's3') return addressOf(x);
  const full = addressOf(x);
  return full.includes('@') ? full.slice(full.lastIndexOf('@') + 1) : full;
}

/**
 * Accepts what people type in a terminal as well: "ssh user@host",
 * "ssh -p 2222 user@host" and ssh:// become the usual user@host:port.
 */
export function normalizeSshAddress(address: string): string {
  let a = address.trim().replace(/^ssh:\/\//i, '');
  const cmd = a.match(/^ssh\s+(.*)$/i);
  if (!cmd) return a;
  let port = '';
  const words: string[] = [];
  const parts = cmd[1].trim().split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '-p' && parts[i + 1]) port = parts[++i];
    else if (/^-p\d+$/.test(parts[i])) port = parts[i].slice(2);
    else if (parts[i] === '-l' && parts[i + 1]) words.unshift(`${parts[++i]}@`);
    // Options with a value (key file, jump host, -o …): skipped together with it.
    else if (/^-[bcDEeFIiJLlmOoQRSWw]$/.test(parts[i])) i++;
    else if (!parts[i].startsWith('-')) words.push(parts[i]);
  }
  a = words.join('');
  return port && !/:\d+(\/|$)/.test(a) ? `${a}:${port}` : a;
}

/** The parts of "user@host:port/path" (without a scheme); only the host is required. */
export interface AddressParts {
  user?: string;
  host: string;
  port?: number;
  path?: string;
}

/** Splits "user@host:port/path"; null when it is not an address of that form. */
export function splitAddress(address: string): AddressParts | null {
  const m = address.match(/^(?:([^@]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/);
  if (!m) return null;
  const [, user, host, port, path] = m;
  return { user, host, port: port ? Number(port) : undefined, path };
}

/** A quick-connect address: the scheme as typed, the protocol it stands for and the port it implies. */
export interface QuickAddress extends AddressParts {
  /** Lower-case scheme, "sftp" when none was typed. */
  scheme: string;
  protocol: Protocol;
  /** Port used when the address names none. */
  defaultPort: number;
}

/**
 * Reads "scheme://user@host:port/path". Schemes: sftp:// (default), ftp://, ftps:// (implicit
 * TLS), ftpes:// (explicit TLS), webdav:// / davs:// (HTTPS), dav:// (HTTP) and smb://; an
 * unknown scheme counts as SFTP.
 */
export function parseQuickAddress(address: string): QuickAddress | null {
  const typed = address.trim();
  const scheme = typed.match(/^([a-z]+):\/\//i)?.[1]?.toLowerCase() ?? 'sftp';
  const parts = splitAddress(typed.replace(/^[a-z]+:\/\//i, ''));
  if (!parts) return null;
  const protocol: Protocol =
    scheme === 'ftp'
      ? 'ftp'
      : scheme === 'ftps' || scheme === 'ftpes'
        ? 'ftps'
        : scheme === 'webdav' || scheme === 'davs' || scheme === 'dav'
          ? 'webdav'
          : scheme === 'smb'
            ? 'smb'
            : 'sftp';
  const defaultPort =
    protocol === 'ftp'
      ? 21
      : protocol === 'ftps'
        ? scheme === 'ftps'
          ? 990
          : 21
        : protocol === 'webdav'
          ? scheme === 'dav'
            ? 80
            : 443
          : protocol === 'smb'
            ? 445
            : 22;
  return { ...parts, scheme, protocol, defaultPort };
}
