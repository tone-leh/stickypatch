// Minimal line diff (Myers O(ND)) plus a unified-diff printer and hunk grouping.
// No dependencies; good enough for source files of a few thousand lines.

export function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  // Keep a trailing newline as part of the last line's identity.
  if (lines[lines.length - 1] === '') {
    lines.pop();
    return lines.map((line) => `${line}\n`);
  }
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
}

/**
 * Returns an edit script: array of { op: 'equal'|'delete'|'insert', a, b }
 * where a / b are line indexes into the old / new arrays.
 */
export function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Backtrack.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vd = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ op: 'equal', a: x, b: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        ops.push({ op: 'insert', a: x, b: y });
      } else {
        x -= 1;
        ops.push({ op: 'delete', a: x, b: y });
      }
    }
  }
  return ops.reverse();
}

/**
 * Group an edit script into change regions: [{ a0, a1, b0, b1 }] where old
 * lines [a0, a1) were replaced by new lines [b0, b1).
 */
export function changeRegions(ops) {
  const regions = [];
  let current = null;
  for (const step of ops) {
    if (step.op === 'equal') {
      if (current) {
        regions.push(current);
        current = null;
      }
      continue;
    }
    if (!current) current = { a0: step.a, a1: step.a, b0: step.b, b1: step.b };
    if (step.op === 'delete') current.a1 = step.a + 1;
    if (step.op === 'insert') current.b1 = step.b + 1;
  }
  if (current) regions.push(current);
  // Normalise: a region's a1/b1 must be >= a0/b0.
  for (const r of regions) {
    r.a1 = Math.max(r.a1, r.a0);
    r.b1 = Math.max(r.b1, r.b0);
  }
  return regions;
}

export function unifiedDiff(oldText, newText, { fromFile = 'a', toFile = 'b', context = 3 } = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffLines(a, b);
  const regions = changeRegions(ops);
  if (!regions.length) return '';
  const out = [`--- ${fromFile}`, `+++ ${toFile}`];
  // Merge regions whose context windows overlap.
  const hunks = [];
  for (const r of regions) {
    const last = hunks[hunks.length - 1];
    if (last && r.a0 - last.a1 <= context * 2) {
      last.regions.push(r);
      last.a1 = r.a1;
      last.b1 = r.b1;
    } else {
      hunks.push({ a0: r.a0, a1: r.a1, b0: r.b0, b1: r.b1, regions: [r] });
    }
  }
  const fmt = (line) => (line.endsWith('\n') ? line.slice(0, -1) : `${line}\n\\ No newline at end of file`);
  for (const h of hunks) {
    const start = Math.max(0, h.a0 - context);
    const bStart = Math.max(0, h.b0 - context);
    const end = Math.min(a.length, h.a1 + context);
    const bEnd = Math.min(b.length, h.b1 + context);
    out.push(`@@ -${start + 1},${end - start} +${bStart + 1},${bEnd - bStart} @@`);
    let ai = start;
    for (const r of h.regions) {
      for (; ai < r.a0; ai += 1) out.push(` ${fmt(a[ai])}`);
      for (let i = r.a0; i < r.a1; i += 1) out.push(`-${fmt(a[i])}`);
      for (let i = r.b0; i < r.b1; i += 1) out.push(`+${fmt(b[i])}`);
      ai = r.a1;
    }
    for (; ai < end; ai += 1) out.push(` ${fmt(a[ai])}`);
  }
  return `${out.join('\n')}\n`;
}
