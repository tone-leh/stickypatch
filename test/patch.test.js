import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizePatch } from '../src/config.js';
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

test('all examples/*.stickypatch.json templates load cleanly and adhere to schema keys', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const examplesDir = path.join(repoRoot, 'examples');
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'stickypatch.schema.json'), 'utf8'));

  const multiKeys = new Set(Object.keys(schema.oneOf[1].properties));
  const targetKeys = new Set(Object.keys(schema.$defs.target.properties));
  const healthKeys = new Set(Object.keys(schema.$defs.target.properties.health.oneOf[1].properties));
  const guardKeys = new Set(Object.keys(schema.$defs.target.properties.guard.properties));

  const files = fs
    .readdirSync(examplesDir)
    .filter((name) => name.endsWith('.stickypatch.json'))
    .sort();

  assert.ok(files.length >= 5, `expected at least 5 example configs, found ${files.length}`);
  for (const expected of [
    'antigravity-mcp-tooling.stickypatch.json',
    'claude-code.stickypatch.json',
    'codex-cli.stickypatch.json',
    'multi-target.stickypatch.json',
    'opencodex.stickypatch.json',
  ]) {
    assert.ok(files.includes(expected), `missing expected example template: ${expected}`);
  }

  for (const name of files) {
    const filePath = path.join(examplesDir, name);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const isMulti = Array.isArray(raw.targets);

    const allowedRoot = isMulti ? multiKeys : targetKeys;
    for (const key of Object.keys(raw)) {
      assert.ok(allowedRoot.has(key), `${name}: unexpected top-level key "${key}"`);
    }

    const rawTargets = isMulti ? raw.targets : [raw];
    assert.ok(rawTargets.length > 0, `${name}: must declare at least one target`);
    for (const rawTarget of rawTargets) {
      for (const key of Object.keys(rawTarget)) {
        assert.ok(targetKeys.has(key), `${name}: unexpected target key "${key}"`);
      }
      if (rawTarget.guard !== undefined) {
        assert.equal(typeof rawTarget.guard, 'object');
        for (const key of Object.keys(rawTarget.guard)) {
          assert.ok(guardKeys.has(key), `${name}: unexpected guard key "${key}"`);
        }
      }
      if (rawTarget.health && typeof rawTarget.health === 'object') {
        for (const key of Object.keys(rawTarget.health)) {
          assert.ok(healthKeys.has(key), `${name}: unexpected health key "${key}"`);
        }
      }
    }

    const cfg = await loadConfig(filePath);
    assert.equal(cfg.editable, true, `${name}: JSON config should be editable`);
    assert.equal(cfg.multi, isMulti, `${name}: multi flag mismatch`);
    assert.equal(cfg.targets.length, rawTargets.length, `${name}: target count mismatch`);
    for (const target of cfg.targets) {
      assert.ok(target.name, `${name}: target must resolve a name`);
      assert.ok(target.package || target.path, `${name}: target must set package or path`);
      assert.ok(Array.isArray(target.guard.denyEnv), `${name}: guard.denyEnv must normalize to an array`);
    }
  }

  const claudeCfg = await loadConfig(path.join(examplesDir, 'claude-code.stickypatch.json'));
  assert.deepEqual(claudeCfg.targets[0].guard.denyEnv, ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']);

  const codexCfg = await loadConfig(path.join(examplesDir, 'codex-cli.stickypatch.json'));
  assert.equal(codexCfg.targets[0].package, '@openai/codex');
  assert.equal(codexCfg.targets[0].bin, 'codex');
  assert.ok(codexCfg.targets[0].guard.denyEnv.includes('CODEX_THREAD_ID'));

  const agyMcpCfg = await loadConfig(path.join(examplesDir, 'antigravity-mcp-tooling.stickypatch.json'));
  assert.equal(agyMcpCfg.multi, true);
  assert.ok(agyMcpCfg.targets.length >= 2);
  assert.ok(agyMcpCfg.targets.some((t) => t.restart && t.health?.url));
  assert.ok(agyMcpCfg.targets.some((t) => t.health?.command));
});
