import { describe, expect, it } from 'vitest';
import type { Server } from '../backend/types';
import { addressOf, hostOf, normalizeSshAddress, parseQuickAddress, splitAddress } from './serverAddress';

function server(patch: Partial<Server>): Server {
  return {
    id: 'srv-1',
    name: 'Web',
    mono: 'WE',
    color: 'gray',
    host: 'web.example',
    port: 22,
    user: 'deploy',
    auth: 'agent',
    keyPath: '~/.ssh/id_ed25519',
    group: '',
    localStart: '~',
    remoteStart: '/srv/www',
    online: false,
    ...patch,
  };
}

describe('addressOf / hostOf', () => {
  it('hides default ports', () => {
    expect(addressOf(server({}))).toBe('deploy@web.example');
    expect(addressOf(server({ protocol: 'ftp', port: 21 }))).toBe('deploy@web.example');
    expect(addressOf(server({ protocol: 'ftps', implicitTls: true, port: 990 }))).toBe('deploy@web.example');
    expect(addressOf(server({ protocol: 'webdav', davHttps: false, port: 80 }))).toBe('deploy@web.example');
  });

  it('shows other ports', () => {
    expect(addressOf(server({ port: 2222 }))).toBe('deploy@web.example:2222');
    expect(addressOf(server({ protocol: 'ftps', port: 990 }))).toBe('deploy@web.example:990');
  });

  it('shows the account for cloud services and the bucket for S3', () => {
    expect(addressOf(server({ protocol: 'dropbox', user: 'alex@mail.example' }))).toBe('alex@mail.example');
    expect(addressOf(server({ protocol: 'dropbox', user: '' }))).toBe('web.example');
    expect(addressOf(server({ protocol: 's3', s3Bucket: 'assets', host: 's3.example' }))).toBe('assets · s3.example');
  });

  it('leaves the user out of the short form', () => {
    expect(hostOf(server({ port: 2222 }))).toBe('web.example:2222');
    expect(hostOf(server({ user: '' }))).toBe('web.example');
    expect(hostOf(server({ protocol: 'dropbox', user: 'alex@mail.example' }))).toBe('alex@mail.example');
  });
});

describe('normalizeSshAddress', () => {
  it('reads ssh commands', () => {
    expect(normalizeSshAddress('ssh deploy@web.example')).toBe('deploy@web.example');
    expect(normalizeSshAddress('ssh -p 2222 deploy@web.example')).toBe('deploy@web.example:2222');
    expect(normalizeSshAddress('ssh -p2222 deploy@web.example')).toBe('deploy@web.example:2222');
    expect(normalizeSshAddress('SSH -l root -p 22 web.example')).toBe('root@web.example:22');
    expect(normalizeSshAddress('ssh web.example -l root')).toBe('root@web.example');
  });

  it('skips options and their values', () => {
    expect(normalizeSshAddress('ssh -i ~/.ssh/key -J jump.example -v deploy@web.example')).toBe('deploy@web.example');
    expect(normalizeSshAddress('ssh -o StrictHostKeyChecking=no deploy@web.example')).toBe('deploy@web.example');
  });

  it('keeps a port that is already in the address', () => {
    expect(normalizeSshAddress('ssh -p 2222 deploy@web.example:22')).toBe('deploy@web.example:22');
  });

  it('strips ssh:// and leaves other addresses as typed', () => {
    expect(normalizeSshAddress(' ssh://deploy@web.example:2200 ')).toBe('deploy@web.example:2200');
    expect(normalizeSshAddress('  ftp://web@host.example ')).toBe('ftp://web@host.example');
    expect(normalizeSshAddress('deploy@web.example')).toBe('deploy@web.example');
  });
});

describe('splitAddress', () => {
  it('splits all parts', () => {
    expect(splitAddress('deploy@web.example:2222/srv/www')).toEqual({
      user: 'deploy',
      host: 'web.example',
      port: 2222,
      path: '/srv/www',
    });
  });

  it('needs only the host', () => {
    expect(splitAddress('web.example')).toEqual({ host: 'web.example' });
    expect(splitAddress('web.example/srv')).toEqual({ host: 'web.example', path: '/srv' });
  });

  it('rejects what is not an address', () => {
    expect(splitAddress('')).toBeNull();
    expect(splitAddress('deploy@web.example:ssh')).toBeNull();
    expect(splitAddress(':22')).toBeNull();
  });

  it('splits at the first "@"; the rest counts as the host', () => {
    expect(splitAddress('web@domain.example@ftp.example')).toEqual({
      user: 'web',
      host: 'domain.example@ftp.example',
    });
    expect(splitAddress('deploy@')).toEqual({ host: 'deploy@' });
  });
});

describe('parseQuickAddress', () => {
  it('defaults to SFTP', () => {
    expect(parseQuickAddress(' deploy@web.example ')).toEqual({
      scheme: 'sftp',
      protocol: 'sftp',
      defaultPort: 22,
      user: 'deploy',
      host: 'web.example',
    });
  });

  it('maps each scheme to its protocol and default port', () => {
    const pick = (a: string) => {
      const q = parseQuickAddress(a);
      return q && [q.protocol, q.defaultPort];
    };
    expect(pick('sftp://h')).toEqual(['sftp', 22]);
    expect(pick('ftp://h')).toEqual(['ftp', 21]);
    expect(pick('ftps://h')).toEqual(['ftps', 990]);
    expect(pick('ftpes://h')).toEqual(['ftps', 21]);
    expect(pick('webdav://h')).toEqual(['webdav', 443]);
    expect(pick('DAVS://h')).toEqual(['webdav', 443]);
    expect(pick('dav://h')).toEqual(['webdav', 80]);
    expect(pick('smb://h')).toEqual(['smb', 445]);
    expect(pick('gopher://h')).toEqual(['sftp', 22]);
  });

  it('keeps the scheme as typed (lower case) and the explicit port and path', () => {
    expect(parseQuickAddress('FTPES://web@host.example:2121/htdocs')).toEqual({
      scheme: 'ftpes',
      protocol: 'ftps',
      defaultPort: 21,
      user: 'web',
      host: 'host.example',
      port: 2121,
      path: '/htdocs',
    });
  });

  it('rejects an address without a host', () => {
    expect(parseQuickAddress('ftp://')).toBeNull();
    expect(parseQuickAddress('')).toBeNull();
  });
});
