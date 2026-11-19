import { describe, expect, it } from 'vitest';
import { algoOfSum, cleanSum, programName } from './fileTools';

describe('pasted checksums', () => {
  it('drops spaces and case', () => {
    expect(cleanSum('  AB cd\nEF ')).toBe('abcdef');
  });

  it('tells the algorithm by length', () => {
    expect(algoOfSum('d41d8cd98f00b204e9800998ecf8427e')).toBe('md5');
    expect(algoOfSum('DA39A3EE 5E6B4B0D 3255BFEF 95601890 AFD80709')).toBe('sha1');
    expect(algoOfSum('a'.repeat(64))).toBe('sha256');
    expect(algoOfSum('a'.repeat(128))).toBe('sha512');
  });

  it('refuses values that are no checksum', () => {
    expect(algoOfSum('g'.repeat(32))).toBeUndefined();
    expect(algoOfSum('abc')).toBeUndefined();
  });
});

describe('programName', () => {
  it('drops folder and extension on both systems', () => {
    expect(programName('/Applications/Visual Studio Code.app')).toBe('Visual Studio Code');
    expect(programName('C:\\Program Files\\Notepad++\\notepad++.exe')).toBe('notepad++');
  });
});
