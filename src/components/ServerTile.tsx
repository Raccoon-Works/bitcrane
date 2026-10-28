/**
 * Small symbols in front of servers and of this computer (Phosphor icons,
 * duotone, after the filled symbols of Transmit).
 */
import { Cloud, Database, DropboxLogo, GlobeHemisphereWest, GoogleDriveLogo } from '@phosphor-icons/react';
import type { Server, ServerColor, Theme } from '../backend/types';

export const serverColors: Record<ServerColor, Record<Theme, { bg: string; fg: string }>> = {
  blue: { dark: { bg: '#2B4A7A', fg: '#CFE0FF' }, light: { bg: '#DCE7FB', fg: '#1D4E9E' } },
  purple: { dark: { bg: '#4A3A6E', fg: '#E2D6FF' }, light: { bg: '#E9E1FA', fg: '#5B3A9E' } },
  green: { dark: { bg: '#3D4A3A', fg: '#D3E6CF' }, light: { bg: '#E2EDDF', fg: '#3A6A33' } },
  yellow: { dark: { bg: '#4D4232', fg: '#F0DFC3' }, light: { bg: '#F3E9DA', fg: '#7A5A26' } },
  orange: { dark: { bg: '#5A3A22', fg: '#FFD9BC' }, light: { bg: '#FBE4D3', fg: '#8A4515' } },
  red: { dark: { bg: '#5C2A2A', fg: '#FFD2CF' }, light: { bg: '#FADBD9', fg: '#8E1F1A' } },
  gray: { dark: { bg: '#3A3A3F', fg: '#E4E4E8' }, light: { bg: '#E4E4E8', fg: '#3A3A3F' } },
};

/** Swatch colours for the colour picker in the server dialog. */
export const swatch: Record<ServerColor, string> = {
  blue: '#2A6DE0', purple: '#AF52DE', green: '#30D158', yellow: '#FFCC00', orange: '#FF9F0A', red: '#FF453A', gray: '#8E8E93',
};

/**
 * Server symbol after Transmit and WinSCP: one calm globe, the same for
 * every server and protocol; the name tells them apart. A colour is optional
 * (default "gray" = none); when one is chosen, e.g. red for a live server,
 * it shows as a small dot on the symbol (like WinSCP's site colour).
 */
export function ServerTile({ server, size = 20, color, protocol }: { server?: Server; size?: number; mono?: string; color?: ServerColor; protocol?: Server['protocol'] }) {
  const proto = protocol ?? server?.protocol ?? 'sftp';
  // One globe for every protocol (Transmit): the drive stack for FTP looked restless in the list.
  // The protocol stays visible in the tooltip and the server dialog.
  const Icon = GlobeHemisphereWest;
  const c = color ?? server?.color;
  const dot = Math.max(7, Math.round(size * 0.36));
  return (
    <span className={`server-glyph proto-${proto}`} aria-hidden="true" style={{ width: size, height: size }}>
      <Icon size={size} weight="fill" />
      {c && c !== 'gray' && <span className="server-glyph-dot" style={{ background: swatch[c], width: dot, height: dot }} />}
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

/**
 * Symbol of a cloud service. Draft: Dropbox and Google Drive use the
 * monochrome brand glyphs of the Phosphor icon set, OneDrive and S3 plain
 * symbols. The finished feature takes the logos from the services' official
 * brand kits and follows their usage rules.
 */
export function CloudTile({ service, size = 20 }: { service: CloudService; size?: number }) {
  const Icon = service === 'dropbox' ? DropboxLogo : service === 'gdrive' ? GoogleDriveLogo : service === 'onedrive' ? Cloud : Database;
  return (
    <span className={`server-glyph cloud-${service}`} aria-hidden="true" style={{ width: size, height: size }}>
      {/* OneDrive's placeholder is drawn as an outline so it differs from the "Cloud-Dienste" symbol. */}
      <Icon size={size} weight={service === 'onedrive' ? 'duotone' : 'fill'} />
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
