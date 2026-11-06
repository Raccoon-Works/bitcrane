/**
 * How a server's address is shown: in the list, in tabs and in dialogs.
 */
import { isCloudProtocol, type Server } from '../backend/types';

/** Address shown next to a server name ("user@host" plus a port other than the default). */
export function addressOf(x: Server): string {
  // Cloud services: the signed-in account.
  if (isCloudProtocol(x.protocol)) return x.user || x.host;
  // S3: bucket and service; the access key is no user name worth showing.
  if (x.protocol === 's3') return `${x.s3Bucket ? `${x.s3Bucket} · ` : ''}${x.host}`;
  const defaults: Record<string, number> = { sftp: 22, ftp: 21, ftps: x.implicitTls ? 990 : 21, webdav: x.davHttps === false ? 80 : 443 };
  const port = x.port !== defaults[x.protocol ?? 'sftp'] ? `:${x.port}` : '';
  return `${x.user ? `${x.user}@` : ''}${x.host}${port}`;
}

/** Short address for the list: the host (and a port other than the default); the user is in the tooltip. */
export function hostOf(x: Server): string {
  if (isCloudProtocol(x.protocol) || x.protocol === 's3') return addressOf(x);
  const full = addressOf(x);
  return full.includes('@') ? full.slice(full.lastIndexOf('@') + 1) : full;
}
