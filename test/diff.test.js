import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editsFromDiff } from '../src/capture.js';
import { unifiedDiff } from '../src/diff.js';
import { nearest } from '../src/review.js';
import { count } from '../src/util.js';

function applyEdits(text, edits) {
  let out = text;
  for (const e of edits) {
    assert.equal(count(out, e.find), 1, `anchor must be unique:\n${e.find}`);
    out = out.replace(e.find, () => e.replace);
  }
  return out;
}

test('editsFromDiff round-trips arbitrary changes with unique anchors', () => {
  const base = Array.from({ length: 60 }, (_, i) => `line ${i % 7}\n`).join('');
  const lines = base.split('\n');
  lines[3] = 'CHANGED';
  lines.splice(20, 2);
  lines.splice(40, 0, 'INSERTED A', 'INSERTED B');
  const current = lines.join('\n');
  const edits = editsFromDiff('f.txt', base, current);
  assert.ok(edits.length >= 1);
  assert.equal(applyEdits(base, edits), current);
});

test('editsFromDiff handles changes at the start and end of the file', () => {
  const base = 'a\nb\nc\n';
  const current = 'z\nb\nc\nd\n';
  assert.equal(applyEdits(base, editsFromDiff('f', base, current)), current);
});

test('editsFromDiff on identical texts is empty', () => {
  assert.deepEqual(editsFromDiff('f', 'same\n', 'same\n'), []);
});

test('unifiedDiff output', () => {
  const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', { fromFile: 'a/x', toFile: 'b/x' });
  assert.equal(d, '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
});

test('nearest finds the moved code', () => {
  const text = 'one\ntwo\nfunction timeoutMs(opts) {\n  return opts.timeout ?? 30000;\n}\n';
  const [hit] = nearest(text, 'export function timeoutMs() {\n  return 30000;\n}');
  assert.equal(hit.startLine, 3);
});

test('editsFromDiff keeps anchors off lines owned by other patches', () => {
  const base = 'start\nPATCHED BY OTHER\nvalue = 1\nend\n';
  const current = 'start\nPATCHED BY OTHER\nvalue = 2\nend\n';
  const [edit] = editsFromDiff('f', base, current, { owned: [[1, 2]] });
  assert.doesNotMatch(edit.find, /PATCHED BY OTHER/);
  assert.equal(applyEdits(base, [edit]), current);
});
