/**
 * Data of the server editor shared by its sections: protocol families, S3
 * providers, cloud defaults, FTP time zones and the texts naming the keychain.
 */
import type { Platform, Protocol, Server } from '../../../backend/types';
import { isCloudProtocol } from '../../../backend/types';
import { $t } from '../../../i18n';

/** Protocol families of the form (FTP covers FTP and FTPS). */
export type Fam = 'sftp' | 'ftp' | 'webdav' | 'smb' | 's3' | 'cloud';

export function familyOf(protocol: Protocol | undefined): Fam {
  return isCloudProtocol(protocol)
    ? 'cloud'
    : protocol === 'ftp' || protocol === 'ftps'
      ? 'ftp'
      : protocol === 'webdav'
        ? 'webdav'
        : protocol === 'smb'
          ? 'smb'
          : protocol === 's3'
            ? 's3'
            : 'sftp';
}

/** Changes one field of the server being edited (and resets the connection test). */
export type SetField = <K extends keyof Server>(k: K, v: Server[K]) => void;

/** Default ports per protocol; a port the user chose stays when the protocol changes. */
export const STANDARD_PORTS = [22, 21, 990, 443, 80, 445];

/**
 * S3 providers: the address follows from the region, so picking the provider
 * and the region fills it in. "other" is any S3-compatible service (MinIO,
 * Ceph, a NAS ...); R2 needs the account id in the address.
 */
export const S3_PROVIDERS: Record<
  string,
  { label: string; region: string; host: (region: string) => string; regions?: string[] }
> = {
  aws: {
    label: 'Amazon S3',
    region: 'eu-central-1',
    host: (r) => `s3.${r}.amazonaws.com`,
    regions: [
      'eu-central-1',
      'eu-central-2',
      'eu-west-1',
      'eu-west-2',
      'eu-west-3',
      'eu-north-1',
      'eu-south-1',
      'us-east-1',
      'us-east-2',
      'us-west-1',
      'us-west-2',
      'ca-central-1',
      'ap-southeast-1',
      'ap-southeast-2',
      'ap-northeast-1',
      'sa-east-1',
    ],
  },
  b2: {
    label: 'Backblaze B2',
    region: 'eu-central-003',
    host: (r) => `s3.${r}.backblazeb2.com`,
    regions: ['eu-central-003', 'us-west-000', 'us-west-001', 'us-west-002', 'us-west-004', 'us-east-005'],
  },
  r2: { label: 'Cloudflare R2', region: 'auto', host: () => '' },
  wasabi: {
    label: 'Wasabi',
    region: 'eu-central-1',
    host: (r) => `s3.${r}.wasabisys.com`,
    regions: [
      'eu-central-1',
      'eu-central-2',
      'eu-west-1',
      'eu-west-2',
      'us-east-1',
      'us-east-2',
      'us-west-1',
      'ap-northeast-1',
    ],
  },
  hetzner: {
    label: 'Hetzner Object Storage',
    region: 'fsn1',
    host: (r) => `${r}.your-objectstorage.com`,
    regions: ['fsn1', 'nbg1', 'hel1'],
  },
  other: { label: $t('Anderer Dienst (MinIO, Ceph …)'), region: '', host: () => '' },
};

/** Time zones for FTP servers that list local times (UTC-12 to UTC+14). */
export const TIMEZONES = Array.from({ length: 27 }, (_, i) => i - 12).map((h) => ({
  value: String(h * 60),
  label:
    h === 0
      ? $t('UTC (Standard)')
      : `UTC${h > 0 ? '+' : '−'}${Math.abs(h)}${h === 1 ? $t(' (Winterzeit Deutschland)') : h === 2 ? $t(' (Sommerzeit Deutschland)') : ''}`,
}));

/** Fixed fields of a cloud service entry (no address, port or password of its own). */
export function cloudDefaults(service: Protocol): Partial<Server> {
  return {
    protocol: service,
    host: service === 'gdrive' ? 'drive.google.com' : service === 'onedrive' ? 'onedrive.live.com' : 'dropbox.com',
    port: 443,
    auth: 'agent',
    remoteStart: '',
  };
}

/**
 * SFTP with root rights: sudo starts the system's SFTP server (WinSCP "SFTP server").
 * The places differ between Linux distributions, so the first one that exists is taken.
 */
export const SUDO_SFTP =
  'sudo -n sh -c \'for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server; do [ -x "$p" ] && exec "$p"; done; exit 127\'';

/** Where secrets are kept, short form ("gespeichert im Schlüsselbund"). */
export const keychainShort = (platform: Platform) =>
  platform === 'mac' ? $t('im Schlüsselbund') : $t('in der Anmeldeinformationsverwaltung');

/** Where secrets are kept, naming the Windows tool in full (sentences about passwords). */
export const keychainLong = (platform: Platform) =>
  platform === 'mac' ? $t('im Schlüsselbund') : $t('in der Windows-Anmeldeinformationsverwaltung');
