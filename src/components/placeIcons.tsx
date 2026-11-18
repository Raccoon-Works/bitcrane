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

export function PlaceIcon({ place }: { place: Place }) {
  const last =
    place.path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase() ?? '';
  if (isBrandService(place.cloud)) return <BrandLogo service={place.cloud} size={14} />;
  if (place.cloud) return <Cloud {...PLACE_ICON} />;
  if (place.path === '~') return <House {...PLACE_ICON} />;
  if (last === 'desktop' || last === 'schreibtisch') return <Desktop {...PLACE_ICON} />;
  if (last === 'downloads') return <DownloadSimple {...PLACE_ICON} />;
  if (last === 'documents' || last === 'dokumente') return <FileText {...PLACE_ICON} />;
  return <FolderSimple {...PLACE_ICON} />;
}

/** Start disk, other disks and removable drives look different (Finder). */
export function DriveIcon({ drive, first }: { drive: Place; first: boolean }) {
  if (first) return <HardDrive {...PLACE_ICON} />;
  if (/usb|stick/i.test(drive.name)) return <Usb {...PLACE_ICON} />;
  return <HardDrives {...PLACE_ICON} />;
}
