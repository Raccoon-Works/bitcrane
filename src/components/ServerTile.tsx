/**
 * Small symbols in front of servers and of this computer (Phosphor icons,
 * duotone, after the filled symbols of Transmit).
 */
import { Database, GlobeHemisphereWest, LockSimple } from '@phosphor-icons/react';
import { BrandLogo } from './BrandLogo';
import type { Server, ServerColor } from '../backend/types';
import { swatch } from './serverColors';

/**
 * Server symbol after Transmit and WinSCP: one calm globe, the same for
 * every server and protocol; the name tells them apart. A colour is optional
 * (default "gray" = none); when one is chosen, e.g. red for a live server,
 * it shows as a small dot on the symbol (like WinSCP's site colour).
 */
export function ServerTile({
  server,
  size = 20,
  color,
  protocol,
  image,
}: {
  server?: Server;
  size?: number;
  mono?: string;
  color?: ServerColor;
  protocol?: Server['protocol'];
  image?: string;
}) {
  const proto = protocol ?? server?.protocol ?? 'sftp';
  const picture = image ?? server?.image;
  // Cloud services show their own symbol (unless the user chose a picture).
  if (!picture && (proto === 'dropbox' || proto === 'gdrive' || proto === 'onedrive'))
    return <CloudTile service={proto} size={size} />;
  // An own picture replaces the globe (the colour dot stays, so groups remain recognisable).
  if (picture) {
    const c = color ?? server?.color;
    const dot = Math.max(7, Math.round(size * 0.36));
    return (
      <span className="server-glyph has-image" aria-hidden="true" style={{ width: size, height: size }}>
        <img src={picture} alt="" width={size} height={size} draggable={false} />
        {c && c !== 'gray' && (
          <span className="server-glyph-dot" style={{ background: swatch[c], width: dot, height: dot }} />
        )}
      </span>
    );
  }
  // One globe for every protocol (Transmit): the drive stack for FTP looked restless in the list.
  // The protocol stays visible in the tooltip and the server dialog.
  // An unlocked Cryptomator vault is no server: it shows a lock.
  const Icon = proto === 'vault' ? LockSimple : GlobeHemisphereWest;
  const c = color ?? server?.color;
  const dot = Math.max(7, Math.round(size * 0.36));
  return (
    <span className={`server-glyph proto-${proto}`} aria-hidden="true" style={{ width: size, height: size }}>
      <Icon size={size} weight="fill" />
      {c && c !== 'gray' && (
        <span className="server-glyph-dot" style={{ background: swatch[c], width: dot, height: dot }} />
      )}
    </span>
  );
}

/**
 * Symbol for "Cloud-Dienste" in the server list: a plain, symmetric cloud
 * (drawn here) so it differs from any service's own symbol.
 */
export function CloudServicesIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M7 19a5 5 0 0 1-.9-9.92A6 6 0 0 1 17.9 9.08 5 5 0 0 1 17 19H7z" />
    </svg>
  );
}

/** Cloud services shown as a preview in the prototype (not connectable yet). */
export type CloudService = 'dropbox' | 'gdrive' | 'onedrive' | 's3';

/** Symbol of a cloud service: its own logo (Simple Icons), S3 a plain symbol. */
export function CloudTile({ service, size = 20 }: { service: CloudService; size?: number }) {
  return (
    <span className={`server-glyph cloud-${service}`} aria-hidden="true" style={{ width: size, height: size }}>
      {service === 's3' ? <Database size={size} weight="fill" /> : <BrandLogo service={service} size={size - 2} />}
    </span>
  );
}

/**
 * Symbol for this computer: a small drive, drawn here (grey case, darker
 * front with a green lamp), the same on Mac and Windows.
 */
export function LocalTile({ size = 20 }: { size?: number }) {
  return (
    <span className="server-glyph is-local" aria-hidden="true" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 24 24">
        <defs>
          <linearGradient id="bc-drive-top" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#e3e5e9" />
            <stop offset="1" stopColor="#a9adb5" />
          </linearGradient>
          <linearGradient id="bc-drive-front" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#7d828b" />
            <stop offset="1" stopColor="#5d6168" />
          </linearGradient>
        </defs>
        <path d="M5.2 5h13.6a2 2 0 0 1 1.8 1.1L23 11v1H1v-1l2.4-4.9A2 2 0 0 1 5.2 5z" fill="url(#bc-drive-top)" />
        <rect x="1" y="11" width="22" height="8" rx="2" fill="url(#bc-drive-front)" />
        <rect x="4" y="14.4" width="9" height="1.4" rx="0.7" fill="#41454b" />
        <circle cx="19" cy="15.1" r="1.3" fill="#5fd36a" />
      </svg>
    </span>
  );
}
