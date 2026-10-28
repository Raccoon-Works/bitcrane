/**
 * Line-based difference of two texts (Myers algorithm), used by the
 * "Unterschiede zeigen" view of the conflict dialog.
 */

export type DiffOp = 'same' | 'add' | 'del';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** Line number in the old text (server version), if the line exists there. */
  oldNo?: number;
  /** Line number in the new text (local version), if the line exists there. */
  newNo?: number;
}

/** Hunk of changed lines with some unchanged context around it. */
export interface DiffHunk {
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

/** Computes the line operations that turn `oldText` into `newText`. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk the trace backwards to recover the edit script.
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: 'same', text: a[x - 1], oldNo: x, newNo: y });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ op: 'add', text: b[y - 1], newNo: y });
      else out.push({ op: 'del', text: a[x - 1], oldNo: x });
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
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) if (changed[j]) return true;
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
