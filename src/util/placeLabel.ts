/**
 * Name under which a place (folder, drive, cloud service) is shown in the bar,
 * the sidebar and menus.
 */
import type { Place } from '../backend/types';

/**
 * Name shown for a place. Cloud folders found by older versions were named
 * with their account ("Google Drive (name@example.com)"), which filled the bar;
 * the account is shown in the tooltip instead.
 */
export function placeLabel(place: Place): string {
  if (!place.cloud) return place.name;
  return place.name.replace(/\s*\([^)]*@[^)]*\)\s*$/, '');
}
