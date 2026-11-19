import { afterEach, describe, expect, it } from 'vitest';
import { getState, setState } from './store';
import { actionFor, conflictsWith, keysFor } from './keys';

const press = (key: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;
const withSettings = (patch: Partial<ReturnType<typeof getState>['settings']>) =>
  setState((s) => ({ settings: { ...s.settings, ...patch } }));
const original = getState().settings;
afterEach(() => setState({ settings: original }));

describe('actionFor', () => {
  it('finds the action of a key press on each system', () => {
    expect(actionFor(press('n', 'KeyN', { metaKey: true, shiftKey: true }), 'mac', false)?.id).toBe('newFolder');
    expect(actionFor(press('N', 'KeyN', { ctrlKey: true, shiftKey: true }), 'win', false)?.id).toBe('newFolder');
  });

  it('leaves text editing keys to a text field', () => {
    const copy = press('c', 'KeyC', { metaKey: true });
    expect(actionFor(copy, 'mac', false)?.id).toBe('copy');
    expect(actionFor(copy, 'mac', true)).toBeUndefined();
  });

  it('takes no plain keys while typing', () => {
    expect(actionFor(press('F6', 'F6'), 'win', false)).toBeDefined();
    expect(actionFor(press('F6', 'F6'), 'win', true)).toBeUndefined();
  });

  it('follows a key the user changed', () => {
    withSettings({ shortcuts: { newFolder: 'Mod+Alt+N' } });
    expect(actionFor(press('n', 'KeyN', { metaKey: true, shiftKey: true }), 'mac', false)?.id).not.toBe('newFolder');
    expect(actionFor(press('n', 'KeyN', { metaKey: true, altKey: true }), 'mac', false)?.id).toBe('newFolder');
  });
});

describe('keysFor', () => {
  it('has no key for an action whose key the user removed', () => {
    withSettings({ shortcuts: { newFolder: '' } });
    expect(keysFor('newFolder', 'mac')).toEqual([]);
  });
});

describe('conflictsWith', () => {
  it('names the other actions on the same combination', () => {
    expect(conflictsWith('newFolder', 'Mod+C', 'mac').map((a) => a.id)).toEqual(['copy']);
    expect(conflictsWith('copy', 'Mod+C', 'mac')).toEqual([]);
  });
});
