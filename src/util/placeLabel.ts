/**
 * Name under which a place (folder, drive, cloud service) is shown in the bar,
 * the sidebar and menus.
 */
import type { Place } from '../backend/types';
import { $t } from '../i18n';

/**
 * Name shown for a place. Cloud folders found by older versions were named
 * with their account ("Google Drive (name@example.com)"), which filled the bar;
 * the account is shown in the tooltip instead.
 */
export function placeLabel(place: Place): string {
  if (!place.cloud) return place.name;
  return place.name.replace(/\s*\([^)]*@[^)]*\)\s*$/, '');
}

/**
 * A Windows drive with its label, the letter first so it stays visible in a
 * narrow sidebar: "F: GAMES - DATEN", "C: Lokaler Datenträger".
 */
export function driveLabel(d: Place, mac: boolean): string {
  if (mac || d.network || !/^[A-Z]:$/.test(d.name)) return d.name;
  return `${d.name} ${d.label || $t('Lokaler Datenträger')}`;
}

/** Account part of a cloud folder's name ("GoogleDrive-name@example.com" → "name"). */
function accountOf(place: Place): string {
  const folder =
    place.path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? '';
  if (!place.cloud || !folder.includes('-')) return '';
  return folder.slice(folder.indexOf('-') + 1).split('@')[0];
}

/**
 * Favourites with the names they are shown under: two accounts of the same
 * service keep both entries and are told apart by the account name.
 */
export function favoriteLabels(places: Place[]): Array<{ place: Place; label: string }> {
  return places.map((p) => {
    const label = placeLabel(p);
    const twin = places.some((o) => o !== p && placeLabel(o) === label);
    const acc = twin ? accountOf(p) : '';
    return { place: p, label: acc ? `${label} (${acc})` : label };
  });
}
