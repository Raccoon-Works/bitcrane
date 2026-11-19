import { describe, expect, it } from 'vitest';
import type { Server } from '../backend/types';
import { defaultPort, isSftp } from './protocols';
import { addressOf, parseQuickAddress } from './serverAddress';

const srv = (patch: Partial<Server>) =>
  ({ id: 's', name: 's', host: 'nas', port: 22, user: 'anna', auth: 'password', keyPath: '', ...patch }) as Server;

describe('defaultPort', () => {
  it('gives the standard port of every protocol', () => {
    expect([
      defaultPort(undefined),
      defaultPort('ftp'),
      defaultPort('ftps'),
      defaultPort('ftps', { implicitTls: true }),
      defaultPort('webdav'),
      defaultPort('webdav', { https: false }),
      defaultPort('smb'),
    ]).toEqual([22, 21, 21, 990, 443, 80, 445]);
  });

  it('leaves the standard port out of shown addresses, also for SMB', () => {
    expect(addressOf(srv({ protocol: 'smb', port: 445 }))).toBe('anna@nas');
    expect(addressOf(srv({ protocol: 'smb', port: 4450 }))).toBe('anna@nas:4450');
    expect(addressOf(srv({ protocol: 'webdav', davHttps: false, port: 80 }))).toBe('anna@nas');
  });
});

describe('quick addresses', () => {
  it('end the user at the last @ and read IPv6 in brackets', () => {
    expect(parseQuickAddress('ftp://web1@shop.example@ftp.host.example')).toMatchObject({
      user: 'web1@shop.example',
      host: 'ftp.host.example',
      protocol: 'ftp',
      defaultPort: 21,
    });
    expect(parseQuickAddress('smb://[::1]:4450/share')).toMatchObject({ host: '::1', port: 4450, defaultPort: 445 });
  });
});

describe('isSftp', () => {
  it('counts a server without protocol as SFTP', () => {
    expect([isSftp({}), isSftp({ protocol: 'sftp' }), isSftp({ protocol: 'ftp' })]).toEqual([true, true, false]);
  });
});
