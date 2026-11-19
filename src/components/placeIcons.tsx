/**
 * Symbols of the places of this computer (favourite folders, drives), shared
 * by the sidebar and the location menu of a half.
 */
import {
  Cloud,
  Desktop,
  DownloadSimple,
  FileText,
  FolderSimple,
  HardDrive,
  HardDrives,
  House,
  Usb,
} from '@phosphor-icons/react';
import type { Place } from '../backend/types';
import { BrandLogo } from './BrandLogo';
import { isBrandService } from './brands';

/** Size and weight of the place symbols. */
export const PLACE_ICON = { size: 16, weight: 'regular', 'aria-hidden': true } as const;

/**
 * Icon of a place, guessed from its folder (home, desktop, downloads, documents); cloud folders show
 * the service's own logo (single-colour, like the Finder sidebar). `big`: the places bar's look.
 */
export function PlaceIcon({ place, big }: { place: Place; big?: boolean }) {
  const last =
    place.path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase() ?? '';
  const props = big ? ({ size: 17, weight: 'duotone', 'aria-hidden': true } as const) : PLACE_ICON;
  if (isBrandService(place.cloud)) return <BrandLogo service={place.cloud} size={big ? 16 : 14} />;
  if (place.cloud) return <Cloud {...props} />;
  if (place.path === '~') return <House {...props} />;
  if (last === 'desktop' || last === 'schreibtisch') return <Desktop {...props} />;
  if (last === 'downloads') return <DownloadSimple {...props} />;
  if (last === 'documents' || last === 'dokumente') return <FileText {...props} />;
  return <FolderSimple {...props} />;
}

/** Start disk, other disks and removable drives look different (Finder). */
export function DriveIcon({ drive, first }: { drive: Place; first: boolean }) {
  if (first) return <HardDrive {...PLACE_ICON} />;
  if (/usb|stick/i.test(drive.name)) return <Usb {...PLACE_ICON} />;
  return <HardDrives {...PLACE_ICON} />;
}
