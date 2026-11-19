/**
 * Facts about the transfer protocols that several parts of the interface need.
 */
import type { Protocol, Server } from '../backend/types';

/** SFTP / SSH servers (the default when no protocol is set): terminal, tunnels, jump servers. */
export const isSftp = (srv: Pick<Server, 'protocol'>) => !srv.protocol || srv.protocol === 'sftp';

/**
 * The port a protocol uses unless another is set: SFTP 22, FTP 21 (FTPS with implicit TLS 990),
 * WebDAV 443 (80 without HTTPS), SMB 445.
 */
export function defaultPort(
  protocol: Protocol | undefined,
  opts: { implicitTls?: boolean; https?: boolean } = {},
): number {
  switch (protocol) {
    case 'ftp':
      return 21;
    case 'ftps':
      return opts.implicitTls ? 990 : 21;
    case 'webdav':
      return opts.https === false ? 80 : 443;
    case 'smb':
      return 445;
    default:
      return 22;
  }
}

/** Every port `defaultPort` can give; a port the user chose stays when the protocol changes. */
export const STANDARD_PORTS = [22, 21, 990, 443, 80, 445];
