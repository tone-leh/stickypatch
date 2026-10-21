import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePatch } from '../src/config.js';
import * as P from '../src/patch.js';

const mk = (raw) => normalizePatch(raw, process.cwd());
const FILE = 'a.js';

test('missing -> render -> applied, and render is idempotent', () => {
  const patch = mk({ id: 'x', edits: [{ file: FILE, find: 'A = 1', replace: 'A = 2' }] });
  const files = { [FILE]: 'let A = 1;\n' };
  assert.equal(P.detect(files, patch).status, P.MISSING);
  const out = P.render(files, patch);
  assert.equal(out[FILE], 'let A = 2;\n');
  assert.equal(P.detect(out, patch).status, P.APPLIED);
  assert.deepEqual(P.render(out, patch), {});
});

test('insertions whose replace contains the anchor stay detectable', () => {
  const patch = mk({ id: 'x', edits: [{ file: FILE, find: 'start();', replace: 'start();\nlog();' }] });
  const out = P.render({ [FILE]: 'start();\n' }, patch);
  assert.equal(out[FILE], 'start();\nlog();\n');
  assert.equal(P.detect(out, patch).status, P.APPLIED);
});

test('ambiguous anchors are incompatible, never guessed', () => {
  const patch = mk({ id: 'x', edits: [{ file: FILE, find: 'x', replace: 'y' }] });
  const r = P.detect({ [FILE]: 'x x' }, patch);
  assert.equal(r.status, P.INCOMPATIBLE);
  assert.match(r.detail, /2 places/);
  assert.throws(() => P.render({ [FILE]: 'x x' }, patch), /cannot be edited/);
});

test('anchor gone -> incompatible; with upstream markers -> upstream', () => {
  const plain = mk({ id: 'x', edits: [{ file: FILE, find: 'LIMIT = 10', replace: 'LIMIT = 99' }] });
  assert.equal(P.detect({ [FILE]: 'LIMIT = computeLimit()' }, plain).status, P.INCOMPATIBLE);
  const withUpstream = mk({
    id: 'x',
    edits: [{ file: FILE, find: 'LIMIT = 10', replace: 'LIMIT = 99' }],
    upstream: [{ file: FILE, contains: 'computeLimit(' }],
  });
  assert.equal(P.detect({ [FILE]: 'LIMIT = computeLimit()' }, withUpstream).status, P.UPSTREAM);
});

test('upstream "absent" condition', () => {
  const patch = mk({
    id: 'x',
    edits: [{ file: FILE, find: 'old()', replace: 'fixed()' }],
    upstream: [{ file: FILE, absent: 'old()' }],
  });
  assert.equal(P.detect({ [FILE]: 'nothing here' }, patch).status, P.UPSTREAM);
});

test('upstream marker in another file is read', () => {
  const patch = mk({
    id: 'x',
    edits: [{ file: FILE, find: 'old()', replace: 'fixed()' }],
    upstream: [{ file: 'b.js', contains: 'nativeFix' }],
  });
  assert.deepEqual(patch.readFiles, [FILE, 'b.js']);
  assert.equal(P.detect({ [FILE]: 'old()', 'b.js': 'nativeFix()' }, patch).status, P.UPSTREAM);
  assert.equal(P.detect({ [FILE]: 'old()', 'b.js': '' }, patch).status, P.MISSING);
});

test('outdated form is migrated to the current form', () => {
  const patch = mk({ id: 'x', edits: [{ file: FILE, find: 'n = 1', replace: 'n = 3', previous: ['n = 2'] }] });
  const files = { [FILE]: 'let n = 2;' };
  assert.equal(P.detect(files, patch).status, P.OUTDATED);
  const out = P.render(files, patch);
  assert.equal(out[FILE], 'let n = 3;');
  assert.equal(P.detect(out, patch).status, P.APPLIED);
});

test('partially applied multi-edit patch is finished by render', () => {
  const patch = mk({
    id: 'x',
    edits: [
      { file: FILE, find: 'a = 1', replace: 'a = 2' },
      { file: FILE, find: 'b = 1', replace: 'b = 2' },
    ],
  });
  const files = { [FILE]: 'a = 2; b = 1;' };
  const r = P.detect(files, patch);
  assert.equal(r.status, P.MISSING);
  assert.match(r.detail, /1\/2/);
  assert.equal(P.render(files, patch)[FILE], 'a = 2; b = 2;');
});

test('a generic replace text that already occurs elsewhere is not mistaken for applied', () => {
  const patch = mk({ id: 'x', edits: [{ file: FILE, find: 'retries = 1', replace: 'true' }] });
  const r = P.detect({ [FILE]: 'ok = true; retries = 1;' }, patch);
  assert.equal(r.status, P.INCOMPATIBLE);
  assert.match(r.detail, /more specific/);
});

test('missing target file -> unverifiable', () => {
  const patch = mk({ id: 'x', edits: [{ file: FILE, find: 'a', replace: 'b' }] });
  assert.equal(P.detect({}, patch).status, P.UNVERIFIABLE);
});

test('retired patches report retired regardless of content', () => {
  const patch = mk({ id: 'x', retired: { version: '2.0.0', reason: 'native' }, edits: [{ file: FILE, find: 'a', replace: 'b' }] });
  const r = P.detect({}, patch);
  assert.equal(r.status, P.RETIRED);
  assert.match(r.detail, /2\.0\.0/);
});

test('deletion edits (empty replace)', () => {
  const patch = mk({ id: 'x', edits: [{ file: FILE, find: 'telemetry();\n', replace: '' }] });
  const files = { [FILE]: 'run();\ntelemetry();\n' };
  assert.equal(P.detect(files, patch).status, P.MISSING);
  const out = P.render(files, patch);
  assert.equal(out[FILE], 'run();\n');
  assert.equal(P.detect(out, patch).status, P.APPLIED);
});

test('replacement text containing $ patterns is inserted literally', () => {
  const patch = mk({ id: 'x', edits: [{ file: FILE, find: 'X', replace: "price = '$&$1'" }] });
  assert.equal(P.render({ [FILE]: 'X' }, patch)[FILE], "price = '$&$1'");
});

test('array-of-lines form joins with newlines', () => {
  const patch = mk({ id: 'x', edits: [{ file: FILE, find: ['a', 'b'], replace: ['a', 'c'] }] });
  assert.equal(patch.edits[0].find, 'a\nb');
});

test('custom patches: detect/render functions', () => {
  const patch = mk({
    id: 'c',
    files: [FILE],
    detect: (files) => (files[FILE].includes('B') ? { status: 'applied' } : { status: 'missing', detail: 'no B' }),
    render: (files) => ({ [FILE]: files[FILE].replace('A', 'B') }),
  });
  assert.equal(P.detect({ [FILE]: 'A' }, patch).status, P.MISSING);
  assert.deepEqual(P.render({ [FILE]: 'A' }, patch), { [FILE]: 'B' });
  const rogue = mk({ id: 'r', files: [FILE], detect: () => ({ status: 'missing' }), render: () => ({ 'other.js': 'x' }) });
  assert.throws(() => P.render({ [FILE]: 'A' }, rogue), /not in files/);
});

test('config validation', () => {
  assert.throws(() => mk({ id: 'bad id!', edits: [] }), /invalid patch id/);
  assert.throws(() => mk({ id: 'x', edits: [] }), /at least one edit/);
  assert.throws(() => mk({ id: 'x', edits: [{ file: FILE, find: 'a', replace: 'a' }] }), /identical/);
  assert.throws(() => mk({ id: 'x', edits: [{ file: FILE, find: '', replace: 'a' }] }), /find/);
});
