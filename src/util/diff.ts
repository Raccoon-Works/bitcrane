/**
 * Line-based difference of two texts (Myers algorithm), used by "Unterschiede
 * zeigen" in the conflict dialog and by "Dateien vergleichen" (DiffDialog.tsx).
 */

type DiffOp = 'same' | 'add' | 'del';

interface DiffLine {
  op: DiffOp;
  text: string;
  /** Line number in the old text (server version), if the line exists there. */
  oldNo?: number;
  /** Line number in the new text (local version), if the line exists there. */
  newNo?: number;
}

/** Hunk of changed lines with some unchanged context around it. */
interface DiffHunk {
  lines: DiffLine[];
  /** Unchanged lines skipped before this hunk. */
  skipped: number;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Most edits the exact comparison looks for. Its memory grows with the square of the edits (about
 * 16 MB here); beyond it the changed middle shows as removed and added as a whole, which is still
 * correct, only not the shortest way.
 */
const MAX_EDITS = 2000;

/** Computes the line operations that turn `oldText` into `newText`. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // Equal lines at the start and the end need no search.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const same = (from: number, to: number): DiffLine[] =>
    a
      .slice(from, to)
      .map((text, i) => ({ op: 'same', text, oldNo: from + i + 1, newNo: from + i + 1 + b.length - a.length }));
  const head = a.slice(0, start).map((text, i): DiffLine => ({ op: 'same', text, oldNo: i + 1, newNo: i + 1 }));
  const tail = same(a.length - end, a.length);
  const middle =
    myers(a.slice(start, a.length - end), b.slice(start, b.length - end)) ??
    wholesale(a.length - start - end, b.length - start - end);
  return [
    ...head,
    ...middle.map(({ op, i, j }): DiffLine => {
      if (op === 'add') return { op, text: b[start + j], newNo: start + j + 1 };
      if (op === 'del') return { op, text: a[start + i], oldNo: start + i + 1 };
      return { op, text: a[start + i], oldNo: start + i + 1, newNo: start + j + 1 };
    }),
    ...tail,
  ];
}

/** One step of an edit script: index `i` in the old lines, `j` in the new ones. */
interface Step {
  op: DiffOp;
  i: number;
  j: number;
}

/** Everything old removed, then everything new added. */
function wholesale(n: number, m: number): Step[] {
  return [
    ...Array.from({ length: n }, (_, i): Step => ({ op: 'del', i, j: 0 })),
    ...Array.from({ length: m }, (_, j): Step => ({ op: 'add', i: 0, j })),
  ];
}

/** Shortest edit script (Myers); null when it needs more than MAX_EDITS edits. */
function myers(a: string[], b: string[]): Step[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Only the diagonals step d can reach are kept for the way back (-d-1 … d+1).
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

/** Walks the kept diagonals backwards to the edit script. */
function backtrack(trace: Int32Array[], n: number, m: number): Step[] {
  const out: Step[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const at = (k: number) => vd[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: 'same', i: x - 1, j: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ op: 'add', i: x, j: y - 1 });
      else out.push({ op: 'del', i: x - 1, j: y });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

/** Groups the lines into hunks with `context` unchanged lines around changes. */
export function toHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed = lines.map((l) => l.op !== 'same');
  const keep = lines.map((_, i) => {
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++)
      if (changed[j]) return true;
    return false;
  });
  const hunks: DiffHunk[] = [];
  let skipped = 0;
  let current: DiffHunk | null = null;
  lines.forEach((l, i) => {
    if (!keep[i]) {
      skipped++;
      current = null;
      return;
    }
    if (!current) {
      current = { lines: [], skipped };
      hunks.push(current);
      skipped = 0;
    }
    current.lines.push(l);
  });
  return hunks;
}

/** Number of added and removed lines. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.op === 'add').length, removed: lines.filter((l) => l.op === 'del').length };
}
