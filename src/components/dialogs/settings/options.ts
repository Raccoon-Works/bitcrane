/**
 * Choices offered by more than one settings area (Übertragungen and Regeln):
 * what to do with existing files and the default upload permissions.
 */
import type { ExistingRule } from '../../../state/store';
import { $t } from '../../../i18n';

export const existingOptions: Array<{ value: ExistingRule; label: string }> = [
  { value: 'ask', label: $t('Nachfragen') },
  { value: 'overwrite', label: $t('Überschreiben') },
  { value: 'newer', label: $t('Nur wenn neuer') },
  { value: 'keepBoth', label: $t('Beide behalten') },
  { value: 'skip', label: $t('Überspringen') },
];

/** Choices for default upload permissions: octal value with its rwx text. */
export function permOptions(values: string[], dir = false): Array<{ value: string; label: string }> {
  const rwx = (v: string) =>
    [...v]
      .map((d) => {
        const n = Number(d);
        return `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
      })
      .join('');
  return [
    { value: '', label: $t('Wie vom Server vorgegeben') },
    ...values.map((v) => ({ value: v, label: `${v} (${dir ? 'd' : '-'}${rwx(v)})` })),
  ];
}
