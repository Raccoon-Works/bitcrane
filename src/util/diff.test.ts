import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, toHunks } from './diff';

/** The old and the new text rebuilt from a diff, to check it is complete and in order. */
function rebuild(lines: ReturnType<typeof diffLines>) {
  return {
    old: lines.filter((l) => l.op !== 'add').map((l) => l.text),
    new: lines.filter((l) => l.op !== 'del').map((l) => l.text),
  };
}

describe('diffLines', () => {
  it('finds the shortest change with line numbers on both sides', () => {
    const lines = diffLines('a\nb\nc\nd\n', 'a\nx\nc\nd\ne\n');
    expect(lines.map((l) => `${l.op[0]}${l.text}`)).toEqual(['sa', 'db', 'ax', 'sc', 'sd', 'ae']);
    expect(lines.find((l) => l.text === 'c')).toMatchObject({ oldNo: 3, newNo: 3 });
    expect(lines.find((l) => l.text === 'e')).toMatchObject({ newNo: 5 });
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it('treats CRLF and LF alike and finds no change in equal texts', () => {
    expect(diffStats(diffLines('a\r\nb\r\n', 'a\nb\n'))).toEqual({ added: 0, removed: 0 });
    expect(toHunks(diffLines('a\nb', 'a\nb'))).toEqual([]);
  });

  it('stays correct and quick for very different long texts', () => {
    const a = Array.from({ length: 20000 }, (_, i) => `alt ${i}`).join('\n');
    const b = Array.from({ length: 20000 }, (_, i) => `neu ${i}`).join('\n');
    const t = Date.now();
    const lines = diffLines(`kopf\n${a}\nfuss`, `kopf\n${b}\nfuss`);
    expect(Date.now() - t).toBeLessThan(5000);
    const back = rebuild(lines);
    expect(back.old.length).toBe(20002);
    expect(back.new.slice(0, 2)).toEqual(['kopf', 'neu 0']);
    expect(lines[lines.length - 1]).toMatchObject({ op: 'same', text: 'fuss', oldNo: 20002, newNo: 20002 });
  });

  it('rebuilds both texts from any diff', () => {
    const oldText = 'eins\nzwei\ndrei\nvier\nfünf';
    const newText = 'null\neins\ndrei\nvier!\nfünf\nsechs';
    const back = rebuild(diffLines(oldText, newText));
    expect(back.old.join('\n')).toBe(oldText);
    expect(back.new.join('\n')).toBe(newText);
  });
});
