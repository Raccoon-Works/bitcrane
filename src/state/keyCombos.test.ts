import { describe, expect, it } from 'vitest';
import { $t } from '../i18n';
import { combosOf, formatCombo, keyCandidates } from './keyCombos';

/** A key press as the browser reports it. */
const press = (key: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe('formatCombo', () => {
  it('shows the Mac symbols in their order and Windows names with +', () => {
    expect(formatCombo('Mod+Alt+Shift+T', 'mac')).toBe('⌥⇧⌘T');
    expect(formatCombo('Mod+Shift+T', 'win')).toBe(`${$t('Strg')}+${$t('Umschalt')}+T`);
    expect(formatCombo('Mod++', 'mac')).toBe('⌘+');
    expect(formatCombo('Escape', 'win')).toBe($t('Esc'));
  });
});

describe('combosOf', () => {
  it('writes ⌘ as Mod on the Mac and Strg as Mod on Windows', () => {
    expect(combosOf(press('t', 'KeyT', { metaKey: true }), 'mac', true)).toEqual(['Mod+T']);
    expect(combosOf(press('t', 'KeyT', { ctrlKey: true }), 'win', true)).toEqual(['Mod+T']);
    expect(combosOf(press('t', 'KeyT', { ctrlKey: true }), 'mac', true)).toEqual(['Ctrl+T']);
  });

  it('lets Strg stand in for ⌘ in the browser prototype', () => {
    expect(combosOf(press('t', 'KeyT', { ctrlKey: true }), 'mac', false)).toEqual(['Mod+T']);
  });

  it('takes the physical key when ⌥ changes the letter, and punctuation also without Shift', () => {
    expect(keyCandidates(press('†', 'KeyT', { altKey: true }))).toContain('T');
    expect(combosOf(press('?', 'Slash', { metaKey: true, shiftKey: true }), 'mac', true)).toContain('Mod+?');
    expect(combosOf(press('Shift', 'ShiftLeft', { shiftKey: true }), 'mac', true)).toEqual([]);
  });
});
