import { describe, expect, it } from 'vitest';
import { isOwnColor, ownColorFromInput, serverColorCss, swatch } from './serverColors';

describe('serverColorCss', () => {
  it('gives no colour for "gray" and for a missing colour', () => {
    expect(serverColorCss('gray')).toBeUndefined();
    expect(serverColorCss(undefined)).toBeUndefined();
  });

  it('resolves a fixed key to its swatch', () => {
    expect(serverColorCss('red')).toBe(swatch.red);
    expect(serverColorCss('blue')).toBe(swatch.blue);
  });

  it('uses an own colour as it is', () => {
    expect(serverColorCss('#12ab9f')).toBe('#12ab9f');
  });
});

describe('isOwnColor', () => {
  it('tells own colours from keys', () => {
    expect(isOwnColor('#000000')).toBe(true);
    expect(isOwnColor('green')).toBe(false);
  });
});

describe('ownColorFromInput', () => {
  it('accepts #rrggbb and stores it in lower case', () => {
    expect(ownColorFromInput('#A1B2C3')).toBe('#a1b2c3');
  });

  it('rejects anything else', () => {
    for (const v of ['', 'red', '#abc', '#abcdeg', 'a1b2c3', '#a1b2c3d4', ' #a1b2c3'])
      expect(ownColorFromInput(v)).toBeNull();
  });
});
